// SPDX-License-Identifier: GPL-3.0-or-later
// The alert decisions in lib/alerts.js.
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    AlertEngine, DEFAULT_ALERT_SETTINGS, DISK_HYSTERESIS, HeatWatch, MEM_HYSTERESIS, TEMP_HYSTERESIS,
} from '../extension/lib/alerts.js';

/**
 * A PveClient snapshot with only what the engine reads. `nodes` maps
 * 'server/node' to {temp, mem, disk}; `guests` is [server, vmid, name, status].
 */
function snap({
    daemon = 'running', servers = {home: 'ok'}, nodes = {'home/pve': {}}, guests = [],
} = {}) {
    const values = new Map();
    const nodeList = [];
    for (const [id, r] of Object.entries(nodes)) {
        const [server, name] = id.split('/');
        nodeList.push({server, name, status: 'online'});
        for (const [what, v] of Object.entries(r)) {
            if (v !== null && v !== undefined)
                values.set(`${server}/node/${name}/${what}`, v);
        }
    }
    return {
        daemon,
        servers: Object.entries(servers).map(([name, state]) => ({name, state, message: ''})),
        nodes: nodeList,
        guests: guests.map(([server, vmid, name, status]) =>
            ({server, vmid, name, status, kind: 'qemu', node: 'pve'})),
        values,
    };
}

const only = extra => ({
    ...DEFAULT_ALERT_SETTINGS,
    tempEnabled: false, memEnabled: false, diskEnabled: false, downEnabled: false,
    ...extra,
});
const notes = actions => actions.filter(a => a.notify).map(a => a.notify);

/** Feeds snapshots `step` seconds apart and collects every action. */
function run(engine, snapshots, settings, step = 10, start = 0) {
    const all = [];
    snapshots.forEach((s, i) => all.push(...engine.update(s, start + i * step, settings)));
    return all;
}

const hot = t => snap({nodes: {'home/pve': {temp: t}}});

// ---- HeatWatch -----------------------------------------------------------------

test('watch: fires once the reading held the limit for the set time', () => {
    const w = new HeatWatch(3);
    assert.equal(w.update(85, 0, 85, 60), false);
    assert.equal(w.update(90, 59, 85, 60), false);
    assert.equal(w.update(86, 60, 85, 60), true);
});

test('watch: fires only once per episode', () => {
    const w = new HeatWatch(3);
    w.update(90, 0, 85, 60);
    assert.equal(w.update(90, 60, 85, 60), true);
    assert.equal(w.update(90, 70, 85, 60), false);
    assert.equal(w.update(90, 700, 85, 60), false);
});

test('watch: a dip below the limit restarts the streak', () => {
    const w = new HeatWatch(3);
    w.update(90, 0, 85, 60);
    w.update(84, 30, 85, 60);
    assert.equal(w.update(90, 60, 85, 60), false);
    assert.equal(w.update(90, 120, 85, 60), true);
});

test('watch: hysteresis keeps the episode open inside the band', () => {
    const w = new HeatWatch(3);
    w.update(90, 0, 85, 0);
    assert.equal(w.update(90, 10, 85, 0), false);
    w.update(83, 20, 85, 0); // inside the band: still the same episode
    assert.equal(w.update(90, 30, 85, 0), false);
    w.update(81, 40, 85, 0); // below limit - 3: the episode ended
    assert.equal(w.update(90, 50, 85, 0), true);
});

test('watch: a missing reading breaks the streak but does not end the episode', () => {
    const w = new HeatWatch(3);
    w.update(90, 0, 85, 60);
    w.update(null, 30, 85, 60);
    assert.equal(w.update(90, 60, 85, 60), false); // streak restarted at 60
    assert.equal(w.update(90, 120, 85, 60), true);
    w.update(null, 130, 85, 60);
    assert.equal(w.update(90, 400, 85, 60), false); // same episode, already fired
    w.update(NaN, 410, 85, 60);
    assert.equal(w.update(undefined, 420, 85, 60), false);
});

test('hysteresis constants follow the spec', () => {
    assert.deepEqual([TEMP_HYSTERESIS, MEM_HYSTERESIS, DISK_HYSTERESIS], [3, 5, 2]);
});

// ---- host alerts -----------------------------------------------------------------

test('temperature: defaults are 85 C for 60 s, on', () => {
    const e = new AlertEngine();
    const out = notes(run(e, [hot(90), hot(90), hot(90), hot(90), hot(90), hot(90), hot(90)]));
    assert.equal(out.length, 1);
    assert.match(out[0].title, /pve/);
    assert.match(out[0].title, /home/);
    assert.match(out[0].body, /90 °C/);
});

