// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';

import {
    GRAPH_WIDTHS, Level, barPieces, barSlots, formatGiB, formatMemory, formatPercent, formatRate, formatTemp,
    guestRows, guestSetKey, guestSummary, groupByServer, level, nodeSummary, nodeValue, parseColor, pickNode,
    pickServer, sampleSeries, sanitizeThresholds, sectionKey, serverIdsKey, sparklinePieces, stateBadge,
    statusInfo, worstLevel,
} from '../extension/lib/model.js';

test('levels respect thresholds, even inverted ones', () => {
    assert.equal(level(60, 70, 90), Level.NORMAL);
    assert.equal(level(70, 70, 90), Level.WARM);
    assert.equal(level(95, 70, 90), Level.HOT);
    assert.equal(level(null, 70, 90), Level.UNKNOWN);
    assert.equal(level(NaN, 70, 90), Level.UNKNOWN);
    assert.deepEqual(sanitizeThresholds(95, 90), {warm: 89, hot: 90});
    assert.deepEqual(sanitizeThresholds(undefined, undefined), {warm: 75, hot: 90});
    assert.equal(level(89.5, 95, 90), Level.WARM);
});

test('formatting', () => {
    assert.equal(formatPercent(23.4), '23%');
    assert.equal(formatPercent(23.44, 1), '23.4%');
    assert.equal(formatPercent(null), '--');
    assert.equal(formatGiB(64 * 1024 ** 3), '64.0');
    assert.equal(formatMemory(39.2 * 1024 ** 3, 64 * 1024 ** 3), '39.2/64.0 GiB');
    assert.equal(formatMemory(null, 1), '--');
    assert.equal(formatTemp(54.4), '54°');
    assert.equal(formatTemp(null), '--');
});

test('pickNode: wanted, else first online, else first', () => {
    const nodes = [{name: 'a', status: 'offline'}, {name: 'b', status: 'online'}, {name: 'c', status: 'online'}];
    assert.equal(pickNode(nodes, 'c').name, 'c');
    assert.equal(pickNode(nodes, 'a').name, 'a');
    assert.equal(pickNode(nodes, 'zzz').name, 'b');
    assert.equal(pickNode(nodes, '').name, 'b');
    assert.equal(pickNode([{name: 'a', status: 'offline'}], '').name, 'a');
    assert.equal(pickNode([], ''), null);
});

test('nodeValue prefixes the server; NaN and missing give null', () => {
    const map = new Map([['home/node/pve/cpu', 12], ['home/node/pve/temp', NaN], ['lab/node/pve/cpu', 7]]);
    assert.equal(nodeValue(map, 'home', 'pve', 'cpu'), 12);
    assert.equal(nodeValue(map, 'lab', 'pve', 'cpu'), 7, 'same node name on another server');
    assert.equal(nodeValue(map, 'home', 'pve', 'temp'), null);
    assert.equal(nodeValue(map, 'home', 'pve', 'mem'), null);
    assert.equal(nodeValue({'home/node/pve/cpu': 3}, 'home', 'pve', 'cpu'), 3);
    assert.equal(nodeValue(map, 'home', null, 'cpu'), null);
    assert.equal(nodeValue(map, null, 'pve', 'cpu'), null);
});

test('pickServer: wanted, else the first', () => {
    const servers = [{name: 'home', state: 'offline'}, {name: 'lab', state: 'ok'}];
    assert.equal(pickServer(servers, 'lab').name, 'lab');
    assert.equal(pickServer(servers, '').name, 'home');
    assert.equal(pickServer(servers, 'gone').name, 'home');
    assert.equal(pickServer([], ''), null);
});

const SERVERS = [
    {name: 'home', state: 'ok', message: ''},
    {name: 'lab', state: 'offline', message: 'connection refused'},
    {name: 'edge', state: 'ok', message: ''},
];
const NODES = [
    {server: 'home', name: 'pve', status: 'online'},
    {server: 'edge', name: 'a', status: 'online'},
    {server: 'edge', name: 'b', status: 'offline'},
];

