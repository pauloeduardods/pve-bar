// SPDX-License-Identifier: GPL-3.0-or-later
// Smoke test of the Settings pages: builds them in a real GTK window and
// drives them. Run it only through tests/smoke/prefs-smoke.sh, which gives
// it Xvfb, a private session bus, a memory GSettings backend and scratch
// HOME/XDG directories:
//
//   gjs -m tests/smoke/prefs-smoke.js sample|live [preview.png]
//
// `live` expects `pved --fake` on that private bus; `sample` expects no pved.

import Adw from 'gi://Adw';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import System from 'system';

import {alertsPage} from '../../extension/lib/prefs/alerts.js';
import {DaemonLink} from '../../extension/lib/prefs/daemon.js';
import {generalPage} from '../../extension/lib/prefs/generalPage.js';
import {LayoutPage} from '../../extension/lib/prefs/layoutPage.js';
import {thresholdRows, thresholdsPage} from '../../extension/lib/prefs/thresholdsPage.js';
import {renderLayout, sanitizeLayout, serializeLayout} from '../../extension/lib/layout.js';

const [mode = 'sample', png = ''] = ARGV;
const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.path_get_dirname(
    GLib.filename_from_uri(import.meta.url)[0])));

let failures = 0;
function check(ok, what) {
    print(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
    if (!ok)
        failures++;
}

function sleep(ms) {
    return new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        resolve();
        return GLib.SOURCE_REMOVE;
    }));
}

async function until(fn, ms = 5000) {
    const end = Date.now() + ms;
    while (!fn() && Date.now() < end)
        await sleep(50);
    return fn();
}

/** Every descendant of `widget` that `pred` accepts. */
function findAll(widget, pred, out = []) {
    for (let c = widget.get_first_child(); c; c = c.get_next_sibling()) {
        if (pred(c))
            out.push(c);
        findAll(c, pred, out);
    }
    return out;
}

function buttons(root, tooltip) {
    return findAll(root, w => w instanceof Gtk.Button && (w.tooltip_text ?? '').startsWith(tooltip));
}

function savePng(widget, path) {
    const width = widget.get_width();
    const height = widget.get_height();
    const paintable = new Gtk.WidgetPaintable({widget});
    const snapshot = new Gtk.Snapshot();
    paintable.snapshot(snapshot, width, height);
    const node = snapshot.to_node();
    if (!node)
        return false;
    const texture = widget.get_native().get_renderer().render_texture(node, null);
    return texture.save_to_png(path);
}

