// SPDX-License-Identifier: GPL-3.0-or-later
// PveClient: the extension's only link to Proxmox. It watches pved on the
// session bus, keeps a proxy for its interface and a map of every value
// (seeded by GetValues, kept current by the Updated signal). It reports one
// of three states: 'connecting', 'running' or 'not-running'.
// No timers, no network, no files, no subprocesses.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

export const BUS_NAME = 'io.github.pauloeduardods.PveBar1';
export const OBJECT_PATH = '/io/github/pauloeduardods/PveBar1';
const IFACE = 'io.github.pauloeduardods.PveBar1';

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

/** `(a{sd})` or `a{sd}`, unpacked, to an object of key -> number. */
function dictFrom(variant) {
    const unpacked = variant?.deepUnpack();
    const dict = Array.isArray(unpacked) ? unpacked[0] : unpacked;
    return dict ?? {};
}

export class PveClient {
    /** @param {() => void} onChange called on every state, property or value change */
    constructor(onChange) {
        this._onChange = onChange;
        this._daemon = 'connecting';
        this._proxy = null;
        this._signalIds = [];
        this._values = new Map();
        // Keys an Updated touched while GetValues was in flight: newer than its reply.
        this._fresh = null;
        this._generation = 0;
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
     * "node/pve/cpu" -> number; read it, do not modify it.
     */
    snapshot() {
        const p = this._proxy;
        const prop = name => p?.get_cached_property(name)?.deepUnpack();
        return {
            daemon: this._daemon,
            configError: prop('ConfigError') ?? '',
            fake: prop('Fake') === true,
            version: prop('Version') ?? null,
            servers: (prop('Servers') ?? []).map(([name, state, message]) => ({name, state, message})),
            nodes: (prop('Nodes') ?? []).map(([server, name, status]) => ({server, name, status})),
            guests: (prop('Guests') ?? []).map(
                ([server, vmid, kind, node, name, status]) => ({server, vmid, kind, node, name, status})),
            values: this._values,
        };
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
                proxy.connect('g-properties-changed', () => this._onChange()),
                proxy.connect('g-signal', (_proxy, _sender, name, params) => {
                    if (name === 'Updated')
                        this._merge(dictFrom(params));
                }));
            this._setDaemon('running');

            this._fresh = new Set();
            const reply = await this._getValues(proxy);
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
            this._onChange();
        } catch (e) {
            if (generation !== this._generation)
                return;
            console.error('[pve-bar] could not connect to pved:', e.message);
            if (!this._proxy)
                this._setDaemon('not-running');
        }
    }

    _getValues(proxy) {
        return new Promise((resolve, reject) => {
            proxy.call('GetValues', null, Gio.DBusCallFlags.NONE, -1, this._cancellable,
                (_proxy, result) => {
                    try {
                        resolve(proxy.call_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
    }

    /** NaN means the value no longer exists. */
    _merge(dict) {
        for (const [key, value] of Object.entries(dict)) {
            this._fresh?.add(key);
            if (Number.isNaN(value))
                this._values.delete(key);
            else
                this._values.set(key, value);
        }
        this._onChange();
    }

    _onVanished() {
        this._generation++;
        this._dropProxy();
        this._values = new Map();
        this._fresh = null;
        this._setDaemon('not-running');
    }

    _setDaemon(daemon) {
        this._daemon = daemon;
        this._onChange();
    }

    _dropProxy() {
        for (const id of this._signalIds)
            this._proxy?.disconnect(id);
        this._signalIds = [];
        this._proxy = null;
    }

    destroy() {
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
