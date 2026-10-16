// SPDX-License-Identifier: GPL-3.0-or-later
// Pure view logic: turns what pved publishes into what the panel shows.
// No GNOME imports, so it is unit-tested with node (tests/model.test.js).

export const Level = Object.freeze({
    UNKNOWN: 'unknown',
    NORMAL: 'normal',
    WARM: 'warm',
    HOT: 'hot',
});

function missing(value) {
    return value === null || value === undefined || !Number.isFinite(value);
}

/** Keeps warm < hot no matter what the user typed. */
export function sanitizeThresholds(warm, hot, defaults = {warm: 75, hot: 90}) {
    let w = Number.isFinite(warm) ? warm : defaults.warm;
    const h = Number.isFinite(hot) ? hot : defaults.hot;
    if (w >= h)
        w = h - 1;
    return {warm: w, hot: h};
}

/** Level of any reading (percent or °C) against its thresholds. */
export function level(value, warm, hot) {
    if (missing(value))
        return Level.UNKNOWN;
    const t = sanitizeThresholds(warm, hot);
    if (value >= t.hot)
        return Level.HOT;
    if (value >= t.warm)
        return Level.WARM;
    return Level.NORMAL;
}

export const tempLevel = level;

// ---- formatting -------------------------------------------------------------

/** 23.4 -> "23%", 23.4 with 1 decimal -> "23.4%". */
export function formatPercent(value, decimals = 0) {
    if (missing(value))
        return '--';
    return `${value.toFixed(decimals)}%`;
}

const GIB = 1024 ** 3;

export function formatGiB(bytes) {
    if (missing(bytes))
        return '--';
    return (bytes / GIB).toFixed(1);
}

/** "39.2/64.0 GiB". */
export function formatMemory(used, total) {
    if (missing(used) || missing(total))
        return '--';
    return `${formatGiB(used)}/${formatGiB(total)} GiB`;
}

export function formatTemp(celsius) {
    if (missing(celsius))
        return '--';
    return `${Math.round(celsius)}°`;
}

// ---- nodes ------------------------------------------------------------------

/** The node to show: the wanted one if it exists, else the first online, else the first. */
export function pickNode(nodes, wanted) {
    if (!nodes || nodes.length === 0)
        return null;
    return (wanted ? nodes.find(n => n.name === wanted) : null) ??
        nodes.find(n => n.status === 'online') ?? nodes[0];
}

function lookup(values, key) {
    const v = values?.get ? values.get(key) : values?.[key];
    return v === undefined || Number.isNaN(v) ? null : v;
}

/** The value of `<server>/node/<node>/<what>`, or null. */
export function nodeValue(values, server, node, what) {
    if (!server || !node)
        return null;
    return lookup(values, `${server}/node/${node}/${what}`);
}

/** The value of `<server>/guest/<vmid>/<what>`, or null. */
export function guestValue(values, server, vmid, what) {
    return lookup(values, `${server}/guest/${vmid}/${what}`);
}

// ---- servers ------------------------------------------------------------------

/** The server to show: the wanted one if configured, else the first. */
export function pickServer(servers, wanted) {
    if (!servers || servers.length === 0)
        return null;
    return (wanted ? servers.find(s => s.name === wanted) : null) ?? servers[0];
}

/**
 * Servers in config order, each with its own nodes and guests. A server that
 * is down simply has none: it never affects the others.
 */
export function groupByServer(servers, nodes, guests) {
    return servers.map(s => ({
        name: s.name,
        state: s.state,
        message: s.message,
        nodes: nodes.filter(n => n.server === s.name),
        guests: guests.filter(g => g.server === s.name),
    }));
}

/** The menu rebuilds its list of sections only when this changes. */
export function serverIdsKey(servers) {
    return servers.map(s => s.name).join('\n');
}

/** One section rebuilds only when its nodes or guests appear, vanish or rename. */
export function sectionKey(group) {
    return `${group.nodes.map(n => n.name).join(',')}\n${guestSetKey(group.guests)}`;
}

