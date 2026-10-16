// SPDX-License-Identifier: GPL-3.0-or-later
// PveClient against the fake session bus in tests/gi-stubs/Gio.mjs.
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';

const {PveClient, BUS_NAME} = await import('../extension/lib/client.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    globalThis.FAKE_BUS = {
        props: {
            Version: '0.1.0',
            ApiVersion: 2,
            ConfigError: '',
            Fake: false,
            Servers: [['home', 'ok', ''], ['lab', 'offline', 'connection refused']],
            Nodes: [['home', 'pve', 'online']],
            Guests: [
                ['home', 100, 'qemu', 'pve', 'web', 'running'],
                ['home', 101, 'lxc', 'pve', 'db', 'stopped'],
            ],
        },
        values: {'home/node/pve/cpu': 23.4, 'home/node/pve/mem': 61, 'home/guest/100/cpu': 5.5},
        proxy: null,
        calls: [],
        holdCalls: false,
        pending: [],
        callError: null,
        failProxies: false,
        unwatched: [],
        history: {},
        callErrors: {},
    };
    globalThis.FAKE_NOW_US = 10_000e6;
});

function start() {
    let changes = 0;
    const client = new PveClient(() => changes++);
    return {client, changes: () => changes};
}

const values = client => Object.fromEntries(client.snapshot().values);

test('watches the session bus name with auto-start', () => {
    start();
    const {watch} = globalThis.FAKE_BUS;
    assert.equal(watch.type, 'session');
    assert.equal(watch.name, BUS_NAME);
    assert.equal(watch.flags, 1);
});

test('starts connecting, with nothing to show', () => {
    const {client} = start();
    const snap = client.snapshot();
    assert.equal(snap.daemon, 'connecting');
    assert.equal(snap.values.size, 0);
    assert.deepEqual(snap.nodes, []);
    assert.deepEqual(snap.guests, []);
});

test('pved not running: name vanished', () => {
    const {client, changes} = start();
    globalThis.FAKE_BUS.vanish();
    assert.equal(client.state, 'not-running');
    assert.equal(changes(), 1);
});

test('pved not running: name appeared but the proxy failed', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.failProxies = true;
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.equal(client.state, 'not-running');
});

test('appearing: properties and GetValues populate the snapshot', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const snap = client.snapshot();
    assert.equal(snap.daemon, 'running');
    assert.equal(snap.configError, '');
    assert.deepEqual(snap.servers[1], {name: 'lab', state: 'offline', message: 'connection refused'});
    assert.equal(snap.fake, false);
    assert.equal(snap.version, '0.1.0');
    assert.deepEqual(snap.nodes, [{server: 'home', name: 'pve', status: 'online'}]);
    assert.deepEqual(snap.guests[1], {server: 'home', vmid: 101, kind: 'lxc', node: 'pve', name: 'db', status: 'stopped'});
    assert.deepEqual(values(client), globalThis.FAKE_BUS.values);
    assert.equal(globalThis.FAKE_BUS.calls.length, 1);
    assert.equal(globalThis.FAKE_BUS.calls[0].method, 'GetValues');
});

test('Updated merges values and NaN deletes them', async () => {
    const {client, changes} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const before = changes();
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': 30.1, 'home/node/pve/temp': 54, 'home/guest/100/cpu': NaN});
    assert.equal(changes(), before + 1);
    assert.deepEqual(values(client), {'home/node/pve/cpu': 30.1, 'home/node/pve/mem': 61, 'home/node/pve/temp': 54});
});

test('other signals are ignored; property changes notify', async () => {
    const {changes} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const before = changes();
    globalThis.FAKE_BUS.proxy.emit('g-signal', ':1.1', 'Other', {deepUnpack: () => [{x: 1}]});
    assert.equal(changes(), before);
    globalThis.FAKE_BUS.proxy.emit('g-properties-changed');
    assert.equal(changes(), before + 1);
});

