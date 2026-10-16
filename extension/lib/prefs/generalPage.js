// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → General: which server and node "selected" means, and where the
// indicator sits in the top bar.
import Adw from 'gi://Adw';

import {comboRow, entryRow, spinRow} from './rows.js';

/** Builds the Adw.PreferencesPage for the general settings. */
export function generalPage(settings) {
    const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

    const node = new Adw.PreferencesGroup({
        title: 'Selected server and node',
        description: 'Segments that read "the selected server" or "the selected node" use these. ' +
            'The menu always lists every server.',
    });
    node.add(entryRow(settings, 'server', 'Server name',
        'Empty = the first server in pved.conf'));
    node.add(entryRow(settings, 'node', 'Node name',
        'Empty = the first online node of that server'));
    page.add(node);

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
