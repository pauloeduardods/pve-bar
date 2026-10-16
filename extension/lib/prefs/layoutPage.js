// SPDX-License-Identifier: GPL-3.0-or-later
// Settings → Layout: the segments of the top bar, what each one reads (a
// node, a guest or a whole server), their templates, icons and graphs, a
// live preview, presets with Undo, and import/export of the layout as JSON.
// All the rules live in lib/layout.js; this file only edits `panel-layout`.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {
    GRAPH_READINGS, ICONS, MAX_SEGMENTS, PLACEHOLDERS, PRESETS, READINGS, UndoStack, addItem, addSegment,
    applyPreset, colorHex, effectiveTemplate, exportLayout, importLayout, layoutNeeds, loadLayout, moveItemTo,
    moveSegment, parseTemplate, readOptions, readStyle, readingInfo, removeItem, removeSegment, sameTarget,
    sampleSnapshot, serializeLayout, setSegment, setTemplate, targetKind, targetLabel,
} from '../layout.js';
import {HISTORY_MAX_S} from '../model.js';
import {hasLists, listsKey, readsValue, retarget, targetFromChoice, targetOptions, typedTarget} from './choices.js';
import {Preview, setPreviewColors} from './preview.js';
import {choiceRow, flatButton} from './rows.js';

/** The largest layout file import reads. */
const MAX_IMPORT_BYTES = 64 * 1024;

/** The sample history ends here; the preview draws samples at this time. */
const SAMPLE_NOW_US = HISTORY_MAX_S * 1e6;

const ICON_LABELS = {cpu: 'CPU', ram: 'RAM', temp: 'Temperature', disk: 'Disk', net: 'Network', server: 'Server', vm: 'VM'};
const ICON_CHOICES = [['auto', 'Automatic (first reading)'], ['none', 'None'],
    ...ICONS.map(id => [id, ICON_LABELS[id] ?? id])];
const KIND_CHOICES = [['line', 'Line'], ['area', 'Filled area'], ['bars', 'Bars']];
const WIDTH_CHOICES = [['narrow', 'Narrow'], ['medium', 'Medium'], ['wide', 'Wide']];
const WINDOW_CHOICES = [[300, '5 minutes'], [900, '15 minutes'], [1800, '30 minutes'], [3600, '1 hour']];
const TYPED_KINDS = [['node', 'A node'], ['guest', 'A guest'], ['server', 'The whole server']];
const SETTINGS_KEYS_OF_OPTIONS = /^(server|node|(cpu|mem|disk|temp|fs)-(warm|hot))$/;

function isDismissed(e) {
    return e instanceof GLib.Error &&
        (e.matches(Gtk.DialogError, Gtk.DialogError.DISMISSED) ||
         e.matches(Gtk.DialogError, Gtk.DialogError.CANCELLED));
}

function jsonFilters() {
    const filter = new Gtk.FileFilter({name: 'Layout files (JSON)'});
    filter.add_pattern('*.json');
    filter.add_mime_type('application/json');
    const store = new Gio.ListStore({item_type: Gtk.FileFilter});
    store.append(filter);
    return {store, filter};
}

export class LayoutPage {
    /**
     * @param {Gio.Settings} settings
     * @param {Adw.PreferencesWindow} window for dialogs and toasts
     * @param {string} extensionPath where the icons are
     * @param {import('./daemon.js').DaemonLink} daemon pved, shared by the pages
     */
    constructor(settings, window, extensionPath, daemon) {
        this._settings = settings;
        this._window = window;
        this._daemon = daemon;
        this._expanded = new Set();
        this._typedKind = new Map(); // segment index -> kind picked in the free-text fallback
        this._rebuildId = 0;
        this._draft = null;
        this._live = null;
        this._needsKey = null;
        this._watching = new Map();
        this._undo = new UndoStack();
        this._options = readOptions(settings);
        this._style = readStyle(settings);
        setPreviewColors(this._style);

        const {layout, migrated} = loadLayout(settings);
        this._layout = layout;
        this._written = migrated ?? settings.get_string('panel-layout');
        if (migrated !== null)
            settings.set_string('panel-layout', migrated);
        this._listsKey = listsKey(daemon.snapshot());

        this.page = new Adw.PreferencesPage({title: 'Layout', icon_name: 'view-grid-symbolic'});
        this._preview = new Preview(extensionPath);
        this.page.add(this._previewGroup());
        this.page.add(this._segmentsGroup());
        this.page.add(this._presetGroup());
        this.page.add(this._backupGroup());
        this._segmentRows = [];
        this._buildSegments();

        this._changedId = settings.connect('changed', (_s, key) => this._onSetting(key));
        this._unsubscribe = daemon.subscribe(changed => this._onDaemon(changed));
        this._updatePreview(null);
    }

