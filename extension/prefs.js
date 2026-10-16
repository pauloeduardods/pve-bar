// SPDX-License-Identifier: GPL-3.0-or-later
// The preferences window: it only assembles the pages in lib/prefs/.
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {alertsPage} from './lib/prefs/alerts.js';
import {DaemonLink} from './lib/prefs/daemon.js';
import {generalPage} from './lib/prefs/generalPage.js';
import {LayoutPage} from './lib/prefs/layoutPage.js';
import {thresholdsPage} from './lib/prefs/thresholdsPage.js';

export default class PveBarPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(680, 780);
        // One link to pved for the window: preview, target pickers, guest list.
        const daemon = new DaemonLink();
        const layout = new LayoutPage(settings, window, this.path, daemon);
        window.add(layout.page);
        window.add(generalPage(settings, daemon));
        window.add(thresholdsPage(settings));
        window.add(alertsPage(settings, daemon));
        window.connect('close-request', () => {
            layout.destroy();
            daemon.destroy();
            return false;
        });
    }
}