test('vanishing clears the values and drops the proxy signals', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const proxy = globalThis.FAKE_BUS.proxy;
    globalThis.FAKE_BUS.vanish();
    assert.equal(client.state, 'not-running');
    assert.equal(client.snapshot().values.size, 0);
    assert.equal(proxy.handlers.size, 0);
});

test('a stale GetValues after vanish is ignored', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.holdCalls = true;
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.equal(globalThis.FAKE_BUS.pending.length, 1);
    globalThis.FAKE_BUS.vanish();
    globalThis.FAKE_BUS.pending.shift()();
    await tick();
    assert.equal(client.state, 'not-running');
    assert.equal(client.snapshot().values.size, 0);
});

test('a stale GetValues from the old session does not overwrite the new one', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.holdCalls = true;
    globalThis.FAKE_BUS.appear();
    await tick();
    globalThis.FAKE_BUS.vanish();
    globalThis.FAKE_BUS.values = {'home/node/pve/cpu': 99};
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.equal(globalThis.FAKE_BUS.pending.length, 2);
    globalThis.FAKE_BUS.values = {'home/node/pve/cpu': 1};
    // The old reply arrives after the new session started.
    globalThis.FAKE_BUS.pending.shift()();
    await tick();
    assert.equal(client.snapshot().values.size, 0);
    globalThis.FAKE_BUS.pending.shift()();
    await tick();
    assert.equal(client.state, 'running');
    assert.deepEqual(values(client), {'home/node/pve/cpu': 99});
});

test('an Updated that beats the GetValues reply is not undone by it', async () => {
    // pved can answer GetValues before its first poll (empty) while the
    // Updated carrying everything arrives first.
    const {client} = start();
    globalThis.FAKE_BUS.holdCalls = true;
    globalThis.FAKE_BUS.values = {};
    globalThis.FAKE_BUS.appear();
    await tick();
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': 23.4, 'home/node/pve/disk': 38});
    globalThis.FAKE_BUS.pending.shift()();
    await tick();
    assert.deepEqual(values(client), {'home/node/pve/cpu': 23.4, 'home/node/pve/disk': 38});
});

test('the GetValues reply fills keys no Updated touched, and never revives deleted ones', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.holdCalls = true;
    globalThis.FAKE_BUS.values = {'home/node/pve/cpu': 10, 'home/node/pve/mem': 61, 'home/guest/100/cpu': 5};
    globalThis.FAKE_BUS.appear();
    await tick();
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': 12, 'home/guest/100/cpu': NaN});
    globalThis.FAKE_BUS.pending.shift()();
    await tick();
    assert.deepEqual(values(client), {'home/node/pve/cpu': 12, 'home/node/pve/mem': 61});
});

test('a failing GetValues keeps the daemon running with no values', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.callError = new Error('boom');
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.equal(client.state, 'running');
    assert.equal(client.snapshot().values.size, 0);
});

test('destroy unwatches and silences the callback', async () => {
    const {client, changes} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const proxy = globalThis.FAKE_BUS.proxy;
    const id = globalThis.FAKE_BUS.watch.id;
    const before = changes();
    client.destroy();
    assert.deepEqual(globalThis.FAKE_BUS.unwatched, [id]);
    assert.equal(proxy.handlers.size, 0);
    client.destroy();
    assert.deepEqual(globalThis.FAKE_BUS.unwatched, [id], 'second destroy is a no-op');
    assert.equal(changes(), before);
});

// ---- history ----------------------------------------------------------------

const S = 1e6;
const methods = () => globalThis.FAKE_BUS.calls.map(c => c.method);
/** A series as [seconds before now, value] pairs. */
const series = (client, key) => {
    const s = client.snapshot().history.get(key);
    return s ? s.t.map((t, i) => [(t - globalThis.FAKE_NOW_US) / S, s.v[i]]) : null;
};

test('no history keys: no GetHistory', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.deepEqual(methods(), ['GetValues']);
    assert.equal(client.snapshot().history.size, 0);
});