/** Compact "23% · 61% · 54°" of one node; the temperature only when known. */
export function nodeSummary(values, server, node) {
    const cpu = nodeValue(values, server, node, 'cpu');
    const mem = nodeValue(values, server, node, 'mem');
    const temp = nodeValue(values, server, node, 'temp');
    const parts = [formatPercent(cpu), formatPercent(mem)];
    if (temp !== null)
        parts.push(formatTemp(temp));
    return parts.join(' · ');
}

const ORDER = [Level.UNKNOWN, Level.NORMAL, Level.WARM, Level.HOT];

/** The most severe of several levels. */
export function worstLevel(levels) {
    return levels.reduce((a, b) => (ORDER.indexOf(b) > ORDER.indexOf(a) ? b : a), Level.UNKNOWN);
}

/** Badge text of a server's state in its menu header; '' when ok. */
export function stateBadge(state) {
    switch (state) {
    case 'ok':
        return '';
    case 'offline':
        return 'offline';
    case 'unauthorized':
        return 'auth failed';
    case 'tls-error':
        return 'TLS';
    case 'no-token':
        return 'no token';
    default:
        return 'connecting';
    }
}

// ---- daemon and Proxmox state -------------------------------------------------

/**
 * Text for the states where the panel has nothing to show; null when the
 * readings of the selected server are valid. `daemon` is the client state,
 * `configError` and `server` (the picked {name, state, message}, or null)
 * come from pved. Other servers' states never matter here.
 */
export function statusInfo(daemon, configError, server) {
    if (daemon === 'not-running') {
        return {
            panel: 'pve off',
            menu: 'pved is not running',
            hint: 'Find out why with: pvectl doctor',
        };
    }
    if (daemon !== 'running')
        return {panel: '--', menu: 'Connecting to pved…', hint: ''};
    if (configError)
        return {panel: 'pve conf', menu: 'pved.conf has a problem', hint: configError};
    if (!server)
        return {panel: 'pve setup', menu: 'pve-bar is not configured', hint: 'Run: pvectl setup NAME'};
    const name = server.name;
    switch (server.state) {
    case 'ok':
        return null;
    case 'offline':
        return {panel: 'pve off', menu: `${name} is unreachable`, hint: server.message};
    case 'unauthorized':
        return {panel: 'pve auth', menu: `${name} rejected the API token`, hint: server.message};
    case 'tls-error':
        return {panel: 'pve tls', menu: `Could not verify the certificate of ${name}`, hint: server.message};
    case 'no-token':
        return {
            panel: 'pve key', menu: `No API token for ${name}`,
            hint: server.message || `Run: pvectl setup ${name}`,
        };
    default: // 'connecting' or anything newer
        return {panel: '--', menu: `Connecting to ${name}…`, hint: ''};
    }
}

// ---- guests -----------------------------------------------------------------

const DOTS = Object.freeze({
    running: {dot: '●', cls: 'running'},
    stopped: {dot: '○', cls: 'stopped'},
    paused: {dot: '◐', cls: 'paused'},
    suspended: {dot: '◐', cls: 'paused'},
    prelaunch: {dot: '◐', cls: 'paused'},
});

export function guestDot(status) {
    return DOTS[status] ?? {dot: '◌', cls: 'unknown'};
}

export function kindBadge(kind) {
    return kind === 'lxc' ? 'CT' : 'VM';
}

/**
 * Identity of the guest list. The menu rows are rebuilt only when it changes;
 * a status change is updated in place, so it is not part of the key.
 */
export function guestSetKey(guests) {
    return guests.map(g => `${g.server}|${g.vmid}|${g.name}|${g.kind}`).join('\n');
}

/** "3 running / 5". */
export function guestSummary(guests) {
    const running = guests.filter(g => g.status === 'running').length;
    return `${running} running / ${guests.length}`;
}

/** Display rows, one per guest, in the order pved sent them. */
export function guestRows(guests, values) {
    return guests.map(g => {
        const cpu = guestValue(values, g.server, g.vmid, 'cpu');
        const mem = guestValue(values, g.server, g.vmid, 'mem');
        const live = g.status === 'running';
        const {dot, cls} = guestDot(g.status);
        return {
            vmid: g.vmid,
            title: `${g.vmid} ${g.name}`,
            badge: kindBadge(g.kind),
            status: g.status,
            dot,
            dotClass: cls,
            usage: live ? `${formatPercent(cpu)} · ${formatPercent(mem)}` : '',
        };
    });
}