test('temperature: not before the hold time, nothing when disabled', () => {
    const snaps = [hot(90), hot(90), hot(90), hot(90), hot(90)]; // 0..40 s
    assert.equal(notes(run(new AlertEngine(), snaps)).length, 0);
    const off = {...DEFAULT_ALERT_SETTINGS, tempEnabled: false};
    assert.equal(notes(run(new AlertEngine(), Array(20).fill(hot(99)), off)).length, 0);
});

test('temperature: custom limit and hold', () => {
    const s = only({tempEnabled: true, tempLimit: 70, tempSeconds: 20});
    const out = notes(run(new AlertEngine(), [hot(71), hot(72), hot(73)], s));
    assert.equal(out.length, 1);
});

test('temperature: re-arms only below limit - 3, and the episode notifies once', () => {
    const s = only({tempEnabled: true, tempSeconds: 10});
    const e = new AlertEngine();
    const first = notes(run(e, [hot(90), hot(90), hot(90), hot(90)], s));
    assert.equal(first.length, 1);
    // 83 is inside the band: same episode, silent.
    assert.equal(notes(run(e, [hot(83), hot(90), hot(90), hot(90)], s, 10, 100)).length, 0);
    // 80 ends it; a new one fires.
    run(e, [hot(80)], s, 10, 200);
    assert.equal(notes(run(e, [hot(90), hot(90), hot(90)], s, 10, 210)).length, 1);
});

test('memory: 95 % for 120 s, ends below 90', () => {
    const mem = v => snap({nodes: {'home/pve': {mem: v}}});
    const s = only({memEnabled: true});
    const e = new AlertEngine();
    const a = notes(run(e, Array(13).fill(mem(96)), s)); // 0..120 s
    assert.equal(a.length, 1);
    assert.match(a[0].body, /96 %/);
    run(e, [mem(92)], s, 10, 200); // inside the band
    assert.equal(notes(run(e, Array(13).fill(mem(96)), s, 10, 210)).length, 0);
    run(e, [mem(89)], s, 10, 400);
    assert.equal(notes(run(e, Array(13).fill(mem(96)), s, 10, 410)).length, 1);
});

test('memory: short spike under the hold time is ignored', () => {
    const mem = v => snap({nodes: {'home/pve': {mem: v}}});
    const out = run(new AlertEngine(), [mem(97), mem(97), mem(50), mem(97), mem(97)], only({memEnabled: true}));
    assert.equal(out.length, 0);
});

test('disk: fires at once at 90 %, ends below 88', () => {
    const disk = v => snap({nodes: {'home/pve': {disk: v}}});
    const s = only({diskEnabled: true});
    const e = new AlertEngine();
    assert.equal(notes(e.update(disk(89), 0, s)).length, 0);
    const a = notes(e.update(disk(90), 10, s));
    assert.equal(a.length, 1);
    assert.match(a[0].body, /90 %/);
    assert.equal(e.update(disk(95), 20, s).length, 0);
    e.update(disk(89), 30, s); // inside the band
    assert.equal(e.update(disk(91), 40, s).length, 0);
    e.update(disk(87), 50, s);
    assert.equal(e.update(disk(91), 60, s).length, 1);
});

test('missing readings (no temperature agent) never alert', () => {
    const out = run(new AlertEngine(), Array(30).fill(snap({nodes: {'home/pve': {cpu: 10}}})));
    assert.equal(out.length, 0);
});

test('one episode per node and per server, never mixed', () => {
    const both = t => snap({
        servers: {home: 'ok', lab: 'ok'},
        nodes: {'home/pve': {temp: t}, 'home/pve2': {temp: 40}, 'lab/pve': {temp: 40}},
    });
    const s = only({tempEnabled: true, tempSeconds: 10});
    const e = new AlertEngine();
    const out = notes(run(e, [both(90), both(90), both(90)], s));
    assert.equal(out.length, 1);
    assert.match(out[0].title, /pve \(home\)/);

    // The same node name on another server is its own episode.
    const lab = snap({
        servers: {home: 'ok', lab: 'ok'},
        nodes: {'home/pve': {temp: 90}, 'lab/pve': {temp: 90}},
    });
    const next = notes(run(e, [lab, lab, lab], s, 10, 100));
    assert.equal(next.length, 1);
    assert.match(next[0].title, /\(lab\)/);
});

test('several hot nodes notify once each, in the same update', () => {
    const two = snap({nodes: {'home/a': {temp: 90}, 'home/b': {temp: 91}}});
    const s = only({tempEnabled: true, tempSeconds: 10});
    const out = run(new AlertEngine(), [two, two, two], s);
    assert.equal(notes(out).length, 2);
});

// ---- connection ----------------------------------------------------------------------

