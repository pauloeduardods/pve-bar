// SPDX-License-Identifier: GPL-3.0-or-later
// Alerts as pure logic: no GNOME imports, no timers. AlertEngine.update()
// takes a PveClient snapshot, the monotonic time in seconds and the settings,
// and returns actions: {notify: {title, body}}. Time only moves when pved
// sends a change (about every 10 s), so "held for N seconds" is measured
// between those updates. Every episode is keyed by server and node, guest or
// server, so several servers never mix.

/** Hysteresis: an episode ends only this far below its limit. */
export const TEMP_HYSTERESIS = 3;
export const MEM_HYSTERESIS = 5;
export const DISK_HYSTERESIS = 2;

export const DEFAULT_ALERT_SETTINGS = Object.freeze({
    tempEnabled: true,
    tempLimit: 85,
    tempSeconds: 60,
    memEnabled: true,
    memLimit: 95,
    memSeconds: 120,
    diskEnabled: true,
    diskLimit: 90,
    downEnabled: true,
    downSeconds: 120,
    stoppedEnabled: false,
    stoppedGuests: Object.freeze([]), // 'server/vmid'; empty = every guest that was running
    startedEnabled: false,
});

/**
 * One reading of one node. An episode starts when the reading reaches the
 * limit, fires once after it held for the set time and ends only when the
 * reading drops below limit - hysteresis.
 */
export class HeatWatch {
    constructor(hysteresis) {
        this.hysteresis = hysteresis;
        this.reset();
    }

    reset() {
        this.since = null; // when the reading reached the limit
        this.fired = false; // notified in this episode
    }

    /** Returns true when the alert should fire now. */
    update(value, now, limit, seconds) {
        if (value === null || value === undefined || !Number.isFinite(value)) {
            // No reading: the streak is broken, but the episode only ends on
            // a reading below the hysteresis band.
            this.since = null;
            return false;
        }
        if (value < limit) {
            this.since = null;
            if (value < limit - this.hysteresis)
                this.fired = false;
            return false;
        }
        this.since ??= now;
        if (this.fired || now - this.since < seconds)
            return false;
        this.fired = true;
        return true;
    }
}

function reading(values, key) {
    const v = values.get(key);
    return v === undefined || Number.isNaN(v) ? null : v;
}

function notify(title, body) {
    return {notify: {title, body}};
}

export class AlertEngine {
    constructor() {
        this._nodes = new Map(); // server -> Map(node -> watches)
        this._down = new Map(); // server -> {since, fired}
        this._guests = new Map(); // 'server/vmid' -> last known status
        this._seen = new Set();
    }

    /**
     * @param snapshot a PveClient.snapshot()
     * @param now monotonic seconds
     * @param settings see DEFAULT_ALERT_SETTINGS
     * @returns {Array<{notify: {title: string, body: string}}>}
     */
    update(snapshot, now, settings = DEFAULT_ALERT_SETTINGS) {
        if (snapshot.daemon !== 'running') {
            // Start over on the next connection: its first snapshot is no
            // transition, and old streaks say nothing about the new data.
            this._reset();
            return [];
        }
        const s = settings === DEFAULT_ALERT_SETTINGS ? settings : {...DEFAULT_ALERT_SETTINGS, ...settings};
        const actions = [];
        this._nodeActions(snapshot, now, s, actions);
        this._serverActions(snapshot, now, s, actions);
        this._guestActions(snapshot, s, actions);
        return actions;
    }

    _reset() {
        if (this._nodes.size)
            this._nodes = new Map();
        if (this._down.size)
            this._down = new Map();
        if (this._guests.size)
            this._guests = new Map();
    }

    _watchesOf(server, node) {
        let byNode = this._nodes.get(server);
        if (!byNode) {
            byNode = new Map();
            this._nodes.set(server, byNode);
        }
        let w = byNode.get(node);
        if (!w) {
            const prefix = `${server}/node/${node}/`;
            w = {
                tempKey: `${prefix}temp`,
                memKey: `${prefix}mem`,
                diskKey: `${prefix}disk`,
                temp: new HeatWatch(TEMP_HYSTERESIS),
                mem: new HeatWatch(MEM_HYSTERESIS),
                disk: new HeatWatch(DISK_HYSTERESIS),
            };
            byNode.set(node, w);
        }
        return w;
    }

