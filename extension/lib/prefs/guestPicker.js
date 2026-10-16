// SPDX-License-Identifier: GPL-3.0-or-later
// The guests a "guest stopped" alert covers: a checklist of pved's guests
// ("home/101 · web"), keeping stored entries pved does not list, or a
// comma separated entry while pved is not running.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {guestFilterChoices, hasLists, listsKey, toggleGuestFilter} from './choices.js';

function summary(stored) {
    return stored.length ? stored.join(', ') : 'Every guest';
}

/**
 * An expander row editing the string-array setting `key`. `daemon` is the
 * window's DaemonLink, or null (then always the text entry). The rows
 * inside are rebuilt only when pved's guest list or state changes.
 */
export function guestFilterRow(settings, key, daemon, title) {
    const row = new Adw.ExpanderRow({title, subtitle: summary(settings.get_strv(key)), use_markup: false});
    let children = [];
    let builtKey = null;

    const store = list => {
        settings.set_strv(key, list);
        row.subtitle = summary(list);
    };

    const build = () => {
        const snap = daemon?.snapshot() ?? null;
        const k = listsKey(snap);
        if (k === builtKey)
            return;
        builtKey = k;
        for (const child of children)
            row.remove(child);
        children = [];
        if (hasLists(snap)) {
            for (const choice of guestFilterChoices(snap.guests, settings.get_strv(key))) {
                const check = new Gtk.CheckButton({active: choice.checked, valign: Gtk.Align.CENTER});
                const item = new Adw.ActionRow({title: choice.label, use_markup: false, activatable_widget: check});
                if (!choice.known)
                    item.subtitle = 'pved does not list it now';
                item.add_prefix(check);
                check.connect('toggled', () =>
                    store(toggleGuestFilter(settings.get_strv(key), choice.id, check.active)));
                children.push(item);
            }
            if (children.length === 0)
                children.push(new Adw.ActionRow({title: 'pved lists no guests'}));
        } else {
            const entry = new Adw.EntryRow({
                title: 'server/vmid, comma separated (pved is not running)',
                text: settings.get_strv(key).join(', '),
                tooltip_text: 'e.g. home/101, lab/200. Empty = every guest.',
            });
            entry.connect('changed', () => store(entry.text.split(',').map(x => x.trim()).filter(Boolean)));
            children.push(entry);
        }
        for (const child of children)
            row.add_row(child);
    };

    build();
    if (daemon) {
        const stop = daemon.subscribe(changed => {
            if (changed === null)
                build();
        });
        row.connect('destroy', stop);
    }
    return row;
}
