#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A client of pved like the extension, for tools/footprint.sh bench: once
// pved is on the bus (DBUS_SESSION_BUS_ADDRESS) and has had a couple of
// seconds for its first poll, it calls GetHistory once,
// watches COUNT guests of each SERVER (vmids from 100 up) and stays
// connected. It keeps OUT up to date with "<Updated signals so far>
// <keys GetHistory returned>", so the caller can count signals.
//
//   gjs -m watch-client.js OUT COUNT SERVER...

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const NAME = 'io.github.pauloeduardods.PveBar1';
const PATH = '/io/github/pauloeduardods/PveBar1';

const [out, count = '0', ...servers] = ARGV;
let updates = 0;
let historyKeys = 0;

function report() {
    GLib.file_set_contents(out, `${updates} ${historyKeys}\n`);
}

function call(connection, method, args, type) {
    return connection.call_sync(NAME, PATH, NAME, method, args, type,
        Gio.DBusCallFlags.NONE, -1, null);
}

const loop = new GLib.MainLoop(null, false);
let started = false;
Gio.bus_watch_name(Gio.BusType.SESSION, NAME, Gio.BusNameWatcherFlags.NONE,
    connection => {
        if (started)
            return;
        started = true;
        connection.signal_subscribe(NAME, NAME, 'Updated', PATH, null,
            Gio.DBusSignalFlags.NONE, () => {
                updates++;
                report();
            });
        GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 2, () => {
            const [history] = call(connection, 'GetHistory',
                new GLib.Variant('(as)', [[]]),
                new GLib.VariantType('(a{s(adad)})')).deepUnpack();
            historyKeys = Object.keys(history).length;
            report();
            for (const server of servers) {
                for (let i = 0; i < Number(count); i++)
                    call(connection, 'Watch', new GLib.Variant('(su)', [server, 100 + i]), null);
            }
            return GLib.SOURCE_REMOVE;
        });
    },
    null);
loop.run();