    destroy() {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
        if (this._rebuildId) {
            GLib.source_remove(this._rebuildId);
            this._rebuildId = 0;
        }
        this._unsubscribe?.();
        this._unsubscribe = null;
        // The client goes with the window (DaemonLink.destroy), and its watches with it.
    }

    /** The layout as stored now (for tests). */
    get layout() {
        return this._layout;
    }

    // ------------------------------------------------------------ state

    _onSetting(key) {
        if (key === 'panel-layout') {
            const text = this._settings.get_string(key);
            if (text === this._written)
                return;
            this._written = text;
            this._layout = loadLayout(this._settings).layout;
            this._draft = null;
            this._scheduleRebuild();
        } else if (SETTINGS_KEYS_OF_OPTIONS.test(key)) {
            this._options = readOptions(this._settings);
            // The "Selected server/node (now …)" labels follow these.
            if (key === 'server' || key === 'node')
                this._scheduleRebuild();
        } else if (key.startsWith('color-')) {
            this._style = readStyle(this._settings);
            setPreviewColors(this._style);
        } else {
            return;
        }
        this._updatePreview(null);
    }

    _onDaemon(changed) {
        if (changed === null) {
            const key = listsKey(this._daemon.snapshot());
            if (key !== this._listsKey) {
                this._listsKey = key;
                this._scheduleRebuild();
            }
        }
        this._updatePreview(changed);
    }

    /** Stores a new layout; Settings rebuilds its rows unless `rebuild` is false. */
    _write(next, {rebuild = true} = {}) {
        this._layout = next;
        this._draft = null;
        this._typedKind.clear();
        this._written = serializeLayout(next);
        this._settings.set_string('panel-layout', this._written);
        if (rebuild)
            this._scheduleRebuild();
        this._updatePreview(null);
    }

    /** Applies `next`, remembering the current layout for Undo. */
    _writeWithUndo(next, message) {
        this._undo.push(this._layout);
        this._expanded.clear();
        this._write(next);
        this._updateUndo();
        this._toast(message, () => this.undo());
    }

    /** Goes back to the layout before the last preset, import or removal. */
    undo() {
        const previous = this._undo.pop();
        if (previous) {
            this._expanded.clear();
            this._write(previous);
        }
        this._updateUndo();
    }

    _updateUndo() {
        if (this._undoButton)
            this._undoButton.sensitive = this._undo.canUndo;
    }

    _toast(title, undo = null) {
        const toast = new Adw.Toast({title, timeout: 5});
        if (undo) {
            toast.button_label = 'Undo';
            toast.connect('button-clicked', undo);
        }
        this._window.add_toast?.(toast);
        this.lastToast = title;
    }

