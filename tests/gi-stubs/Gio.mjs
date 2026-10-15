// SPDX-License-Identifier: GPL-3.0-or-later
// A fake session bus for lib/client.js. Tests drive it through
// globalThis.FAKE_BUS (see tests/client.test.js):
//   appear() / vanish()        pved claims or loses its name
//   props[name]                 cached property values
//   values                      what GetValues returns (object)
//   proxy                       the proxy the client created
//   calls                       method calls made through the proxy
//   holdCalls / pending         park method replies; call pending.shift()() to deliver
//   callError                   GLib.Error the next call fails with
//   failProxies                 make proxy creation fail
import GLib from './GLib.mjs';

class FakeProxy {
    constructor() {
        this.handlers = new Map();
        this.nextId = 1;
    }

    get_cached_property(name) {
        const value = globalThis.FAKE_BUS.props[name];
        return value === undefined ? null : new GLib.Variant('?', value);
    }

    connect(signal, handler) {
        const id = this.nextId++;
        this.handlers.set(id, {signal, handler});
        return id;
    }

    disconnect(id) {
        this.handlers.delete(id);
    }

    /** Like GDBusProxy: g-signal handlers get (proxy, sender, name, params). */
    emit(signal, ...args) {
        for (const h of [...this.handlers.values()]) {
            if (h.signal === signal)
                h.handler(this, ...args);
        }
    }

    /** What the bus does for Updated(a{sd}). */
    emitUpdated(dict) {
        this.emit('g-signal', ':1.1', 'Updated', new GLib.Variant('(a{sd})', [dict]));
    }

    call(method, params, _flags, timeout, _cancellable, callback) {
        const bus = globalThis.FAKE_BUS;
        bus.calls.push({method, params, timeout});
        const error = bus.callError;
        bus.callError = null;
        const reply = {error, reply: new GLib.Variant('(a{sd})', [{...bus.values}])};
        const deliver = () => callback(this, reply);
        if (bus.holdCalls)
            bus.pending.push(deliver);
        else
            queueMicrotask(deliver);
    }

    call_finish(result) {
        if (result.error)
            throw result.error;
        return result.reply;
    }
}

let nextWatch = 1;

const Gio = {
    BusType: {SESSION: 'session', SYSTEM: 'system'},
    BusNameWatcherFlags: {AUTO_START: 1},
    DBusProxyFlags: {NONE: 0},
    DBusCallFlags: {NONE: 0},
    Cancellable: class {
        cancel() {
            this.cancelled = true;
        }
    },
    DBusNodeInfo: {
        new_for_xml: () => ({lookup_interface: name => ({name})}),
    },
    DBusProxy: {
        new(_conn, _flags, info, _name, _path, _iface, _cancellable, callback) {
            queueMicrotask(() => {
                const bus = globalThis.FAKE_BUS;
                if (bus.failProxies) {
                    callback(null, {error: new GLib.Error('no such interface')});
                    return;
                }
                const proxy = new FakeProxy();
                bus.proxy = proxy;
                callback(null, {proxy, info});
            });
        },
        new_finish(result) {
            if (result.error)
                throw result.error;
            return result.proxy;
        },
    },
    bus_watch_name(type, name, flags, onAppeared, onVanished) {
        const id = nextWatch++;
        Object.assign(globalThis.FAKE_BUS, {
            watch: {id, type, name, flags},
            appear: () => onAppeared({fake: 'connection'}, name, ':1.1'),
            vanish: () => onVanished(null, name),
        });
        return id;
    },
    bus_unwatch_name(id) {
        globalThis.FAKE_BUS.unwatched.push(id);
    },
};
export default Gio;
