// SPDX-License-Identifier: GPL-3.0-or-later
// PveClient: the extension's only link to Proxmox. It watches pved on the
// session bus, keeps a proxy for its interface and a map of every value
// (seeded by GetValues, kept current by the Updated signal). It reports one
// of three states: 'connecting', 'running' or 'not-running'.
//
// It also keeps the history of the keys its user draws (setHistoryKeys):
// one GetHistory call per connection (and one per newly wanted key), then
// every Updated is appended locally, so graphs cost no extra D-Bus calls.
// And it asks pved for a guest's details while someone watches it (watch).
// No timers, no network, no files, no subprocesses.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {HISTORY_MAX_S} from './model.js';

export const BUS_NAME = 'io.github.pauloeduardods.PveBar1';
export const OBJECT_PATH = '/io/github/pauloeduardods/PveBar1';
const IFACE = 'io.github.pauloeduardods.PveBar1';

/** GetHistory only copies memory; anything slower is a stuck daemon. */
const HISTORY_TIMEOUT_MS = 5000;

/** A series never holds more points than this, whatever pved sends. */
const MAX_POINTS = 4096;

const INTROSPECTION = `
<node>
  <interface name="${IFACE}">
    <property name="Version" type="s" access="read"/>
    <property name="ApiVersion" type="u" access="read"/>
    <property name="Fake" type="b" access="read"/>
    <property name="ConfigError" type="s" access="read"/>
    <property name="Servers" type="a(sss)" access="read"/>
    <property name="Nodes" type="a(sss)" access="read"/>
    <property name="Guests" type="a(sussss)" access="read"/>
    <method name="GetValues">
      <arg name="values" type="a{sd}" direction="out"/>
    </method>
    <method name="GetHistory">
      <arg name="keys" type="as" direction="in"/>
      <arg name="history" type="a{s(adad)}" direction="out"/>
    </method>
    <method name="Watch">
      <arg name="server" type="s" direction="in"/>
      <arg name="vmid" type="u" direction="in"/>
    </method>
    <method name="Unwatch">
      <arg name="server" type="s" direction="in"/>
      <arg name="vmid" type="u" direction="in"/>
    </method>
    <signal name="Updated">
      <arg name="values" type="a{sd}"/>
    </signal>
  </interface>
</node>`;

let nodeInfo = null;
function interfaceInfo() {
    nodeInfo ??= Gio.DBusNodeInfo.new_for_xml(INTROSPECTION);
    return nodeInfo.lookup_interface(IFACE);
}

