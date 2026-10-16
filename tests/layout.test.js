// SPDX-License-Identifier: GPL-3.0-or-later
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

import {
    GRAPH_READINGS, GRAPH_WINDOWS, PLACEHOLDERS, PRESETS, READINGS, SELECTED_NODE, UndoStack, addItem,
    addSegment, applyPreset, colorHex, defaultLayout, effectiveTemplate, escapeMarkup, exportLayout,
    importLayout, layoutNeeds, loadLayout, makeResolver, migrateLegacy, moveItemTo, moveSegment, parseLayout,
    parseTemplate, pinGuest, presetLayout, readOptions, readStyle, removeFromTemplate, removeItem,
    removeSegment, renderLayout, renderOptions, renderSegment, renderTemplate, resolveTarget, sampleHistory,
    sampleSnapshot, sanitizeLayout, sanitizeTarget, segmentColor, segmentMarkup, serializeLayout, setSegment,
    setTemplate, targetKind, targetLabel, templateReadings,
} from '../extension/lib/layout.js';
import {Level, sampleSeries} from '../extension/lib/model.js';

// ---- helpers ------------------------------------------------------------------

/** The schema's defaults, read from the XML so the tests follow it. */
function schemaDefaults() {
    const xml = readFileSync(new URL('../extension/schemas/org.gnome.shell.extensions.pve-bar.gschema.xml',
        import.meta.url), 'utf8');
    const out = {};
    for (const m of xml.matchAll(/<key name="([^"]+)" type="([^"]+)">[\s\S]*?<default>([\s\S]*?)<\/default>/g)) {
        const [, name, type, raw] = m;
        if (type === 'b')
            out[name] = raw === 'true';
        else if (type === 'i')
            out[name] = Number(raw);
        else
            out[name] = raw.replace(/^'|'$/g, '');
    }
    return out;
}

function fakeSettings(overrides = {}) {
    const values = {...schemaDefaults(), ...overrides};
    const get = key => {
        assert.ok(key in values, `unknown key ${key}`);
        return values[key];
    };
    return {values, get_boolean: get, get_int: get, get_string: get};
}

const GIB = 1024 ** 3;

function snapshot(over = {}) {
    return {
        daemon: 'running',
        configError: '',
        fake: false,
        version: '0.2.0',
        servers: [
            {name: 'home', state: 'ok', message: ''},
            {name: 'lab', state: 'offline', message: 'connection refused'},
            {name: 'edge', state: 'ok', message: ''},
        ],
        nodes: [
            {server: 'home', name: 'pve', status: 'online'},
            {server: 'edge', name: 'a', status: 'offline'},
            {server: 'edge', name: 'b', status: 'online'},
        ],
        guests: [
            {server: 'home', vmid: 100, kind: 'qemu', node: 'pve', name: 'web', status: 'running'},
            {server: 'home', vmid: 101, kind: 'lxc', node: 'pve', name: 'db', status: 'stopped'},
            {server: 'edge', vmid: 100, kind: 'lxc', node: 'b', name: 'dns', status: 'running'},
        ],
        values: new Map(Object.entries({
            'home/node/pve/cpu': 23.44,
            'home/node/pve/mem': 61,
            'home/node/pve/mem_used': 39.2 * GIB,
            'home/node/pve/mem_total': 64 * GIB,
            'home/node/pve/disk': 38,
            'home/node/pve/temp': 54.4,
            'edge/node/a/cpu': 1,
            'edge/node/b/cpu': 5,
            'edge/node/b/mem': 20,
            'home/guest/100/cpu': 87.1,
            'home/guest/100/mem': 45,
            'home/guest/100/netin': 1536,
            'home/guest/100/netout': 512,
            'home/guest/100/fs': 62,
            'home/guest/101/cpu': 0,
            'home/guest/101/mem': 0,
            'edge/guest/100/cpu': 2.5,
            'edge/guest/100/mem': 30,
        })),
        history: new Map(),
        ...over,
    };
}

function without(snap, ...keys) {
    const values = new Map(snap.values);
    for (const k of keys)
        values.delete(k);
    return {...snap, values};
}

const HERE = SELECTED_NODE;

const text = (template, target = HERE, snap = snapshot(), options = {}) => {
    const t = resolveTarget(target, snap, options);
    return renderTemplate(template, makeResolver(t, snap, options), targetKind(target)).map(p => p.text).join('');
};

const seg = (target, items, extra = {}) => ({target, items, template: '', icon: 'auto', graph: null, ...extra});
const texts = (layout, snap = snapshot(), options = {}) => renderLayout(layout, snap, options).map(s => s.text);

const STYLE = {normal: '', warm: '#f8e45c', hot: '#f66151', bold: false};

// ---- targets ---------------------------------------------------------------------