test('groupByServer keeps config order; a down server leaves the others intact', () => {
    const guests = [
        {server: 'home', vmid: 100, kind: 'qemu', node: 'pve', name: 'web', status: 'running'},
        {server: 'edge', vmid: 100, kind: 'lxc', node: 'a', name: 'dns', status: 'running'},
    ];
    const groups = groupByServer(SERVERS, NODES, guests);
    assert.deepEqual(groups.map(g => g.name), ['home', 'lab', 'edge']);
    assert.equal(groups[1].nodes.length, 0);
    assert.equal(groups[1].guests.length, 0);
    assert.equal(groups[1].state, 'offline');
    assert.equal(groups[0].guests[0].name, 'web');
    assert.equal(groups[2].guests[0].name, 'dns', 'same vmid on two servers');
    assert.equal(groups[2].nodes.length, 2);
});

test('server and section keys', () => {
    assert.equal(serverIdsKey(SERVERS), 'home\nlab\nedge');
    assert.equal(serverIdsKey(SERVERS.map(s => ({...s, state: 'offline'}))), serverIdsKey(SERVERS));
    const g = groupByServer(SERVERS, NODES, [])[2];
    const same = {...g, nodes: g.nodes.map(n => ({...n, status: 'online'}))};
    assert.equal(sectionKey(same), sectionKey(g), 'node status changes update in place');
    assert.notEqual(sectionKey({...g, nodes: g.nodes.slice(1)}), sectionKey(g));
});

test('nodeSummary and worstLevel', () => {
    const values = new Map([
        ['edge/node/a/cpu', 23.4], ['edge/node/a/mem', 61], ['edge/node/a/temp', 54.2], ['edge/node/b/cpu', 5],
    ]);
    assert.equal(nodeSummary(values, 'edge', 'a'), '23% · 61% · 54°');
    assert.equal(nodeSummary(values, 'edge', 'b'), '5% · --');
    assert.equal(worstLevel([Level.NORMAL, Level.HOT, Level.WARM]), Level.HOT);
    assert.equal(worstLevel([]), Level.UNKNOWN);
});

test('state badges', () => {
    assert.equal(stateBadge('ok'), '');
    assert.equal(stateBadge('offline'), 'offline');
    assert.equal(stateBadge('unauthorized'), 'auth failed');
    assert.equal(stateBadge('tls-error'), 'TLS');
    assert.equal(stateBadge('no-token'), 'no token');
    assert.equal(stateBadge('connecting'), 'connecting');
});

test('status messages', () => {
    const ok = {name: 'home', state: 'ok', message: ''};
    assert.deepEqual(statusInfo('not-running', '', null), {
        panel: 'pve off', menu: 'pved is not running', hint: 'Find out why with: pvectl doctor',
    });
    assert.equal(statusInfo('connecting', '', null).panel, '--');
    assert.equal(statusInfo('running', '', ok), null);
    const conf = statusInfo('running', 'line 3: bad key', null);
    assert.equal(conf.panel, 'pve conf');
    assert.equal(conf.hint, 'line 3: bad key');
    const setup = statusInfo('running', '', null);
    assert.equal(setup.panel, 'pve setup');
    assert.equal(setup.hint, 'Run: pvectl setup NAME');
    const off = statusInfo('running', '', {name: 'lab', state: 'offline', message: 'connection refused'});
    assert.equal(off.panel, 'pve off');
    assert.equal(off.hint, 'connection refused');
    assert.equal(statusInfo('running', '', {name: 'lab', state: 'unauthorized', message: ''}).panel, 'pve auth');
    assert.equal(statusInfo('running', '', {name: 'lab', state: 'tls-error', message: ''}).panel, 'pve tls');
    assert.equal(statusInfo('running', '', {name: 'lab', state: 'no-token', message: ''}).panel, 'pve key');
    assert.equal(statusInfo('running', '', {name: 'lab', state: 'connecting', message: ''}).panel, '--');
});

