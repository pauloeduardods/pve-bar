// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Thresholds: when a reading turns warm or hot, and the colors.
import Adw from 'gi://Adw';

import {thresholdPair} from './choices.js';
import {colorRow} from './rows.js';

/** Every `<kind>-warm`/`<kind>-hot` pair, with the schema's ranges. */
const KINDS = [
    ['cpu', 'CPU (%)', 'Of a node, a guest or a server', 1, 110],
    ['mem', 'RAM (%)', 'Of a node, a guest or a server', 1, 110],
    ['disk', 'Root disk of a node (%)', null, 1, 110],
    ['temp', 'Temperature (°C)', 'CPU package of a node, from pve-temp-agent', 30, 110],
    ['fs', 'Disk inside a guest (%)', 'From the QEMU guest agent', 1, 110],
];

/** Builds the Adw.PreferencesPage for thresholds and colors. */
export function thresholdsPage(settings) {
    const page = new Adw.PreferencesPage({title: 'Thresholds', icon_name: 'applications-graphics-symbolic'});
    for (const [kind, title, description, min, max] of KINDS) {
        const group = new Adw.PreferencesGroup({title});
        if (description)
            group.description = description;
        for (const r of thresholdRows(settings, kind, min, max))
            group.add(r);
        page.add(group);
    }

    const colors = new Adw.PreferencesGroup({
        title: 'Colors',
        description: 'Used by the readings and, unless a segment picks a fixed color, by the graphs.',
    });
    colors.add(colorRow(settings, 'color-normal', 'Normal', 'Empty = theme color'));
    colors.add(colorRow(settings, 'color-warm', 'Warm', null));
    colors.add(colorRow(settings, 'color-hot', 'Hot', null));
    page.add(colors);
    return page;
}

/** The warm and hot rows of one kind; moving one past the other pushes it along. */
export function thresholdRows(settings, kind, min, max) {
    const make = (which, title) => {
        const row = Adw.SpinRow.new_with_range(min, max, 1);
        row.title = title;
        row.value = settings.get_int(`${kind}-${which}`);
        return row;
    };
    const warm = make('warm', 'Warm from');
    const hot = make('hot', 'Hot from');
    const changed = which => {
        const pair = thresholdPair(which, warm.value, hot.value, min, max);
        for (const [key, row] of [['warm', warm], ['hot', hot]]) {
            if (row.value !== pair[key])
                row.value = pair[key];
            if (settings.get_int(`${kind}-${key}`) !== pair[key])
                settings.set_int(`${kind}-${key}`, pair[key]);
        }
    };
    warm.connect('notify::value', () => changed('warm'));
    hot.connect('notify::value', () => changed('hot'));
    return [warm, hot];
}