    /** Rebuilds after the current signal handler returns (never from inside a widget's own signal). */
    _scheduleRebuild() {
        if (this._rebuildId)
            return;
        this._rebuildId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._rebuildId = 0;
            this._buildSegments();
            return GLib.SOURCE_REMOVE;
        });
    }

    // ------------------------------------------------------------ preview

    _previewGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Preview',
            description: 'Drawn by the same code as the top bar.',
        });
        this._previewSource = new Gtk.Label({css_classes: ['dim-label', 'caption'], xalign: 0, valign: Gtk.Align.CENTER});
        group.set_header_suffix(this._previewSource);
        group.add(this._preview.widget);
        return group;
    }

    /** What the preview draws: pved's values and history, or samples. */
    _data() {
        const snap = this._daemon.snapshot();
        if (hasLists(snap))
            return {snap, live: true, now: () => GLib.get_monotonic_time()};
        this._sample ??= {snap: sampleSnapshot(SAMPLE_NOW_US), live: false, now: () => SAMPLE_NOW_US};
        return this._sample;
    }

    /** `changed`: the client's Updated values, or null after an edit or any other change. */
    _updatePreview(changed) {
        const {snap, live, now} = this._data();
        if (live !== this._live) {
            this._live = live;
            changed = null;
        }
        if (changed === null) {
            const daemon = this._daemon.snapshot().daemon;
            let source = 'Live from pved';
            if (!live) {
                const why = {connecting: 'connecting to pved', running: 'pved has no servers'}[daemon] ??
                    'pved is not running';
                source = `Sample values (${why})`;
            }
            if (this._previewSource.label !== source)
                this._previewSource.label = source;
        }
        const layout = this._draft ?? this._layout;
        if (live && changed === null)
            this._updateNeeds(layout, snap);
        const rendered = this._preview.render(layout, snap, this._options, this._style, changed, now);
        this._updateTitles(rendered);
    }

    /**
     * Asks pved for the history the preview's graphs draw and the guest
     * details its segments show. Only after an edit or a list change.
     */
    _updateNeeds(layout, snap) {
        const client = this._daemon.client;
        const needs = layoutNeeds(layout, snap, this._options);
        const key = `${needs.span}\n${needs.keys.join('\n')}\n${needs.watches.map(w => `${w.server}/${w.vmid}`).join('\n')}`;
        if (key === this._needsKey)
            return;
        this._needsKey = key;
        client.setHistoryKeys(needs.keys, needs.span || 1);
        const wanted = new Map(needs.watches.map(w => [`${w.server}/${w.vmid}`, w]));
        for (const [id, w] of this._watching) {
            if (!wanted.has(id))
                client.unwatch(w.server, w.vmid);
        }
        for (const [id, w] of wanted) {
            if (!this._watching.has(id))
                client.watch(w.server, w.vmid);
        }
        this._watching = wanted;
    }

    _updateTitles(rendered) {
        for (const [i, row] of (this._expanders ?? []).entries()) {
            const r = rendered[i];
            if (!r)
                continue;
            const text = r.text || '(empty)';
            const title = r.showText || !r.graph ? text : `${text} (graph only)`;
            if (row.title !== title)
                row.title = title;
        }
    }

    // ------------------------------------------------------------ segments

    _segmentsGroup() {
        this._segmentGroup = new Adw.PreferencesGroup({
            title: 'Segments',
            description: 'Left to right in the top bar. Each segment reads one node, guest or server and ' +
                'has one icon, one text and optionally a graph. Readings merge only into a segment that ' +
                'reads the same target.',
        });
        this._addSegmentButton = flatButton('list-add-symbolic', 'Add a segment',
            () => this._write(addSegment(this._layout)));
        this._segmentGroup.set_header_suffix(this._addSegmentButton);
        return this._segmentGroup;
    }

    /** (Re)creates one expander row per segment. */
    _buildSegments() {
        for (const row of this._segmentRows)
            this._segmentGroup.remove(row);
        this._draft = null;
        const layout = this._layout;
        const count = layout.segments.length;
        this._addSegmentButton.sensitive = count < MAX_SEGMENTS;
        this._expanders = layout.segments.map((seg, i) => this._segmentRow(seg, i, count));
        this._segmentRows = [...this._expanders];
        if (count === 0) {
            this._segmentRows.push(new Adw.ActionRow({
                title: 'The top bar is empty',
                subtitle: 'Add a segment, or pick a preset below',
            }));
        }
        for (const row of this._segmentRows)
            this._segmentGroup.add(row);
        this._updatePreview(null);
    }

    _segmentRow(seg, index, count) {
        const kind = targetKind(seg.target);
        const readings = seg.items.map(id => readingInfo(kind, id)?.label ?? id).join(' + ') || 'Text only';
        const row = new Adw.ExpanderRow({
            use_markup: false,
            subtitle: `${targetLabel(seg.target)}: ${readings}`,
            expanded: this._expanded.has(index),
        });
        row.connect('notify::expanded', () => {
            if (row.expanded)
                this._expanded.add(index);
            else
                this._expanded.delete(index);
        });
        const swapExpanded = delta => {
            const a = this._expanded.has(index);
            const b = this._expanded.has(index + delta);
            this._expanded.delete(index);
            this._expanded.delete(index + delta);
            if (a)
                this._expanded.add(index + delta);
            if (b)
                this._expanded.add(index);
        };
        // An expander row puts each new suffix before the previous ones.
        row.add_suffix(flatButton('user-trash-symbolic', 'Remove this segment',
            () => this._writeWithUndo(removeSegment(this._layout, index), 'Segment removed')));
        row.add_suffix(flatButton('go-down-symbolic', 'Move right', () => {
            swapExpanded(1);
            this._write(moveSegment(this._layout, index, 1));
        }, index < count - 1));
        row.add_suffix(flatButton('go-up-symbolic', 'Move left', () => {
            swapExpanded(-1);
            this._write(moveSegment(this._layout, index, -1));
        }, index > 0));

        for (const r of this._targetRows(seg, index))
            row.add_row(r);
        for (const id of seg.items)
            row.add_row(this._itemRow(seg, index, count, id));
        row.add_row(this._addItemRow(seg, index));
        for (const r of this._templateRows(seg, index))
            row.add_row(r);
        row.add_row(choiceRow('Icon', ICON_CHOICES, seg.icon,
            icon => this._write(setSegment(this._layout, index, {icon}))));
        for (const r of this._graphRows(seg, index))
            row.add_row(r);
        return row;
    }

    // ------------------------------------------------------------ target picker

    _targetRows(seg, index) {
        const snap = this._daemon.snapshot();
        return hasLists(snap) ? this._pickedTargetRows(seg, index, snap) : this._typedTargetRows(seg, index);
    }

    /** Server, then node, guest or whole server, from pved's lists. */
    _pickedTargetRows(seg, index, snap) {
        const target = seg.target;
        const o = targetOptions(snap, target, this._options);
        const server = choiceRow('Server', o.servers, target.server, name => {
            // VMIDs and node names belong to a server: start from its selected node.
            const reads = targetKind(target) === 'server' ? 'server' : 'node:';
            this._write(retarget(this._layout, index, targetFromChoice(name, reads)));
        });
        const reads = choiceRow('Reads', o.reads, readsValue(target),
            value => this._write(retarget(this._layout, index, targetFromChoice(target.server, value))));
        return [server, reads];
    }

    /** Free text while pved is not running: server name, kind, node name or VMID. */
    _typedTargetRows(seg, index) {
        const target = seg.target;
        const kind = this._typedKind.get(index) ?? targetKind(target);
        const idText = () => {
            if (kind === 'guest')
                return targetKind(target) === 'guest' ? String(target.guest) : '';
            return kind === 'node' && targetKind(target) === 'node' ? target.node : '';
        };
        const server = new Adw.EntryRow({
            title: 'Server (empty: the selected one)', text: target.server, show_apply_button: true,
        });
        const id = new Adw.EntryRow({
            title: kind === 'guest' ? 'VMID' : 'Node (empty: the selected or first online one)',
            text: idText(), show_apply_button: true, visible: kind !== 'server',
        });
        const apply = (entry, serverText, text) => {
            const next = typedTarget(kind, serverText, text);
            if (!next) {
                entry.add_css_class('error');
                this._toast(kind === 'guest' ? 'Type a server name (or nothing) and a VMID'
                    : 'Server names are a-z, 0-9 and -; node names have no spaces');
                return;
            }
            entry.remove_css_class('error');
            this._write(retarget(this._layout, index, next));
        };
        server.connect('apply', () => apply(server, server.text, id.text));
        id.connect('apply', () => apply(id, server.text, id.text));
        const kindRow = choiceRow('Reads', TYPED_KINDS, kind, picked => {
            const next = typedTarget(picked, target.server, '');
            if (next) {
                this._write(retarget(this._layout, index, next));
            } else {
                // A guest needs its VMID first.
                this._typedKind.set(index, picked);
                this._scheduleRebuild();
            }
        }, 'pved is not running: type the names');
        return [server, kindRow, id];
    }

    // ------------------------------------------------------------ readings

    _itemRow(seg, index, count, id) {
        const layout = this._layout;
        const kind = targetKind(seg.target);
        const info = readingInfo(kind, id);
        const row = new Adw.ActionRow({title: info?.label ?? id, subtitle: `{${id}}`, use_markup: false});
        const move = to => {
            this._expanded.add(to === 'new' ? index + 1 : to);
            this._write(moveItemTo(this._layout, index, id, to));
        };
        const mergeable = other => other >= 0 && other < count && sameTarget(seg.target, layout.segments[other].target);
        const why = ' (only into a segment that reads the same target)';
        row.add_suffix(flatButton('go-previous-symbolic', `Move into the segment on the left${mergeable(index - 1) ? '' : why}`,
            () => move(index - 1), mergeable(index - 1)));
        row.add_suffix(flatButton('go-next-symbolic', `Move into the segment on the right${mergeable(index + 1) ? '' : why}`,
            () => move(index + 1), mergeable(index + 1)));
        row.add_suffix(flatButton('edit-cut-symbolic', 'Move into a segment of its own',
            () => move('new'), seg.items.length > 1 && count < MAX_SEGMENTS));
        row.add_suffix(flatButton('list-remove-symbolic', 'Remove from this segment',
            () => this._write(removeItem(this._layout, index, id))));
        return row;
    }

    _addItemRow(seg, index) {
        const kind = targetKind(seg.target);
        const missing = READINGS[kind].filter(r => !seg.items.includes(r.id));
        const options = [['', 'Choose…'], ...missing.map(r => [r.id, r.label])];
        return choiceRow('Add a reading', options, '',
            id => this._write(addItem(this._layout, index, id)));
    }

    _templateRows(seg, index) {
        const kind = targetKind(seg.target);
        const entry = new Adw.EntryRow({
            title: 'Template (empty: the readings joined by " · ")',
            text: seg.template,
            show_apply_button: true,
        });
        const help = new Adw.ActionRow({
            title: 'Placeholders',
            subtitle_selectable: true,
            use_markup: false,
            css_classes: ['property'],
        });
        const placeholderHelp = `${PLACEHOLDERS[kind].map(p => `{${p}}`).join(' ')}. ` +
            'Add :1 for one decimal, e.g. {cpu:1}. Press Enter to apply.';
        const validate = () => {
            const {errors} = parseTemplate(entry.text, kind);
            if (errors.length) {
                entry.add_css_class('error');
                help.title = 'Shown as "--" until fixed';
                help.subtitle = errors.join('; ');
            } else {
                entry.remove_css_class('error');
                help.title = entry.text ? 'Placeholders' : `Now: ${effectiveTemplate(seg)}`;
                help.subtitle = placeholderHelp;
            }
        };
        entry.connect('changed', () => {
            validate();
            // Preview the draft while typing; it is stored on Enter.
            this._draft = setTemplate(this._layout, index, entry.text);
            this._updatePreview(null);
        });
        entry.connect('apply', () => this._write(setTemplate(this._layout, index, entry.text)));
        validate();
        return [entry, help];
    }

    _graphRows(seg, index) {
        const kind = targetKind(seg.target);
        const g = seg.graph;
        const set = patch => this._write(setSegment(this._layout, index, {graph: patch}));
        const options = [['', 'None'], ...GRAPH_READINGS[kind].map(id => [id, readingInfo(kind, id).label])];
        const rows = [choiceRow('Graph', options, g?.reading ?? '',
            reading => set(reading ? {reading} : null))];
        if (!g)
            return rows;

        rows.push(choiceRow('Graph style', KIND_CHOICES, g.kind, k => set({kind: k})));
        const only = new Adw.SwitchRow({title: 'Graph only', subtitle: 'Hide the text', active: g.only});
        only.connect('notify::active', () => set({only: only.active}));
        rows.push(only);
        rows.push(choiceRow('Graph width', WIDTH_CHOICES, g.width, width => set({width})));
        rows.push(choiceRow('Time span', WINDOW_CHOICES, g.window, window => set({window})));

        const fixed = g.color !== 'follow';
        rows.push(choiceRow('Graph color', [['follow', 'Threshold colors'], ['fixed', 'One fixed color']],
            fixed ? 'fixed' : 'follow', mode => set({color: mode === 'fixed' ? '#62a0ea' : 'follow'})));
        if (fixed) {
            const colorRow = new Adw.ActionRow({title: 'Fixed color'});
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: false}), valign: Gtk.Align.CENTER,
            });
            const rgba = new Gdk.RGBA();
            if (rgba.parse(g.color))
                button.rgba = rgba;
            button.connect('notify::rgba', () => {
                const color = colorHex(button.rgba.to_string());
                if (color)
                    this._write(setSegment(this._layout, index, {graph: {color}}), {rebuild: false});
            });
            colorRow.add_suffix(button);
            rows.push(colorRow);
        }
        return rows;
    }

    // ------------------------------------------------------------ presets and backup

    _presetGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Presets',
            description: 'Replace the layout with a ready-made one. Colors and thresholds are kept.',
        });
        this._undoButton = new Gtk.Button({
            label: 'Undo', valign: Gtk.Align.CENTER, sensitive: false,
            tooltip_text: 'Go back to the layout before the last preset, import or removal',
        });
        this._undoButton.connect('clicked', () => this.undo());
        group.set_header_suffix(this._undoButton);
        for (const preset of PRESETS) {
            const row = new Adw.ActionRow({title: preset.label, subtitle: preset.description});
            const button = new Gtk.Button({label: 'Use', valign: Gtk.Align.CENTER});
            button.connect('clicked', () => this.applyPreset(preset.id));
            row.add_suffix(button);
            row.activatable_widget = button;
            group.add(row);
        }
        return group;
    }

    /** Switches to a preset; the Cluster preset names the servers pved lists. */
    applyPreset(id) {
        const preset = PRESETS.find(p => p.id === id);
        if (!preset)
            return;
        const snap = this._daemon.snapshot();
        const {layout} = applyPreset(this._layout, id, {servers: hasLists(snap) ? snap.servers : []});
        this._writeWithUndo(layout, `${preset.label} layout applied`);
    }

    _backupGroup() {
        const group = new Adw.PreferencesGroup({
            title: 'Backup and sharing',
            description: 'The layout as a JSON file: segments, targets, templates, icons and graphs.',
        });
        const exportRow = new Adw.ActionRow({title: 'Export the layout…'});
        const exportButton = flatButton('document-save-symbolic', 'Export', () => this._export());
        exportRow.add_suffix(exportButton);
        exportRow.activatable_widget = exportButton;
        group.add(exportRow);

        const importRow = new Adw.ActionRow({title: 'Import a layout…', subtitle: 'Replaces the current layout'});
        const importButton = flatButton('document-open-symbolic', 'Import', () => this._import());
        importRow.add_suffix(importButton);
        importRow.activatable_widget = importButton;
        group.add(importRow);
        return group;
    }

    _export() {
        const {store, filter} = jsonFilters();
        const dialog = new Gtk.FileDialog({
            title: 'Export the layout', initial_name: 'pve-bar-layout.json', filters: store, default_filter: filter,
        });
        dialog.save(this._window, null, (_d, result) => {
            let file;
            try {
                file = dialog.save_finish(result);
            } catch (e) {
                if (!isDismissed(e))
                    this._toast(`Could not export: ${e.message}`);
                return;
            }
            try {
                file.replace_contents(new TextEncoder().encode(exportLayout(this._layout)), null, false,
                    Gio.FileCreateFlags.REPLACE_DESTINATION, null);
                this._toast(`Layout exported to ${file.get_basename()}`);
            } catch (e) {
                this._toast(`Could not export: ${e.message}`);
            }
        });
    }

    _import() {
        const {store, filter} = jsonFilters();
        const dialog = new Gtk.FileDialog({title: 'Import a layout', filters: store, default_filter: filter});
        dialog.open(this._window, null, (_d, result) => {
            let text;
            try {
                const file = dialog.open_finish(result);
                const [, bytes] = file.load_contents(null);
                if (bytes.length > MAX_IMPORT_BYTES) {
                    this._toast('That file is too large to be a layout');
                    return;
                }
                text = new TextDecoder().decode(bytes);
            } catch (e) {
                if (!isDismissed(e))
                    this._toast(`Could not import: ${e.message}`);
                return;
            }
            this.importText(text);
        });
    }

    /** Imports a layout file's text; anything that is not a layout is refused. */
    importText(text) {
        const {ok, layout, errors} = importLayout(text);
        if (!ok) {
            this._toast(`Not a pve-bar layout: ${errors[0]}`);
            return false;
        }
        this._writeWithUndo(layout, errors.length
            ? `Layout imported; ${errors.length} template mistake(s) show as "--"`
            : 'Layout imported');
        return true;
    }
}