test('targets: node, guest or server; anything else is the selected node', () => {
    assert.deepEqual(sanitizeTarget({server: 'home', node: 'pve'}), {server: 'home', node: 'pve'});
    assert.deepEqual(sanitizeTarget({server: 'home', guest: 101}), {server: 'home', guest: 101});
    assert.deepEqual(sanitizeTarget({server: '', guest: '101'}), {server: '', guest: 101});
    assert.deepEqual(sanitizeTarget({server: 'lab'}), {server: 'lab'});
    assert.deepEqual(sanitizeTarget({server: 'Bad Name!', node: '../etc'}), {server: '', node: ''});
    assert.deepEqual(sanitizeTarget({server: 'home', guest: 'x'}), HERE);
    assert.deepEqual(sanitizeTarget({server: 'home', guest: -1}), HERE);
    for (const bad of [null, undefined, 'home', 3, [], {}])
        assert.deepEqual(sanitizeTarget(bad), HERE, String(bad));
    assert.equal(targetKind({server: 'a', guest: 1}), 'guest');
    assert.equal(targetKind({server: '', node: ''}), 'node');
    assert.equal(targetKind({server: 'a'}), 'server');
    assert.equal(targetLabel({server: 'home', guest: 101}), 'guest 101 on home');
    assert.equal(targetLabel({server: '', node: ''}), 'first node of the selected server');
});

test('"" resolves through the server and node settings, else the first server and online node', () => {
    const snap = snapshot();
    const t = (target, options = {}) => {
        const r = resolveTarget(target, snap, options);
        return r.exists ? `${r.server}/${r.node ?? r.guest?.vmid ?? ''}` : `missing ${r.server}`;
    };
    assert.equal(t(HERE), 'home/pve');
    assert.equal(t(HERE, {server: 'edge'}), 'edge/b', 'first online node');
    assert.equal(t(HERE, {server: 'edge', node: 'a'}), 'edge/a', 'the node setting, even offline');
    assert.equal(t(HERE, {server: 'gone', node: 'zzz'}), 'home/pve', 'unknown settings fall back');
    assert.equal(t({server: 'edge', node: ''}), 'edge/b');
    assert.equal(t({server: 'edge', node: 'a'}), 'edge/a');
    assert.equal(t({server: 'home', node: 'gone'}), 'missing home');
    assert.equal(t({server: 'lab', node: ''}), 'missing lab', 'a server that is down has no nodes');
    assert.equal(t({server: 'nope', node: ''}), 'missing nope');
    assert.equal(t({server: '', guest: 100}), 'home/100');
    assert.equal(t({server: 'edge', guest: 100}), 'edge/100', 'same vmid on another server');
    assert.equal(t({server: 'home', guest: 999}), 'missing home');
    assert.equal(t({server: 'lab'}), 'lab/', 'a down server still exists as a target');
    assert.equal(resolveTarget(HERE, {}, {}).exists, false, 'nothing known yet');
    assert.equal(resolveTarget(HERE, null, {}).exists, false);
});

// ---- templates ------------------------------------------------------------------

test('templates parse into text and placeholders of the target kind', () => {
    assert.deepEqual(parseTemplate('{cpu}%/{mem:1}%').tokens, [
        {name: 'cpu', decimals: null}, {text: '%/'}, {name: 'mem', decimals: 1}, {text: '%'},
    ]);
    assert.deepEqual(parseTemplate('{{x}} {temp}').tokens, [{text: '{x} '}, {name: 'temp', decimals: null}]);
    assert.deepEqual(parseTemplate('{cpu:9}').tokens, [{name: 'cpu', decimals: 2}], 'at most 2 decimals');
    assert.deepEqual(parseTemplate('').tokens, []);
    assert.deepEqual(parseTemplate(null).tokens, []);
    assert.deepEqual(templateReadings('{running}/{guests} {state}', 'server'), ['running', 'state']);
    assert.deepEqual(templateReadings('{guests}', 'server'), ['running'], '{guests} belongs to running');
    assert.deepEqual(templateReadings('{mem-used}/{mem-total} GiB'), ['mem-used', 'mem-total']);
    assert.deepEqual(templateReadings('{name} {netin}', 'guest'), ['name', 'netin']);
});

test('template mistakes are reported, never thrown', () => {
    assert.deepEqual(parseTemplate('{nope} {cpu').errors, ['unknown placeholder {nope}', '"{cpu" has no closing }']);
    assert.deepEqual(parseTemplate('{}').errors, ['empty placeholder {}']);
    assert.deepEqual(parseTemplate('{running}').errors, ['unknown placeholder {running}'], 'not a node reading');
    assert.deepEqual(parseTemplate('{netin}', 'node').errors.length, 1);
    assert.deepEqual(parseTemplate('{netin}', 'guest').errors, []);
    assert.deepEqual(parseTemplate('{CPU}{cpu:x}').errors.length, 2);
    assert.deepEqual(parseTemplate('a } b').errors, [], 'a lone } is text');
    assert.equal(parseTemplate('x'.repeat(500)).tokens[0].text.length, 200, 'long templates are cut');
    assert.ok(Object.isFrozen(parseTemplate('{cpu}').tokens), 'shared results cannot be changed');
});

test('every node placeholder renders', () => {
    assert.equal(text('{cpu}%'), '23%');
    assert.equal(text('{cpu:1}%'), '23.4%');
    assert.equal(text('{mem}%'), '61%');
    assert.equal(text('{mem-used}/{mem-total} GiB'), '39.2/64.0 GiB');
    assert.equal(text('{mem-used:0} of {mem-total:2}'), '39 of 64.00');
    assert.equal(text('{disk}%'), '38%');
    assert.equal(text('{temp}°'), '54°');
    assert.equal(text('{status}'), 'online');
    assert.equal(text('{name}'), 'pve');
    assert.equal(text('{name} {status} {cpu}%', {server: 'edge', node: 'a'}), 'a offline 1%');
    assert.equal(text('{{cpu}} = {cpu}'), '{cpu} = 23');
});