test('history is loaded once after GetValues, for the wanted keys only', async () => {
    const {client} = start();
    client.setHistoryKeys(['home/node/pve/cpu', 'home/node/pve/mem'], 900);
    globalThis.FAKE_BUS.history = {
        'home/node/pve/cpu': [[20, 10, 0], [10, NaN, 23.4]],
        'home/node/pve/disk': [[0], [38]],
    };
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    assert.deepEqual(methods(), ['GetValues', 'GetHistory']);
    assert.deepEqual(globalThis.FAKE_BUS.calls[1].params, [['home/node/pve/cpu', 'home/node/pve/mem']]);
    const cpu = series(client, 'home/node/pve/cpu');
    assert.deepEqual(cpu.map(([t]) => t), [-20, -10, 0]);
    assert.ok(Number.isNaN(cpu[1][1]), 'a gap stays a gap');
    assert.deepEqual(series(client, 'home/node/pve/mem'), [[0, 61]], 'unknown to pved: seeded from GetValues');
    assert.equal(client.snapshot().history.has('home/node/pve/disk'), false);
});

test('Updated appends to the history of wanted keys, NaN is a gap', async () => {
    const {client} = start();
    client.setHistoryKeys(['home/node/pve/cpu', 'home/node/pve/temp']);
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    globalThis.FAKE_NOW_US += 10 * S;
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': 30, 'home/node/pve/temp': 54, 'home/guest/100/cpu': 1});
    globalThis.FAKE_NOW_US += 10 * S;
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': NaN});
    const cpu = series(client, 'home/node/pve/cpu');
    assert.deepEqual(cpu.slice(0, 2), [[-20, 23.4], [-10, 30]]);
    assert.equal(cpu[2][0], 0);
    assert.ok(Number.isNaN(cpu[2][1]));
    assert.deepEqual(series(client, 'home/node/pve/temp'), [[-10, 54]], 'a new key starts with its first value');
    assert.equal(client.snapshot().history.has('home/guest/100/cpu'), false, 'not wanted: not kept');
});

test('the history is trimmed to the span in use, keeping the point in force', async () => {
    const {client} = start();
    client.setHistoryKeys(['home/node/pve/cpu'], 300);
    globalThis.FAKE_BUS.history = {'home/node/pve/cpu': [[3000, 400, 200, 0], [1, 2, 3, 4]]};
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    assert.deepEqual(series(client, 'home/node/pve/cpu'), [[-400, 2], [-200, 3], [0, 4]]);
    globalThis.FAKE_NOW_US += 250 * S;
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': 5});
    assert.deepEqual(series(client, 'home/node/pve/cpu'), [[-450, 3], [-250, 4], [0, 5]]);
    client.setHistoryKeys(['home/node/pve/cpu'], 100);
    assert.deepEqual(series(client, 'home/node/pve/cpu'), [[-250, 4], [0, 5]], 'a shorter span trims at once');
});

test('a change of keys fetches only the new ones and drops the old', async () => {
    const {client} = start();
    client.setHistoryKeys(['home/node/pve/cpu']);
    globalThis.FAKE_BUS.history = {'home/node/pve/cpu': [[0], [23.4]], 'home/node/pve/mem': [[10, 0], [60, 61]]};
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    client.setHistoryKeys(['home/node/pve/cpu']);
    assert.equal(methods().filter(m => m === 'GetHistory').length, 1, 'same keys: nothing');
    client.setHistoryKeys(['home/node/pve/mem']);
    await tick();
    assert.deepEqual(globalThis.FAKE_BUS.calls.at(-1).params, [['home/node/pve/mem']]);
    assert.equal(client.snapshot().history.has('home/node/pve/cpu'), false);
    assert.deepEqual(series(client, 'home/node/pve/mem'), [[-10, 60], [0, 61]]);
});