test('a daemon that is not running gives no actions and starts over', () => {
    const s = only({tempEnabled: true, tempSeconds: 10});
    const e = new AlertEngine();
    assert.deepEqual(e.update(snap({daemon: 'not-running'}), 0, s), []);
    assert.deepEqual(e.update(snap({daemon: 'connecting'}), 1, s), []);
    // Streak before a reconnect does not count; the episode is forgotten.
    e.update(hot(90), 10, s);
    e.update(snap({daemon: 'not-running'}), 15, s);
    assert.equal(e.update(hot(90), 20, s).length, 0); // new streak starts at 20
    assert.equal(e.update(hot(90), 30, s).length, 1);
    // A fired episode is forgotten on reconnect too: it may fire again.
    e.update(snap({daemon: 'not-running'}), 40, s);
    e.update(hot(90), 50, s);
    assert.equal(e.update(hot(90), 60, s).length, 1);
});

// ---- server unreachable ------------------------------------------------------------

const down = (state = 'offline') => snap({servers: {home: state}, nodes: {}});

test('unreachable: fires after 120 s, once, names the server', () => {
    const e = new AlertEngine();
    const out = notes(run(e, Array(14).fill(down()), DEFAULT_ALERT_SETTINGS)); // 0..130
    assert.equal(out.length, 1);
    assert.match(out[0].title, /home/);
    assert.match(out[0].body, /offline/);
});

test('unreachable: not before the hold; ok again ends the episode', () => {
    const e = new AlertEngine();
    assert.equal(run(e, Array(12).fill(down())).length, 0); // 0..110
    e.update(snap({nodes: {}}), 115, DEFAULT_ALERT_SETTINGS); // back to ok: streak gone
    assert.equal(run(e, Array(12).fill(down()), DEFAULT_ALERT_SETTINGS, 10, 120).length, 0);
    assert.equal(run(e, Array(3).fill(down()), DEFAULT_ALERT_SETTINGS, 10, 240).length, 1);
    // A second outage after ok is a new episode.
    e.update(snap({nodes: {}}), 300, DEFAULT_ALERT_SETTINGS);
    assert.equal(notes(run(e, Array(14).fill(down('unauthorized')), DEFAULT_ALERT_SETTINGS, 10, 310)).length, 1);
});

test('unreachable: connecting counts as not ok; custom hold; disabled', () => {
    const s = {...DEFAULT_ALERT_SETTINGS, downSeconds: 30};
    assert.equal(notes(run(new AlertEngine(), Array(5).fill(down('connecting')), s)).length, 1);
    const off = {...DEFAULT_ALERT_SETTINGS, downEnabled: false};
    assert.equal(run(new AlertEngine(), Array(30).fill(down()), off).length, 0);
});

test('unreachable: servers are independent', () => {
    const two = (a, b) => snap({servers: {home: a, lab: b}, nodes: {}});
    const e = new AlertEngine();
    const out = notes(run(e, Array(14).fill(two('offline', 'ok')), DEFAULT_ALERT_SETTINGS));
    assert.equal(out.length, 1);
    assert.match(out[0].title, /home/);
    // lab goes down later: its own clock.
    const late = notes(run(e, Array(14).fill(two('offline', 'offline')), DEFAULT_ALERT_SETTINGS, 10, 200));
    assert.equal(late.length, 1);
    assert.match(late[0].title, /lab/);
});

test('unreachable: a server removed from the config is forgotten', () => {
    const e = new AlertEngine();
    run(e, Array(5).fill(down()), DEFAULT_ALERT_SETTINGS);
    e.update(snap({servers: {}, nodes: {}}), 100, DEFAULT_ALERT_SETTINGS);
    assert.equal(e._down.size, 0);
});

// ---- guests -------------------------------------------------------------------------

const g = (...rows) => snap({nodes: {}, guests: rows});
const stopped = {stoppedEnabled: true};

test('guest stopped: off by default', () => {
    const out = run(new AlertEngine(), [g(['home', 101, 'web', 'running']), g(['home', 101, 'web', 'stopped'])]);
    assert.equal(out.length, 0);
});

test('guest stopped: running to anything else, named, once per transition', () => {
    const s = only(stopped);
    const e = new AlertEngine();
    const out = notes(run(e, [
        g(['home', 101, 'web', 'running']),
        g(['home', 101, 'web', 'running']),
        g(['home', 101, 'web', 'stopped']),
        g(['home', 101, 'web', 'stopped']),
    ], s));
    assert.equal(out.length, 1);
    assert.match(out[0].title, /web/);
    assert.match(out[0].body, /101/);
    assert.match(out[0].body, /home/);
    // Running again, then stopping again is a new transition.
    const again = notes(run(e, [g(['home', 101, 'web', 'running']), g(['home', 101, 'web', 'stopped'])], s, 10, 100));
    assert.equal(again.length, 1);
});

