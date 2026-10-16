// SPDX-License-Identifier: GPL-3.0-or-later
// The pure helpers behind the Settings pages (lib/prefs/choices.js).
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    guestFilterChoices, guestLabel, hasLists, listsKey, nodePickerChoices, readsValue, retarget,
    serverPickerChoices, targetFromChoice, targetOptions,
    thresholdPair, toggleGuestFilter, typedTarget,
} from '../extension/lib/prefs/choices.js';
import {defaultLayout, sampleSnapshot, sanitizeLayout, setSegment} from '../extension/lib/layout.js';

const snap = sampleSnapshot();

// ---- labels and lists -----------------------------------------------------------

test('guestLabel names the VMID, the name and VM or CT', () => {
    assert.equal(guestLabel({vmid: 101, name: 'web', kind: 'qemu'}), '101 · web (VM)');
    assert.equal(guestLabel({vmid: 200, name: 'dns', kind: 'lxc'}), '200 · dns (CT)');
    assert.equal(guestLabel({vmid: 7, name: '', kind: 'qemu'}), '7 · (no name) (VM)');
});

test('listsKey changes with the lists, not with values or statuses', () => {
    const a = listsKey(snap);
    const values = {...snap, values: new Map([['home/node/pve/cpu', 99]])};
    assert.equal(listsKey(values), a);
    const status = {...snap, guests: snap.guests.map(g => ({...g, status: 'stopped'}))};
    assert.equal(listsKey(status), a);
    const renamed = {...snap, guests: snap.guests.map(g => (g.vmid === 100 ? {...g, name: 'www'} : g))};
    assert.notEqual(listsKey(renamed), a);
    assert.notEqual(listsKey({...snap, daemon: 'not-running'}), a);
    assert.notEqual(listsKey({...snap, nodes: snap.nodes.slice(1)}), a);
    assert.equal(listsKey(null), '');
});

test('hasLists needs a running pved with servers', () => {
    assert.equal(hasLists(snap), true);
    assert.equal(hasLists({...snap, daemon: 'not-running'}), false);
    assert.equal(hasLists({...snap, servers: []}), false);
    assert.equal(hasLists(null), false);
});

// ---- target picker ------------------------------------------------------------

test('readsValue and targetFromChoice round-trip every kind of target', () => {
    for (const target of [{server: '', node: ''}, {server: 'home', node: 'pve'}, {server: 'lab', guest: 200},
        {server: 'lab'}, {server: '', guest: 101}]) {
        assert.deepEqual(targetFromChoice(target.server, readsValue(target)), target);
    }
    assert.equal(readsValue({server: 'lab'}), 'server');
    assert.equal(readsValue({server: '', node: ''}), 'node:');
    assert.deepEqual(targetFromChoice('home', 'garbage'), {server: 'home', node: ''});
    assert.deepEqual(targetFromChoice('BAD NAME', 'guest:x'), {server: '', node: ''});
});

test('targetOptions lists servers, then the nodes, whole server and guests of the target server', () => {
    const o = targetOptions(snap, {server: 'lab', node: 'lab2'});
    assert.deepEqual(o.servers.map(([v]) => v), ['', 'home', 'lab']);
    assert.match(o.servers[0][1], /Selected server \(now home\)/);
    assert.equal(o.server, 2);
    assert.deepEqual(o.reads.map(([v]) => v), ['node:', 'node:lab1', 'node:lab2', 'server', 'guest:200']);
    assert.equal(o.reads[o.read][0], 'node:lab2');
    assert.equal(o.reads[4][1], '200 · dns (CT)');
    assert.match(o.reads[0][1], /now lab1/);
});

