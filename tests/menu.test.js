// SPDX-License-Identifier: GPL-3.0-or-later
// The menu's pure logic (extension/lib/menuModel.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {defaultLayout, pinGuest, sanitizeLayout, MAX_SEGMENTS} from '../extension/lib/layout.js';
import {
    FS_HINT, GUEST_WINDOW, MENU_NODE_WINDOW, MenuNeeds, formatUptime, guestDetail, guestHistoryKeys, mergeNeeds,
    nodeHistoryKeys, nodeSetKey, pinLabel, pinState, serverSummary, shouldExpand,
} from '../extension/lib/menuModel.js';
import {Level, THRESHOLD_DEFAULTS} from '../extension/lib/model.js';

const GIB = 1024 ** 3;
const T = THRESHOLD_DEFAULTS;

function group(overrides = {}) {
    return {
        name: 'home', state: 'ok', message: '',
        nodes: [{server: 'home', name: 'pve', status: 'online'}],
        guests: [
            {server: 'home', vmid: 100, kind: 'qemu', node: 'pve', name: 'web', status: 'running'},
            {server: 'home', vmid: 101, kind: 'lxc', node: 'pve', name: 'db', status: 'stopped'},
        ],
        ...overrides,
    };
}

const vals = obj => new Map(Object.entries(obj));

// ---- uptime -------------------------------------------------------------------------

test('formatUptime picks the two largest units', () => {
    assert.equal(formatUptime(0), '0s');
    assert.equal(formatUptime(45), '45s');
    assert.equal(formatUptime(754), '12m');
    assert.equal(formatUptime(4 * 3600 + 12 * 60 + 5), '4h 12m');
    assert.equal(formatUptime(3 * 86400 + 4 * 3600 + 59 * 60), '3d 4h');
    assert.equal(formatUptime(null), '--');
    assert.equal(formatUptime(NaN), '--');
    assert.equal(formatUptime(-5), '--');
});

// ---- server summary ---------------------------------------------------------------------

test('a single-node server: CPU, RAM, temperature and running/total guests', () => {
    const values = vals({
        'home/node/pve/cpu': 23.4, 'home/node/pve/mem': 61, 'home/node/pve/temp': 54,
    });
    const s = serverSummary(group(), values, T);
    assert.equal(s.text, 'home · 23% · 61% · 54° · 1/2');
    assert.equal(s.level, Level.NORMAL);
    assert.equal(s.down, false);
});

test('no temperature: left out; no guests: no count', () => {
    const values = vals({'home/node/pve/cpu': 5, 'home/node/pve/mem': 10});
    assert.equal(serverSummary(group({guests: []}), values, T).text, 'home · 5% · 10%');
});

test('the title takes the worst level of any reading', () => {
    const values = vals({'home/node/pve/cpu': 23, 'home/node/pve/mem': 61, 'home/node/pve/temp': 88});
    assert.equal(serverSummary(group(), values, T).level, Level.HOT);
    values.set('home/node/pve/temp', 72);
    assert.equal(serverSummary(group(), values, T).level, Level.WARM);
    values.set('home/node/pve/mem', 99);
    assert.equal(serverSummary(group(), values, T).level, Level.HOT);
});

test('a cluster: mean CPU, RAM from the byte counts, hottest temperature, worst node level', () => {
    const g = group({
        nodes: [
            {server: 'home', name: 'a', status: 'online'},
            {server: 'home', name: 'b', status: 'online'},
            {server: 'home', name: 'c', status: 'offline'},
        ],
        guests: [],
    });
    const values = vals({
        'home/node/a/cpu': 10, 'home/node/a/mem': 50, 'home/node/a/mem_used': 8 * GIB, 'home/node/a/mem_total': 16 * GIB,
        'home/node/b/cpu': 95, 'home/node/b/mem': 25, 'home/node/b/mem_used': 16 * GIB, 'home/node/b/mem_total': 64 * GIB,
        'home/node/a/temp': 50, 'home/node/b/temp': 61,
    });
    const s = serverSummary(g, values, T);
    // CPU (10+95)/2 = 52.5, RAM 24/80 GiB = 30 %, hottest 61°; node b's CPU is hot.
    assert.equal(s.text, 'home · 53% · 30% · 61°');
    assert.equal(s.level, Level.HOT);
});

