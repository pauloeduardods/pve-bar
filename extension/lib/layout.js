// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar layout: which segments the bar shows, what each one says,
// which node, guest or server it reads, and whether it draws a graph. Stored
// as JSON in the `panel-layout` setting (docs/CUSTOMIZATION.md, section 3).
// Pure: no GNOME imports, so it is unit-tested with node
// (tests/layout.test.js). The indicator and the preview in Settings both
// render through it, so what Settings shows is what the bar shows.
//
// Nothing here may throw on bad input: a bad template or an unknown
// placeholder renders as "--", a target that no longer exists renders "--",
// and a layout that cannot be read at all becomes the default layout.

import {
    GRAPH_WIDTHS, HISTORY_MAX_S, Level, THRESHOLD_DEFAULTS, THRESHOLD_KINDS, formatRate, level as thresholdLevel,
    parseColor, pickNode, pickServer,
} from './model.js';

export const LAYOUT_VERSION = 1;

/** What a segment can draw its history as. */
export const GRAPH_KINDS = Object.freeze(['line', 'area', 'bars']);

/** How far back a graph reaches, in seconds. */
export const GRAPH_WINDOWS = Object.freeze([300, 900, 1800, 3600]);
const DEFAULT_WINDOW = 900;

/** Icons a segment can show ('auto' = its first reading's, 'none' = no icon). */
export const ICONS = Object.freeze(['cpu', 'ram', 'temp', 'disk', 'net', 'server', 'vm']);

/** What a segment reads: a node, a guest or a server as a whole. */
export const TARGET_KINDS = Object.freeze(['node', 'guest', 'server']);

/** The longest template kept, and the most segments and readings. */
export const MAX_TEMPLATE = 200;
export const MAX_SEGMENTS = 12;
export const MAX_ITEMS = 8;
const MAX_TEXT = 120;

/** Placed between readings when a segment has no template of its own. */
export const SEPARATOR = ' · ';

const GIB = 1024 ** 3;

function reading(id, label, icon, template, extra = {}) {
    return Object.freeze({
        id, label, icon, template,
        // The value key suffix the graph draws (null: no graph).
        series: null,
        // The value key suffix the text shows.
        value: null,
        // Threshold kind for its color (cpu, mem, disk, temp, fs), or null.
        level: null,
        // How the value shows: 'number' (0 decimals), 'gib' (bytes, 1 decimal), 'rate' (B/s).
        format: 'number',
        // Percent readings: bar graphs span 0–100 %.
        percent: false,
        // Missing value: hide it from a merged segment (the host has no such sensor).
        optional: false,
        // Only exists while the guest is watched (pved's Watch).
        details: false,
        ...extra,
    });
}

const percent = (key, extra = {}) => ({series: key, value: key, level: key, percent: true, ...extra});

/**
 * Everything a segment can show, per target kind. `template` is how a
 * reading shows when the segment has no template of its own.
 */
export const READINGS = Object.freeze({
    node: Object.freeze([
        reading('cpu', 'CPU usage', 'cpu', '{cpu}%', percent('cpu')),
        reading('mem', 'RAM usage', 'ram', '{mem}%', percent('mem')),
        reading('mem-used', 'RAM used of total', 'ram', '{mem-used}/{mem-total} GiB',
            {series: 'mem', value: 'mem_used', level: 'mem', format: 'gib'}),
        reading('mem-total', 'RAM total', 'ram', '{mem-total} GiB', {value: 'mem_total', format: 'gib'}),
        reading('disk', 'Root disk usage', 'disk', '{disk}%', percent('disk')),
        reading('temp', 'CPU temperature', 'temp', '{temp}°',
            {series: 'temp', value: 'temp', level: 'temp', optional: true}),
        reading('status', 'Node status', 'server', '{status}'),
        reading('name', 'Node name', 'server', '{name}'),
    ]),
    guest: Object.freeze([
        reading('cpu', 'CPU usage', 'cpu', '{cpu}%', percent('cpu')),
        reading('mem', 'RAM usage', 'ram', '{mem}%', percent('mem')),
        reading('name', 'Name', 'vm', '{name}'),
        reading('status', 'Status', 'vm', '{status}'),
        reading('netin', 'Network in', 'net', '{netin}',
            {series: 'netin', value: 'netin', format: 'rate', details: true}),
        reading('netout', 'Network out', 'net', '{netout}',
            {series: 'netout', value: 'netout', format: 'rate', details: true}),
        reading('fs', 'Disk inside the guest', 'disk', '{fs}%', percent('fs', {details: true, optional: true})),
    ]),
    server: Object.freeze([
        reading('running', 'Guests running of all', 'server', '{running}/{guests}'),
        reading('state', 'Connection state', 'server', '{state}'),
        reading('name', 'Server name', 'server', '{name}'),
        reading('cpu', 'CPU usage of its node', 'cpu', '{cpu}%', percent('cpu')),
        reading('mem', 'RAM usage of its node', 'ram', '{mem}%', percent('mem')),
    ]),
});

const READING = Object.freeze(Object.fromEntries(TARGET_KINDS.map(kind =>
    [kind, Object.freeze(Object.fromEntries(READINGS[kind].map(r => [r.id, r])))])));

/** Placeholders that are not readings of their own, and the reading they belong to. */
const ALIASES = Object.freeze({node: {}, guest: {}, server: {guests: 'running'}});

/** The reading `id` of a `kind` target, or null. */
export function readingInfo(kind, id) {
    return READING[kind]?.[id] ?? null;
}

/** Readings of a target kind that can draw a graph. */
export const GRAPH_READINGS = Object.freeze(Object.fromEntries(TARGET_KINDS.map(kind =>
    [kind, Object.freeze(READINGS[kind].filter(r => r.series).map(r => r.id))])));

