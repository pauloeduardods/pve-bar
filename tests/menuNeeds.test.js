// SPDX-License-Identifier: GPL-3.0-or-later
// MenuNeeds driving a real PveClient over the fake session bus
// (tests/gi-stubs): what pved hears when the menu opens a guest's details,
// closes, or the extension is disabled, next to the top bar's own needs.
import {test, beforeEach} from 'node:test';
import assert from 'node:assert/strict';

const {PveClient} = await import('../extension/lib/client.js');
const {MenuNeeds, guestHistoryKeys} = await import('../extension/lib/menuModel.js');

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => {
    globalThis.FAKE_BUS = {
        props: {
            Version: '0.1.0', ApiVersion: 2, ConfigError: '', Fake: false,
            Servers: [['home', 'ok', '']],
            Nodes: [['home', 'pve', 'online']],
            Guests: [['home', 100, 'qemu', 'pve', 'web', 'running'], ['home', 101, 'lxc', 'pve', 'db', 'running']],
        },
        values: {'home/node/pve/cpu': 23.4, 'home/guest/100/cpu': 5.5},
        history: {'home/guest/100/cpu': [[3600, 60, 0], [1, 2, 5.5]]},
        proxy: null, calls: [], holdCalls: false, pending: [], callError: null, callErrors: {},
        failProxies: false, unwatched: [],
    };
    globalThis.FAKE_NOW_US = 10_000e6;
});

async function connected() {
    const client = new PveClient(() => {});
    const needs = new MenuNeeds(client);
    globalThis.FAKE_BUS.appear();
    await tick();
    await tick();
    globalThis.FAKE_BUS.calls.length = 0;
    return {client, needs};
}

/** What pved heard, without GetValues: "Watch home/100", "GetHistory a,b". */
const heard = () => globalThis.FAKE_BUS.calls
    .filter(c => c.method !== 'GetValues')
    .map(c => (c.method === 'GetHistory' ? `GetHistory ${c.params[0].join(',')}` : `${c.method} ${c.params.join('/')}`));

test('opening a guest detail watches it and fetches only its new keys; going back unwatches', async () => {
    const {client, needs} = await connected();
    needs.setPanel(['home/node/pve/cpu'], 900);
    await tick();
    globalThis.FAKE_BUS.calls.length = 0;

    needs.showGuest('home', 100);
    await tick();
    assert.deepEqual(heard(), ['Watch home/100', `GetHistory ${guestHistoryKeys('home', 100).join(',')}`]);
    assert.ok(client.snapshot().history.has('home/guest/100/cpu'), 'backfilled hour loaded');

    globalThis.FAKE_BUS.calls.length = 0;
    needs.hideGuest();
    assert.deepEqual(heard(), ['Unwatch home/100']);
    assert.equal(client.snapshot().history.has('home/guest/100/cpu'), false, 'menu-only key dropped');
    assert.ok(client.snapshot().history.has('home/node/pve/cpu'), 'the bar keeps its key');
});

test('switching guests: the first is unwatched before the second is watched', async () => {
    const {needs} = await connected();
    needs.showGuest('home', 100);
    needs.showGuest('home', 101);
    assert.deepEqual(heard().filter(h => !h.startsWith('GetHistory')),
        ['Watch home/100', 'Unwatch home/100', 'Watch home/101']);
});

test('closing the menu unwatches the guest shown', async () => {
    const {client, needs} = await connected();
    needs.setMenu(['home/node/pve/cpu']);
    needs.showGuest('home', 100);
    globalThis.FAKE_BUS.calls.length = 0;
    needs.menuClosed();
    assert.deepEqual(heard(), ['Unwatch home/100']);
    assert.deepEqual(client.watched, []);
    assert.equal(client.snapshot().history.size, 0, 'no history kept for a closed menu');
});

test('a guest the bar also watches stays watched when the menu closes', async () => {
    const {client, needs} = await connected();
    client.watch('home', 100); // the bar's segment
    needs.showGuest('home', 100);
    needs.menuClosed();
    assert.deepEqual(heard().filter(h => !h.startsWith('GetHistory')), ['Watch home/100']);
    assert.deepEqual(client.watched, ['home/100']);
});

test('destroy (extension disabled) unwatches the guest shown', async () => {
    const {client, needs} = await connected();
    needs.showGuest('home', 100);
    needs.destroy();
    client.destroy();
    assert.deepEqual(heard().filter(h => !h.startsWith('GetHistory')), ['Watch home/100', 'Unwatch home/100']);
});

test('reopening the menu fetches the menu keys again', async () => {
    const {needs} = await connected();
    needs.setMenu(['home/node/pve/cpu']);
    needs.menuClosed();
    needs.setMenu(['home/node/pve/cpu']);
    assert.deepEqual(heard(), ['GetHistory home/node/pve/cpu', 'GetHistory home/node/pve/cpu']);
});
