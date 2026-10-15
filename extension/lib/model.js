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