/** Every placeholder a template of a target kind may use, for the help text. */
export const PLACEHOLDERS = Object.freeze(Object.fromEntries(TARGET_KINDS.map(kind =>
    [kind, Object.freeze([...READINGS[kind].map(r => r.id), ...Object.keys(ALIASES[kind])])])));

function readingOf(kind, name) {
    if (READING[kind]?.[name])
        return name;
    return ALIASES[kind]?.[name] ?? null;
}

// ---- targets ----------------------------------------------------------------

const SERVER_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const NODE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/** The selected server's selected node ('' = the `server` and `node` settings). */
export const SELECTED_NODE = Object.freeze({server: '', node: ''});

/** 'node', 'guest' or 'server'. */
export function targetKind(target) {
    if (target && Object.hasOwn(target, 'guest'))
        return 'guest';
    if (target && Object.hasOwn(target, 'node'))
        return 'node';
    return 'server';
}

/** Any value to a valid target; anything unreadable is the selected node. */
export function sanitizeTarget(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {...SELECTED_NODE};
    const server = typeof raw.server === 'string' && SERVER_NAME.test(raw.server) ? raw.server : '';
    if (Object.hasOwn(raw, 'guest')) {
        const vmid = Number(raw.guest);
        return Number.isInteger(vmid) && vmid > 0 && vmid < 2 ** 32 ? {server, guest: vmid} : {...SELECTED_NODE};
    }
    if (Object.hasOwn(raw, 'node'))
        return {server, node: typeof raw.node === 'string' && NODE_NAME.test(raw.node) ? raw.node : ''};
    if (Object.hasOwn(raw, 'server'))
        return {server};
    return {...SELECTED_NODE};
}

export function sameTarget(a, b) {
    const kind = targetKind(a);
    return kind === targetKind(b) && a.server === b.server &&
        (kind !== 'node' || a.node === b.node) && (kind !== 'guest' || a.guest === b.guest);
}

/** "node pve on home", "guest 101 on lab", "selected node", for lists. */
export function targetLabel(target) {
    const server = target.server || 'the selected server';
    switch (targetKind(target)) {
    case 'guest':
        return `guest ${target.guest} on ${server}`;
    case 'node':
        return target.node ? `node ${target.node} on ${server}` : `first node of ${server}`;
    default:
        return `server ${server}`;
    }
}

// ---- templates --------------------------------------------------------------

const parsed = new Map();

/**
 * A template as tokens: {text} for literal text, {name, decimals} for a
 * placeholder, {bad} for something unreadable. "{{" and "}}" are literal
 * braces; "{cpu:1}" asks for one decimal (0 to 2). Placeholders are those
 * of the `kind` target. Never throws. The result is shared: do not modify it.
 */
export function parseTemplate(template, kind = 'node') {
    const s = String(template ?? '').slice(0, MAX_TEMPLATE);
    const cacheKey = `${kind}\n${s}`;
    const hit = parsed.get(cacheKey);
    if (hit)
        return hit;
    const tokens = [];
    const errors = [];
    let text = '';
    const flush = () => {
        if (text)
            tokens.push({text});
        text = '';
    };
    for (let i = 0; i < s.length;) {
        const c = s[i];
        if ((c === '{' || c === '}') && s[i + 1] === c) {
            text += c;
            i += 2;
            continue;
        }
        if (c !== '{') {
            text += c;
            i++;
            continue;
        }
        flush();
        const end = s.indexOf('}', i);
        if (end < 0) {
            errors.push(`"${s.slice(i)}" has no closing }`);
            tokens.push({bad: s.slice(i)});
            break;
        }
        const body = s.slice(i + 1, end).trim();
        const m = /^([a-z0-9-]+)(?::([0-9]))?$/.exec(body);
        if (m && readingOf(kind, m[1])) {
            tokens.push({name: m[1], decimals: m[2] === undefined ? null : Math.min(2, Number(m[2]))});
        } else {
            errors.push(body ? `unknown placeholder {${body}}` : 'empty placeholder {}');
            tokens.push({bad: body});
        }
        i = end + 1;
    }
    flush();
    const result = Object.freeze({tokens: Object.freeze(tokens), errors: Object.freeze(errors)});
    if (parsed.size >= 256)
        parsed.clear();
    parsed.set(cacheKey, result);
    return result;
}

/** The readings a template uses, in order, once each ("{guests}" counts as running). */
export function templateReadings(template, kind = 'node') {
    const out = [];
    for (const t of parseTemplate(template, kind).tokens) {
        const id = t.name ? readingOf(kind, t.name) : null;
        if (id && !out.includes(id))
            out.push(id);
    }
    return out;
}

function escapeTemplate(text) {
    return text.replace(/[{}]/g, c => c + c);
}

function tokensToTemplate(tokens) {
    return tokens.map(t => {
        if (t.text !== undefined)
            return escapeTemplate(t.text);
        if (t.name !== undefined)
            return `{${t.name}${t.decimals === null ? '' : `:${t.decimals}`}}`;
        return `{${t.bad}`;
    }).join('');
}

/** A unit right after a placeholder: "°", "%", " GiB". */
const GLUED = /^ ?[^\s·/|,;:()[\]{}<>&]+/;
const SEPARATORS = /^[\s·/|,;-]+|[\s·/|,;-]+$/g;

/** Tidies a template after a placeholder was cut out of it. */
function tidyTemplate(text) {
    return text
        // A run of separators becomes one: " · " if it has one, else its first.
        .replace(/(\s*)([·/|,;])(\s*)(?:[·/|,;]\s*)+/g,
            (m, a, c, b) => (m.includes('·') ? ' · ' : `${a ? ' ' : ''}${c}${b ? ' ' : ''}`))
        .replace(/ {2,}/g, ' ')
        .replace(SEPARATORS, '');
}

