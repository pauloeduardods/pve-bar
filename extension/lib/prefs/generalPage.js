// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → General: which server and node "selected" means, and where the
// indicator sits in the top bar.
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {hasLists, listsKey, nodePickerChoices, serverPickerChoices} from './choices.js';
import {comboRow, entryRow, spinRow} from './rows.js';

/**
 * A combo row over [value, label] choices whose model is replaced in place
 * (pved's lists change); `onPick(value)` runs only for the user's picks.
 */
function pickerRow(title, subtitle, onPick) {
    const row = new Adw.ComboRow({title, subtitle, model: Gtk.StringList.new([])});
    let values = [];
    let syncing = false;
    row.connect('notify::selected', () => {
        if (!syncing && values[row.selected] !== undefined)
            onPick(values[row.selected]);
    });
    row.setChoices = ({choices, index}) => {
        syncing = true;
        values = choices.map(([v]) => v);
        row.model = Gtk.StringList.new(choices.map(([, label]) => label));
        row.selected = index;
        syncing = false;
    };
    return row;
}

/**
 * Builds the Adw.PreferencesPage for the general settings. `daemon` (the
 * window's DaemonLink, optional) feeds the server and node drop-downs;
 * while pved is not running they are the text entries.
 */
export function generalPage(settings, daemon = null) {
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

    const node = new Adw.PreferencesGroup({
        title: 'Selected server and node',
        description: 'Segments that read "the selected server" or "the selected node" use these. ' +
            'The menu always lists every server.',
    });
    const serverEntry = entryRow(settings, 'server', 'Server name',
        'Empty = the first server in pved.conf');
    const nodeEntry = entryRow(settings, 'node', 'Node name',
        'Empty = the first online node of that server');
    const serverPick = pickerRow('Server', 'pved is running: pick one of its servers',
        value => settings.set_string('server', value));
    const nodePick = pickerRow('Node', 'The nodes of the server above',
        value => settings.set_string('node', value));
    for (const row of [serverPick, nodePick, serverEntry, nodeEntry])
        node.add(row);
    page.add(node);

    let shown = null;
    let wasLists = null;
    const refresh = () => {
        const snap = daemon?.snapshot() ?? null;
        const lists = hasLists(snap);
        const server = settings.get_string('server');
        const name = settings.get_string('node');
        // Rebuild the drop-downs only when what they show changed.
        const key = `${lists}\n${listsKey(snap)}\n${server}\n${name}`;
        if (key === shown)
            return;
        shown = key;
        serverPick.visible = nodePick.visible = lists;
        serverEntry.visible = nodeEntry.visible = !lists;
        if (lists) {
            serverPick.setChoices(serverPickerChoices(snap, server));
            nodePick.setChoices(nodePickerChoices(snap, server, name));
        } else if (wasLists !== false) {
            // Only when switching over: never rewrite what is being typed.
            if (serverEntry.text !== server)
                serverEntry.text = server;
            if (nodeEntry.text !== name)
                nodeEntry.text = name;
        }
        wasLists = lists;
    };
    refresh();
    const ids = ['server', 'node'].map(k => settings.connect(`changed::${k}`, refresh));
    node.connect('destroy', () => ids.forEach(id => settings.disconnect(id)));
    if (daemon) {
        const stop = daemon.subscribe(changed => {
            if (changed === null)
                refresh();
        });
        node.connect('destroy', stop);
    }

    const place = new Adw.PreferencesGroup({
        title: 'Position',
        description: 'What the top bar shows is on the Layout page.',
    });
    place.add(comboRow(settings, 'panel-position', 'Top bar area', [
        ['left', 'Left'], ['center', 'Center'], ['right', 'Right (next to Wi-Fi)'],
    ]));
    place.add(spinRow(settings, 'panel-index', 'Order within the area', '0 = leftmost', 0, 20));
    page.add(place);
    return page;
}