test('targetOptions for the selected server follows the server and node settings', () => {
    const o = targetOptions(snap, {server: '', node: ''}, {server: 'lab', node: 'lab2'});
    assert.match(o.servers[0][1], /now lab/);
    assert.deepEqual(o.reads.map(([v]) => v), ['node:', 'node:lab1', 'node:lab2', 'server', 'guest:200']);
    assert.match(o.reads[0][1], /now lab2/);
    assert.equal(o.server, 0);
    assert.equal(o.read, 0);
    const home = targetOptions(snap, {server: '', guest: 101});
    assert.equal(home.reads[home.read][1], '101 · db (CT)');
});

test('targetOptions keeps targets pved does not list, marked not found', () => {
    const gone = targetOptions(snap, {server: 'old', guest: 999});
    assert.deepEqual(gone.servers[gone.server], ['old', 'old (not found)']);
    assert.deepEqual(gone.reads[gone.read], ['guest:999', 'Guest 999 (not found)']);
    const node = targetOptions(snap, {server: 'home', node: 'gone'});
    assert.deepEqual(node.reads[node.read], ['node:gone', 'Node gone (not found)']);
    const down = targetOptions({...snap, servers: [{name: 'home', state: 'offline', message: ''}]}, {server: 'home'});
    assert.equal(down.servers[1][1], 'home (offline)');
    const empty = targetOptions(null, {server: '', node: ''});
    assert.deepEqual(empty.servers, [['', 'Selected server']]);
    assert.deepEqual(empty.reads.map(([v]) => v), ['node:', 'server']);
});

test('typedTarget validates the free-text fallback', () => {
    assert.deepEqual(typedTarget('node', '', ''), {server: '', node: ''});
    assert.deepEqual(typedTarget('node', ' home ', 'pve'), {server: 'home', node: 'pve'});
    assert.deepEqual(typedTarget('guest', 'lab', '200'), {server: 'lab', guest: 200});
    assert.deepEqual(typedTarget('server', 'lab', 'ignored'), {server: 'lab'});
    assert.equal(typedTarget('guest', 'lab', 'web'), null);
    assert.equal(typedTarget('guest', 'lab', '0'), null);
    assert.equal(typedTarget('guest', 'lab', ''), null);
    assert.equal(typedTarget('node', 'Bad Server', ''), null);
    assert.equal(typedTarget('node', '', 'no spaces'), null);
});

test('retarget keeps shared readings, fills in one and drops what the new kind lacks', () => {
    let layout = setSegment(defaultLayout(), 2, {graph: {reading: 'temp'}});
    // temp to a guest: nothing shared, so its first reading; the temp graph goes.
    layout = retarget(layout, 2, {server: 'home', guest: 100});
    assert.deepEqual(layout.segments[2], {
        target: {server: 'home', guest: 100}, items: ['cpu'], template: '', icon: 'auto', graph: null,
    });
    // cpu with a graph to a server: kept, graph kept.
    layout = setSegment(layout, 0, {graph: {reading: 'cpu'}});
    layout = retarget(layout, 0, {server: 'lab'});
    assert.deepEqual(layout.segments[0].items, ['cpu']);
    assert.equal(layout.segments[0].graph.reading, 'cpu');
    // A template the new kind cannot read is dropped; one it can is kept.
    const t = sanitizeLayout({segments: [{target: {server: '', node: ''}, template: '{cpu}% {temp}°'},
        {target: {server: '', node: ''}, template: 'C {cpu}%'}]});
    const a = retarget(t, 0, {server: 'home', guest: 101});
    assert.equal(a.segments[0].template, '');
    assert.deepEqual(a.segments[0].items, ['cpu']);
    const b = retarget(t, 1, {server: 'home', guest: 101});
    assert.equal(b.segments[1].template, 'C {cpu}%');
    // Out of range: unchanged.
    assert.deepEqual(retarget(t, 9, {server: 'lab'}), t);
});

// ---- alerts guest list ----------------------------------------------------------