/** `template` without `id` (and its aliases) and its unit. */
export function removeFromTemplate(template, id, kind = 'node') {
    const tokens = [...parseTemplate(template, kind).tokens];
    const out = [];
    for (let i = 0; i < tokens.length; i++) {
        const t = tokens[i];
        if (t.name && readingOf(kind, t.name) === id) {
            const next = tokens[i + 1];
            if (next?.text !== undefined) {
                const glued = GLUED.exec(next.text);
                if (glued)
                    tokens[i + 1] = {text: next.text.slice(glued[0].length)};
            }
            continue;
        }
        out.push(t);
    }
    return tidyTemplate(tokensToTemplate(out));
}

// ---- layout -----------------------------------------------------------------

function segment(target, items, extra = {}) {
    return {target: {...target}, items, template: '', icon: 'auto', graph: null, ...extra};
}

function graph(id, extra = {}) {
    return {reading: id, kind: 'line', only: false, width: 'medium', window: DEFAULT_WINDOW, color: 'follow', ...extra};
}

/** The default layout: what the bar showed before layouts existed. */
export function defaultLayout() {
    return {
        version: LAYOUT_VERSION,
        segments: [segment(SELECTED_NODE, ['cpu']), segment(SELECTED_NODE, ['mem']), segment(SELECTED_NODE, ['temp'])],
    };
}

function serverNames(context) {
    const servers = Array.isArray(context?.servers) ? context.servers : [];
    return servers.map(s => (typeof s === 'string' ? s : s?.name)).filter(n => typeof n === 'string' && SERVER_NAME.test(n));
}

/**
 * Ready-made layouts for the Settings page. `layout(context)` may use
 * `context.servers` (names or pved's {name} entries).
 */
export const PRESETS = Object.freeze([
    {
        id: 'minimal',
        label: 'Minimal',
        description: 'CPU and RAM of the selected node in one segment',
        layout: () => ({version: LAYOUT_VERSION, segments: [segment(SELECTED_NODE, ['cpu', 'mem'])]}),
    },
    {
        id: 'default',
        label: 'Default',
        description: 'CPU, RAM and temperature of the selected node',
        layout: defaultLayout,
    },
    {
        id: 'graphs',
        label: 'Graphs',
        description: 'CPU as a line, RAM as an area, then the temperature',
        layout: () => ({
            version: LAYOUT_VERSION,
            segments: [
                segment(SELECTED_NODE, ['cpu'], {graph: graph('cpu')}),
                segment(SELECTED_NODE, ['mem'], {graph: graph('mem', {kind: 'area'})}),
                segment(SELECTED_NODE, ['temp']),
            ],
        }),
    },
    {
        id: 'cluster',
        label: 'Cluster',
        description: 'One compact segment per server: guests running and CPU',
        layout: context => {
            const names = serverNames(context);
            const template = names.length > 1 ? '{name} {running}/{guests} · {cpu}%' : '{running}/{guests} · {cpu}%';
            const servers = names.length ? names : [''];
            return {
                version: LAYOUT_VERSION,
                segments: servers.slice(0, MAX_SEGMENTS).map(server => segment({server}, [], {template})),
            };
        },
    },
]);

/** A preset's layout (the default layout for an unknown id). */
export function presetLayout(id, context = {}) {
    const preset = PRESETS.find(p => p.id === id);
    return sanitizeLayout(preset ? preset.layout(context) : defaultLayout());
}

/** Switches to a preset: {layout, undo}, where `undo` is the layout to go back to. */
export function applyPreset(current, id, context = {}) {
    return {layout: presetLayout(id, context), undo: clone(current)};
}

/** The layouts to go back to, newest last; Settings shows an Undo while it is not empty. */
export class UndoStack {
    constructor(limit = 20) {
        this._limit = limit;
        this._items = [];
    }

    get canUndo() {
        return this._items.length > 0;
    }

    push(layout) {
        this._items.push(serializeLayout(layout));
        if (this._items.length > this._limit)
            this._items.shift();
    }

    /** The last pushed layout, or null. */
    pop() {
        const text = this._items.pop();
        return text === undefined ? null : parseLayout(text).layout;
    }

    clear() {
        this._items = [];
    }
}

function nearestWindow(seconds) {
    let best = DEFAULT_WINDOW;
    let distance = Infinity;
    for (const w of GRAPH_WINDOWS) {
        const d = Math.abs(w - seconds);
        if (d <= distance) {
            best = w;
            distance = d;
        }
    }
    return best;
}

function sanitizeColor(color) {
    if (typeof color !== 'string')
        return 'follow';
    const value = color.trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(value) ? value : 'follow';
}

function sanitizeGraph(raw, kind) {
    if (!raw || typeof raw !== 'object' || !GRAPH_READINGS[kind].includes(raw.reading))
        return null;
    return {
        reading: raw.reading,
        kind: GRAPH_KINDS.includes(raw.kind) ? raw.kind : 'line',
        only: raw.only === true,
        width: typeof raw.width === 'string' && Object.hasOwn(GRAPH_WIDTHS, raw.width) ? raw.width : 'medium',
        window: Number.isFinite(raw.window) ? nearestWindow(raw.window) : DEFAULT_WINDOW,
        color: sanitizeColor(raw.color),
    };
}

function sanitizeIcon(icon) {
    if (icon === false || icon === 'none')
        return 'none';
    return ICONS.includes(icon) ? icon : 'auto';
}

/** One segment, cleaned up; null when it shows nothing. */
function sanitizeSegment(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const target = sanitizeTarget(raw.target);
    const kind = targetKind(target);
    let template = typeof raw.template === 'string' ? raw.template.slice(0, MAX_TEMPLATE) : '';
    if (template.trim() === '')
        template = '';
    let items;
    if (template) {
        // A template is the truth: its readings are the segment's.
        items = templateReadings(template, kind).slice(0, MAX_ITEMS);
    } else {
        const ids = Array.isArray(raw.items) ? raw.items : [];
        items = [...new Set(ids)].filter(id => typeof id === 'string' && READING[kind][id]).slice(0, MAX_ITEMS);
    }
    const graphSpec = sanitizeGraph(raw.graph, kind);
    if (items.length === 0 && !template && !graphSpec)
        return null;
    return {target, items, template, icon: sanitizeIcon(raw.icon), graph: graphSpec};
}