const GUESTS = [
    {server: 'home', vmid: 100, kind: 'qemu', node: 'pve', name: 'web', status: 'running'},
    {server: 'home', vmid: 101, kind: 'lxc', node: 'pve', name: 'db', status: 'stopped'},
    {server: 'home', vmid: 102, kind: 'qemu', node: 'pve', name: 'old', status: 'paused'},
];

test('guestSetKey ignores status changes but not renames or new guests', () => {
    const key = guestSetKey(GUESTS);
    const stopped = GUESTS.map(g => ({...g, status: 'stopped'}));
    assert.equal(guestSetKey(stopped), key);
    assert.notEqual(guestSetKey(GUESTS.map(g => ({...g, name: `${g.name}2`}))), key);
    assert.notEqual(guestSetKey(GUESTS.slice(1)), key);
    assert.notEqual(guestSetKey(GUESTS.map(g => ({...g, kind: 'lxc'}))), key);
    assert.equal(guestSetKey([]), '');
});

test('guestRows and summary', () => {
    const values = new Map([['home/guest/100/cpu', 87.1], ['home/guest/100/mem', 45.2], ['home/guest/101/cpu', 0], ['lab/guest/100/cpu', 1]]);
    const [web, db, old] = guestRows(GUESTS, values);
    assert.equal(web.title, '100 web');
    assert.equal(web.badge, 'VM');
    assert.equal(web.dot, '●');
    assert.equal(web.usage, '87% · 45%');
    assert.equal(db.badge, 'CT');
    assert.equal(db.dot, '○');
    assert.equal(db.usage, '');
    assert.equal(old.dot, '◐');
    assert.equal(old.usage, '');
    assert.equal(guestSummary(GUESTS), '1 running / 3');
    assert.equal(guestRows([{...GUESTS[0]}], new Map())[0].usage, '-- · --');
});

// ---- rates and colors ----------------------------------------------------------

test('rates scale from B/s to GB/s', () => {
    assert.equal(formatRate(512), '512 B/s');
    assert.equal(formatRate(999), '999 B/s');
    assert.equal(formatRate(1000), '1.0 KB/s');
    assert.equal(formatRate(1536), '1.5 KB/s');
    assert.equal(formatRate(1536, 2), '1.50 KB/s');
    assert.equal(formatRate(12.3 * 1024 ** 2), '12 MB/s');
    assert.equal(formatRate(5 * 1024 ** 3), '5.0 GB/s');
    assert.equal(formatRate(-3), '0 B/s');
    assert.equal(formatRate(null), '--');
    assert.equal(formatRate(NaN), '--');
});

test('colors parse for Cairo; anything else is the theme color', () => {
    assert.deepEqual(parseColor('#fff'), [1, 1, 1]);
    assert.deepEqual(parseColor('#FF0000'), [1, 0, 0]);
    assert.deepEqual(parseColor(' rgb(255, 0, 0) '), [1, 0, 0]);
    assert.deepEqual(parseColor('rgba(0,0,255,0.5)'), [0, 0, 1]);
    assert.equal(parseColor(''), null);
    assert.equal(parseColor('tomato'), null);
    assert.equal(parseColor(null), null);
    assert.deepEqual(GRAPH_WIDTHS, {narrow: 30, medium: 45, wide: 70});
});

// ---- history sampling and graphs ----------------------------------------------

const S = 1e6;
const steps = (pairs) => ({t: pairs.map(([t]) => t * S), v: pairs.map(([, v]) => v)});

test('sampleSeries: step values per column, gaps and the time before the first point are null', () => {
    const now = 100 * S;
    assert.deepEqual(sampleSeries(steps([[5, 10], [45, NaN], [65, 30], [85, 20]]), now, 100, 5),
        [10, 10, 10, 30, 30]);
    assert.deepEqual(sampleSeries(steps([[5, 10], [25, NaN], [75, 40]]), now, 100, 5), [10, 10, null, 40, 40]);
    assert.deepEqual(sampleSeries(steps([[50, 7]]), now, 100, 5), [null, null, 7, 7, 7]);
    assert.deepEqual(sampleSeries(steps([[-500, 7]]), now, 100, 5), [7, 7, 7, 7, 7], 'a value holds until the next');
});

