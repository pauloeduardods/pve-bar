#!/usr/bin/env -S gjs -m
// SPDX-License-Identifier: GPL-3.0-or-later
//
// A stand-in for the GNOME Keyring (org.freedesktop.secrets) on whatever
// session bus DBUS_SESSION_BUS_ADDRESS names, for tools/footprint.sh bench.
// Never point it at your real session bus: it would shadow your keyring.
//
//   gjs -m secret-service.js TOKEN
//
// Implements just what pve-sys reads: OpenSession("plain"), SearchItems,
// GetSecrets and Session.Close. Every pve-bar API token lookup finds an item
// whose secret is TOKEN; there are no temperature agent tokens.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const [token] = ARGV;
if (!token) {
    printerr('usage: gjs -m secret-service.js TOKEN');
    imports.system.exit(2);
}

const SESSION = '/org/freedesktop/secrets/session/s1';
const ITEMS = '/org/freedesktop/secrets/collection/login';

const SERVICE_XML = `<node>
  <interface name="org.freedesktop.Secret.Service">
    <method name="OpenSession">
      <arg type="s" direction="in"/><arg type="v" direction="in"/>
      <arg type="v" direction="out"/><arg type="o" direction="out"/>
    </method>
    <method name="SearchItems">
      <arg type="a{ss}" direction="in"/>
      <arg type="ao" direction="out"/><arg type="ao" direction="out"/>
    </method>
    <method name="GetSecrets">
      <arg type="ao" direction="in"/><arg type="o" direction="in"/>
      <arg type="a{o(oayays)}" direction="out"/>
    </method>
  </interface>
</node>`;

const SESSION_XML = `<node>
  <interface name="org.freedesktop.Secret.Session">
    <method name="Close"/>
  </interface>
</node>`;

const service = Gio.DBusExportedObject.wrapJSObject(SERVICE_XML, {
    OpenSession(_algorithm, _input) {
        return [new GLib.Variant('s', ''), SESSION];
    },
    SearchItems(attributes) {
        if (attributes.application !== 'pve-bar' || attributes.kind !== 'api-token')
            return [[], []];
        // Object paths allow [A-Za-z0-9_]; server names also have '-'.
        return [[`${ITEMS}/${attributes.server.replaceAll('-', '_')}`], []];
    },
    GetSecretsAsync([items, session], invocation) {
        const secret = [...new TextEncoder().encode(token)];
        const reply = {};
        for (const item of items)
            reply[item] = [session, [], secret, 'text/plain'];
        invocation.return_value(new GLib.Variant('(a{o(oayays)})', [reply]));
    },
});
const session = Gio.DBusExportedObject.wrapJSObject(SESSION_XML, {Close() {}});

const loop = new GLib.MainLoop(null, false);
Gio.bus_own_name(
    Gio.BusType.SESSION,
    'org.freedesktop.secrets',
    Gio.BusNameOwnerFlags.NONE,
    connection => {
        service.export(connection, '/org/freedesktop/secrets');
        session.export(connection, SESSION);
    },
    null,
    () => {
        printerr('secret-service.js: could not own org.freedesktop.secrets');
        loop.quit();
    }
);
loop.run();