/** Any value to a valid layout. Unknown readings and empty segments are dropped. */
export function sanitizeLayout(raw) {
    const segments = Array.isArray(raw?.segments) ? raw.segments : [];
    return {
        version: LAYOUT_VERSION,
        segments: segments.map(sanitizeSegment).filter(Boolean).slice(0, MAX_SEGMENTS),
    };
}

/**
 * The `panel-layout` text as {ok, layout, errors}. Text that is not a layout
 * at all gives ok = false and the default layout; template mistakes are
 * listed in `errors` but the layout is still used (they render as "--").
 */
export function parseLayout(text) {
    let raw;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        return {ok: false, layout: defaultLayout(), errors: [`not JSON: ${e.message}`]};
    }
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.segments))
        return {ok: false, layout: defaultLayout(), errors: ['not a pve-bar layout (no "segments" list)']};
    const layout = sanitizeLayout(raw);
    const errors = [];
    layout.segments.forEach((s, i) => {
        for (const e of parseTemplate(s.template, targetKind(s.target)).errors)
            errors.push(`segment ${i + 1}: ${e}`);
    });
    return {ok: true, layout, errors};
}

export function serializeLayout(layout) {
    return JSON.stringify(sanitizeLayout(layout));
}

/** The layout as a file to back up or share. */
export function exportLayout(layout) {
    return `${JSON.stringify(sanitizeLayout(layout), null, 2)}\n`;
}

/**
 * A file to import: {ok, layout, errors}. Unlike parseLayout, text that is
 * not a layout gives layout = null, so Settings can refuse it.
 */
export function importLayout(text) {
    const r = parseLayout(String(text ?? ''));
    return r.ok ? r : {ok: false, layout: null, errors: r.errors};
}

// ---- migration from the MVP settings -------------------------------------------

/**
 * The layout the MVP settings described: CPU, RAM and temperature of the
 * selected node, with or without icons. The `server` and `node` settings and
 * the thresholds keep working as they did: '' targets read them.
 * `settings` is anything with get_boolean/get_int/get_string.
 */
export function migrateLegacy(settings) {
    const icon = settings.get_boolean('show-icons') ? 'auto' : 'none';
    const layout = defaultLayout();
    for (const s of layout.segments)
        s.icon = icon;
    return sanitizeLayout(layout);
}

/**
 * The layout in `settings`. On first run `panel-layout` is empty: the layout
 * then comes from the MVP settings and `migrated` is the text to store, so
 * the migration happens once.
 */
export function loadLayout(settings) {
    const stored = settings.get_string('panel-layout');
    if (stored.trim() === '') {
        const layout = migrateLegacy(settings);
        return {layout, migrated: serializeLayout(layout)};
    }
    return {layout: parseLayout(stored).layout, migrated: null};
}

// ---- editing (Settings) ---------------------------------------------------------

function clone(layout) {
    return JSON.parse(JSON.stringify(sanitizeLayout(layout)));
}

function inRange(layout, index) {
    return Number.isInteger(index) && index >= 0 && index < layout.segments.length;
}

/** Adds a reading to segment `index`, at the end of its template if it has one. */
export function addItem(layout, index, id) {
    const out = clone(layout);
    const s = out.segments[index];
    const info = s ? readingInfo(targetKind(s.target), id) : null;
    if (!info || s.items.includes(id) || s.items.length >= MAX_ITEMS)
        return out;
    if (s.template)
        s.template = `${s.template}${SEPARATOR}${info.template}`;
    s.items.push(id);
    return sanitizeLayout(out);
}

/** Removes a reading from segment `index`; a segment left empty goes away. */
export function removeItem(layout, index, id) {
    const out = clone(layout);
    const s = out.segments[index];
    if (!s)
        return out;
    const kind = targetKind(s.target);
    s.items = s.items.filter(x => x !== id);
    if (s.template) {
        s.template = removeFromTemplate(s.template, id, kind);
        if (templateReadings(s.template, kind).length === 0)
            s.template = '';
    }
    if (s.graph?.reading === id)
        s.graph = null;
    return sanitizeLayout(out);
}

/**
 * Moves a reading from segment `from` into segment `to` (merging it), or
 * into a new segment right after `from` when `to` is 'new' (splitting it).
 * Readings only merge into a segment with the same target, so a reading
 * never silently starts showing another node or guest.
 */
export function moveItemTo(layout, from, id, to) {
    if (!inRange(layout, from) || !layout.segments[from].items.includes(id))
        return clone(layout);
    const source = layout.segments[from];
    if (to !== 'new' && (!inRange(layout, to) || to === from || !sameTarget(source.target, layout.segments[to].target)))
        return clone(layout);
    let out = clone(layout);
    const graphSpec = out.segments[from].graph?.reading === id ? out.segments[from].graph : null;
    const target = {...out.segments[from].target};
    const before = out.segments.length;
    out = removeItem(out, from, id);
    const removed = out.segments.length < before;
    if (to === 'new') {
        out.segments.splice(removed ? from : from + 1, 0, segment(target, [id], {graph: graphSpec}));
        return sanitizeLayout(out);
    }
    const at = removed && to > from ? to - 1 : to;
    out = addItem(out, at, id);
    if (graphSpec && !out.segments[at].graph)
        out.segments[at].graph = graphSpec;
    return sanitizeLayout(out);
}

