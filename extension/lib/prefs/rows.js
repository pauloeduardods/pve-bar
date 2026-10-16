// SPDX-License-Identifier: GPL-3.0-or-later
// Row helpers shared by the Settings pages.
import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

export function switchRow(settings, key, title, subtitle = null) {
    const row = new Adw.SwitchRow({title});
    if (subtitle)
        row.subtitle = subtitle;
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

export function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    if (subtitle)
        row.subtitle = subtitle;
    row.value = settings.get_int(key);
    row.connect('notify::value', () => {
        const value = Math.round(row.value);
        if (settings.get_int(key) !== value)
            settings.set_int(key, value);
    });
    return row;
}

/** options: [value, label][] for a string key. Unknown stored values are kept. */
export function comboRow(settings, key, title, options) {
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

/**
 * A combo row over [value, label] options that calls `onPick(value)` when
 * the user picks another one than `current`.
 */
export function choiceRow(title, options, current, onPick, subtitle = null) {
    const row = new Adw.ComboRow({title, model: Gtk.StringList.new(options.map(([, label]) => label))});
    if (subtitle)
        row.subtitle = subtitle;
    if (options.length > 12) {
        // Long lists (a server's guests) get a search field.
        row.expression = new Gtk.PropertyExpression(Gtk.StringObject, null, 'string');
        row.enable_search = true;
    }
    const index = options.findIndex(([value]) => value === current);
    row.selected = index < 0 ? 0 : index;
    row.connect('notify::selected', () => {
        const option = options[row.selected];
        if (option && option[0] !== current)
            onPick(option[0]);
    });
    return row;
}

export function colorRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title});
    if (subtitle)
        row.subtitle = subtitle;

    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false}),
        valign: Gtk.Align.CENTER,
    });
    const show = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key) || '#ffffff') && !rgba.equal(button.rgba))
            button.rgba = rgba;
    };
    show();
    button.connect('notify::rgba', () => {
        const value = button.rgba.to_string();
        const rgba = new Gdk.RGBA();
        // Leave '' (theme color) alone until the user picks another color.
        if (rgba.parse(settings.get_string(key) || '#ffffff') && rgba.equal(button.rgba))
            return;
        settings.set_string(key, value);
    });
    const id = settings.connect(`changed::${key}`, show);
    button.connect('destroy', () => settings.disconnect(id));
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

export function entryRow(settings, key, title, subtitle) {
    const row = new Adw.EntryRow({title, text: settings.get_string(key)});
    if (subtitle)
        row.tooltip_text = subtitle;
    row.connect('changed', () => settings.set_string(key, row.text.trim()));
    return row;
}

export function flatButton(icon, tooltip, onClick, sensitive = true) {
    const button = new Gtk.Button({
        icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: ['flat'], sensitive,
    });
    button.connect('clicked', onClick);
    return button;
}

export function infoRow(title, value) {
    const row = new Adw.ActionRow({title, subtitle: value});
    row.add_css_class('property');
    return row;
}