// ---- rates ----------------------------------------------------------------------

const RATE_UNITS = Object.freeze(['B/s', 'KB/s', 'MB/s', 'GB/s']);

/**
 * Bytes per second, scaled: 512 -> "512 B/s", 1536 -> "1.5 KB/s",
 * 12.3 MiB/s -> "12 MB/s" (one decimal below 10, none above; `decimals`
 * overrides that). Base 1024, as the Proxmox UI.
 */
export function formatRate(bytesPerS, decimals = null) {
    if (missing(bytesPerS))
        return '--';
    let v = Math.max(0, bytesPerS);
    let unit = 0;
    while (v >= 1000 && unit < RATE_UNITS.length - 1) {
        v /= 1024;
        unit++;
    }
    const d = decimals ?? (unit === 0 || v >= 10 ? 0 : 1);
    return `${v.toFixed(d)} ${RATE_UNITS[unit]}`;
}

// ---- thresholds per reading kind ---------------------------------------------

/** Reading kinds with warm/hot thresholds (`<kind>-warm`, `<kind>-hot` settings). */
export const THRESHOLD_KINDS = Object.freeze(['cpu', 'mem', 'disk', 'temp', 'fs']);

/** The schema's defaults, used when a setting is unavailable. */
export const THRESHOLD_DEFAULTS = Object.freeze({
    cpu: Object.freeze({warm: 70, hot: 90}),
    mem: Object.freeze({warm: 80, hot: 95}),
    disk: Object.freeze({warm: 80, hot: 90}),
    temp: Object.freeze({warm: 70, hot: 85}),
    fs: Object.freeze({warm: 80, hot: 90}),
});

// ---- colors -------------------------------------------------------------------

/**
 * A color setting ("#rgb", "#rrggbb", "rgb(…)", "rgba(…)") as [r, g, b] in
 * 0–1 for Cairo; null when empty or unreadable (use the theme color).
 */
export function parseColor(text) {
    const value = String(text ?? '').trim().toLowerCase();
    let m = value.match(/^#([0-9a-f]{3})$/);
    if (m)
        return [...m[1]].map(c => parseInt(c + c, 16) / 255);
    m = value.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/);
    if (m)
        return m.slice(1).map(h => parseInt(h, 16) / 255);
    m = value.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(,[^)]*)?\)$/);
    if (m)
        return m.slice(1, 4).map(n => Math.min(255, Number(n)) / 255);
    return null;
}

// ---- history and graphs -------------------------------------------------------

/** pved keeps one hour; so does the client, at most. */
export const HISTORY_MAX_S = 3600;

/** Graph widths in pixels. */
export const GRAPH_WIDTHS = Object.freeze({narrow: 30, medium: 45, wide: 70});

/** Index of the first time in `times` (sorted) greater than `t`. */
function upperBound(times, t) {
    let lo = 0;
    let hi = times.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (times[mid] <= t)
            lo = mid + 1;
        else
            hi = mid;
    }
    return lo;
}

/**
 * A time-stamped step series ({t: [µs], v: [value or NaN for a gap]}, t
 * ascending) as `width` columns spanning the `spanS` seconds before
 * `nowUs`, oldest first. A value holds until the next point (step
 * semantics); each column is the highest value it holds, so a short spike
 * is never lost, and null where the series has no value (before its first
 * point, or in a gap). Returns null when no column has a value. Pass `out`
 * (an array of `width`) to reuse it instead of allocating.
 */
export function sampleSeries(series, nowUs, spanS, width, out = null) {
    const times = series?.t;
    const values = series?.v;
    if (!times || times.length === 0 || !(width > 0) || !(spanS > 0))
        return null;
    const n = times.length;
    const span = spanS * 1e6;
    const start = nowUs - span;
    const column = span / width;
    const result = out && out.length === width ? out : new Array(width);
    let j = upperBound(times, start) - 1; // the point in force at `start`
    let any = false;
    for (let i = 0; i < width; i++) {
        const end = start + (i + 1) * column;
        let peak = j >= 0 && !Number.isNaN(values[j]) ? values[j] : null;
        while (j + 1 < n && times[j + 1] < end) {
            j++;
            const v = values[j];
            if (!Number.isNaN(v) && (peak === null || v > peak))
                peak = v;
        }
        result[i] = peak;
        if (peak !== null)
            any = true;
    }
    return any ? result : null;
}

