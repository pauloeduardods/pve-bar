// SPDX-License-Identifier: GPL-3.0-or-later
// The "Alerts" page of the preferences window.
import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {guestFilterRow} from './guestPicker.js';

/**
 * Builds the Adw.PreferencesPage for the alert settings. `daemon` (the
 * window's DaemonLink, optional) lists the guests to pick from.
 */
export function alertsPage(settings, daemon = null) {
    const page = new Adw.PreferencesPage({title: 'Alerts', icon_name: 'preferences-system-notifications-symbolic'});

    const host = new Adw.PreferencesGroup({
        title: 'Hosts',
        description: 'One notification per episode and node. An alert can come again only after ' +
            'the reading drops below the limit by a margin (3 °C, 5 % RAM, 2 % disk).',
    });
    host.add(switchRow(settings, 'alert-temp', 'Temperature'));
    host.add(spinRow(settings, 'alert-temp-limit', 'From (°C)', null, 30, 110));
    host.add(spinRow(settings, 'alert-temp-seconds', 'For at least (seconds)', null, 2, 3600));
    host.add(switchRow(settings, 'alert-mem', 'RAM'));
    host.add(spinRow(settings, 'alert-mem-limit', 'From (%)', null, 10, 100));
    host.add(spinRow(settings, 'alert-mem-seconds', 'For at least (seconds)', null, 2, 3600));
    host.add(switchRow(settings, 'alert-disk', 'Disk'));
    host.add(spinRow(settings, 'alert-disk-limit', 'From (%)', null, 10, 100));
    page.add(host);

    const down = new Adw.PreferencesGroup({title: 'Servers'});
    down.add(switchRow(settings, 'alert-down', 'Unreachable'));
    down.add(spinRow(settings, 'alert-down-seconds', 'Not answering for (seconds)', null, 10, 3600));
    page.add(down);

    const guests = new Adw.PreferencesGroup({title: 'Guests'});
    guests.add(switchRow(settings, 'alert-guest-stopped', 'A guest stops',
        'Only guests that were running when pve-bar saw them.'));
    guests.add(guestFilterRow(settings, 'alert-guests', daemon, 'Only these guests'));
    guests.add(switchRow(settings, 'alert-guest-started', 'A guest starts'));
    page.add(guests);

    const test = new Adw.PreferencesGroup();
    const row = new Adw.ActionRow({title: 'Test notification', subtitle: 'Needs the extension to be enabled.'});
    const button = new Gtk.Button({label: 'Send', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => settings.set_int('alert-test', (settings.get_int('alert-test') + 1) % 1000000));
    row.add_suffix(button);
    row.activatable_widget = button;
    test.add(row);
    page.add(test);
    return page;
}

// Copies of the prefs.js row helpers, kept here so prefs.js stays as is.

function switchRow(settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title});
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    if (subtitle)
        row.subtitle = subtitle;
    row.value = settings.get_int(key);
    row.connect('notify::value', () => settings.set_int(key, Math.round(row.value)));
    return row;
}

