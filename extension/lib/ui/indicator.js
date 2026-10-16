// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar button: the segments of the user's layout in the panel (see
// lib/layout.js) and, in its menu, the status, the servers (ui/menu.js) and
// Settings. Everything comes from pved through PveClient; this file only
// renders. It has no timers: it redraws when pved reports a change or a
// setting changes. Actors are only touched when what they show changed,
// graphs repaint only when their series got a value, and the menu is not
// updated while it is closed.

import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PveClient} from '../client.js';
import {paintBars, paintPieces} from '../draw.js';
import {
    layoutNeeds, levelColor, loadLayout, pinGuest, readOptions, readStyle, renderLayout, segmentColor,
    segmentMarkup, serializeLayout,
} from '../layout.js';
import {MenuNeeds} from '../menuModel.js';
import {
    Level, barPieces, barSlots, graphNeedsRepaint, parseColor, pickServer, sampleSeries, sparklinePieces,
    statusInfo,
} from '../model.js';
import {ServerMenu} from './menu.js';
import {makeInfoRow, setText, setVisible} from './widgets.js';

const FOLLOW = Object.freeze({color: 'follow'});

function makeLabel() {
    const label = new St.Label({text: '--', y_align: Clutter.ActorAlign.CENTER});
    // Panel values are short; never let the panel squeeze them into "…".
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    return label;
}

/** The segment shown instead of the layout while pved or Proxmox is unavailable. */
function makeStatusSegment(iconPath) {
    const box = new St.BoxLayout({style_class: 'pve-bar-segment', y_align: Clutter.ActorAlign.CENTER});
    const icon = new St.Icon({
        gicon: Gio.icon_new_for_string(iconPath),
        style_class: 'system-status-icon pve-bar-icon',
    });
    const label = makeLabel();
    box.add_child(icon);
    box.add_child(label);
    box.opacity = 128;
    return {actor: box, box, icon, label, text: '--', visible: true};
}

/**
 * One segment of the layout: icon, text and graph. `shown` caches what each
 * actor shows, so a render only calls GNOME for what changed.
 */
function makeLayoutSegment() {
    const box = new St.BoxLayout({style_class: 'pve-bar-segment', y_align: Clutter.ActorAlign.CENTER});
    const icon = new St.Icon({style_class: 'system-status-icon pve-bar-icon', visible: false});
    const label = makeLabel();
    const graph = new St.DrawingArea({style_class: 'pve-bar-graph', y_align: Clutter.ActorAlign.CENTER, visible: false});
    box.add_child(icon);
    box.add_child(label);
    box.add_child(graph);
    return {
        box, icon, label, graph,
        shown: {
            visible: true, opacity: 255, icon: null, iconVisible: false, iconStyle: null,
            labelVisible: true, markup: null, graphVisible: false, graphWidth: 0,
        },
        spec: null, // the rendered graph spec the next repaint draws
        samples: null, // reused column buffer
        lastPaintUs: 0, // monotonic time of the last paint (0 = never)
    };
}

/** Sets `seg.shown[key]` and calls `apply` only when the value changed. */
function update(seg, key, value, apply) {
    if (seg.shown[key] === value)
        return;
    seg.shown[key] = value;
    apply(value);
}

function sameGraph(a, b) {
    return a !== null && b !== null && a.key === b.key && a.kind === b.kind && a.window === b.window &&
        a.color === b.color && a.width === b.width && a.levelOf === b.levelOf;
}

