// SPDX-License-Identifier: GPL-3.0-or-later
// Pure logic of the menu: the summary in each server's title, the rows of a
// guest's detail view, which history the open menu draws, and MenuNeeds,
// which merges that with what the top bar needs and watches the guest whose
// details are on screen. No GNOME imports, so it is unit-tested with node
// (tests/menu.test.js).

import {MAX_SEGMENTS, targetKind} from './layout.js';
import {
    Level, formatMemory, formatPercent, formatRate, formatTemp, guestDot, guestValue, kindBadge, level, nodeValue,
    stateBadge, worstLevel,
} from './model.js';

/** Seconds of history the node graphs in the menu span. */
export const MENU_NODE_WINDOW = 900;

/** Seconds of history a guest's detail graphs span: the hour pved backfills from rrddata. */
export const GUEST_WINDOW = 3600;

/**
 * How each graph of the menu is drawn: `levelKind` picks the thresholds
 * that colour the line (none: normal colour), `minRange` keeps a small
 * wobble from looking like a cliff.
 */
export const MENU_GRAPHS = Object.freeze({
    cpu: Object.freeze({levelKind: 'cpu', minRange: 20}),
    mem: Object.freeze({levelKind: 'mem', minRange: 20}),
    temp: Object.freeze({levelKind: 'temp', minRange: 10}),
    netin: Object.freeze({levelKind: null, minRange: 10 * 1024}),
    netout: Object.freeze({levelKind: null, minRange: 10 * 1024}),
});

/** Shown in place of `fs` when pved does not get it. */
export const FS_HINT = 'needs the QEMU guest agent and the VM.Monitor privilege';

function known(v) {
    return v !== null && v !== undefined && Number.isFinite(v);
}

function levelOf(value, thresholds, kind) {
    const t = thresholds?.[kind];
    return t ? level(value, t.warm, t.hot) : (known(value) ? Level.NORMAL : Level.UNKNOWN);
}

// ---- formatting -------------------------------------------------------------------