test('guestFilterChoices checks the stored guests and keeps unknown ones', () => {
    const choices = guestFilterChoices(snap.guests, ['lab/200', 'old/7']);
    assert.deepEqual(choices.map(c => [c.id, c.checked, c.known]), [
        ['home/100', false, true], ['home/101', false, true], ['home/102', false, true],
        ['lab/200', true, true], ['old/7', true, false],
    ]);
    assert.equal(choices[0].label, 'home/100 · web');
    assert.equal(choices[4].label, 'old/7 (not found)');
    assert.deepEqual(guestFilterChoices([], ['a/1', 'a/1']).map(c => c.id), ['a/1']);
});

test('toggleGuestFilter adds at the end and removes in place', () => {
    assert.deepEqual(toggleGuestFilter(['a/1', 'b/2'], 'c/3', true), ['a/1', 'b/2', 'c/3']);
    assert.deepEqual(toggleGuestFilter(['a/1', 'b/2'], 'a/1', false), ['b/2']);
    assert.deepEqual(toggleGuestFilter(['a/1'], 'a/1', true), ['a/1']);
});

// ---- thresholds -----------------------------------------------------------------

test('thresholdPair keeps warm below hot by moving the other one', () => {
    assert.deepEqual(thresholdPair('warm', 70, 90, 1, 110), {warm: 70, hot: 90});
    assert.deepEqual(thresholdPair('warm', 95, 90, 1, 110), {warm: 95, hot: 96});
    assert.deepEqual(thresholdPair('hot', 70, 60, 1, 110), {warm: 59, hot: 60});
    assert.deepEqual(thresholdPair('warm', 110, 90, 1, 110), {warm: 109, hot: 110});
    assert.deepEqual(thresholdPair('hot', 70, 1, 1, 110), {warm: 1, hot: 2});
    assert.deepEqual(thresholdPair('warm', 40, 30, 30, 110), {warm: 40, hot: 41});
});

// ---- general page pickers -------------------------------------------------------

test('serverPickerChoices: automatic first, pved servers, stored unknown kept', () => {
    const {choices, index} = serverPickerChoices(snap, '');
    assert.deepEqual(choices[0], ['', 'Automatic (first server)']);
    assert.deepEqual(choices.slice(1).map(([v]) => v), snap.servers.map(s => s.name));
    assert.equal(index, 0);
    const named = serverPickerChoices(snap, snap.servers[0].name);
    assert.equal(named.index, 1);
    const gone = serverPickerChoices(snap, 'old');
    assert.deepEqual(gone.choices.at(-1), ['old', 'old (not found)']);
    assert.equal(gone.index, gone.choices.length - 1);
});

test('serverPickerChoices: without pved only automatic and the stored value', () => {
    assert.deepEqual(serverPickerChoices(null, '').choices, [['', 'Automatic (first server)']]);
    assert.deepEqual(serverPickerChoices(null, 'home').choices.map(([v]) => v), ['', 'home']);
});

test('nodePickerChoices: the nodes of the chosen (or first) server, stored unknown kept', () => {
    const first = snap.servers[0].name;
    const nodes = snap.nodes.filter(n => n.server === first).map(n => n.name);
    const auto = nodePickerChoices(snap, '', '');
    assert.deepEqual(auto.choices[0], ['', 'Automatic (first online node)']);
    assert.deepEqual(auto.choices.slice(1).map(([v]) => v), nodes);
    assert.equal(auto.index, 0);
    assert.deepEqual(nodePickerChoices(snap, first, '').choices, auto.choices);
    const picked = nodePickerChoices(snap, first, nodes[0]);
    assert.equal(picked.index, 1);
    const gone = nodePickerChoices(snap, first, 'ghost');
    assert.deepEqual(gone.choices.at(-1), ['ghost', 'ghost (not found)']);
    assert.equal(gone.index, gone.choices.length - 1);
});

test('nodePickerChoices: a server pved does not list has no nodes to pick', () => {
    const {choices} = nodePickerChoices(snap, 'old', 'pve');
    assert.deepEqual(choices.map(([v]) => v), ['', 'pve']);
    assert.deepEqual(nodePickerChoices(null, '', '').choices, [['', 'Automatic (first online node)']]);
});