export const PveIndicator = GObject.registerClass(
class PveIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'pve-bar', false);

        this._ext = extension;
        this._settings = extension.getSettings();
        this._segs = [];
        this._layout = null;
        this._layoutKey = null;
        this._needsKey = null;
        this._watching = new Map(); // "server/vmid" -> {server, vmid}
        this._menuStale = true;
        this._readSettings();

        this._client = new PveClient(changed => this._render(changed));
        // The history and the guest watch the menu adds to the bar's.
        this._needs = new MenuNeeds(this._client);
        this._buildPanel();
        this._buildMenu();

        // The menu is not kept up to date while it is closed (most of the
        // time); opening it renders it first, and closing it drops what only
        // the menu needed (guest details, history).
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open) {
                this._serverMenu.opened();
                this._render(undefined);
            } else {
                this._serverMenu.closed();
            }
        });
        this._settingsId = this._settings.connect('changed', (_s, key) => {
            this._readSettings();
            if (key === 'panel-layout')
                this._loadLayout();
            this._render(null);
        });
        // Not named _onDestroy: PanelMenu.ButtonBox already connects 'destroy' to
        // this._onDestroy, and overriding it would skip destroying the menu.
        this.connect('destroy', () => this._cleanup());

        this._render(null);
    }

    _iconPath(name) {
        return `${this._ext.path}/icons/${name}-symbolic.svg`;
    }

    /** Settings rendering reads on every update, read once per change. */
    _readSettings() {
        this._options = readOptions(this._settings);
        this._style = readStyle(this._settings);
        this._colors = {
            [Level.NORMAL]: parseColor(this._style.normal),
            [Level.WARM]: parseColor(this._style.warm),
            [Level.HOT]: parseColor(this._style.hot),
        };
    }

    // ---------------------------------------------------------------- build

    _buildPanel() {
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box pve-bar-panel-box'});
        this.add_child(this._box);
        this._statusSeg = makeStatusSegment(this._iconPath('server'));
        this._box.add_child(this._statusSeg.box);
        this._loadLayout();
    }

    /**
     * Reads the layout and builds one segment per entry, only when the
     * layout changed. The first run migrates the MVP settings into
     * panel-layout, once.
     */
    _loadLayout() {
        const {layout, migrated} = loadLayout(this._settings);
        if (migrated !== null)
            this._settings.set_string('panel-layout', migrated);
        const key = serializeLayout(layout);
        if (key === this._layoutKey)
            return;
        this._layoutKey = key;
        this._layout = layout;
        this._needsKey = null;
        for (const seg of this._segs)
            seg.box.destroy();
        this._segs = layout.segments.map(() => {
            const seg = makeLayoutSegment();
            seg.graph.connect('repaint', () => this._drawGraph(seg));
            this._box.insert_child_below(seg.box, this._statusSeg.box);
            return seg;
        });
    }

    _buildMenu() {
        this._statusSection = new PopupMenu.PopupMenuSection();
        this._statusRow = makeInfoRow('');
        this._statusRow.value.text = '';
        this._statusHint = makeInfoRow('');
        this._statusHint.value.text = '';
        this._statusHint.name.add_style_class_name('pve-bar-menu-dim');
        this._statusSection.addMenuItem(this._statusRow.item);
        this._statusSection.addMenuItem(this._statusHint.item);
        this.menu.addMenuItem(this._statusSection);
        this._statusVisible = {actor: this._statusSection.actor, visible: true};

        // One section per server (ui/menu.js).
        this._serverMenu = new ServerMenu({
            needs: this._needs,
            snapshot: () => this._client?.snapshot() ?? null,
            options: () => this._options,
            styleFor: lvl => this._styleFor(lvl),
            rgbOf: area => this._rgbOf(area, FOLLOW),
            layout: () => this._layout,
            pinGuest: (server, vmid) => this._pinGuest(server, vmid),
        });
        this.menu.addMenuItem(this._serverMenu.section);
        this._serversVisible = {actor: this._serverMenu.section.actor, visible: true};

        this._fakeRow = makeInfoRow('(fake data)');
        this._fakeRow.name.add_style_class_name('pve-bar-menu-dim');
        this._fakeRow.value.text = '';
        this.menu.addMenuItem(this._fakeRow.item);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this.menu.addAction('Settings', () => this._ext.openPreferences());
    }

    // ---------------------------------------------------------------- render

    /**
     * `changed`: the values of an Updated (only their graphs repaint), null
     * when anything may have changed, undefined for "the menu opened" (the
     * menu is drawn in full, the bar is left alone).
     */
    _render(changed) {
        if (!this._client || !this._layout)
            return;
        const snap = this._client.snapshot();
        const server = pickServer(snap.servers, this._options.server);
        const info = statusInfo(snap.daemon, snap.configError, server);

        if (changed !== undefined) {
            if (changed === null)
                this._updateNeeds(snap);
            setVisible(this._statusSeg, info !== null);
            if (info) {
                for (const seg of this._segs) {
                    update(seg, 'visible', false, v => (seg.box.visible = v));
                    seg.spec = null;
                }
                setText(this._statusSeg, info.panel);
            } else {
                this._renderSegments(snap, changed);
            }
        }

        this._menuStale = !this.menu.isOpen;
        if (this._menuStale)
            return;
        const listed = snap.daemon === 'running' && !snap.configError && snap.servers.length > 0;
        setVisible(this._statusVisible, info !== null);
        setVisible(this._serversVisible, listed);
        setVisible(this._fakeRow, snap.fake);
        if (info) {
            setText(this._statusRow.nameHolder, info.menu);
            setText(this._statusHint.nameHolder, info.hint);
            setVisible(this._statusHint, info.hint !== '');
        }
        if (listed)
            this._serverMenu.render(snap, changed ?? null);
    }

    /**
     * Tells the client which history the graphs draw and which guests need
     * details. Runs when the layout, a setting or pved's lists change, never
     * per Updated.
     */
    _updateNeeds(snap) {
        const needs = layoutNeeds(this._layout, snap, this._options);
        const key = `${needs.span}\n${needs.keys.join('\n')}\n${needs.watches.map(w => `${w.server}/${w.vmid}`).join('\n')}`;
        if (key === this._needsKey)
            return;
        this._needsKey = key;
        this._needs.setPanel(needs.keys, needs.span);
        const wanted = new Map(needs.watches.map(w => [`${w.server}/${w.vmid}`, w]));
        for (const [id, w] of this._watching) {
            if (!wanted.has(id))
                this._client.unwatch(w.server, w.vmid);
        }
        for (const [id, w] of wanted) {
            if (!this._watching.has(id))
                this._client.watch(w.server, w.vmid);
        }
        this._watching = wanted;
    }

    /** Draws every segment of the layout; only what changed reaches GNOME. */
    _renderSegments(snap, changed) {
        const rendered = renderLayout(this._layout, snap, this._options);
        const style = this._style;
        let now = 0; // read once, only when a graph needs the time
        for (let i = 0; i < rendered.length; i++) {
            const r = rendered[i];
            const seg = this._segs[i];
            update(seg, 'visible', r.visible, v => (seg.box.visible = v));
            if (!r.visible) {
                seg.spec = null; // shown again: repaint
                continue;
            }
            update(seg, 'opacity', r.dim ? 128 : 255, v => (seg.box.opacity = v));
            update(seg, 'icon', r.icon, name => {
                seg.icon.gicon = name ? Gio.icon_new_for_string(this._iconPath(name)) : null;
            });
            update(seg, 'iconVisible', r.icon !== null, v => (seg.icon.visible = v));
            const color = segmentColor(r, style);
            update(seg, 'iconStyle', color ? `color: ${color};` : null, v => seg.icon.set_style(v));
            update(seg, 'labelVisible', r.showText, v => (seg.label.visible = v));
            if (r.showText)
                update(seg, 'markup', segmentMarkup(r, style), m => seg.label.clutter_text.set_markup(m));

            const spec = r.graph;
            update(seg, 'graphVisible', spec !== null, v => (seg.graph.visible = v));
            if (!spec) {
                seg.spec = null;
                continue;
            }
            update(seg, 'graphWidth', spec.width, w => seg.graph.set_width(w));
            let repaint = changed === null || !sameGraph(seg.spec, spec);
            if (!repaint && spec.key !== null) {
                // Its series got a value, or a column of time passed: a flat
                // series still scrolls and an old spike leaves the window.
                now ||= GLib.get_monotonic_time();
                const columns = spec.kind === 'bars' ? barSlots(spec.width) : spec.width;
                repaint = graphNeedsRepaint(seg.lastPaintUs, now, spec.window, columns,
                    Object.hasOwn(changed, spec.key));
            }
            seg.spec = spec;
            if (repaint)
                seg.graph.queue_repaint();
        }
    }

    /** A graph color as [r, g, b]: the fixed one, else the level's, else the theme's text color. */
    _rgbOf(area, spec) {
        const fixed = spec.color === 'follow' ? null : parseColor(spec.color);
        let theme = null;
        return lvl => {
            const rgb = fixed ?? this._colors[lvl] ?? this._colors[Level.NORMAL];
            if (rgb)
                return rgb;
            if (!theme) {
                const c = area.get_theme_node().get_foreground_color();
                theme = [c.red / 255, c.green / 255, c.blue / 255];
            }
            return theme;
        };
    }

    /** Paints a segment's graph from the client's history: a line, an area or bars. */
    _drawGraph(seg) {
        const spec = seg.spec;
        const now = GLib.get_monotonic_time();
        seg.lastPaintUs = now;
        const series = spec?.key ? this._client?.snapshot().history.get(spec.key) : null;
        if (!series)
            return;
        const area = seg.graph;
        const [width, height] = area.get_surface_size();
        const columns = spec.kind === 'bars' ? barSlots(width) : Math.max(1, Math.round(width));
        if (seg.samples?.length !== columns)
            seg.samples = new Array(columns);
        const samples = sampleSeries(series, now, spec.window, columns, seg.samples);
        if (!samples)
            return;
        const options = {levelOf: spec.levelOf, minRange: spec.minRange, percent: spec.percent};
        const rgbOf = this._rgbOf(area, spec);
        const cr = area.get_context();
        if (spec.kind === 'bars')
            paintBars(cr, barPieces(samples, width, height, options), rgbOf);
        else
            paintPieces(cr, height, sparklinePieces(samples, width, height, options), rgbOf, {fill: spec.kind === 'area'});
        cr.$dispose();
    }

    // ---------------------------------------------------------------- menu colors

    _colorFor(lvl) {
        return levelColor(lvl, this._style) || null;
    }

    _styleFor(lvl) {
        const color = this._colorFor(lvl);
        return color ? `color: ${color};` : null;
    }

    /** Appends a segment for this guest to the layout (the menu's "Pin to bar"). */
    _pinGuest(server, vmid) {
        const next = serializeLayout(pinGuest(this._layout, server, vmid));
        if (next !== this._layoutKey)
            this._settings.set_string('panel-layout', next);
    }

    _cleanup() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._serverMenu?.destroy();
        this._client?.destroy();
        this._client = null;
    }
});
