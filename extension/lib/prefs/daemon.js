// SPDX-License-Identifier: GPL-3.0-or-later
// One PveClient for the whole preferences window, shared by the pages that
// read pved: the layout preview and target pickers, the alert guest list.
// Plain Gio, no timers: pages hear about changes through subscribe().

import {PveClient} from '../client.js';

export class DaemonLink {
    constructor() {
        this._listeners = new Set();
        this._client = new PveClient(changed => {
            for (const listener of [...this._listeners])
                listener(changed);
        });
    }

    /** The PveClient (for setHistoryKeys and watch). */
    get client() {
        return this._client;
    }

    snapshot() {
        return this._client.snapshot();
    }

    /**
     * Calls `listener(changed)` on every client change (see PveClient);
     * returns the function that stops it.
     */
    subscribe(listener) {
        this._listeners.add(listener);
        return () => this._listeners.delete(listener);
    }

    destroy() {
        this._listeners.clear();
        this._client.destroy();
    }
}
