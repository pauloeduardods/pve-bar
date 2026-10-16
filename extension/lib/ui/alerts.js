// SPDX-License-Identifier: GPL-3.0-or-later
// PveAlerts: the GNOME side of lib/alerts.js. It owns its own PveClient,
// feeds every pved change to an AlertEngine with the monotonic time and the
// settings, and shows notifications from a "pve-bar" source.
// No timers: it only runs when pved reports a change.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {AlertEngine} from '../alerts.js';
import {PveClient} from '../client.js';

/** The settings the engine reads, from GSettings. */
function readSettings(settings) {
    return {
        tempEnabled: settings.get_boolean('alert-temp'),
        tempLimit: settings.get_int('alert-temp-limit'),
        tempSeconds: settings.get_int('alert-temp-seconds'),
        memEnabled: settings.get_boolean('alert-mem'),
        memLimit: settings.get_int('alert-mem-limit'),
        memSeconds: settings.get_int('alert-mem-seconds'),
        diskEnabled: settings.get_boolean('alert-disk'),
        diskLimit: settings.get_int('alert-disk-limit'),
        downEnabled: settings.get_boolean('alert-down'),
        downSeconds: settings.get_int('alert-down-seconds'),
        stoppedEnabled: settings.get_boolean('alert-guest-stopped'),
        stoppedGuests: settings.get_strv('alert-guests'),
        startedEnabled: settings.get_boolean('alert-guest-started'),
    };
}

export class PveAlerts {
    constructor(settings) {
        this._settings = settings;
        this._engine = new AlertEngine();
        this._config = null; // cached settings, dropped when one changes
        this._source = null;
        this._testCount = settings.get_int('alert-test');
        this._settingsId = settings.connect('changed', (_s, key) => this._onSettings(key));
        // History is of no use here.
        this._client = new PveClient(() => this._update(), {history: false});
    }

    _onSettings(key) {
        if (key === 'alert-test') {
            const count = this._settings.get_int('alert-test');
            if (count !== this._testCount) {
                this._testCount = count;
                this._notify('pve-bar test notification', 'Alerts from pve-bar look like this.');
            }
        } else if (key.startsWith('alert-')) {
            this._config = null;
        }
    }

    _update() {
        if (!this._client)
            return;
        this._config ??= readSettings(this._settings);
        const now = GLib.get_monotonic_time() / 1e6;
        const actions = this._engine.update(this._client.snapshot(), now, this._config);
        for (const action of actions)
            this._notify(action.notify.title, action.notify.body);
    }

    _notify(title, body) {
        try {
            if (!this._source) {
                this._source = new MessageTray.Source({title: 'pve-bar', iconName: 'network-server-symbolic'});
                this._source.connect('destroy', () => {
                    this._source = null;
                });
                Main.messageTray.add(this._source);
            }
            this._source.addNotification(new MessageTray.Notification({source: this._source, title, body}));
        } catch (e) {
            console.warn(`[pve-bar] notification source failed, using the default: ${e.message}`);
            Main.notify(title, body);
        }
    }

    destroy() {
        this._settings?.disconnect(this._settingsId);
        this._client?.destroy();
        this._client = null;
        this._source?.destroy();
        this._source = null;
        this._engine = null;
        this._settings = null;
    }
}
