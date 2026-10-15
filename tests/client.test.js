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
            ApiVersion: 1,
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
    };
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