async function main() {
    Adw.init();
    const settings = new Gio.Settings({schema_id: 'org.gnome.shell.extensions.pve-bar'});
    check(settings.get_string('panel-layout') === '', 'panel-layout starts empty');
    const daemon = new DaemonLink();
    const window = new Adw.PreferencesWindow({default_width: 720, default_height: 900});
    const page = new LayoutPage(settings, window, `${ROOT}/extension`, daemon);
    window.add(page.page);
    window.add(generalPage(settings));
    window.add(thresholdsPage(settings));
    const alerts = alertsPage(settings, daemon);
    window.add(alerts);
    window.present();

    await until(() => daemon.snapshot().daemon !== 'connecting');
    const live = mode === 'live';
    if (live)
        await until(() => daemon.snapshot().servers.length > 0 && daemon.snapshot().values.size > 0);
    await sleep(300);
    const snap = daemon.snapshot();
    check(snap.daemon === (live ? 'running' : 'not-running'), `pved is ${snap.daemon}`);
    const source = page._previewSource.label;
    check(live ? source === 'Live from pved' : source.startsWith('Sample values'), `preview says "${source}"`);

    // Migration happened once, from the MVP settings.
    const stored = settings.get_string('panel-layout');
    check(stored !== '' && JSON.parse(stored).segments.length === 3, 'layout migrated and stored');

    // Target picker: combos from pved, or free text without it.
    const entries = findAll(page.page, w => w instanceof Adw.EntryRow);
    const combos = findAll(page.page, w => w instanceof Adw.ComboRow);
    if (live) {
        check(combos.some(c => c.title === 'Server'), 'target picker offers pved servers');
        const reads = combos.find(c => c.title === 'Reads');
        const labels = [];
        for (let i = 0; i < reads.model.get_n_items(); i++)
            labels.push(reads.model.get_string(i));
        check(labels.includes('Whole server') && labels.some(l => / · .*\((VM|CT)\)$/.test(l)),
            `reads offers nodes, whole server and guests (${labels.length} choices)`);
        // Pick a guest for segment 3 through the combo.
        const guestIndex = labels.findIndex(l => /\((VM|CT)\)$/.test(l));
        const readsRows = combos.filter(c => c.title === 'Reads');
        readsRows[2].selected = guestIndex;
        await sleep(100);
        check(page.layout.segments[2].target.guest > 0, `segment 3 now reads guest ${page.layout.segments[2].target.guest}`);
    } else {
        check(entries.some(e => e.title.startsWith('Server (empty')), 'free-text target entry without pved');
        const server = entries.find(e => e.title.startsWith('Server (empty'));
        server.text = 'Not A Name';
        server.emit('apply');
        check(server.has_css_class('error') && page.lastToast.startsWith('Server names'), 'bad server name refused');
        // Segment 3 to a guest of a typed server.
        const third = findAll(page.page, w => w instanceof Adw.EntryRow && w.title.startsWith('Server (empty'))[2];
        third.text = 'home';
        third.emit('apply');
        await sleep(100);
        check(page.layout.segments[2].target.server === 'home', 'typed server applied');
    }

    // Presets with Undo.
    const before = serializeLayout(page.layout);
    page.applyPreset('graphs');
    await sleep(100);
    check(page.layout.segments.filter(s => s.graph).length === 2, 'Graphs preset applied');
    check(page._undoButton.sensitive, 'Undo offered');
    page.undo();
    await sleep(100);
    check(serializeLayout(page.layout) === before, 'Undo restores the layout');
    check(!page._undoButton.sensitive, 'nothing more to undo');

    // Merge through the buttons: Default preset, CPU into the RAM segment.
    page.applyPreset('default');
    await sleep(100);
    const right = buttons(page.page, 'Move into the segment on the right');
    check(right.length > 0 && right[0].sensitive, 'merge right is offered for the same target');
    right[0].emit('clicked');
    await sleep(100);
    check(page.layout.segments.length === 2 && page.layout.segments[0].items.join() === 'mem,cpu',
        `merged: ${JSON.stringify(page.layout.segments.map(s => s.items))}`);

    // Different targets never merge: the buttons are off.
    page.importText(JSON.stringify({segments: [
        {target: {server: '', node: ''}, items: ['cpu']},
        {target: {server: 'home', guest: 100}, items: ['cpu']},
    ]}));
    await sleep(100);
    const offRight = buttons(page.page, 'Move into the segment on the right');
    check(offRight.length === 2 && offRight.every(b => !b.sensitive), 'merge is off between different targets');

    // Import refuses what is not a layout.
    check(page.importText('{"foo": 1}') === false && page.lastToast.startsWith('Not a pve-bar layout'),
        `broken import refused: ${page.lastToast}`);
    check(page.importText('not json at all') === false, 'non-JSON import refused');
    check(page.importText('{"segments": [{"items": ["cpu"], "template": "{cpu}% {bogus}"}]}') === true &&
        page.lastToast.includes('template mistake'), 'layout with a template mistake imported with a warning');

    // A bad template: error under the field, previewed while typing, applied on Enter.
    page.applyPreset('minimal');
    await sleep(100);
    const template = findAll(page.page, w => w instanceof Adw.EntryRow && w.title.startsWith('Template'))[0];
    template.text = '{cpu}% {nope}';
    check(template.has_css_class('error'), 'bad template marked as an error');
    const help = findAll(page.page, w => w instanceof Adw.ActionRow && w.title === 'Shown as "--" until fixed');
    check(help.length === 1 && help[0].subtitle.includes('{nope}'), 'the error is shown under the field');
    check(page._draft !== null && settings.get_string('panel-layout').includes('"template":""'),
        'typing previews a draft without storing it');
    template.emit('apply');
    await sleep(100);
    check(page.layout.segments[0].template === '{cpu}% {nope}', 'Enter stores the template');
    const rendered = renderLayout(page.layout, page._data().snap, page._options);
    check(rendered[0].text.endsWith('--'), `the mistake renders as "--": ${rendered[0].text}`);

    // Graph controls and the preview's paints.
    page.applyPreset('graphs');
    await sleep(500);
    const paints = page._preview.paints;
    check(paints > 0, `preview painted ${paints} graph(s)`);
    await sleep(1500);
    check(page._preview.paints === paints, 'no repaint without a change (no timers)');
    page._write(page.layout); // an edit repaints
    await sleep(300);
    check(page._preview.paints > paints, 'an edit repaints');
    const spans = findAll(page.page, w => w instanceof Adw.ComboRow && w.title === 'Time span');
    check(spans.length === 2, 'time span controls for both graphs');
    spans[0].selected = 3; // 1 hour
    await sleep(100);
    check(page.layout.segments[0].graph.window === 3600, 'time span set to 1 hour');
    const colorMode = findAll(page.page, w => w instanceof Adw.ComboRow && w.title === 'Graph color')[1];
    colorMode.selected = 1;
    await sleep(100);
    check(page.layout.segments[1].graph.color === '#62a0ea', 'fixed graph color');

    // Thresholds keep warm < hot.
    const [warm, hot] = thresholdRows(settings, 'cpu', 1, 110);
    warm.value = 95;
    check(settings.get_int('cpu-warm') === 95 && settings.get_int('cpu-hot') === 96 && hot.value === 96,
        'warm above hot pushes hot along');
    hot.value = 50;
    check(settings.get_int('cpu-warm') === 49 && settings.get_int('cpu-hot') === 50, 'hot below warm pulls warm');

    // Alerts guest list: checkboxes from pved, or the text entry.
    const guestRow = findAll(alerts, w => w instanceof Adw.ExpanderRow && w.title === 'Only these guests')[0];
    check(Boolean(guestRow), 'alert guest list present');
    if (live) {
        const checks = findAll(guestRow, w => w instanceof Gtk.CheckButton);
        check(checks.length === daemon.snapshot().guests.length, `one checkbox per guest (${checks.length})`);
        checks[1].active = true;
        const g = daemon.snapshot().guests[1];
        check(settings.get_strv('alert-guests').join() === `${g.server}/${g.vmid}`, 'checking a guest stores it');
    } else {
        const entry = findAll(guestRow, w => w instanceof Adw.EntryRow)[0];
        entry.text = 'home/101, lab/200';
        check(settings.get_strv('alert-guests').join() === 'home/101,lab/200', 'text entry stores the list');
    }

    // A layout written by someone else (the extension's Pin to bar) is picked up.
    settings.set_string('panel-layout', serializeLayout(sanitizeLayout({segments: [
        {target: {server: 'home', guest: 100}, items: ['name', 'cpu', 'mem']}]})));
    await sleep(200);
    check(page._expanders.length === 1, 'external layout change rebuilds the page');

    if (png) {
        page.applyPreset('graphs');
        page.importText(JSON.stringify({segments: [
            {target: {server: '', node: ''}, items: ['cpu'], graph: {reading: 'cpu', kind: 'line'}},
            {target: {server: '', node: ''}, items: ['mem'], graph: {reading: 'mem', kind: 'area'}},
            {target: {server: '', node: ''}, items: ['temp']},
            {target: {server: 'home', guest: live ? daemon.snapshot().guests[0].vmid : 100},
                items: ['name', 'cpu'], graph: {reading: 'cpu', kind: 'bars', width: 'narrow'}},
            {target: {server: 'lab'}, template: '{name} {running}/{guests}'},
        ]}));
        await sleep(600);
        check(savePng(page._preview.widget, png), `preview saved to ${png}`);
        const pagePng = png.replace(/\.png$/, '-page.png');
        check(savePng(window, pagePng), `window saved to ${pagePng}`);
        page._expanders[3].expanded = true;
        await sleep(600);
        const segmentPng = png.replace(/\.png$/, '-segment.png');
        check(savePng(page._expanders[3], segmentPng), `expanded segment saved to ${segmentPng}`);
    }

    page.destroy();
    daemon.destroy();
    window.destroy();
}

const loop = new GLib.MainLoop(null, false);
main().catch(e => {
    print(`FAIL exception: ${e}\n${e.stack}`);
    failures++;
}).finally(() => loop.quit());
await loop.runAsync();
print(failures ? `${failures} check(s) failed` : 'all checks passed');
if (failures)
    System.exit(1);