test('points that arrive while GetHistory is in flight are kept', async () => {
    const {client} = start();
    client.setHistoryKeys(['home/node/pve/cpu']);
    globalThis.FAKE_BUS.history = {'home/node/pve/mem': [[20, 10], [20, 21]]};
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    globalThis.FAKE_BUS.holdCalls = true;
    client.setHistoryKeys(['home/node/pve/cpu', 'home/node/pve/mem']);
    assert.deepEqual(methods(), ['GetValues', 'GetHistory', 'GetHistory']);
    globalThis.FAKE_NOW_US += 5 * S;
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/mem': 25});
    globalThis.FAKE_BUS.pending.shift()();
    await tick();
    assert.deepEqual(series(client, 'home/node/pve/mem'), [[-20, 20], [-10, 21], [0, 25]],
        'the seed from GetValues is replaced, the Updated in flight kept');
});

test('API 1 pved: no GetHistory or Watch, history grows locally, no errors', async () => {
    globalThis.FAKE_BUS.props.ApiVersion = 1;
    const {client} = start();
    client.setHistoryKeys(['home/node/pve/cpu']);
    client.watch('home', 100);
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    assert.deepEqual(methods(), ['GetValues']);
    globalThis.FAKE_NOW_US += 10 * S;
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': 30});
    assert.deepEqual(series(client, 'home/node/pve/cpu'), [[-10, 23.4], [0, 30]]);
});

test('history: false never fetches or keeps history', async () => {
    const client = new PveClient(() => {}, {history: false});
    client.setHistoryKeys(['home/node/pve/cpu']);
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': 30});
    assert.deepEqual(methods(), ['GetValues']);
    assert.equal(client.snapshot().history.size, 0);
    assert.equal(client.snapshot().values.get('home/node/pve/cpu'), 30);
});

test('a failing GetHistory leaves the seeded history', async () => {
    globalThis.FAKE_BUS.callErrors = {GetHistory: new Error('UnknownMethod')};
    const {client} = start();
    client.setHistoryKeys(['home/node/pve/cpu']);
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    assert.equal(client.state, 'running');
    assert.deepEqual(series(client, 'home/node/pve/cpu'), [[0, 23.4]]);
});

test('vanishing drops the history; reappearing loads it again', async () => {
    const {client} = start();
    client.setHistoryKeys(['home/node/pve/cpu']);
    globalThis.FAKE_BUS.history = {'home/node/pve/cpu': [[0], [23.4]]};
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    globalThis.FAKE_BUS.vanish();
    assert.equal(client.snapshot().history.size, 0);
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    assert.equal(methods().filter(m => m === 'GetHistory').length, 2);
    assert.deepEqual(series(client, 'home/node/pve/cpu'), [[0, 23.4]]);
});

test('onChange gets the Updated dictionary, or null when anything may have changed', async () => {
    const seen = [];
    const client = new PveClient(changed => seen.push(changed));
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.ok(seen.length > 0 && seen.every(c => c === null));
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': 1});
    assert.deepEqual(seen.at(-1), {'home/node/pve/cpu': 1});
    globalThis.FAKE_BUS.proxy.emit('g-properties-changed');
    assert.equal(seen.at(-1), null);
    client.destroy();
});

test('the snapshot is shared until a property or the state changes', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const a = client.snapshot();
    globalThis.FAKE_BUS.proxy.emitUpdated({'home/node/pve/cpu': 1});
    assert.equal(client.snapshot(), a, 'values are live');
    assert.equal(a.values.get('home/node/pve/cpu'), 1);
    globalThis.FAKE_BUS.props.Guests = [];
    globalThis.FAKE_BUS.proxy.emit('g-properties-changed');
    assert.notEqual(client.snapshot(), a);
    assert.deepEqual(client.snapshot().guests, []);
});

// ---- watches ----------------------------------------------------------------

const watchCalls = () => globalThis.FAKE_BUS.calls
    .filter(c => c.method === 'Watch' || c.method === 'Unwatch')
    .map(c => `${c.method} ${c.params.join('/')}`);