export function moveSegment(layout, index, delta) {
    const out = clone(layout);
    if (!inRange(out, index))
        return out;
    const to = Math.max(0, Math.min(out.segments.length - 1, index + delta));
    out.segments.splice(to, 0, ...out.segments.splice(index, 1));
    return out;
}

/**
 * Adds a segment at the end with one reading of `target` (default: the
 * selected node): `id`, or the first reading of that target not shown yet.
 */
export function addSegment(layout, id = null, target = SELECTED_NODE) {
    const out = clone(layout);
    if (out.segments.length >= MAX_SEGMENTS)
        return out;
    const t = sanitizeTarget(target);
    const kind = targetKind(t);
    const shown = new Set(out.segments.filter(s => sameTarget(s.target, t)).flatMap(s => s.items));
    const pick = READING[kind][id] ? id : (READINGS[kind].find(r => !shown.has(r.id)) ?? READINGS[kind][0]).id;
    out.segments.push(segment(t, [pick]));
    return out;
}

/** "Pin to bar" for a guest: a segment with its name, CPU and RAM at the end. */
export function pinGuest(layout, server, vmid) {
    const out = clone(layout);
    const target = sanitizeTarget({server, guest: vmid});
    if (out.segments.length >= MAX_SEGMENTS || targetKind(target) !== 'guest')
        return out;
    out.segments.push(segment(target, ['name', 'cpu', 'mem']));
    return sanitizeLayout(out);
}

export function removeSegment(layout, index) {
    const out = clone(layout);
    if (inRange(out, index))
        out.segments.splice(index, 1);
    return out;
}

/**
 * Sets segment `index`'s template; '' goes back to the readings joined by
 * " · ". A template that uses no reading keeps the segment's readings out.
 */
export function setTemplate(layout, index, template) {
    const out = clone(layout);
    if (!inRange(out, index))
        return out;
    const s = out.segments[index];
    s.template = String(template ?? '').slice(0, MAX_TEMPLATE);
    const next = sanitizeSegment(s);
    if (next)
        out.segments[index] = next;
    return out;
}

/**
 * Changes `icon`, `graph` (null turns it off; an object is merged into the
 * current graph) or `target` of segment `index`. A new target keeps the
 * readings it also has and drops the others.
 */
export function setSegment(layout, index, patch) {
    const out = clone(layout);
    if (!inRange(out, index) || !patch || typeof patch !== 'object')
        return out;
    const s = {...out.segments[index]};
    if ('target' in patch)
        s.target = sanitizeTarget(patch.target);
    const kind = targetKind(s.target);
    if ('icon' in patch)
        s.icon = patch.icon;
    if ('graph' in patch) {
        const base = s.graph ?? graph(GRAPH_READINGS[kind].find(r => s.items.includes(r)) ?? GRAPH_READINGS[kind][0]);
        s.graph = patch.graph === null ? null : {...base, ...patch.graph};
    }
    out.segments[index] = sanitizeSegment(s) ?? out.segments[index];
    return out;
}

/** The template a segment uses: its own, or its readings joined. */
export function effectiveTemplate(seg) {
    const kind = targetKind(seg.target);
    return seg.template || seg.items.map(id => READING[kind][id].template).join(SEPARATOR);
}

// ---- what the layout needs from pved ---------------------------------------------

/**
 * What rendering `layout` needs beyond GetValues: `keys`, the value keys its
 * graphs draw (for PveClient.setHistoryKeys), `span`, the longest graph
 * window in seconds, and `watches`, the guests ({server, vmid}) whose
 * details a segment shows (for PveClient.watch). Depends on the snapshot
 * only through which server and node '' targets resolve to.
 */
export function layoutNeeds(layout, snapshot, options = {}) {
    const keys = [];
    const watches = [];
    let span = 0;
    for (const seg of layout.segments) {
        const kind = targetKind(seg.target);
        const t = resolveTarget(seg.target, snapshot, options);
        if (seg.graph) {
            const key = seriesKey(t, READING[kind][seg.graph.reading]);
            if (key && !keys.includes(key))
                keys.push(key);
            span = Math.max(span, seg.graph.window);
        }
        if (kind === 'guest' && t.exists) {
            const used = [...(seg.template ? templateReadings(seg.template, kind) : seg.items)];
            if (seg.graph)
                used.push(seg.graph.reading);
            if (used.some(id => READING[kind][id]?.details) &&
                !watches.some(w => w.server === t.server && w.vmid === t.guest.vmid))
                watches.push({server: t.server, vmid: t.guest.vmid});
        }
    }
    return {keys, span: Math.min(span, HISTORY_MAX_S), watches};
}

// ---- rendering --------------------------------------------------------------------

/** The display settings rendering needs, from a GSettings-like object. */
export function readOptions(settings) {
    const thresholds = {};
    for (const kind of THRESHOLD_KINDS) {
        const def = THRESHOLD_DEFAULTS[kind];
        let warm = def.warm;
        let hot = def.hot;
        try {
            warm = settings.get_int(`${kind}-warm`);
            hot = settings.get_int(`${kind}-hot`);
        } catch {
            // An older schema: keep the defaults.
        }
        thresholds[kind] = {warm, hot};
    }
    return renderOptions({
        server: settings.get_string('server'),
        node: settings.get_string('node'),
        thresholds,
    });
}

/** The colors rendering uses, from a GSettings-like object. */
export function readStyle(settings) {
    return {
        normal: settings.get_string('color-normal'),
        warm: settings.get_string('color-warm'),
        hot: settings.get_string('color-hot'),
        bold: false,
    };
}

const DEFAULT_OPTIONS = Object.freeze({server: '', node: '', thresholds: THRESHOLD_DEFAULTS});
const FULL = Symbol('complete options');

/**
 * Options with every default filled in. Renders reuse the result as is, so
 * callers that render often (the indicator) pass the same object each time.
 */
