// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar button: the segments of the user's layout in the panel (see
// lib/layout.js), details and the guest list in its menu. Everything comes
// from pved through PveClient; this file only renders. It has no timers: it
// redraws when pved reports a change or a setting changes. Actors are only
// touched when what they show changed, graphs repaint only when their series
// got a value, the menu is not updated while it is closed, and the guest
// rows are created once and updated in place.

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
    layoutNeeds, levelColor, loadLayout, readOptions, readStyle, renderLayout, segmentColor, segmentMarkup,
    serializeLayout,
} from '../layout.js';
import {
    Level, barPieces, barSlots, formatMemory, formatPercent, formatTemp, groupByServer, guestRows, guestSummary,
    level, nodeSummary, nodeValue, parseColor, pickServer, sampleSeries, sectionKey, serverIdsKey,
    sparklinePieces, stateBadge, statusInfo, worstLevel,
} from '../model.js';

// Each holder caches what its actor shows, so GNOME is only called on a change.
function setText(holder, text) {
    if (holder.text === text)
        return;
    holder.text = text;
    holder.label.set_text(text);
}

function setStyle(holder, style) {
    if (holder.style === style)
        return;
    holder.style = style;
    holder.actor.set_style(style);
}

function setVisible(holder, visible) {
    if (holder.visible === visible)
        return;
    holder.visible = visible;
    holder.actor.visible = visible;
}

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
    };
}

/** Sets `seg.shown[key]` and calls `apply` only when the value changed. */
function update(seg, key, value, apply) {
    if (seg.shown[key] === value)
        return;
    seg.shown[key] = value;
    apply(value);
}