test('watch is counted: pved hears the first watch and the last unwatch', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    client.watch('home', 100);
    client.watch('home', 100);
    client.watch('lab', 100);
    client.unwatch('home', 100);
    assert.deepEqual(watchCalls(), ['Watch home/100', 'Watch lab/100']);
    client.unwatch('home', 100);
    client.unwatch('home', 100);
    assert.deepEqual(watchCalls(), ['Watch home/100', 'Watch lab/100', 'Unwatch home/100']);
    assert.deepEqual(client.watched, ['lab/100']);
});

test('watches made before pved appears, or before it restarts, are issued again', async () => {
    const {client} = start();
    client.watch('home', 100);
    assert.deepEqual(watchCalls(), []);
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.deepEqual(watchCalls(), ['Watch home/100']);
    globalThis.FAKE_BUS.vanish();
    client.watch('home', 101);
    globalThis.FAKE_BUS.appear();
    await tick();
    assert.deepEqual(watchCalls(), ['Watch home/100', 'Watch home/100', 'Watch home/101']);
});

test('a refused watch (too many) is only logged', async () => {
    globalThis.FAKE_BUS.callErrors = {Watch: new Error('TooManyWatches')};
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    const warn = console.warn;
    const warned = [];
    console.warn = m => warned.push(m);
    try {
        client.watch('home', 100);
        await tick();
        await tick();
    } finally {
        console.warn = warn;
    }
    assert.equal(client.state, 'running');
    assert.match(warned[0], /TooManyWatches/);
});

test('destroy unwatches every guest it watched', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.appear();
    await tick();
    client.watch('home', 100);
    client.watch('home', 100);
    client.destroy();
    assert.deepEqual(watchCalls(), ['Watch home/100', 'Unwatch home/100']);
});

test('a longer span for held keys fetches again and merges in front of the local series', async () => {
    const {client} = start();
    const cpu = 'home/node/pve/cpu';
    client.setHistoryKeys([cpu], 300);
    globalThis.FAKE_BUS.history = {[cpu]: [[3000, 400, 200, 0], [1, 2, 3, 4]]};
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    assert.deepEqual(series(client, cpu), [[-400, 2], [-200, 3], [0, 4]]);
    client.setHistoryKeys([cpu], 300);
    client.setHistoryKeys([cpu], 100);
    assert.equal(methods().filter(m => m === 'GetHistory').length, 1, 'same or shorter span: nothing');
    globalThis.FAKE_BUS.holdCalls = true;
    globalThis.FAKE_BUS.history = {[cpu]: [[3000, 400, 200, 10], [1, 2, 3, 4]]};
    client.setHistoryKeys([cpu], 3600);
    assert.equal(methods().filter(m => m === 'GetHistory').length, 2, 'longer span: fetched again');
    assert.deepEqual(globalThis.FAKE_BUS.calls.at(-1).params, [[cpu]]);
    globalThis.FAKE_NOW_US += 5 * S;
    globalThis.FAKE_BUS.proxy.emitUpdated({[cpu]: 9});
    globalThis.FAKE_BUS.pending.shift()();
    await tick();
    assert.deepEqual(series(client, cpu), [[-3000, 1], [-400, 2], [-200, 3], [-10, 4], [0, 9]],
        'older points in front, the point appended in flight kept');
    client.setHistoryKeys([cpu], 3600);
    client.setHistoryKeys([cpu], 600);
    assert.equal(methods().filter(m => m === 'GetHistory').length, 2, 'covered span: no refetch');
});

test('API 1 pved: a longer span does not call GetHistory', async () => {
    const {client} = start();
    globalThis.FAKE_BUS.props.ApiVersion = 1;
    client.setHistoryKeys(['home/node/pve/cpu'], 300);
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    client.setHistoryKeys(['home/node/pve/cpu'], 100);
    client.setHistoryKeys(['home/node/pve/cpu'], 3600);
    assert.equal(methods().includes('GetHistory'), false);
});