export function renderOptions(options = {}) {
    if (options?.[FULL])
        return options;
    const out = {...DEFAULT_OPTIONS, ...options, thresholds: {...THRESHOLD_DEFAULTS, ...options?.thresholds}};
    Object.defineProperty(out, FULL, {value: true});
    return out;
}
const optionsWithDefaults = renderOptions;

// Indexes of the snapshot's lists, built once per list (the client shares its
// lists until a property changes).
const nodeIndexes = new WeakMap();
const guestIndexes = new WeakMap();

function nodesByServer(nodes) {
    let index = nodeIndexes.get(nodes);
    if (!index) {
        index = new Map();
        for (const n of nodes) {
            if (!index.has(n.server))
                index.set(n.server, []);
            index.get(n.server).push(n);
        }
        nodeIndexes.set(nodes, index);
    }
    return index;
}

function guestIndex(guests) {
    let index = guestIndexes.get(guests);
    if (!index) {
        index = {byId: new Map(), counts: new Map()};
        for (const g of guests) {
            index.byId.set(`${g.server}/${g.vmid}`, g);
            const c = index.counts.get(g.server) ?? {running: 0, total: 0};
            c.total++;
            if (g.status === 'running')
                c.running++;
            index.counts.set(g.server, c);
        }
        guestIndexes.set(guests, index);
    }
    return index;
}

const EMPTY = Object.freeze([]);

/**
 * What a target points at right now: {kind, server (name), node (name or
 * null), guest (pved's entry or null), serverInfo, exists}. '' for the
 * server is the `server` setting (else the first server); '' for the node
 * is the `node` setting (else the first online node of that server).
 */
export function resolveTarget(target, snapshot, options = {}) {
    const servers = snapshot?.servers ?? EMPTY;
    const kind = targetKind(target);
    const serverInfo = target.server
        ? servers.find(s => s.name === target.server) ?? null
        : pickServer(servers, options.server ?? '');
    const server = serverInfo?.name ?? target.server ?? '';
    const out = {kind, server, node: null, guest: null, serverInfo, exists: false};
    if (!serverInfo)
        return out;
    if (kind === 'guest') {
        out.guest = guestIndex(snapshot.guests ?? EMPTY).byId.get(`${server}/${target.guest}`) ?? null;
        out.exists = out.guest !== null;
        return out;
    }
    const nodes = nodesByServer(snapshot.nodes ?? EMPTY).get(server) ?? EMPTY;
    let node;
    if (kind === 'node' && target.node)
        node = nodes.find(n => n.name === target.node) ?? null;
    else
        node = pickNode(nodes, options.node ?? '');
    out.node = node?.name ?? null;
    out.nodeInfo = node;
    out.exists = kind === 'server' || node !== null;
    return out;
}

/** The value key a reading of a resolved target reads (`suffix` of the reading), or null. */
function valueKey(t, suffix) {
    if (!suffix)
        return null;
    if (t.kind === 'guest')
        return t.guest ? `${t.server}/guest/${t.guest.vmid}/${suffix}` : null;
    return t.node ? `${t.server}/node/${t.node}/${suffix}` : null;
}

function seriesKey(t, info) {
    return info?.series ? valueKey(t, info.series) : null;
}

function lookup(values, key) {
    if (key === null || !values)
        return null;
    const v = values.get ? values.get(key) : values[key];
    return v === undefined || v === null || Number.isNaN(v) ? null : v;
}

const NONE = Object.freeze({text: '--', level: Level.NORMAL, tint: null, dim: false, absent: true, hasValue: false});
const MISSING = Object.freeze({...NONE, absent: false});

function textResult(text, extra = {}) {
    return {text, level: Level.NORMAL, tint: null, dim: false, absent: false, hasValue: true, ...extra};
}

function levelFor(kind, value, thresholds) {
    if (!kind)
        return Level.NORMAL;
    const t = thresholds[kind] ?? THRESHOLD_DEFAULTS[kind];
    const lvl = thresholdLevel(value, t.warm, t.hot);
    return lvl === Level.UNKNOWN ? Level.NORMAL : lvl;
}

/**
 * A function from a placeholder (name, decimals) to what it shows for the
 * resolved target `t`: {text, level, tint, dim, absent, hasValue}. `absent`
 * means the target has no such reading right now (no temperature agent, no
 * guest agent); `hasValue` is false for "--", whose units are then left out.
 */
export function makeResolver(t, snapshot, options = {}) {
    const opt = optionsWithDefaults(options);
    const values = snapshot?.values;
    const kind = t.kind;

    return (name, decimals = null) => {
        const id = readingOf(kind, name);
        if (!id)
            return NONE;
        if (!t.exists)
            return MISSING;
        const info = READING[kind][id];
        if (info.value) {
            const v = lookup(values, valueKey(t, info.value));
            if (v === null)
                return info.optional ? NONE : MISSING;
            let text;
            if (info.format === 'gib')
                text = (v / GIB).toFixed(decimals ?? 1);
            else if (info.format === 'rate')
                text = formatRate(v, decimals);
            else
                text = v.toFixed(decimals ?? 0);
            let lvl = Level.NORMAL;
            if (info.level) {
                const basis = info.series && info.series !== info.value ? lookup(values, valueKey(t, info.series)) : v;
                lvl = levelFor(info.level, basis, opt.thresholds);
            }
            return textResult(text, {level: lvl});
        }
        switch (`${kind}:${name}`) {
        case 'node:name':
            return textResult(t.node);
        case 'node:status': {
            const status = t.nodeInfo?.status ?? 'unknown';
            return textResult(status, {level: status === 'online' ? Level.NORMAL : Level.HOT});
        }
        case 'guest:name':
            return textResult(t.guest.name || String(t.guest.vmid));
        case 'guest:status':
            return textResult(t.guest.status, {dim: t.guest.status !== 'running'});
        case 'server:name':
            return textResult(t.server);
        case 'server:state': {
            const state = t.serverInfo.state;
            return textResult(state, {level: state === 'ok' ? Level.NORMAL : Level.HOT});
        }
        case 'server:running':
        case 'server:guests': {
            const c = guestIndex(snapshot.guests ?? EMPTY).counts.get(t.server) ?? {running: 0, total: 0};
            return textResult(String(name === 'running' ? c.running : c.total));
        }
        default:
            return MISSING;
        }
    };
}