test('a cluster without byte counts averages the RAM percentages', () => {
    const g = group({
        nodes: [{server: 'home', name: 'a', status: 'online'}, {server: 'home', name: 'b', status: 'online'}],
        guests: [],
    });
    const values = vals({'home/node/a/cpu': 1, 'home/node/b/cpu': 3, 'home/node/a/mem': 20, 'home/node/b/mem': 40});
    assert.equal(serverSummary(g, values, T).text, 'home · 2% · 30%');
});

test('every node offline', () => {
    const g = group({nodes: [{server: 'home', name: 'pve', status: 'offline'}], guests: []});
    const s = serverSummary(g, vals({}), T);
    assert.equal(s.text, 'home · nodes offline');
    assert.equal(s.level, Level.UNKNOWN);
});

test('a down server shows its state, hot; connecting has no level', () => {
    const down = serverSummary(group({state: 'offline', message: 'connection refused', nodes: [], guests: []}),
        vals({}), T);
    assert.deepEqual(down, {text: 'home · offline', level: Level.HOT, down: true});
    assert.equal(serverSummary(group({state: 'unauthorized'}), vals({}), T).text, 'home · auth failed');
    const connecting = serverSummary(group({state: 'connecting'}), vals({}), T);
    assert.equal(connecting.text, 'home · connecting');
    assert.equal(connecting.level, Level.UNKNOWN);
});

test('missing values show --', () => {
    assert.equal(serverSummary(group(), vals({}), T).text, 'home · -- · -- · 1/2');
});

test('nodeSetKey changes only with the node names', () => {
    const a = nodeSetKey([{name: 'a', status: 'online'}, {name: 'b', status: 'online'}]);
    assert.equal(a, nodeSetKey([{name: 'a', status: 'offline'}, {name: 'b', status: 'online'}]));
    assert.notEqual(a, nodeSetKey([{name: 'a'}]));
});

// ---- guest detail -----------------------------------------------------------------------

const web = {server: 'home', vmid: 100, kind: 'qemu', node: 'pve', name: 'web', status: 'running'};

test('a watched guest: rates, uptime, vCPUs, RAM in GiB, disk inside', () => {
    const values = vals({
        'home/guest/100/cpu': 5.54, 'home/guest/100/mem': 50,
        'home/guest/100/maxcpu': 4, 'home/guest/100/maxmem': 4 * GIB,
        'home/guest/100/uptime': 2 * 86400 + 3 * 3600,
        'home/guest/100/netin': 1536, 'home/guest/100/netout': 512,
        'home/guest/100/fs': 91,
    });
    const d = guestDetail(web, values, T);
    assert.equal(d.title, '100 web');
    assert.equal(d.badge, 'VM');
    assert.equal(d.dotClass, 'running');
    assert.equal(d.status, 'running · on pve');
    assert.equal(d.uptime, '2d 3h');
    assert.equal(d.cpu.text, '5.5% · 4 vCPU');
    assert.equal(d.cpu.level, Level.NORMAL);
    assert.equal(d.mem.text, '50% · 2.0/4.0 GiB');
    assert.equal(d.netin, '1.5 KB/s');
    assert.equal(d.netout, '512 B/s');
    assert.deepEqual(d.fs, {visible: true, text: '91%', level: Level.HOT, hint: ''});
});

test('details not fetched yet: -- everywhere and no hint', () => {
    const d = guestDetail(web, vals({'home/guest/100/cpu': 1, 'home/guest/100/mem': 30}), T);
    assert.equal(d.uptime, '--');
    assert.equal(d.cpu.text, '1.0%');
    assert.equal(d.mem.text, '30%');
    assert.equal(d.netin, '--');
    assert.equal(d.netout, '--');
    assert.equal(d.fs.text, '--');
    assert.equal(d.fs.hint, '');
});