/** 45 -> "45s", 754 -> "12m", 15120 -> "4h 12m", 273600 -> "3d 4h". */
export function formatUptime(seconds) {
    if (!known(seconds) || seconds < 0)
        return '--';
    const s = Math.floor(seconds);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m`;
    const h = Math.floor(m / 60);
    if (h < 24)
        return `${h}h ${m % 60}m`;
    return `${Math.floor(h / 24)}d ${h % 24}h`;
}

// ---- server titles ------------------------------------------------------------------

/**
 * The aggregate of a server's online nodes: mean CPU, RAM used over RAM
 * total (mean of the percentages when a node lacks the byte counts), the
 * hottest temperature, and the worst level of any node's CPU, RAM or
 * temperature, so one hot node of a cluster colours the title.
 */
function serverAggregate(group, values, thresholds) {
    const online = group.nodes.filter(n => n.status === 'online');
    const cpus = [];
    const mems = [];
    let used = 0;
    let total = 0;
    let bytes = online.length > 0;
    let temp = null;
    const levels = [];
    for (const n of online) {
        const v = what => nodeValue(values, group.name, n.name, what);
        const cpu = v('cpu');
        const mem = v('mem');
        const t = v('temp');
        if (cpu !== null)
            cpus.push(cpu);
        if (mem !== null)
            mems.push(mem);
        const u = v('mem_used');
        const m = v('mem_total');
        if (u !== null && m !== null && m > 0) {
            used += u;
            total += m;
        } else {
            bytes = false;
        }
        if (t !== null && (temp === null || t > temp))
            temp = t;
        levels.push(levelOf(cpu, thresholds, 'cpu'), levelOf(mem, thresholds, 'mem'), levelOf(t, thresholds, 'temp'));
    }
    const mean = list => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
    const mem = bytes && total > 0 ? (used / total) * 100 : mean(mems);
    return {cpu: mean(cpus), mem, temp, level: worstLevel(levels), online: online.length};
}

/**
 * Whether a server's section starts expanded: it was expanded before, or it is
 * the only server and the user has not collapsed it.
 */
export function shouldExpand(name, serverCount, expanded, collapsed) {
    if (expanded.has(name))
        return true;
    return serverCount === 1 && !collapsed.has(name);
}

/**
 * A server's title in the menu: {text, level, down}. Up:
 * "home · 23% · 61% · 54° · 23/30" (CPU, RAM, the hottest temperature when
 * known, running/total guests when it has any), with the worst level of its
 * nodes. Down: "lab · offline", hot (its message goes on a row below).
 * Connecting: "lab · connecting", no level.
 */
export function serverSummary(group, values, thresholds) {
    if (group.state !== 'ok') {
        return {
            text: `${group.name} · ${stateBadge(group.state)}`,
            level: group.state === 'connecting' || !group.state ? Level.UNKNOWN : Level.HOT,
            down: true,
        };
    }
    const parts = [group.name];
    const agg = serverAggregate(group, values, thresholds);
    if (group.nodes.length > 0 && agg.online === 0) {
        parts.push('nodes offline');
    } else if (group.nodes.length > 0) {
        parts.push(formatPercent(agg.cpu), formatPercent(agg.mem));
        if (agg.temp !== null)
            parts.push(formatTemp(agg.temp));
    }
    if (group.guests.length > 0) {
        const running = group.guests.filter(g => g.status === 'running').length;
        parts.push(`${running}/${group.guests.length}`);
    }
    return {text: parts.join(' · '), level: agg.level, down: false};
}

/** The menu rebuilds a server's node rows only when this changes. */
export function nodeSetKey(nodes) {
    return nodes.map(n => n.name).join('\n');
}

// ---- guest detail -----------------------------------------------------------------------

/**
 * Everything a guest's detail view shows, from pved's entry for it and the
 * current values: texts, the level of each reading, and whether the disk
 * row shows the hint. Details (uptime, network, fs, maxmem, maxcpu) exist
 * only while the guest is watched; until the first fetch lands they are
 * "--" and the hint stays hidden.
 */
export function guestDetail(guest, values, thresholds) {
    const v = what => guestValue(values, guest.server, guest.vmid, what);
    const running = guest.status === 'running';
    const cpu = v('cpu');
    const mem = v('mem');
    const maxcpu = v('maxcpu');
    const maxmem = v('maxmem');
    const uptime = v('uptime');
    const fs = v('fs');
    const loaded = uptime !== null || maxmem !== null;

    let cpuText = formatPercent(cpu, 1);
    if (maxcpu !== null)
        cpuText += ` · ${maxcpu} vCPU`;
    let memText = formatPercent(mem);
    if (mem !== null && maxmem !== null)
        memText += ` · ${formatMemory((mem / 100) * maxmem, maxmem)}`;

    // fs comes from the QEMU guest agent; containers never have it.
    const fsShown = guest.kind !== 'lxc';
    const fsHint = fsShown && fs === null && running && loaded;
    const {dot, cls} = guestDot(guest.status);
    return {
        title: `${guest.vmid} ${guest.name}`,
        badge: kindBadge(guest.kind),
        dot,
        dotClass: cls,
        status: guest.node ? `${guest.status} · on ${guest.node}` : guest.status,
        uptime: running ? formatUptime(uptime) : '--',
        cpu: {text: cpuText, level: levelOf(cpu, thresholds, 'cpu')},
        mem: {text: memText, level: levelOf(mem, thresholds, 'mem')},
        netin: formatRate(v('netin')),
        netout: formatRate(v('netout')),
        fs: {
            visible: fsShown,
            text: fs !== null ? formatPercent(fs) : '--',
            level: levelOf(fs, thresholds, 'fs'),
            hint: fsHint ? FS_HINT : '',
        },
    };
}

/**
 * Whether a guest can be pinned to the bar: 'pinned' when a segment
 * already targets it (a '' server counts when it is the selected one),
 * 'full' when the layout has no room, else 'available'.
 */
export function pinState(layout, server, vmid, selectedServer = null) {
    const segments = layout?.segments ?? [];
    const pinned = segments.some(s => targetKind(s.target) === 'guest' && s.target.guest === vmid &&
        (s.target.server === server || (s.target.server === '' && selectedServer === server)));
    if (pinned)
        return 'pinned';
    return segments.length >= MAX_SEGMENTS ? 'full' : 'available';
}

/** The label of the pin item for a pinState(). */
export function pinLabel(state) {
    return {pinned: 'Pinned to the bar', full: 'The bar is full (12 segments)'}[state] ?? 'Pin to bar';
}

// ---- history the menu draws ------------------------------------------------------------

/** The value keys a guest's detail view draws. */
export function guestHistoryKeys(server, vmid) {
    return ['cpu', 'mem', 'netin', 'netout'].map(what => `${server}/guest/${vmid}/${what}`);
}

/**
 * The value keys a server's expanded section draws: CPU, RAM and
 * temperature of a single node, the CPU of each node of a cluster.
 */
export function nodeHistoryKeys(group) {
    if (group.nodes.length === 1) {
        const n = group.nodes[0].name;
        return ['cpu', 'mem', 'temp'].map(what => `${group.name}/node/${n}/${what}`);
    }
    return group.nodes.map(n => `${group.name}/node/${n.name}/cpu`);
}

/** Union of several {keys, span}: keys in first-seen order, the longest span. */
export function mergeNeeds(...needs) {
    const keys = [];
    const seen = new Set();
    let span = 0;
    for (const n of needs) {
        for (const key of n?.keys ?? []) {
            if (!seen.has(key)) {
                seen.add(key);
                keys.push(key);
            }
        }
        span = Math.max(span, n?.span ?? 0);
    }
    return {keys, span};
}

/**
 * The history and the guest watch the menu adds to the top bar's. The
 * client hears the union of the bar's keys (setPanel) and the open menu's
 * (setMenu, plus the keys of the guest whose details are shown), and only
 * when that union changes. The guest shown is watched while it is shown
 * (showGuest .. hideGuest); closing the menu hides it and drops every
 * menu-only key; destroy hides it.
 *
 * `client` needs setHistoryKeys(keys, span), watch(server, vmid) and
 * unwatch(server, vmid) (PveClient, which counts watches, so the bar and
 * the menu may watch the same guest).
 */
export class MenuNeeds {
    constructor(client) {
        this._client = client;
        this._panel = {keys: [], span: 0};
        this._menu = {keys: [], span: 0};
        this._detail = null; // {server, vmid}
        this._sent = null;
        this._destroyed = false;
    }

    /** The guest whose details are shown, or null. */
    get detail() {
        return this._detail;
    }

    /** What the bar draws (layoutNeeds' keys and span). */
    setPanel(keys, span) {
        this._panel = {keys: [...keys], span};
        this._apply();
    }

    /** What the open menu's expanded sections draw. */
    setMenu(keys, span = MENU_NODE_WINDOW) {
        this._menu = {keys: [...keys], span: keys.length ? span : 0};
        this._apply();
    }

    /** Shows a guest's details: watches it and draws its history; hides the one shown before. */
    showGuest(server, vmid) {
        if (this._destroyed)
            return;
        if (this._detail?.server === server && this._detail?.vmid === vmid)
            return;
        this._unwatch();
        this._detail = {server, vmid};
        this._client.watch(server, vmid);
        this._apply();
    }

    hideGuest() {
        if (this._unwatch())
            this._apply();
    }

    /** The menu closed: no detail, no menu-only history. */
    menuClosed() {
        this._unwatch();
        this._menu = {keys: [], span: 0};
        this._apply();
    }

    /** Unwatches the guest shown; afterwards nothing reaches the client. */
    destroy() {
        this._unwatch();
        this._destroyed = true;
    }

    /** What the client is asked for: the bar's needs, the menu's and the shown guest's. */
    needs() {
        const detail = this._detail
            ? {keys: guestHistoryKeys(this._detail.server, this._detail.vmid), span: GUEST_WINDOW}
            : null;
        return mergeNeeds(this._panel, this._menu, detail);
    }

    _unwatch() {
        if (!this._detail)
            return false;
        const {server, vmid} = this._detail;
        this._detail = null;
        this._client.unwatch(server, vmid);
        return true;
    }

    _apply() {
        if (this._destroyed)
            return;
        const {keys, span} = this.needs();
        const sent = `${span}\n${keys.join('\n')}`;
        if (sent === this._sent)
            return;
        this._sent = sent;
        this._client.setHistoryKeys(keys, span || 1);
    }
}