test('guest stopped: the first snapshot is never a transition', () => {
    const s = only({...stopped, startedEnabled: true});
    assert.equal(run(new AlertEngine(), [g(['home', 101, 'web', 'stopped'])], s).length, 0);
    assert.equal(run(new AlertEngine(), [g(['home', 101, 'web', 'running'])], s).length, 0);
});

test('guest stopped: a guest that was never running does not alert', () => {
    const s = only({...stopped});
    const out = run(new AlertEngine(), [g(['home', 5, 'x', 'stopped']), g(['home', 5, 'x', 'paused'])], s);
    assert.equal(out.length, 0);
});

test('guest stopped: running to paused is silent, paused to stopped alerts', () => {
    const s = only(stopped);
    const e = new AlertEngine();
    assert.equal(run(e, [g(['home', 7, 'vm', 'running']), g(['home', 7, 'vm', 'paused'])], s).length, 0);
    const out = notes(run(e, [g(['home', 7, 'vm', 'paused']), g(['home', 7, 'vm', 'stopped'])], s, 10, 100));
    assert.equal(out.length, 1);
    assert.match(out[0].title, /vm stopped/);
    assert.match(out[0].body, /from paused to stopped/);
});

test('guest stopped: paused to another non-running state alerts, paused to running does not', () => {
    const s = only(stopped);
    const odd = notes(run(new AlertEngine(), [g(['home', 7, 'vm', 'paused']), g(['home', 7, 'vm', 'unknown'])], s));
    assert.equal(odd.length, 1);
    assert.equal(run(new AlertEngine(), [g(['home', 7, 'vm', 'paused']), g(['home', 7, 'vm', 'running'])], s).length, 0);
});

test('guest stopped: list filter uses server/vmid and does not mix servers', () => {
    const s = only({...stopped, stoppedGuests: ['lab/101']});
    const e = new AlertEngine();
    const out = notes(run(e, [
        g(['home', 101, 'web', 'running'], ['lab', 101, 'db', 'running'], ['lab', 102, 'x', 'running']),
        g(['home', 101, 'web', 'stopped'], ['lab', 101, 'db', 'stopped'], ['lab', 102, 'x', 'stopped']),
    ], s));
    assert.equal(out.length, 1);
    assert.match(out[0].title, /db/);
});

test('guest stopped: empty list covers every guest that was running', () => {
    const s = only(stopped);
    const out = notes(run(new AlertEngine(), [
        g(['home', 1, 'a', 'running'], ['lab', 1, 'b', 'running'], ['lab', 2, 'c', 'stopped']),
        g(['home', 1, 'a', 'stopped'], ['lab', 1, 'b', 'stopped'], ['lab', 2, 'c', 'stopped']),
    ], s));
    assert.equal(out.length, 2);
});

test('guest started: transition to running only, off by default', () => {
    const rows = status => g(['home', 7, 'db', status]);
    assert.equal(run(new AlertEngine(), [rows('stopped'), rows('running')]).length, 0);
    const s = only({startedEnabled: true});
    const e = new AlertEngine();
    const out = notes(run(e, [rows('stopped'), rows('running'), rows('running')], s));
    assert.equal(out.length, 1);
    assert.match(out[0].title, /db started/);
    // Going down is silent when the stop alert is off.
    assert.equal(run(e, [rows('stopped')], s, 10, 100).length, 0);
});

test('guests: one that vanishes (server down) comes back without a transition', () => {
    const s = only({...stopped, startedEnabled: true});
    const e = new AlertEngine();
    run(e, [g(['home', 1, 'a', 'running'])], s);
    run(e, [g()], s, 10, 10); // server went away
    assert.equal(run(e, [g(['home', 1, 'a', 'stopped'])], s, 10, 20).length, 0);
    assert.equal(e._guests.size, 1);
});

test('guests: a reconnect to pved starts over', () => {
    const s = only(stopped);
    const e = new AlertEngine();
    e.update(g(['home', 1, 'a', 'running']), 0, s);
    e.update(snap({daemon: 'not-running'}), 10, s);
    assert.equal(e.update(g(['home', 1, 'a', 'stopped']), 20, s).length, 0);
});

test('guests: nameless guest falls back to its vmid', () => {
    const s = only(stopped);
    const out = notes(run(new AlertEngine(), [g(['home', 9, '', 'running']), g(['home', 9, '', 'stopped'])], s));
    assert.equal(out.length, 1);
    assert.match(out[0].title, /9 stopped/);
});

test('settings: partial settings fall back to the defaults', () => {
    const e = new AlertEngine();
    const out = run(e, Array(8).fill(hot(90)), {tempLimit: 80});
    assert.equal(notes(out).length, 1);
});