test('a running VM without fs: the guest agent / VM.Monitor hint', () => {
    const d = guestDetail(web, vals({'home/guest/100/uptime': 60, 'home/guest/100/maxmem': GIB}), T);
    assert.equal(d.fs.visible, true);
    assert.equal(d.fs.text, '--');
    assert.equal(d.fs.hint, FS_HINT);
    assert.match(FS_HINT, /QEMU guest agent/);
    assert.match(FS_HINT, /VM\.Monitor/);
});

test('a stopped VM: no uptime and no hint', () => {
    const d = guestDetail({...web, status: 'stopped'}, vals({'home/guest/100/maxmem': GIB}), T);
    assert.equal(d.uptime, '--');
    assert.equal(d.fs.hint, '');
    assert.equal(d.dotClass, 'stopped');
});

test('a container has no disk-inside row', () => {
    const ct = {...web, vmid: 101, kind: 'lxc'};
    const d = guestDetail(ct, vals({'home/guest/101/uptime': 60}), T);
    assert.equal(d.badge, 'CT');
    assert.equal(d.fs.visible, false);
    assert.equal(d.fs.hint, '');
});

// ---- pin ------------------------------------------------------------------------------------

test('pinState: available, pinned after pinGuest, full at the limit', () => {
    let layout = defaultLayout();
    assert.equal(pinState(layout, 'home', 100), 'available');
    layout = pinGuest(layout, 'home', 100);
    assert.equal(pinState(layout, 'home', 100), 'pinned');
    assert.equal(pinState(layout, 'lab', 100), 'available');
    assert.equal(pinState(layout, 'home', 101), 'available');
    const full = sanitizeLayout({segments: Array.from({length: MAX_SEGMENTS},
        () => ({target: {server: '', node: ''}, items: ['cpu']}))});
    assert.equal(pinState(full, 'home', 100), 'full');
});

test('pinState: a guest segment on the selected server counts as pinned', () => {
    const layout = sanitizeLayout({segments: [{target: {server: '', guest: 100}, items: ['cpu']}]});
    assert.equal(pinState(layout, 'home', 100, 'home'), 'pinned');
    assert.equal(pinState(layout, 'home', 100, 'lab'), 'available');
});

test('pinLabel', () => {
    assert.equal(pinLabel('available'), 'Pin to bar');
    assert.equal(pinLabel('pinned'), 'Pinned to the bar');
    assert.match(pinLabel('full'), /full/);
});

// ---- history keys -----------------------------------------------------------------------------

test('history keys of a guest detail and of a server section', () => {
    assert.deepEqual(guestHistoryKeys('home', 100),
        ['home/guest/100/cpu', 'home/guest/100/mem', 'home/guest/100/netin', 'home/guest/100/netout']);
    assert.deepEqual(nodeHistoryKeys(group()), ['home/node/pve/cpu', 'home/node/pve/mem', 'home/node/pve/temp']);
    const cluster = group({nodes: [{name: 'a'}, {name: 'b'}]});
    assert.deepEqual(nodeHistoryKeys(cluster), ['home/node/a/cpu', 'home/node/b/cpu']);
});

test('mergeNeeds: union in first-seen order, longest span', () => {
    assert.deepEqual(mergeNeeds({keys: ['a', 'b'], span: 900}, {keys: ['b', 'c'], span: 300}, null),
        {keys: ['a', 'b', 'c'], span: 900});
    assert.deepEqual(mergeNeeds(), {keys: [], span: 0});
});

/** A client that records what MenuNeeds asks of it. */
function recorder() {
    const calls = [];
    return {
        calls,
        setHistoryKeys: (keys, span) => calls.push(['keys', [...keys], span]),
        watch: (server, vmid) => calls.push(['watch', server, vmid]),
        unwatch: (server, vmid) => calls.push(['unwatch', server, vmid]),
    };
}

