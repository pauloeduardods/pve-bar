// SPDX-License-Identifier: GPL-3.0-or-later
// What the Settings pages offer to pick from: servers, nodes and guests from
// pved's lists, the guests an alert covers, threshold pairs. Pure: no GNOME
// imports, so it is unit-tested with node (tests/prefs.test.js).

import {
    MAX_ITEMS, READINGS, parseLayout, parseTemplate, sanitizeLayout, sanitizeTarget, serializeLayout, targetKind,
} from '../layout.js';
import {guestSetKey, kindBadge, pickNode, pickServer} from '../model.js';

/** "101 · web (VM)", "200 · dns (CT)". */
export function guestLabel(guest) {
    const name = guest.name || '(no name)';
    return `${guest.vmid} · ${name} (${kindBadge(guest.kind)})`;
}

/**
 * Identity of pved's lists as far as the pickers care: the pages rebuild
 * their pickers only when this changes, never per Updated.
 */
export function listsKey(snapshot) {
    if (!snapshot)
        return '';
    const servers = (snapshot.servers ?? []).map(s => s.name).join(',');
    const nodes = (snapshot.nodes ?? []).map(n => `${n.server}/${n.name}`).join(',');
    return `${snapshot.daemon}\n${servers}\n${nodes}\n${guestSetKey(snapshot.guests ?? [])}`;
}

/** Whether pved can be asked for lists: running and with at least one server. */
export function hasLists(snapshot) {
    return snapshot?.daemon === 'running' && (snapshot.servers ?? []).length > 0;
}

// ---- target picker ------------------------------------------------------------

/** The "reads" choice of a target, as one string: 'node:', 'node:pve', 'guest:101', 'server'. */
export function readsValue(target) {
    switch (targetKind(target)) {
    case 'guest':
        return `guest:${target.guest}`;
    case 'node':
        return `node:${target.node}`;
    default:
        return 'server';
    }
}

/** A server and a reads choice back to a (sanitized) target. */
export function targetFromChoice(server, reads) {
    const value = String(reads ?? '');
    if (value === 'server')
        return sanitizeTarget({server});
    if (value.startsWith('guest:'))
        return sanitizeTarget({server, guest: Number(value.slice(6))});
    return sanitizeTarget({server, node: value.startsWith('node:') ? value.slice(5) : ''});
}

/**
 * What a segment's target picker offers, from a PveClient snapshot:
 * {servers, server, reads, read} where `servers` and `reads` are
 * [value, label] lists and `server`/`read` the index of the current
 * choice. Unknown current values are kept, marked "(not found)", so
 * opening Settings never changes a target by itself. `options.server`
 * and `options.node` are the settings '' targets use.
 */
export function targetOptions(snapshot, target, options = {}) {
    const servers = snapshot?.servers ?? [];
    const picked = pickServer(servers, options.server ?? '');
    const serverChoices = [['', picked ? `Selected server (now ${picked.name})` : 'Selected server'],
        ...servers.map(s => [s.name, s.state === 'ok' ? s.name : `${s.name} (${s.state})`])];
    if (!serverChoices.some(([v]) => v === target.server))
        serverChoices.push([target.server, `${target.server} (not found)`]);

    // The lists of the server the target reads: a '' server reads the selected one.
    const name = target.server || picked?.name || '';
    const nodes = (snapshot?.nodes ?? []).filter(n => n.server === name);
    const guests = (snapshot?.guests ?? []).filter(g => g.server === name);
    const auto = pickNode(nodes, target.server ? '' : options.node ?? '');
    const reads = [['node:', auto ? `Selected or first online node (now ${auto.name})` : 'Selected or first online node'],
        ...nodes.map(n => [`node:${n.name}`, n.status === 'online' ? `Node ${n.name}` : `Node ${n.name} (${n.status})`]),
        ['server', 'Whole server'],
        ...guests.map(g => [`guest:${g.vmid}`, guestLabel(g)])];
    const current = readsValue(target);
    if (!reads.some(([v]) => v === current)) {
        const label = targetKind(target) === 'guest' ? `Guest ${target.guest} (not found)` : `Node ${target.node} (not found)`;
        reads.push([current, label]);
    }
    return {
        servers: serverChoices,
        server: serverChoices.findIndex(([v]) => v === target.server),
        reads,
        read: reads.findIndex(([v]) => v === current),
    };
}

