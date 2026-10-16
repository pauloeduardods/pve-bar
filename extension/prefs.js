// SPDX-License-Identifier: GPL-3.0-or-later
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {alertsPage} from './lib/prefs/alerts.js';

export default class PveBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(640, 720);
        window.add(this._panelPage(settings));
        window.add(this._colorsPage(settings));
        window.add(alertsPage(settings));
    }

    // ------------------------------------------------------------ pages

    _panelPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Panel', icon_name: 'video-display-symbolic'});

        const node = new Adw.PreferencesGroup({
            title: 'Shown in the panel',
            description: 'The menu always lists every server.',
        });
        node.add(entryRow(settings, 'server', 'Server name',
            'Empty = the first server in pved.conf'));
        node.add(entryRow(settings, 'node', 'Node name',
            'Empty = the first online node of that server'));
        page.add(node);

        const show = new Adw.PreferencesGroup({title: 'Shown in the top bar'});
        show.add(switchRow(settings, 'show-icons', 'Icons'));
        page.add(show);

        const place = new Adw.PreferencesGroup({title: 'Position'});
        place.add(comboRow(settings, 'panel-position', 'Top bar area', [
            ['left', 'Left'], ['center', 'Center'], ['right', 'Right (next to Wi-Fi)'],
        ]));
        place.add(spinRow(settings, 'panel-index', 'Order within the area', '0 = leftmost', 0, 20));
        page.add(place);
        return page;
    }

    _colorsPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Colors', icon_name: 'applications-graphics-symbolic'});

        const cpu = new Adw.PreferencesGroup({title: 'CPU thresholds (%)'});
        cpu.add(spinRow(settings, 'cpu-warm', 'Warm from', null, 1, 110));
        cpu.add(spinRow(settings, 'cpu-hot', 'Hot from', null, 1, 110));
        page.add(cpu);

        const mem = new Adw.PreferencesGroup({title: 'RAM thresholds (%)'});
        mem.add(spinRow(settings, 'mem-warm', 'Warm from', null, 1, 110));
        mem.add(spinRow(settings, 'mem-hot', 'Hot from', null, 1, 110));
        page.add(mem);

        const temp = new Adw.PreferencesGroup({title: 'Temperature thresholds (°C)'});
        temp.add(spinRow(settings, 'temp-warm', 'Warm from', null, 30, 110));
        temp.add(spinRow(settings, 'temp-hot', 'Hot from', null, 30, 110));
        page.add(temp);

        const colors = new Adw.PreferencesGroup({title: 'Colors'});
        colors.add(colorRow(settings, 'color-normal', 'Normal', 'Empty = theme color'));
        colors.add(colorRow(settings, 'color-warm', 'Warm', null));
        colors.add(colorRow(settings, 'color-hot', 'Hot', null));
        page.add(colors);
        return page;
    }
}

// ------------------------------------------------------------ row helpers

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

/** options: [value, label][] for a string key. Unknown stored values are kept. */
function comboRow(settings, key, title, options) {
    const current = settings.get_string(key);
    if (!options.some(([value]) => value === current))
        options = [...options, [current, `${current} (not found)`]];
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(options.map(([, label]) => label)),
    });
    // Set after construction so it cannot be applied before the model.
    row.selected = options.findIndex(([value]) => value === current);
    row.connect('notify::selected', () => {
        const option = options[row.selected];
        if (option)
            settings.set_string(key, option[0]);
    });
    return row;
}

function colorRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title});
    if (subtitle)
        row.subtitle = subtitle;

    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const rgba = new Gdk.RGBA();
    if (rgba.parse(settings.get_string(key) || '#ffffff'))
        button.rgba = rgba;
    button.connect('notify::rgba', () => settings.set_string(key, button.rgba.to_string()));
    row.add_suffix(button);

    const reset = new Gtk.Button({
        icon_name: 'edit-clear-symbolic',
        tooltip_text: 'Restore default',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    reset.connect('clicked', () => settings.reset(key));
    row.add_suffix(reset);
    return row;
}

function entryRow(settings, key, title, subtitle) {
    const row = new Adw.EntryRow({title, text: settings.get_string(key)});
    if (subtitle)
        row.tooltip_text = subtitle;
    row.connect('changed', () => settings.set_string(key, row.text.trim()));
    return row;
}