function makeInfoRow(title) {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const name = new St.Label({text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const value = new St.Label({
        text: '--', style_class: 'pve-bar-menu-value', y_align: Clutter.ActorAlign.CENTER,
    });
    item.add_child(name);
    item.add_child(value);
    return {
        actor: item, item, name, value,
        // Cache holders for the two labels and the row itself.
        nameHolder: {label: name, text: title},
        valueHolder: {label: value, actor: value, text: '--', style: null},
        visible: true,
    };
}

function makeGuestRow() {
    const item = new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const dot = new St.Label({style_class: 'pve-bar-guest-dot', y_align: Clutter.ActorAlign.CENTER});
    const title = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const badge = new St.Label({style_class: 'pve-bar-guest-badge', y_align: Clutter.ActorAlign.CENTER});
    const usage = new St.Label({
        style_class: 'pve-bar-guest-usage pve-bar-menu-dim', y_align: Clutter.ActorAlign.CENTER,
    });
    for (const actor of [dot, title, badge, usage])
        item.add_child(actor);
    return {
        item, dot, usage,
        dotClass: '',
        dotHolder: {label: dot, text: null},
        titleHolder: {label: title, text: null},
        badgeHolder: {label: badge, text: null},
        usageHolder: {label: usage, text: null},
    };
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
        this._idsKey = null;
        this._sections = [];
        this._segs = [];
        this._layout = null;
        this._layoutKey = null;
        this._needsKey = null;
        this._watching = new Map(); // "server/vmid" -> {server, vmid}
        this._menuStale = true;
        this._readSettings();

        this._client = new PveClient(changed => this._render(changed));
        this._buildPanel();
        this._buildMenu();

        // The menu is not kept up to date while it is closed (most of the
        // time); opening it renders it first.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open && this._menuStale)
                this._render(undefined);
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

        // One section per server, rebuilt only when the set of servers changes.
        this._serversSection = new PopupMenu.PopupMenuSection();
        this.menu.addMenuItem(this._serversSection);
        this._serversVisible = {actor: this._serversSection.actor, visible: true};

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
     * when anything may have changed, undefined for "the menu opened".
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
                for (const seg of this._segs)
                    update(seg, 'visible', false, v => (seg.box.visible = v));
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
            this._renderServers(snap);
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
        this._client.setHistoryKeys(needs.keys, needs.span || 1);
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
        for (let i = 0; i < rendered.length; i++) {
            const r = rendered[i];
            const seg = this._segs[i];
            update(seg, 'visible', r.visible, v => (seg.box.visible = v));
            if (!r.visible)
                continue;
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
            const repaint = changed === null || !sameGraph(seg.spec, spec) ||
                (spec.key !== null && Object.hasOwn(changed, spec.key));
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
        const series = spec?.key ? this._client?.snapshot().history.get(spec.key) : null;
        if (!series)
            return;
        const area = seg.graph;
        const [width, height] = area.get_surface_size();
        const columns = spec.kind === 'bars' ? barSlots(width) : Math.max(1, Math.round(width));
        if (seg.samples?.length !== columns)
            seg.samples = new Array(columns);
        const samples = sampleSeries(series, GLib.get_monotonic_time(), spec.window, columns, seg.samples);
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

    _levelOf(value, key) {
        const t = this._options.thresholds[key];
        return level(value, t.warm, t.hot);
    }

    _styleFor(lvl) {
        const color = this._colorFor(lvl);
        return color ? `color: ${color};` : null;
    }

    // ---------------------------------------------------------------- servers

    _renderServers(snap) {
        const idsKey = serverIdsKey(snap.servers);
        if (idsKey !== this._idsKey) {
            this._idsKey = idsKey;
            this._serversSection.removeAll();
            this._sections = snap.servers.map(() => ({key: null}));
        }
        groupByServer(snap.servers, snap.nodes, snap.guests).forEach((group, i) => {
            const sec = this._sections[i];
            const key = sectionKey(group);
            if (sec.key !== key)
                this._buildSection(sec, group, key, i);
            this._updateSection(sec, group, snap.values);
        });
    }

    /** (Re)creates the rows of one server; runs only when its node or guest set changed. */
    _buildSection(sec, group, key, position) {
        sec.key = key;
        sec.section?.destroy();
        sec.section = new PopupMenu.PopupMenuSection();
        // At its own position, so a rebuilt server keeps its place in the list.
        this._serversSection.addMenuItem(sec.section, position);

        sec.header = makeInfoRow(group.name);
        sec.header.name.add_style_class_name('pve-bar-server-name');
        sec.header.value.text = '';
        sec.message = makeInfoRow('');
        sec.message.name.add_style_class_name('pve-bar-menu-dim');
        sec.message.value.text = '';
        sec.section.addMenuItem(sec.header.item);
        sec.section.addMenuItem(sec.message.item);

        // One node: detailed rows. A cluster: one compact row per node.
        sec.detailed = group.nodes.length === 1;
        sec.nodes = [];
        if (sec.detailed) {
            sec.rows = {
                node: makeInfoRow('Node'),
                cpu: makeInfoRow('CPU'),
                mem: makeInfoRow('RAM'),
                disk: makeInfoRow('Disk'),
                temp: makeInfoRow('Temperature'),
            };
            for (const row of Object.values(sec.rows))
                sec.section.addMenuItem(row.item);
        } else {
            sec.nodes = group.nodes.map(n => {
                const row = makeInfoRow(n.name);
                sec.section.addMenuItem(row.item);
                return row;
            });
        }

        sec.guestsItem = new PopupMenu.PopupSubMenuMenuItem('Guests');
        sec.guestsHolder = {label: sec.guestsItem.label, text: null};
        sec.guestRows = group.guests.map(() => {
            const row = makeGuestRow();
            sec.guestsItem.menu.addMenuItem(row.item);
            return row;
        });
        sec.section.addMenuItem(sec.guestsItem);
        sec.guestsVisible = {actor: sec.guestsItem, visible: true};
    }

    /** Updates a built section in place: text, colours and visibility only. */
    _updateSection(sec, group, values) {
        const badge = stateBadge(group.state);
        setText(sec.header.valueHolder, badge);
        setStyle(sec.header.valueHolder,
            badge ? `color: ${this._settings.get_string('color-hot') || '#f66151'};` : null);
        setText(sec.message.nameHolder, group.message);
        setVisible(sec.message, group.message !== '');

        if (sec.detailed) {
            const node = group.nodes[0];
            const v = what => nodeValue(values, group.name, node.name, what);
            const cpu = v('cpu');
            const mem = v('mem');
            const temp = v('temp');
            const rows = sec.rows;
            setText(rows.node.valueHolder, `${node.name} · ${node.status}`);
            this._paintRow(rows.cpu, cpu, formatPercent(cpu, 1), 'cpu');
            this._paintRow(rows.mem, mem,
                `${formatPercent(mem)} · ${formatMemory(v('mem_used'), v('mem_total'))}`, 'mem');
            setText(rows.disk.valueHolder, formatPercent(v('disk')));
            this._paintRow(rows.temp, temp, formatTemp(temp), 'temp');
            setVisible(rows.temp, temp !== null);
        } else {
            group.nodes.forEach((node, i) => {
                const row = sec.nodes[i];
                const v = what => nodeValue(values, group.name, node.name, what);
                const worst = worstLevel([
                    this._levelOf(v('cpu'), 'cpu'),
                    this._levelOf(v('mem'), 'mem'),
                    this._levelOf(v('temp'), 'temp'),
                ]);
                setText(row.valueHolder, node.status === 'online'
                    ? nodeSummary(values, group.name, node.name) : node.status);
                setStyle(row.valueHolder, this._styleFor(worst));
            });
        }

        setText(sec.guestsHolder, `Guests (${guestSummary(group.guests)})`);
        setVisible(sec.guestsVisible, group.guests.length > 0);
        guestRows(group.guests, values).forEach((data, i) => {
            const row = sec.guestRows[i];
            if (row.dotClass !== data.dotClass) {
                if (row.dotClass)
                    row.dot.remove_style_class_name(`pve-bar-dot-${row.dotClass}`);
                row.dot.add_style_class_name(`pve-bar-dot-${data.dotClass}`);
                row.dotClass = data.dotClass;
            }
            setText(row.dotHolder, data.dot);
            setText(row.titleHolder, data.title);
            setText(row.badgeHolder, data.badge);
            setText(row.usageHolder, data.usage);
        });
    }

    _paintRow(row, value, text, key) {
        setText(row.valueHolder, text);
        setStyle(row.valueHolder, this._styleFor(this._levelOf(value, key)));
    }

    _cleanup() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._client?.destroy();
        this._client = null;
    }
});