test('MenuNeeds: the bar alone, then the open menu adds its keys, closing drops them', () => {
    const client = recorder();
    const needs = new MenuNeeds(client);
    needs.setPanel(['home/node/pve/cpu'], 900);
    needs.setMenu(['home/node/pve/cpu', 'home/node/pve/mem'], MENU_NODE_WINDOW);
    needs.menuClosed();
    assert.deepEqual(client.calls, [
        ['keys', ['home/node/pve/cpu'], 900],
        ['keys', ['home/node/pve/cpu', 'home/node/pve/mem'], 900],
        ['keys', ['home/node/pve/cpu'], 900],
    ]);
});

test('MenuNeeds: no graphs in the bar means span 1, as before', () => {
    const client = recorder();
    new MenuNeeds(client).setPanel([], 0);
    assert.deepEqual(client.calls, [['keys', [], 1]]);
});

test('MenuNeeds: the same needs again reach the client once', () => {
    const client = recorder();
    const needs = new MenuNeeds(client);
    needs.setPanel(['k'], 900);
    needs.setPanel(['k'], 900);
    needs.setMenu([]);
    needs.hideGuest();
    assert.equal(client.calls.length, 1);
});

test('MenuNeeds: a guest detail watches the guest and draws its hour', () => {
    const client = recorder();
    const needs = new MenuNeeds(client);
    needs.setPanel(['home/node/pve/cpu'], 900);
    client.calls.length = 0;
    needs.showGuest('home', 100);
    assert.deepEqual(needs.detail, {server: 'home', vmid: 100});
    needs.showGuest('home', 100); // already shown: nothing
    needs.showGuest('home', 101); // another guest: the first is unwatched
    needs.hideGuest();
    needs.hideGuest();
    assert.equal(needs.detail, null);
    assert.deepEqual(client.calls, [
        ['watch', 'home', 100],
        ['keys', ['home/node/pve/cpu', ...guestHistoryKeys('home', 100)], GUEST_WINDOW],
        ['unwatch', 'home', 100],
        ['watch', 'home', 101],
        ['keys', ['home/node/pve/cpu', ...guestHistoryKeys('home', 101)], GUEST_WINDOW],
        ['unwatch', 'home', 101],
        ['keys', ['home/node/pve/cpu'], 900],
    ]);
});

test('MenuNeeds: closing the menu unwatches the guest shown', () => {
    const client = recorder();
    const needs = new MenuNeeds(client);
    needs.setMenu(['home/node/pve/cpu']);
    needs.showGuest('home', 100);
    client.calls.length = 0;
    needs.menuClosed();
    assert.deepEqual(client.calls, [['unwatch', 'home', 100], ['keys', [], 1]]);
});

test('MenuNeeds: destroy unwatches and then stays silent', () => {
    const client = recorder();
    const needs = new MenuNeeds(client);
    needs.showGuest('home', 100);
    client.calls.length = 0;
    needs.destroy();
    needs.menuClosed();
    needs.setPanel(['x'], 900);
    needs.showGuest('home', 102);
    assert.deepEqual(client.calls, [['unwatch', 'home', 100]]);
});

test('MenuNeeds: a guest the bar already draws keeps its key once', () => {
    const client = recorder();
    const needs = new MenuNeeds(client);
    needs.setPanel(['home/guest/100/cpu'], 300);
    needs.showGuest('home', 100);
    assert.deepEqual(needs.needs(), {keys: guestHistoryKeys('home', 100), span: GUEST_WINDOW});
});

// ---- initial expansion --------------------------------------------------------------
test('shouldExpand: a lone server starts expanded', () => {
    assert.equal(shouldExpand('home', 1, new Set(), new Set()), true);
});

test('shouldExpand: a lone server the user collapsed stays collapsed', () => {
    assert.equal(shouldExpand('home', 1, new Set(), new Set(['home'])), false);
});

test('shouldExpand: several servers start collapsed unless remembered', () => {
    assert.equal(shouldExpand('home', 2, new Set(), new Set()), false);
    assert.equal(shouldExpand('home', 2, new Set(['home']), new Set()), true);
});