test('sampleSeries keeps a short spike and ignores the future', () => {
    const now = 100 * S;
    assert.deepEqual(sampleSeries(steps([[0, 10], [41, 90], [42, 10]]), now, 100, 5), [10, 10, 90, 10, 10]);
    assert.deepEqual(sampleSeries(steps([[0, 10], [150, 99]]), now, 100, 5), [10, 10, 10, 10, 10]);
});

test('sampleSeries: nothing to draw is null; the output array can be reused', () => {
    const now = 100 * S;
    assert.equal(sampleSeries(null, now, 100, 5), null);
    assert.equal(sampleSeries(steps([]), now, 100, 5), null);
    assert.equal(sampleSeries(steps([[0, NaN]]), now, 100, 5), null);
    assert.equal(sampleSeries(steps([[0, 1]]), now, 100, 0), null);
    const out = new Array(5);
    assert.equal(sampleSeries(steps([[0, 1]]), now, 100, 5, out), out);
    assert.notEqual(sampleSeries(steps([[0, 1]]), now, 100, 4, out), out, 'wrong size: a new array');
});

test('line pieces: one point per column, split at gaps', () => {
    assert.deepEqual(sparklinePieces([10, 20, null, 30], 40, 10), [
        {points: [[5, 9], [15, 5]], level: Level.NORMAL},
        {points: [[35, 1]], level: Level.NORMAL},
    ]);
    assert.deepEqual(sparklinePieces(null, 40, 10), []);
    assert.deepEqual(sparklinePieces([null, null], 40, 10), []);
});

test('line pieces change color where the reading crosses a threshold', () => {
    const levelOf = v => (v >= 90 ? Level.HOT : v >= 50 ? Level.WARM : Level.NORMAL);
    const pieces = sparklinePieces([10, 50, 90, 95], 40, 10, {levelOf});
    assert.deepEqual(pieces.map(p => p.level), [Level.WARM, Level.HOT]);
    assert.equal(pieces[0].points.length, 2);
    assert.deepEqual(pieces[1].points[0], pieces[0].points[1], 'pieces join');
    assert.equal(pieces[1].points.length, 3);
});

test('line pieces never draw a small wobble as a cliff', () => {
    const [flat] = sparklinePieces([50, 50], 20, 10, {minRange: 20});
    assert.deepEqual(flat.points.map(([, y]) => y), [5, 5]);
    const [wobble] = sparklinePieces([50, 51], 20, 10, {minRange: 20});
    assert.ok(Math.abs(wobble.points[0][1] - wobble.points[1][1]) < 1);
});

test('bars: one per column, newest at the right, percent spans 0–100 %', () => {
    assert.equal(barSlots(15), 4);
    assert.deepEqual([barSlots(30), barSlots(45), barSlots(70), barSlots(1)], [7, 11, 17, 1]);
    assert.deepEqual(barPieces([50, null, 100, 20], 15, 10, {percent: true}), [
        {x: 0, y: 5, width: 3, height: 5, level: Level.NORMAL},
        {x: 8, y: 0, width: 3, height: 10, level: Level.NORMAL},
        {x: 12, y: 8, width: 3, height: 2, level: Level.NORMAL},
    ]);
    assert.deepEqual(barPieces(null, 15, 10), []);
    assert.deepEqual(barPieces([null], 15, 10), []);
});

test('bars keep a visible floor and take their level from the value', () => {
    const levelOf = v => (v >= 90 ? Level.HOT : Level.NORMAL);
    const bars = barPieces([60, 95], 7, 12, {levelOf});
    assert.equal(bars.length, 2);
    assert.ok(bars[0].height >= 1 && bars[0].height < bars[1].height);
    assert.equal(bars[1].height, 12);
    assert.deepEqual(bars.map(b => b.level), [Level.NORMAL, Level.HOT]);
    assert.ok(bars.every(b => b.y + b.height === 12), 'bars stand on the bottom');
});