/**
 * The text parts of a template: [{text, reading, level, tint, dim}].
 * A unit glued to a placeholder ("°", "%", " GiB") takes its color and is
 * left out when the reading shows "--".
 */
export function renderTemplate(template, resolve, kind = 'node') {
    const {tokens} = parseTemplate(template, kind);
    const parts = [];
    let last = null;
    for (const t of tokens) {
        if (t.text !== undefined) {
            let text = t.text;
            const glued = last ? GLUED.exec(text) : null;
            if (glued) {
                if (last.hasValue)
                    last.part.text += glued[0];
                text = text.slice(glued[0].length);
            }
            if (text)
                parts.push({text, reading: null, level: Level.NORMAL, tint: null, dim: false});
            last = null;
        } else if (t.name !== undefined) {
            const v = resolve(t.name, t.decimals);
            const part = {text: v.text, reading: readingOf(kind, t.name), level: v.level, tint: v.tint, dim: v.dim};
            parts.push(part);
            last = {part, hasValue: v.hasValue};
        } else {
            parts.push({text: '--', reading: null, level: Level.NORMAL, tint: null, dim: false});
            last = null;
        }
    }
    let room = MAX_TEXT;
    let i = 0;
    for (; i < parts.length && room > 0; i++) {
        if (parts[i].text.length > room)
            parts[i].text = parts[i].text.slice(0, room);
        room -= parts[i].text.length;
    }
    parts.length = i;
    return parts;
}

const LEVEL_RANK = Object.freeze({[Level.UNKNOWN]: 0, [Level.NORMAL]: 0, [Level.WARM]: 1, [Level.HOT]: 2});

/** The smallest range a line spans, per threshold kind, so noise is not drawn as a cliff. */
const MIN_RANGE = Object.freeze({cpu: 20, mem: 20, disk: 20, fs: 20, temp: 10});
const RATE_MIN_RANGE = 10 * 1024;

const levelFns = new WeakMap();
const NORMAL = () => Level.NORMAL;

/** Level of each value of a reading's graph: by its thresholds, the rest normal. */
export function seriesLevelOf(levelKind, options = {}) {
    if (!levelKind)
        return NORMAL;
    const opt = optionsWithDefaults(options);
    let fns = levelFns.get(opt.thresholds);
    if (!fns) {
        fns = {};
        levelFns.set(opt.thresholds, fns);
    }
    fns[levelKind] ??= v => levelFor(levelKind, v, opt.thresholds);
    return fns[levelKind];
}

/**
 * One segment ready to draw: {visible, exists, icon, parts, text, dim,
 * level, tint, showText, graph}. `graph` is null or {key (the value key it
 * draws), reading, kind, width (px), window (s), color ('follow' or
 * '#rrggbb'), levelOf, minRange, percent}.
 */
export function renderSegment(seg, snapshot, options = {}) {
    const opt = optionsWithDefaults(options);
    const kind = targetKind(seg.target);
    const t = resolveTarget(seg.target, snapshot, opt);
    const resolve = makeResolver(t, snapshot, opt);
    let template = seg.template;
    if (!template) {
        const present = seg.items.filter(id => !resolve(id).absent);
        template = (present.length ? present : seg.items).map(id => READING[kind][id].template).join(SEPARATOR);
    }
    const used = templateReadings(template, kind);
    const graphReading = seg.graph?.reading ?? null;
    const visible = used.length === 0 && !graphReading
        ? true
        : used.some(id => !resolve(id).absent) || (graphReading !== null && !resolve(graphReading).absent);

    const parts = renderTemplate(template, resolve, kind);
    let dim = false;
    let level = Level.NORMAL;
    let tint = null;
    let valued = 0;
    let dimmed = 0;
    for (const p of parts) {
        if (!p.reading)
            continue;
        valued++;
        if (p.dim)
            dimmed++;
        if (LEVEL_RANK[p.level] > LEVEL_RANK[level])
            level = p.level;
        tint ??= p.tint;
    }
    dim = valued > 0 && dimmed === valued;

    let icon = seg.icon;
    if (icon === 'auto')
        icon = READING[kind][seg.items[0] ?? graphReading]?.icon ?? (kind === 'guest' ? 'vm' : 'server');
    if (icon === 'none')
        icon = null;

    let graphSpec = null;
    if (seg.graph) {
        const info = READING[kind][graphReading];
        graphSpec = {
            key: t.exists ? seriesKey(t, info) : null,
            reading: graphReading,
            kind: seg.graph.kind,
            width: GRAPH_WIDTHS[seg.graph.width] ?? GRAPH_WIDTHS.medium,
            window: seg.graph.window,
            color: seg.graph.color,
            levelOf: seriesLevelOf(info.level, opt),
            minRange: info.format === 'rate' ? RATE_MIN_RANGE : MIN_RANGE[info.level] ?? 0,
            percent: info.percent,
        };
    }

    let text = '';
    for (const p of parts)
        text += p.text;
    return {
        visible,
        exists: t.exists,
        icon,
        parts,
        text,
        dim,
        level,
        tint,
        showText: !(graphSpec && seg.graph.only) && parts.length > 0,
        graph: graphSpec,
    };
}

/** Every segment of `layout` rendered from a client snapshot. */
export function renderLayout(layout, snapshot, options = {}) {
    const opt = optionsWithDefaults(options);
    return layout.segments.map(seg => renderSegment(seg, snapshot, opt));
}