    _nodeActions({nodes, values}, now, s, actions) {
        if (!s.tempEnabled && !s.memEnabled && !s.diskEnabled) {
            if (this._nodes.size)
                this._nodes = new Map();
            return;
        }
        for (const n of nodes) {
            const w = this._watchesOf(n.server, n.name);
            if (s.tempEnabled) {
                const v = reading(values, w.tempKey);
                if (w.temp.update(v, now, s.tempLimit, s.tempSeconds)) {
                    actions.push(notify(`${n.name} (${n.server}) is running hot`,
                        `${n.name} on ${n.server} at ${Math.round(v)} °C for over ${s.tempSeconds} s ` +
                        `(alert from ${s.tempLimit} °C).`));
                }
            } else {
                w.temp.reset();
            }
            if (s.memEnabled) {
                const v = reading(values, w.memKey);
                if (w.mem.update(v, now, s.memLimit, s.memSeconds)) {
                    actions.push(notify(`${n.name} (${n.server}) is low on memory`,
                        `${n.name} on ${n.server} uses ${Math.round(v)} % of its RAM for over ` +
                        `${s.memSeconds} s (alert from ${s.memLimit} %).`));
                }
            } else {
                w.mem.reset();
            }
            if (s.diskEnabled) {
                const v = reading(values, w.diskKey);
                if (w.disk.update(v, now, s.diskLimit, 0)) {
                    actions.push(notify(`${n.name} (${n.server}) is running out of disk`,
                        `${n.name} on ${n.server} has ${Math.round(v)} % of its disk used ` +
                        `(alert from ${s.diskLimit} %).`));
                }
            } else {
                w.disk.reset();
            }
        }
    }

    _serverActions({servers}, now, s, actions) {
        if (!s.downEnabled) {
            if (this._down.size)
                this._down = new Map();
            return;
        }
        for (const server of servers) {
            let w = this._down.get(server.name);
            if (!w) {
                w = {since: null, fired: false};
                this._down.set(server.name, w);
            }
            if (server.state === 'ok') {
                w.since = null;
                w.fired = false;
                continue;
            }
            w.since ??= now;
            if (w.fired || now - w.since < s.downSeconds)
                continue;
            w.fired = true;
            const why = server.message ? ` ${server.message}` : '';
            actions.push(notify(`${server.name} is unreachable`,
                `Server ${server.name} has not answered for over ${s.downSeconds} s ` +
                `(${server.state}).${why}`));
        }
        if (this._down.size > servers.length) {
            // Forget servers removed from the configuration.
            for (const name of [...this._down.keys()]) {
                if (!servers.some(x => x.name === name))
                    this._down.delete(name);
            }
        }
    }

    _guestActions({guests}, s, actions) {
        if (!s.stoppedEnabled && !s.startedEnabled) {
            if (this._guests.size)
                this._guests = new Map();
            return;
        }
        const list = s.stoppedGuests;
        const seen = this._seen;
        seen.clear();
        for (const g of guests) {
            const id = `${g.server}/${g.vmid}`;
            seen.add(id);
            const before = this._guests.get(id);
            this._guests.set(id, g.status);
            // Unknown before (first snapshot, new guest, server back): no transition.
            if (before === undefined || before === g.status)
                continue;
            const name = g.name || String(g.vmid);
            // Paused is deliberate: running -> paused is silent, but a guest that
            // then stops (paused -> stopped) or dies is the "stopped" alert.
            const wasUp = before === 'running' || before === 'paused';
            if (wasUp && g.status !== 'running' && g.status !== 'paused'
                && s.stoppedEnabled && (list.length === 0 || list.includes(id))) {
                actions.push(notify(`${name} stopped`,
                    `Guest ${name} (${g.vmid}) on ${g.server} went from ${before} to ${g.status}.`));
            } else if (g.status === 'running' && s.startedEnabled) {
                actions.push(notify(`${name} started`,
                    `Guest ${name} (${g.vmid}) on ${g.server} is running.`));
            }
        }
        if (this._guests.size > seen.size) {
            // A guest that vanished (server down, deleted) forgets its status.
            for (const id of [...this._guests.keys()]) {
                if (!seen.has(id))
                    this._guests.delete(id);
            }
        }
    }
}