/**
 * The target typed in the free-text fallback (pved not running): `kind` is
 * 'node', 'guest' or 'server', `text` the node name or VMID. null when
 * the text cannot be one (the entry then shows an error).
 */
export function typedTarget(kind, server, text) {
    const s = String(server ?? '').trim();
    const t = String(text ?? '').trim();
    if (s !== '' && sanitizeTarget({server: s}).server !== s)
        return null;
    if (kind === 'server')
        return {server: s};
    if (kind === 'guest') {
        const target = sanitizeTarget({server: s, guest: Number(t)});
        return targetKind(target) === 'guest' && /^[0-9]+$/.test(t) ? target : null;
    }
    const target = sanitizeTarget({server: s, node: t});
    return target.node === t ? target : null;
}

/**
 * Segment `index` reading another target. Readings the new target also has
 * are kept (the first reading of its kind when none is); a template that
 * would not parse for the new kind is dropped, and so is a graph of a
 * reading it lacks. Unlike setSegment, never refuses: the user picked it.
 */
export function retarget(layout, index, target) {
    const out = parseLayout(serializeLayout(layout)).layout;
    const seg = out.segments[index];
    if (!seg)
        return out;
    const next = sanitizeTarget(target);
    const kind = targetKind(next);
    const ids = new Set(READINGS[kind].map(r => r.id));
    seg.target = next;
    if (seg.template && parseTemplate(seg.template, kind).errors.length > 0)
        seg.template = '';
    seg.items = seg.items.filter(id => ids.has(id)).slice(0, MAX_ITEMS);
    if (seg.items.length === 0 && !seg.template)
        seg.items = [READINGS[kind][0].id];
    if (seg.graph && !READINGS[kind].some(r => r.id === seg.graph.reading && r.series))
        seg.graph = null;
    return sanitizeLayout(out);
}

// ---- alerts: guests the stop alert covers --------------------------------------

/**
 * The guest checklist of the Alerts page: one entry per guest pved lists
 * ({id: 'home/101', label, checked, known: true}), then the stored entries
 * pved does not list (known: false), so they are never dropped silently.
 */
export function guestFilterChoices(guests, stored) {
    const wanted = new Set(stored);
    const out = (guests ?? []).map(g => {
        const id = `${g.server}/${g.vmid}`;
        return {id, label: `${id} · ${g.name || '(no name)'}`, checked: wanted.has(id), known: true};
    });
    const listed = new Set(out.map(c => c.id));
    for (const id of stored) {
        if (!listed.has(id)) {
            listed.add(id);
            out.push({id, label: `${id} (not found)`, checked: true, known: false});
        }
    }
    return out;
}

/** `stored` with `id` checked or unchecked, keeping the order. */
export function toggleGuestFilter(stored, id, on) {
    const rest = stored.filter(x => x !== id);
    return on ? [...rest, id] : rest;
}

// ---- thresholds -----------------------------------------------------------------

/**
 * Keeps warm < hot after one of them changed: the other one moves out of
 * the way, within [min, max]. `which` is 'warm' or 'hot'.
 */
export function thresholdPair(which, warm, hot, min, max) {
    let w = Math.max(min, Math.min(max, Math.round(warm)));
    let h = Math.max(min, Math.min(max, Math.round(hot)));
    if (w < h)
        return {warm: w, hot: h};
    if (which === 'warm') {
        h = Math.min(max, w + 1);
        w = Math.min(w, h - 1);
    } else {
        w = Math.max(min, h - 1);
        h = Math.max(h, w + 1);
    }
    return {warm: w, hot: h};
}