/** [low, high] of the known samples, widened to at least `minRange`. */
function sampleRange(samples, minRange) {
    let low = Infinity;
    let high = -Infinity;
    for (const v of samples) {
        if (v === null)
            continue;
        if (v < low)
            low = v;
        if (v > high)
            high = v;
    }
    if (low === Infinity)
        return null;
    if (high - low < minRange) {
        const mid = (high + low) / 2;
        low = mid - minRange / 2;
        high = mid + minRange / 2;
    }
    return [low, high];
}

const NORMAL = () => Level.NORMAL;

/**
 * Pieces of a line graph in a width × height box (y grows down) from
 * sampleSeries' columns: one point per column, newest at the right. A piece
 * is a run of [x, y] points without gaps and with one `level` (from
 * `levelOf`, applied to the value each step ends on), so a line changes
 * color where the reading crosses a threshold. A lone column between gaps
 * is a piece of one point. `minRange` keeps a small wobble from looking
 * like a cliff. Empty when there is nothing to draw.
 */
export function sparklinePieces(samples, width, height, {levelOf = NORMAL, minRange = 0} = {}) {
    if (!samples || samples.length === 0)
        return [];
    const range = sampleRange(samples, minRange);
    if (!range)
        return [];
    const [low, high] = range;
    const pad = 1;
    const y = v => (high > low ? pad + (1 - (v - low) / (high - low)) * (height - 2 * pad) : height / 2);
    const step = width / samples.length;

    const pieces = [];
    let piece = null; // the piece being built
    let prev = null; // the previous point of the current run, with its level
    const endRun = () => {
        if (piece)
            pieces.push(piece);
        else if (prev)
            pieces.push({points: [prev.point], level: prev.level});
        piece = null;
        prev = null;
    };
    for (let i = 0; i < samples.length; i++) {
        const v = samples[i];
        if (v === null) {
            endRun();
            continue;
        }
        const point = [(i + 0.5) * step, y(v)];
        const level = levelOf(v);
        if (prev && !piece) {
            piece = {points: [prev.point, point], level};
        } else if (piece && level !== piece.level) {
            pieces.push(piece);
            piece = {points: [prev.point, point], level};
        } else if (piece) {
            piece.points.push(point);
        }
        prev = {point, level};
    }
    endRun();
    return pieces;
}

/** How many bars of `barWidth` plus `gap` pixels fit in `width`. */
export function barSlots(width, barWidth = 3, gap = 1) {
    return Math.max(1, Math.floor((width + gap) / (barWidth + gap)));
}

/**
 * A bar graph in a width × height box (y grows down) from sampleSeries'
 * columns (sampled with barSlots(width) columns): one bar per column,
 * newest at the right, each with the `level` of its value. `percent`
 * readings span 0–100 %; anything else spans its values like a line, with
 * room below so the lowest bar is still visible. Empty columns draw nothing.
 */
export function barPieces(samples, width, height,
    {levelOf = NORMAL, minRange = 1, percent = false, barWidth = 3, gap = 1} = {}) {
    if (!samples || samples.length === 0)
        return [];
    let low, high;
    if (percent) {
        [low, high] = [0, 100];
    } else {
        const range = sampleRange(samples, Math.max(minRange, 1e-9));
        if (!range)
            return [];
        [low, high] = range;
        low -= (high - low) / 3;
    }
    const step = barWidth + gap;
    const left = width - samples.length * step + gap;
    const bars = [];
    for (let slot = 0; slot < samples.length; slot++) {
        const v = samples[slot];
        if (v === null)
            continue;
        const fraction = Math.max(0, Math.min(1, (v - low) / (high - low)));
        const h = Math.max(1, Math.round(fraction * height));
        bars.push({x: left + slot * step, y: height - h, width: barWidth, height: h, level: levelOf(v)});
    }
    return bars;
}