test('every guest placeholder renders', () => {
    const web = {server: 'home', guest: 100};
    assert.equal(text('{name} {status} {cpu:1}% {mem}%', web), 'web running 87.1% 45%');
    assert.equal(text('{netin} / {netout}', web), '1.5 KB/s / 512 B/s');
    assert.equal(text('{netin:2}', web), '1.50 KB/s');
    assert.equal(text('{fs}%', web), '62%');
    assert.equal(text('{name} {cpu:1}%', {server: 'edge', guest: 100}), 'dns 2.5%');
    assert.equal(text('{name} {status} {cpu}%', {server: '', guest: 101}), 'db stopped 0%');
});

test('every server placeholder renders', () => {
    assert.equal(text('{name} {running}/{guests} {state}', {server: 'home'}), 'home 1/2 ok');
    assert.equal(text('{cpu}% {mem}%', {server: 'home'}), '23% 61%', 'its first online node');
    assert.equal(text('{running}/{guests} · {cpu}%', {server: 'edge'}), '1/1 · 5%');
    assert.equal(text('{state} {running}/{guests} {cpu}%', {server: 'lab'}), 'offline 0/0 --');
    assert.equal(text('{name}', {server: ''}), 'home');
});

test('a target that no longer exists shows "--" for everything', () => {
    assert.equal(text('{name} {cpu}% {temp}°', {server: 'home', node: 'gone'}), '-- -- --');
    assert.equal(text('{name} {cpu}%', {server: 'home', guest: 999}), '-- --');
    assert.equal(text('{state}', {server: 'nope'}), '--');
    assert.equal(text('{cpu}%', HERE, {}), '--', 'pved has told nothing yet');
});

test('a bad template part shows "--" and the rest still renders', () => {
    assert.equal(text('{nope} · {cpu}%'), '-- · 23%');
    assert.equal(text('{cpu}% {mem'), '23% --');
    assert.equal(text('{}'), '--');
    assert.equal(text('{running}'), '--', 'a placeholder of another target kind');
});

test('units glued to a reading with no value are left out', () => {
    const noTemp = without(snapshot(), 'home/node/pve/temp', 'home/node/pve/mem_total');
    assert.equal(text('{cpu}% · {temp}°', HERE, noTemp), '23% · --');
    assert.equal(text('{mem-used}/{mem-total} GiB', HERE, noTemp), '39.2/--');
    assert.equal(text('{fs}% · {netin}', {server: 'edge', guest: 100}), '-- · --');
});

test('readings say when the target lacks them: temperature and guest disk', () => {
    const snap = without(snapshot(), 'home/node/pve/temp');
    const resolve = makeResolver(resolveTarget(HERE, snap), snap);
    assert.equal(resolve('temp').absent, true);
    assert.equal(resolve('cpu').absent, false);
    const dns = makeResolver(resolveTarget({server: 'edge', guest: 100}, snap), snap);
    assert.equal(dns('fs').absent, true, 'no guest agent');
    assert.equal(dns('netin').absent, false, 'details show "--" until the first watched poll');
    const gone = makeResolver(resolveTarget({server: 'home', node: 'gone'}, snap), snap);
    assert.equal(gone('cpu').absent, false, 'a missing target shows "--", it does not hide');
});

test('removing a reading from a template takes its unit and separator too', () => {
    assert.equal(removeFromTemplate('{cpu}%/{mem}%', 'mem'), '{cpu}%');
    assert.equal(removeFromTemplate('{cpu}% · {temp}° · {disk}%', 'temp'), '{cpu}% · {disk}%');
    assert.equal(removeFromTemplate('{mem-used}/{mem-total} GiB · {cpu}%', 'mem-total'), '{mem-used} · {cpu}%');
    assert.equal(removeFromTemplate('{mem-used}/{mem-total} GiB', 'mem-total'), '{mem-used}');
    assert.equal(removeFromTemplate('CPU {cpu}% RAM {mem}%', 'cpu'), 'CPU RAM {mem}%');
    assert.equal(removeFromTemplate('{running}/{guests} · {cpu}%', 'running', 'server'), '{cpu}%');
    assert.equal(removeFromTemplate('{{ {cpu}', 'mem'), '{{ {cpu}', 'escapes survive');
});

// ---- layout parsing --------------------------------------------------------------

test('a layout that cannot be read falls back to the default layout', () => {
    for (const bad of ['', 'nope', '[]', '{"segments": 3}', 'null', '42']) {
        const r = parseLayout(bad);
        assert.equal(r.ok, false, bad);
        assert.deepEqual(r.layout, defaultLayout(), bad);
        assert.ok(r.errors.length > 0);
    }
});