/** A color setting as "#rrggbb" for Pango, or null (theme color). */
export function colorHex(text) {
    const rgb = parseColor(text);
    if (!rgb)
        return null;
    return `#${rgb.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`;
}

/** The color setting for a level, or '' for the theme color. */
export function levelColor(lvl, style) {
    if (lvl === Level.HOT)
        return style.hot ?? '';
    if (lvl === Level.WARM)
        return style.warm ?? '';
    return style.normal ?? '';
}

const MARKUP_ESCAPES = Object.freeze({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;'});

export function escapeMarkup(text) {
    return String(text).replace(/[&<>"']/g, c => MARKUP_ESCAPES[c]);
}

/**
 * A rendered segment's text as Pango markup: each reading in the color of
 * its level, bold when hot (if `style.bold`), half transparent when dimmed
 * (unless the whole segment is dimmed, which the caller does with opacity).
 * `style` comes from readStyle().
 */
export function segmentMarkup(rendered, style) {
    let body = '';
    for (const p of rendered.parts) {
        const text = escapeMarkup(p.text);
        if (!p.reading) {
            body += text;
            continue;
        }
        const attrs = [];
        const color = colorHex(p.tint ?? levelColor(p.level, style));
        if (color && (p.tint || p.level !== Level.NORMAL))
            attrs.push(`foreground="${color}"`);
        if (p.level === Level.HOT && style.bold)
            attrs.push('weight="bold"');
        if (p.dim && !rendered.dim)
            attrs.push('alpha="50%"');
        body += attrs.length ? `<span ${attrs.join(' ')}>${text}</span>` : text;
    }
    const normal = colorHex(style.normal);
    return normal ? `<span foreground="${normal}">${body}</span>` : body;
}

/** The icon's color: the worst reading's when warm or hot, else the tint, else normal. */
export function segmentColor(rendered, style) {
    if (rendered.level === Level.WARM || rendered.level === Level.HOT)
        return colorHex(levelColor(rendered.level, style));
    return colorHex(rendered.tint ?? style.normal);
}

// ---- sample data for the preview ----------------------------------------------

const SAMPLE_VALUES = Object.freeze({
    'home/node/pve/cpu': 23.4,
    'home/node/pve/mem': 61,
    'home/node/pve/mem_used': 39.2 * GIB,
    'home/node/pve/mem_total': 64 * GIB,
    'home/node/pve/disk': 38,
    'home/node/pve/temp': 54,
    'lab/node/lab1/cpu': 12.5,
    'lab/node/lab1/mem': 44,
    'lab/node/lab1/mem_used': 14.1 * GIB,
    'lab/node/lab1/mem_total': 32 * GIB,
    'lab/node/lab1/disk': 71,
    'lab/node/lab2/cpu': 3.1,
    'lab/node/lab2/mem': 20,
    'lab/node/lab2/disk': 15,
    'home/guest/100/cpu': 5.5,
    'home/guest/100/mem': 45,
    'home/guest/100/netin': 123456,
    'home/guest/100/netout': 45678,
    'home/guest/100/fs': 62,
    'home/guest/101/cpu': 1.2,
    'home/guest/101/mem': 30,
    'home/guest/102/cpu': 0,
    'home/guest/102/mem': 0,
    'lab/guest/200/cpu': 0.4,
    'lab/guest/200/mem': 22,
});

/** What the preview shows when pved does not answer. */
export function sampleSnapshot(nowUs = HISTORY_MAX_S * 1e6) {
    return {
        daemon: 'running',
        configError: '',
        fake: false,
        version: null,
        servers: [{name: 'home', state: 'ok', message: ''}, {name: 'lab', state: 'ok', message: ''}],
        nodes: [
            {server: 'home', name: 'pve', status: 'online'},
            {server: 'lab', name: 'lab1', status: 'online'},
            {server: 'lab', name: 'lab2', status: 'online'},
        ],
        guests: [
            {server: 'home', vmid: 100, kind: 'qemu', node: 'pve', name: 'web', status: 'running'},
            {server: 'home', vmid: 101, kind: 'lxc', node: 'pve', name: 'db', status: 'running'},
            {server: 'home', vmid: 102, kind: 'qemu', node: 'pve', name: 'win11', status: 'stopped'},
            {server: 'lab', vmid: 200, kind: 'lxc', node: 'lab1', name: 'dns', status: 'running'},
        ],
        values: new Map(Object.entries(SAMPLE_VALUES)),
        history: sampleHistory(nowUs),
    };
}

/**
 * An hour of made-up history (one point every 10 s, ending at `nowUs`) for
 * every sample value a graph can draw, as PveClient keeps it.
 */
export function sampleHistory(nowUs = HISTORY_MAX_S * 1e6) {
    const count = HISTORY_MAX_S / 10;
    const t = Array.from({length: count}, (_, i) => nowUs - (count - 1 - i) * 10e6);
    const history = new Map();
    let phase = 0;
    for (const [key, last] of Object.entries(SAMPLE_VALUES)) {
        const suffix = key.slice(key.lastIndexOf('/') + 1);
        if (!['cpu', 'mem', 'disk', 'temp', 'fs', 'netin', 'netout'].includes(suffix))
            continue;
        phase += 1.7;
        const amp = suffix === 'disk' ? 0.5 : Math.max(1, last * 0.35);
        const v = t.map((_, i) => {
            const wave = last + amp * Math.sin(i / 9 + phase) + amp / 3 * Math.sin(i / 2.3 + phase);
            const clamped = ['netin', 'netout'].includes(suffix) ? Math.max(0, wave) : Math.max(0, Math.min(100, wave));
            return Math.round(clamped * 10) / 10;
        });
        v[count - 1] = last;
        history.set(key, {t: [...t], v});
    }
    return history;
}