function newProxy(connection, cancellable) {
    return new Promise((resolve, reject) => {
        Gio.DBusProxy.new(
            connection, Gio.DBusProxyFlags.NONE, interfaceInfo(),
            BUS_NAME, OBJECT_PATH, IFACE, cancellable,
            (_source, result) => {
                try {
                    resolve(Gio.DBusProxy.new_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
    });
}

/** `(a{..})` or `a{..}`, unpacked, to an object. */
function dictFrom(variant) {
    const unpacked = variant?.deepUnpack();
    const dict = Array.isArray(unpacked) ? unpacked[0] : unpacked;
    return dict ?? {};
}

function nowUs() {
    return GLib.get_monotonic_time();
}

/** Appends a point to a step series and drops what is older than the span. */
function append(series, t, v, spanUs) {
    series.t.push(t);
    series.v.push(v);
    trim(series, t - spanUs);
}

/** Drops the points before `cutoff`, keeping the one in force at it. */
function trim(series, cutoff) {
    const {t, v} = series;
    let drop = 0;
    while (drop + 1 < t.length && t[drop + 1] <= cutoff)
        drop++;
    drop = Math.max(drop, t.length - MAX_POINTS);
    if (drop > 0) {
        t.splice(0, drop);
        v.splice(0, drop);
    }
}

export class PveClient {
    /**
     * @param {(changed: object|null) => void} onChange called on every
     *   state, property, value or history change. `changed` is the Updated
     *   dictionary (key -> value) when only those values changed, null when
     *   anything may have (state, properties, GetValues, history loaded).
     */
    constructor(onChange) {
        this._onChange = onChange;
        this._daemon = 'connecting';
        this._proxy = null;
        this._signalIds = [];
        this._values = new Map();
        // Keys an Updated touched while GetValues was in flight: newer than its reply.
        this._fresh = null;
        // GetValues answered for this connection: history can be fetched.
        this._ready = false;
        this._generation = 0;
        this._snapshot = null;
        // History: key -> {t: [µs], v: [value, NaN for a gap]}, for the wanted keys only.
        this._historyKeys = new Set();
        this._history = new Map();
        this._spanUs = HISTORY_MAX_S * 1e6;
        // Guests watched: "server/vmid" -> {server, vmid, count}.
        this._watches = new Map();
        this._cancellable = new Gio.Cancellable();
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.AUTO_START,
            connection => this._onAppeared(connection),
            () => this._onVanished());
    }

    get state() {
        return this._daemon;
    }

    /**
     * Everything pved currently publishes. `values` is the live map of
     * "home/node/pve/cpu" -> number and `history` the live map of key ->
     * {t, v} step series (see setHistoryKeys); read them, do not modify
     * them. The rest is rebuilt only when a property or the state changes,
     * and shared, so callers must not modify it either.
     */
    snapshot() {
        this._snapshot ??= this._buildSnapshot();
        return this._snapshot;
    }

    _buildSnapshot() {
        const p = this._proxy;
        const prop = name => p?.get_cached_property(name)?.deepUnpack();
        return {
            daemon: this._daemon,
            configError: prop('ConfigError') ?? '',
            fake: prop('Fake') === true,
            version: prop('Version') ?? null,
            apiVersion: prop('ApiVersion') ?? null,
            servers: (prop('Servers') ?? []).map(([name, state, message]) => ({name, state, message})),
            nodes: (prop('Nodes') ?? []).map(([server, name, status]) => ({server, name, status})),
            guests: (prop('Guests') ?? []).map(
                ([server, vmid, kind, node, name, status]) => ({server, vmid, kind, node, name, status})),
            values: this._values,
            history: this._history,
        };
    }

    // ---------------------------------------------------------------- history

    /**
     * The value keys whose history the caller draws, and the longest span it
     * draws in seconds (at most an hour). New keys are fetched once with
     * GetHistory; keys no longer wanted are dropped. Calling it again with
     * the same keys does nothing.
     */
    setHistoryKeys(keys, spanS = HISTORY_MAX_S) {
        const span = Math.max(1, Math.min(HISTORY_MAX_S, Number(spanS) || HISTORY_MAX_S));
        const spanUs = span * 1e6;
        const shrunk = spanUs < this._spanUs;
        this._spanUs = spanUs;
        const wanted = new Set(keys);
        for (const key of this._historyKeys) {
            if (!wanted.has(key)) {
                this._historyKeys.delete(key);
                this._history.delete(key);
            }
        }
        const added = [];
        for (const key of wanted) {
            if (!this._historyKeys.has(key)) {
                this._historyKeys.add(key);
                added.push(key);
            }
        }
        if (shrunk) {
            const cutoff = nowUs() - spanUs;
            for (const series of this._history.values())
                trim(series, cutoff);
        }
        if (added.length > 0 && this._ready)
            this._loadHistory(added, this._generation);
    }

    /** Starts the series of `keys` from the current values (step semantics). */
    _seed(keys, now) {
        for (const key of keys) {
            const v = this._values.get(key);
            if (v !== undefined && !this._history.has(key))
                this._history.set(key, {t: [now], v: [v]});
        }
    }

    /**
     * Fills the history of `keys` from pved. A pved without GetHistory (API
     * 1) leaves them as seeded: they grow from here. Points appended while
     * the call was in flight are kept after pved's.
     */
    async _loadHistory(keys, generation) {
        const proxy = this._proxy;
        const sent = nowUs();
        this._seed(keys, sent);
        const api = proxy?.get_cached_property('ApiVersion')?.deepUnpack();
        if (!proxy || (typeof api === 'number' && api < 2))
            return;
        let reply;
        try {
            reply = dictFrom(await this._call(proxy, 'GetHistory',
                new GLib.Variant('(as)', [keys]), HISTORY_TIMEOUT_MS));
        } catch (e) {
            if (generation === this._generation)
                console.debug(`[pve-bar] no history from pved: ${e.message}`);
            return;
        }
        if (generation !== this._generation)
            return;
        const now = nowUs();
        let loaded = false;
        for (const key of keys) {
            const entry = reply[key];
            if (!this._historyKeys.has(key) || !Array.isArray(entry))
                continue;
            const [ages, values] = entry;
            if (!Array.isArray(ages) || !Array.isArray(values))
                continue;
            const series = {t: [], v: []};
            const n = Math.min(ages.length, values.length);
            for (let i = 0; i < n; i++) {
                const t = now - ages[i] * 1e6;
                if (Number.isFinite(t) && (series.t.length === 0 || t >= series.t[series.t.length - 1])) {
                    series.t.push(t);
                    series.v.push(typeof values[i] === 'number' ? values[i] : NaN);
                }
            }
            const local = this._history.get(key);
            const last = series.t.length ? series.t[series.t.length - 1] : -Infinity;
            if (local) {
                // Only what Updated appended after the call was sent; the
                // seed is in pved's reply already, at its real time.
                for (let i = 0; i < local.t.length; i++) {
                    if (local.t[i] > sent && local.t[i] > last) {
                        series.t.push(local.t[i]);
                        series.v.push(local.v[i]);
                    }
                }
            }
            if (series.t.length === 0)
                continue;
            trim(series, now - this._spanUs);
            this._history.set(key, series);
            loaded = true;
        }
        if (loaded)
            this._onChange(null);
    }

    // ---------------------------------------------------------------- watches

    /**
     * Asks pved for this guest's details (network, disk inside the guest,
     * uptime) every poll until the matching unwatch. Counted: two watches of
     * one guest need two unwatches. Re-issued when pved restarts.
     */
    watch(server, vmid) {
        const key = `${server}/${vmid}`;
        const entry = this._watches.get(key);
        if (entry) {
            entry.count++;
            return;
        }
        this._watches.set(key, {server, vmid, count: 1});
        if (this._proxy)
            this._sendWatch('Watch', server, vmid);
    }

    unwatch(server, vmid) {
        const key = `${server}/${vmid}`;
        const entry = this._watches.get(key);
        if (!entry)
            return;
        if (--entry.count > 0)
            return;
        this._watches.delete(key);
        if (this._proxy)
            this._sendWatch('Unwatch', server, vmid);
    }

    /** The guests watched now, as "server/vmid". */
    get watched() {
        return [...this._watches.keys()];
    }

    /** `detached`: fire and forget, even after destroy() cancels the rest. */
    _sendWatch(method, server, vmid, detached = false) {
        const proxy = this._proxy;
        const api = proxy.get_cached_property('ApiVersion')?.deepUnpack();
        if (typeof api === 'number' && api < 2)
            return; // pved before Watch: guests simply have no details
        const params = new GLib.Variant('(su)', [server, vmid]);
        if (detached) {
            proxy.call(method, params, Gio.DBusCallFlags.NONE, -1, null, null);
            return;
        }
        const generation = this._generation;
        this._call(proxy, method, params, -1).catch(e => {
            if (generation === this._generation)
                console.warn(`[pve-bar] ${method} ${server}/${vmid}: ${e.message}`);
        });
    }

    // ---------------------------------------------------------------- bus

    _call(proxy, method, params, timeoutMs) {
        return new Promise((resolve, reject) => {
            proxy.call(method, params, Gio.DBusCallFlags.NONE, timeoutMs, this._cancellable,
                (_proxy, result) => {
                    try {
                        resolve(proxy.call_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    async _onAppeared(connection) {
        const generation = ++this._generation;
        try {
            const proxy = await newProxy(connection, this._cancellable);
            if (generation !== this._generation)
                return; // vanished or destroyed meanwhile
            this._dropProxy();
            this._proxy = proxy;
            this._signalIds.push(
                proxy.connect('g-properties-changed', () => {
                    this._snapshot = null;
                    this._onChange(null);
                }),
                proxy.connect('g-signal', (_proxy, _sender, name, params) => {
                    if (name === 'Updated')
                        this._merge(dictFrom(params));
                }));
            this._setDaemon('running');
            for (const {server, vmid} of this._watches.values())
                this._sendWatch('Watch', server, vmid);

            this._fresh = new Set();
            const reply = await this._call(proxy, 'GetValues', null, -1);
            if (generation !== this._generation)
                return; // a stale reply must not overwrite a newer session
            // pved may answer before its first poll (empty) while an Updated
            // with everything races it: never let the reply undo an Updated.
            const fresh = this._fresh;
            this._fresh = null;
            for (const [key, value] of Object.entries(dictFrom(reply))) {
                if (!fresh.has(key) && !Number.isNaN(value))
                    this._values.set(key, value);
            }
            this._ready = true;
            this._onChange(null);
            if (this._historyKeys.size > 0)
                this._loadHistory([...this._historyKeys], generation);
        } catch (e) {
            if (generation !== this._generation)
                return;
            console.error('[pve-bar] could not connect to pved:', e.message);
            if (!this._proxy)
                this._setDaemon('not-running');
        }
    }

    /** NaN means the value no longer exists. */
    _merge(dict) {
        let now = 0;
        for (const key in dict) {
            const value = dict[key];
            this._fresh?.add(key);
            if (Number.isNaN(value))
                this._values.delete(key);
            else
                this._values.set(key, value);
            if (!this._historyKeys.has(key))
                continue;
            now ||= nowUs();
            const series = this._history.get(key);
            if (series)
                append(series, now, value, this._spanUs);
            else if (!Number.isNaN(value))
                this._history.set(key, {t: [now], v: [value]});
        }
        this._onChange(dict);
    }

    _onVanished() {
        this._generation++;
        this._dropProxy();
        this._values = new Map();
        this._history = new Map();
        this._fresh = null;
        this._ready = false;
        this._setDaemon('not-running');
    }

    _setDaemon(daemon) {
        this._daemon = daemon;
        this._snapshot = null;
        this._onChange(null);
    }

    _dropProxy() {
        for (const id of this._signalIds)
            this._proxy?.disconnect(id);
        this._signalIds = [];
        this._proxy = null;
        this._snapshot = null;
    }

    destroy() {
        // pved forgets our watches only when our bus name goes, which is
        // when gnome-shell exits, not when the extension is disabled.
        if (this._proxy) {
            for (const {server, vmid} of this._watches.values())
                this._sendWatch('Unwatch', server, vmid, true);
        }
        this._watches.clear();
        this._generation++;
        this._cancellable.cancel();
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        this._dropProxy();
        this._onChange = () => {};
    }
}