test('a layout is cleaned up: unknown readings, bad targets, empty segments and bad graphs go away', () => {
    const r = parseLayout(JSON.stringify({
        version: 99,
        segments: [
            {target: {server: 'home', node: 'pve'}, items: ['cpu', 'cpu', 'bogus', 'mem'], icon: 'rocket'},
            {items: []},
            'garbage',
            {target: {server: 'home', guest: 100}, items: ['name', 'temp'], icon: false, graph: {reading: 'name'}},
            {items: ['cpu'], graph: {reading: 'cpu', kind: 'pie', window: 9999, width: 'huge', color: 'nope', only: 'yes'}},
            {template: '{cpu}% {nope}', items: ['mem']},
            {target: {server: 'BAD NAME', guest: 'x'}, items: ['cpu']},
            {target: {server: 'lab'}, items: ['running', 'disk'], graph: {reading: 'cpu', window: 600, color: '#FF8800'}},
        ],
    }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.layout.segments, [
        {target: {server: 'home', node: 'pve'}, items: ['cpu', 'mem'], template: '', icon: 'auto', graph: null},
        {target: {server: 'home', guest: 100}, items: ['name'], template: '', icon: 'none', graph: null},
        {target: HERE, items: ['cpu'], template: '', icon: 'auto',
            graph: {reading: 'cpu', kind: 'line', only: false, width: 'medium', window: 3600, color: 'follow'}},
        {target: HERE, items: ['cpu'], template: '{cpu}% {nope}', icon: 'auto', graph: null},
        {target: HERE, items: ['cpu'], template: '', icon: 'auto', graph: null},
        {target: {server: 'lab'}, items: ['running'], template: '', icon: 'auto',
            graph: {reading: 'cpu', kind: 'line', only: false, width: 'medium', window: 900, color: '#ff8800'}},
    ]);
    assert.deepEqual(r.errors, ['segment 4: unknown placeholder {nope}']);
    assert.equal(r.layout.version, 1);
});

test('graph windows snap to 5, 15, 30 or 60 minutes', () => {
    assert.deepEqual(GRAPH_WINDOWS, [300, 900, 1800, 3600]);
    const windowOf = w => sanitizeLayout({segments: [seg(HERE, ['cpu'], {graph: {reading: 'cpu', window: w}})]})
        .segments[0].graph.window;
    assert.deepEqual([10, 300, 500, 900, 1300, 2000, 1e9, 'x'].map(windowOf), [300, 300, 300, 900, 900, 1800, 3600, 900]);
});

test('limits keep a layout small', () => {
    const many = {segments: Array.from({length: 40}, () => ({items: READINGS.node.map(x => x.id)}))};
    const layout = sanitizeLayout(many);
    assert.equal(layout.segments.length, 12);
    assert.equal(layout.segments[0].items.length, 8);
    assert.equal(sanitizeLayout({segments: [{template: 'x'.repeat(500)}]}).segments[0].template.length, 200);
});

test('layouts round-trip through JSON, the export file and import', () => {
    const context = {servers: ['home', 'lab']};
    for (const preset of PRESETS) {
        const layout = presetLayout(preset.id, context);
        assert.deepEqual(parseLayout(serializeLayout(layout)).layout, layout, preset.id);
        assert.deepEqual(parseLayout(exportLayout(layout)).layout, layout, preset.id);
        assert.deepEqual(parseLayout(exportLayout(layout)).errors, [], preset.id);
        assert.deepEqual(importLayout(exportLayout(layout)).layout, layout, preset.id);
    }
    assert.match(exportLayout(defaultLayout()), /\n {2}"segments"/, 'the export is readable');
    for (const bad of ['', '{"x": 1}', 'not json', null]) {
        const r = importLayout(bad);
        assert.equal(r.ok, false);
        assert.equal(r.layout, null, 'import refuses what is not a layout');
    }
});

// ---- presets ------------------------------------------------------------------------

test('presets: minimal, default, graphs, cluster', () => {
    assert.deepEqual(PRESETS.map(p => p.id), ['minimal', 'default', 'graphs', 'cluster']);
    assert.deepEqual(presetLayout('default'), defaultLayout());
    assert.deepEqual(presetLayout('unknown'), defaultLayout());
    assert.deepEqual(texts(presetLayout('minimal')), ['23% · 61%']);
    assert.deepEqual(texts(presetLayout('default')), ['23%', '61%', '54°']);
    const graphs = presetLayout('graphs');
    assert.deepEqual(graphs.segments.map(s => s.graph && [s.graph.reading, s.graph.kind]),
        [['cpu', 'line'], ['mem', 'area'], null]);
    assert.deepEqual(texts(graphs), ['23%', '61%', '54°']);
});

test('the cluster preset has one compact segment per server', () => {
    const snap = snapshot();
    const cluster = presetLayout('cluster', {servers: snap.servers});
    assert.deepEqual(cluster.segments.map(s => s.target), [{server: 'home'}, {server: 'lab'}, {server: 'edge'}]);
    assert.deepEqual(texts(cluster, snap), ['home 1/2 · 23%', 'lab 0/0 · --', 'edge 1/1 · 5%']);
    assert.deepEqual(texts(presetLayout('cluster', {servers: ['home']}), snap), ['1/2 · 23%'], 'one server: no name');
    assert.deepEqual(presetLayout('cluster').segments.map(s => s.target), [{server: ''}], 'servers unknown');
    assert.equal(renderLayout(cluster, snap)[0].icon, 'server');
});

test('presets can be undone', () => {
    const mine = setTemplate(defaultLayout(), 0, 'CPU {cpu:1}%');
    const {layout, undo} = applyPreset(mine, 'minimal');
    assert.deepEqual(layout, presetLayout('minimal'));
    assert.deepEqual(undo, sanitizeLayout(mine));
    const stack = new UndoStack(2);
    assert.equal(stack.canUndo, false);
    assert.equal(stack.pop(), null);
    stack.push(defaultLayout());
    stack.push(mine);
    stack.push(layout);
    assert.deepEqual(stack.pop(), layout);
    assert.deepEqual(stack.pop(), sanitizeLayout(mine));
    assert.equal(stack.canUndo, false, 'the oldest fell off the limit');
    stack.push(mine);
    stack.clear();
    assert.equal(stack.canUndo, false);
});

// ---- migration ------------------------------------------------------------------------

test('a fresh install migrates to the MVP look', () => {
    assert.deepEqual(migrateLegacy(fakeSettings()), defaultLayout());
    const noIcons = migrateLegacy(fakeSettings({'show-icons': false}));
    assert.deepEqual(noIcons.segments.map(s => s.icon), ['none', 'none', 'none']);
    assert.deepEqual(noIcons.segments.map(s => s.target), [HERE, HERE, HERE], 'the server and node settings still apply');
});

test('the migration keeps following the server and node settings and thresholds', () => {
    const settings = fakeSettings({server: 'edge', node: 'a', 'cpu-warm': 50, 'cpu-hot': 60});
    const {layout} = loadLayout(settings);
    const [cpu] = renderLayout(layout, snapshot(), readOptions(settings));
    assert.equal(cpu.text, '1%');
    assert.equal(cpu.level, Level.NORMAL);
    const [hot] = renderLayout(layout, snapshot(), readOptions(fakeSettings({'cpu-warm': 1, 'cpu-hot': 2})));
    assert.equal(hot.level, Level.HOT);
});

test('the migration runs once: only while panel-layout is empty', () => {
    const settings = fakeSettings({'show-icons': false});
    const first = loadLayout(settings);
    assert.ok(first.migrated, 'empty layout: migrate');
    settings.values['panel-layout'] = first.migrated;
    settings.values['show-icons'] = true;
    const second = loadLayout(settings);
    assert.equal(second.migrated, null);
    assert.deepEqual(second.layout, first.layout, 'old keys are not read again');
    settings.values['panel-layout'] = '{broken';
    assert.deepEqual(loadLayout(settings), {layout: defaultLayout(), migrated: null});
    settings.values['panel-layout'] = '  ';
    assert.ok(loadLayout(settings).migrated, 'blank counts as empty');
});

// ---- editing ---------------------------------------------------------------------------

const items = layout => layout.segments.map(s => s.items);

test('readings merge into a segment and split out of it', () => {
    let layout = defaultLayout(); // [cpu] [mem] [temp]
    layout = moveItemTo(layout, 1, 'mem', 0);
    assert.deepEqual(items(layout), [['cpu', 'mem'], ['temp']]);
    assert.deepEqual(texts(layout), ['23% · 61%', '54°']);
    layout = moveItemTo(layout, 1, 'temp', 0);
    assert.deepEqual(items(layout), [['cpu', 'mem', 'temp']]);
    layout = moveItemTo(layout, 0, 'mem', 'new');
    assert.deepEqual(items(layout), [['cpu', 'temp'], ['mem']]);
    layout = moveItemTo(layout, 1, 'mem', 'new');
    assert.deepEqual(items(layout), [['cpu', 'temp'], ['mem']], 'alone already');
    assert.deepEqual(moveItemTo(layout, 0, 'nope', 1), layout);
    assert.deepEqual(moveItemTo(layout, 7, 'cpu', 1), layout);
    assert.deepEqual(moveItemTo(layout, 0, 'cpu', 9), layout);
    assert.deepEqual(moveItemTo(layout, 0, 'cpu', 0), layout);
});

test('readings only merge into a segment with the same target; a split keeps the target', () => {
    const web = {server: 'home', guest: 100};
    let layout = sanitizeLayout({segments: [seg(HERE, ['cpu']), seg(web, ['name', 'cpu'])]});
    assert.deepEqual(moveItemTo(layout, 1, 'cpu', 0), layout, 'would silently read another target');
    layout = moveItemTo(layout, 1, 'cpu', 'new');
    assert.deepEqual(layout.segments.map(s => s.target), [HERE, web, web]);
    assert.deepEqual(texts(layout), ['23%', 'web', '87%']);
    layout = moveItemTo(layout, 2, 'cpu', 1);
    assert.deepEqual(items(layout), [['cpu'], ['name', 'cpu']]);
});

test('a graph moves with its reading', () => {
    let layout = setSegment(defaultLayout(), 1, {graph: {reading: 'mem', kind: 'bars'}});
    layout = moveItemTo(layout, 1, 'mem', 0);
    assert.equal(layout.segments[0].graph.reading, 'mem');
    assert.equal(layout.segments[0].graph.kind, 'bars');
    layout = moveItemTo(layout, 0, 'mem', 'new');
    assert.equal(layout.segments[0].graph, null);
    assert.equal(layout.segments[1].graph.reading, 'mem');
});

test('adding and removing readings keeps a custom template in step', () => {
    let layout = setTemplate(defaultLayout(), 0, 'CPU {cpu:1}%');
    layout = addItem(layout, 0, 'disk');
    assert.equal(layout.segments[0].template, 'CPU {cpu:1}% · {disk}%');
    assert.deepEqual(layout.segments[0].items, ['cpu', 'disk']);
    assert.deepEqual(addItem(layout, 0, 'cpu'), layout, 'no duplicates');
    assert.deepEqual(addItem(layout, 0, 'bogus'), layout);
    assert.deepEqual(addItem(layout, 0, 'running'), layout, 'not a node reading');
    assert.deepEqual(addItem(layout, 9, 'cpu'), layout);
    layout = removeItem(layout, 0, 'cpu');
    assert.equal(layout.segments[0].template, 'CPU · {disk}%');
    layout = removeItem(layout, 0, 'disk');
    assert.deepEqual(items(layout), [['mem'], ['temp']], 'an empty segment goes away');
    assert.deepEqual(removeItem(layout, 5, 'mem'), layout);
});

test('a template decides the readings; clearing it joins them again', () => {
    let layout = setTemplate(defaultLayout(), 0, '{cpu}/{mem} {temp}');
    assert.deepEqual(layout.segments[0].items, ['cpu', 'mem', 'temp']);
    layout = setTemplate(layout, 0, '');
    assert.equal(layout.segments[0].template, '');
    assert.equal(effectiveTemplate(layout.segments[0]), '{cpu}% · {mem}% · {temp}°');
    layout = setTemplate(layout, 0, 'PVE');
    assert.deepEqual(layout.segments[0], seg(HERE, [], {template: 'PVE'}));
    assert.equal(texts(layout)[0], 'PVE');
    assert.deepEqual(setTemplate(layout, 7, 'x'), layout);
});

test('segments are added, moved and removed', () => {
    let layout = addSegment(defaultLayout());
    assert.deepEqual(layout.segments[3].items, ['mem-used'], 'the first reading not shown yet');
    layout = addSegment(layout, 'disk');
    assert.deepEqual(layout.segments[4].items, ['disk']);
    layout = addSegment(layout, null, {server: 'home', guest: 100});
    assert.deepEqual(layout.segments[5], seg({server: 'home', guest: 100}, ['cpu']));
    layout = moveSegment(layout, 4, -10);
    assert.deepEqual(layout.segments.map(s => s.items[0]), ['disk', 'cpu', 'mem', 'temp', 'mem-used', 'cpu']);
    layout = removeSegment(layout, 0);
    layout = removeSegment(layout, 99);
    assert.deepEqual(layout.segments.map(s => s.items[0]), ['cpu', 'mem', 'temp', 'mem-used', 'cpu']);
    let full = defaultLayout();
    for (let i = 0; i < 20; i++)
        full = addSegment(full);
    assert.equal(full.segments.length, 12);
    assert.deepEqual(pinGuest(full, 'home', 100), full, 'full: nothing pinned');
});

test('a guest is pinned to the bar with its name, CPU and RAM', () => {
    const layout = pinGuest(defaultLayout(), 'home', 100);
    assert.deepEqual(layout.segments[3], seg({server: 'home', guest: 100}, ['name', 'cpu', 'mem']));
    const [, , , pinned] = renderLayout(layout, snapshot());
    assert.equal(pinned.text, 'web · 87% · 45%');
    assert.equal(pinned.icon, 'vm');
    assert.deepEqual(pinGuest(defaultLayout(), 'home', 'x'), defaultLayout());
});

test('segment icon, graph and target settings', () => {
    let layout = setSegment(defaultLayout(), 0, {icon: 'disk'});
    assert.equal(layout.segments[0].icon, 'disk');
    layout = setSegment(layout, 0, {graph: {}});
    assert.deepEqual(layout.segments[0].graph,
        {reading: 'cpu', kind: 'line', only: false, width: 'medium', window: 900, color: 'follow'});
    layout = setSegment(layout, 0, {graph: {kind: 'bars', only: true, color: '#FF0000', width: 'narrow', window: 3600}});
    assert.deepEqual(layout.segments[0].graph,
        {reading: 'cpu', kind: 'bars', only: true, width: 'narrow', window: 3600, color: '#ff0000'});
    layout = setSegment(layout, 0, {graph: null});
    assert.equal(layout.segments[0].graph, null);
    layout = setSegment(layout, 0, {target: {server: 'home', guest: 100}});
    assert.deepEqual(layout.segments[0].target, {server: 'home', guest: 100});
    assert.deepEqual(layout.segments[0].items, ['cpu'], 'guests have a CPU reading too');
    assert.deepEqual(setSegment(layout, 2, {target: {server: 'home', guest: 100}}).segments[2], layout.segments[2],
        'a target without any of its readings is refused');
    assert.deepEqual(setSegment(layout, 9, {icon: 'cpu'}), layout);
    assert.deepEqual(setSegment(layout, 0, null), layout);
    assert.deepEqual(GRAPH_READINGS, {
        node: ['cpu', 'mem', 'mem-used', 'disk', 'temp'],
        guest: ['cpu', 'mem', 'netin', 'netout', 'fs'],
        server: ['cpu', 'mem'],
    });
    assert.ok(PLACEHOLDERS.server.includes('guests'));
});

// ---- rendering ------------------------------------------------------------------------------

test('a merged segment hides readings the target lacks, unless its template names them', () => {
    const noTemp = without(snapshot(), 'home/node/pve/temp');
    const merged = seg(HERE, ['cpu', 'temp']);
    assert.equal(renderSegment(merged, noTemp).text, '23%');
    assert.equal(renderSegment({...merged, template: '{cpu}%/{temp}°'}, noTemp).text, '23%/--');
    const tempOnly = seg(HERE, ['temp']);
    assert.equal(renderSegment(tempOnly, noTemp).visible, false, 'no temperature agent: no segment');
    assert.equal(renderSegment(tempOnly, snapshot()).visible, true);
    assert.equal(renderSegment(seg({server: 'edge', guest: 100}, ['fs']), snapshot()).visible, false);
});

test('a missing target stays visible as "--"', () => {
    const r = renderSegment(seg({server: 'home', node: 'gone'}, ['cpu', 'mem']), snapshot());
    assert.equal(r.visible, true);
    assert.equal(r.exists, false);
    assert.equal(r.text, '-- · --');
    assert.deepEqual(texts(defaultLayout(), {}), ['--', '--', '--'], 'no snapshot yet: nothing throws');
    assert.deepEqual(texts(defaultLayout(), null), ['--', '--', '--']);
});

test('segment level, dimming and icon', () => {
    const options = {thresholds: {cpu: {warm: 20, hot: 50}, temp: {warm: 40, hot: 50}}};
    const r = renderSegment(seg(HERE, ['cpu', 'mem']), snapshot(), options);
    assert.equal(r.level, Level.WARM);
    assert.equal(r.icon, 'cpu');
    assert.equal(renderSegment(seg(HERE, ['cpu', 'temp']), snapshot(), options).level, Level.HOT);
    const used = renderSegment(seg(HERE, ['mem-used']), snapshot(), {thresholds: {mem: {warm: 50, hot: 60}}});
    assert.equal(used.level, Level.HOT, 'RAM used takes the level of RAM %');

    const stopped = renderSegment(seg({server: 'home', guest: 101}, ['status']), snapshot());
    assert.equal(stopped.dim, true, 'a stopped guest is dimmed');
    assert.equal(stopped.icon, 'vm');
    assert.equal(stopped.text, 'stopped');
    assert.equal(renderSegment(seg({server: 'lab'}, ['state']), snapshot()).level, Level.HOT);
    assert.equal(renderSegment(seg({server: 'edge', node: 'a'}, ['status']), snapshot()).level, Level.HOT);
    assert.equal(renderSegment(seg(HERE, ['cpu'], {icon: 'none'}), snapshot()).icon, null);
    assert.equal(renderSegment(seg(HERE, ['cpu'], {icon: 'net'}), snapshot()).icon, 'net');
    assert.equal(renderSegment(seg(HERE, [], {template: 'x'}), snapshot()).icon, 'server');
});

test('markup colors each reading and escapes text', () => {
    const options = {thresholds: {cpu: {warm: 20, hot: 90}}};
    const r = renderSegment(seg(HERE, [], {template: '<{cpu}%> & {status}'}), snapshot(), options);
    assert.equal(segmentMarkup(r, STYLE), '&lt;<span foreground="#f8e45c">23%</span>&gt; &amp; online');
    assert.equal(segmentColor(r, STYLE), '#f8e45c', 'the warm CPU colors the icon');

    const db = renderSegment(seg({server: 'home', guest: 101}, ['name', 'status']), snapshot());
    assert.equal(segmentMarkup(db, STYLE), 'db · <span alpha="50%">stopped</span>');

    const hot = renderSegment(seg(HERE, ['cpu']), snapshot(), {thresholds: {cpu: {warm: 10, hot: 20}}});
    assert.equal(segmentMarkup(hot, STYLE), '<span foreground="#f66151">23%</span>');
    assert.equal(segmentMarkup(hot, {...STYLE, bold: true}), '<span foreground="#f66151" weight="bold">23%</span>');
    assert.equal(segmentMarkup(hot, {...STYLE, hot: ''}), '23%');
    assert.equal(segmentMarkup(hot, {...STYLE, normal: 'rgb(255,255,255)'}),
        '<span foreground="#ffffff"><span foreground="#f66151">23%</span></span>');

    const evil = snapshot();
    evil.guests = [{server: 'home', vmid: 100, kind: 'qemu', node: 'pve', name: '<b>a&b</b>', status: 'running'}];
    const named = renderSegment(seg({server: 'home', guest: 100}, ['name']), evil);
    assert.equal(segmentMarkup(named, STYLE), '&lt;b&gt;a&amp;b&lt;/b&gt;');

    const plain = renderSegment(seg(HERE, ['disk']), snapshot());
    assert.equal(segmentMarkup(plain, STYLE), '38%');
    assert.equal(segmentColor(plain, STYLE), null);
    assert.equal(colorHex('rgb(98,160,234)'), '#62a0ea');
    assert.equal(colorHex('tomato'), null);
    assert.equal(escapeMarkup(`"'`), '&quot;&apos;');
});

test('graphs: graph-only segments and their spec', () => {
    let layout = setSegment(defaultLayout(), 0, {graph: {kind: 'area', only: true, width: 'wide', window: 300}});
    layout = setSegment(layout, 2, {graph: {reading: 'cpu'}});
    layout = pinGuest(layout, 'home', 100);
    layout = setSegment(layout, 3, {graph: {reading: 'netin', kind: 'bars'}});
    layout = addSegment(layout, 'mem-used');
    layout = setSegment(layout, 4, {graph: {}});
    layout = addSegment(layout, 'cpu', {server: 'home', node: 'gone'});
    layout = setSegment(layout, 5, {graph: {}});
    const [cpu, , temp, guest, used, gone] = renderLayout(layout, snapshot(), {thresholds: {cpu: {warm: 20, hot: 50}}});
    assert.equal(cpu.showText, false);
    assert.deepEqual({...cpu.graph, levelOf: null},
        {key: 'home/node/pve/cpu', reading: 'cpu', kind: 'area', width: 70, window: 300, color: 'follow',
            levelOf: null, minRange: 20, percent: true});
    assert.equal(cpu.graph.levelOf(60), Level.HOT);
    assert.equal(cpu.graph.levelOf(30), Level.WARM);
    assert.equal(temp.graph.key, 'home/node/pve/cpu', 'a segment may graph a reading it does not show');
    assert.equal(temp.showText, true);
    assert.equal(guest.graph.key, 'home/guest/100/netin');
    assert.equal(guest.graph.percent, false);
    assert.equal(guest.graph.levelOf(1e9), Level.NORMAL);
    assert.equal(guest.graph.minRange, 10240);
    assert.equal(used.graph.key, 'home/node/pve/mem', 'RAM used draws RAM %');
    assert.equal(gone.graph.key, null, 'a missing target draws nothing');
});

test('the layout says which history keys, span and guest watches it needs', () => {
    const web = {server: 'home', guest: 100};
    const layout = sanitizeLayout({segments: [
        seg(HERE, ['cpu'], {graph: {reading: 'cpu', window: 300}}),
        seg(web, ['name'], {graph: {reading: 'netin', window: 1800}}),
        seg({server: 'edge', guest: 100}, ['cpu']),
        seg({server: 'home', guest: 101}, [], {template: '{fs}%'}),
        seg({server: 'home', guest: 999}, ['netin']),
        seg(web, ['netout'], {graph: {reading: 'cpu', window: 300}}),
        seg(HERE, ['mem'], {graph: {reading: 'cpu'}}),
    ]});
    assert.deepEqual(layoutNeeds(layout, snapshot()), {
        keys: ['home/node/pve/cpu', 'home/guest/100/netin', 'home/guest/100/cpu'],
        span: 1800,
        watches: [{server: 'home', vmid: 100}, {server: 'home', vmid: 101}],
    });
    assert.deepEqual(layoutNeeds(defaultLayout(), snapshot()), {keys: [], span: 0, watches: []});
    assert.deepEqual(layoutNeeds(layout, snapshot(), {server: 'edge'}).keys[0], 'edge/node/b/cpu');
});

test('long text is cut so it never floods the bar', () => {
    const r = renderSegment(seg(HERE, [], {template: 'x'.repeat(200)}), snapshot());
    assert.equal(r.text.length, 120);
    const many = renderSegment(seg(HERE, [], {template: `${'x'.repeat(100)}${'{name}'.repeat(10)}`}), snapshot());
    assert.equal(many.text.length, 120);
    assert.equal(many.parts.at(-1).text, 'pv', 'the last part is cut too');
});

test('settings are read into render options and style', () => {
    const settings = fakeSettings();
    assert.deepEqual({...readOptions(settings)}, {
        server: '', node: '',
        thresholds: {
            cpu: {warm: 70, hot: 90}, mem: {warm: 80, hot: 95}, disk: {warm: 80, hot: 90},
            temp: {warm: 70, hot: 85}, fs: {warm: 80, hot: 90},
        },
    });
    assert.deepEqual(readStyle(settings), {normal: '', warm: '#f8e45c', hot: '#f66151', bold: false});
    const options = readOptions(settings);
    assert.equal(renderOptions(options), options, 'complete options are used as they are');
    const a = renderLayout(presetLayout('graphs'), snapshot(), options)[0].graph.levelOf;
    const b = renderLayout(presetLayout('graphs'), snapshot(), options)[0].graph.levelOf;
    assert.equal(a, b, 'level functions are cached per options');
});

test('the preview has sample values and an hour of history', () => {
    const snap = sampleSnapshot();
    assert.deepEqual(texts(presetLayout('graphs'), snap), ['23%', '61%', '54°']);
    assert.equal(texts(presetLayout('cluster', snap), snap)[0], 'home 2/3 · 23%');
    assert.equal(texts(pinGuest(defaultLayout(), 'home', 100), snap)[3], 'web · 6% · 45%');
    const now = 3600e6;
    for (const [key, s] of snap.history) {
        assert.equal(s.t.length, 360, key);
        assert.equal(s.v.at(-1), snap.values.get(key), key);
        assert.ok(sampleSeries(s, now, 3600, 45)?.every(v => v !== null), key);
    }
    for (const seg of renderLayout(presetLayout('graphs'), snap).filter(s => s.graph))
        assert.ok(snap.history.has(seg.graph.key), seg.graph.key);
    assert.equal(sampleHistory(10e6).get('home/node/pve/cpu').t.at(-1), 10e6);
});
