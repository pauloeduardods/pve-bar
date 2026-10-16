// SPDX-License-Identifier: GPL-3.0-or-later
// The servers part of the menu: one collapsed section per server whose
// title carries a summary ("home · 23% · 61% · 54° · 23/30"); expanded, its
// nodes with their history inline and a Guests submenu whose rows open a
// guest's detail view (ui/guestView.js) in place of the list.
//
// GNOME's PopupMenu keeps one submenu open per menu, so a submenu inside a
// submenu closes its parent. The server sections are therefore expanders
// (a header item that shows or hides a section), the guest list is a real
// submenu (it scrolls when long), and a guest's details replace the list
// with a "← Guests" item rather than opening a third level.
//
// It is only rendered while the menu is open, and then only what is on
// screen: the titles, the expanded section, and the guest list or detail
// while the Guests submenu is open. Rows are built once per node or guest
// set and updated in place; graphs repaint when their series got a value or
// a column of time passed.

import GLib from 'gi://GLib';
import Graphene from 'gi://Graphene';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {paintPieces} from '../draw.js';
import {seriesLevelOf} from '../layout.js';
import {MENU_GRAPHS, MENU_NODE_WINDOW, nodeHistoryKeys, nodeSetKey, serverSummary, shouldExpand} from '../menuModel.js';
import {
    formatMemory, formatPercent, formatTemp, graphNeedsRepaint, groupByServer, guestRows, guestSetKey, guestSummary,
    level, nodeSummary, nodeValue, sampleSeries, serverIdsKey, sparklinePieces, worstLevel,
} from '../model.js';
import {GuestView} from './guestView.js';
import {ActionMenuItem, makeInfoRow, setStyle, setText, setVisible} from './widgets.js';

/**
 * Paints the inline graphs of the menu from the client's history. A graph
 * is {area, key, kind, window, lastPaintUs, samples, columns}, as made by
 * makeInfoRow({graph: true}).
 */
class GraphPainter {
    constructor(host) {
        this._host = host;
    }

    attach(g) {
        g.area.connect('repaint', () => this._paint(g));
    }

    /**
     * Points `g` at `key` and queues a repaint when it must: anything may
     * have changed (`changed` null), it draws something else now, its
     * series got a value, or a column of time passed since its last paint.
     */
    refresh(g, key, kind, window, changed) {
        let repaint = changed === null || g.key !== key || g.kind !== kind || g.window !== window ||
            !g.lastPaintUs;
        g.key = key;
        g.kind = kind;
        g.window = window;
        if (!repaint) {
            repaint = graphNeedsRepaint(g.lastPaintUs, GLib.get_monotonic_time(), window, g.columns || 70,
                Object.hasOwn(changed, key));
        }
        if (repaint)
            g.area.queue_repaint();
    }

    _paint(g) {
        const now = GLib.get_monotonic_time();
        g.lastPaintUs = now;
        const series = g.key ? this._host.snapshot()?.history.get(g.key) : null;
        if (!series)
            return;
        const area = g.area;
        const [width, height] = area.get_surface_size();
        const columns = Math.max(1, Math.round(width));
        g.columns = columns;
        if (g.samples?.length !== columns)
            g.samples = new Array(columns);
        const samples = sampleSeries(series, now, g.window, columns, g.samples);
        if (!samples)
            return;
        const spec = MENU_GRAPHS[g.kind];
        const levelOf = seriesLevelOf(spec?.levelKind ?? null, this._host.options());
        const pieces = sparklinePieces(samples, width, height, {levelOf, minRange: spec?.minRange ?? 0});
        const cr = area.get_context();
        paintPieces(cr, height, pieces, this._host.rgbOf(area), {alpha: 0.85});
        cr.$dispose();
    }
}

function makeGuestRow(onActivate) {
    const item = new ActionMenuItem(onActivate);
    const dot = new St.Label({style_class: 'pve-bar-guest-dot', y_align: Clutter.ActorAlign.CENTER});
    const title = new St.Label({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const badge = new St.Label({style_class: 'pve-bar-guest-badge', y_align: Clutter.ActorAlign.CENTER});
    const usage = new St.Label({
        style_class: 'pve-bar-guest-usage pve-bar-menu-dim', y_align: Clutter.ActorAlign.CENTER,
    });
    for (const actor of [dot, title, badge, usage])
        item.add_child(actor);
    return {
        item, dot,
        dotClass: '',
        dotHolder: {label: dot, text: null},
        titleHolder: {label: title, text: null},
        badgeHolder: {label: badge, text: null},
        usageHolder: {label: usage, text: null},
    };
}

export class ServerMenu {
    /**
     * @param {object} host what the indicator lends the menu:
     *   needs (MenuNeeds), snapshot(), options() (readOptions), styleFor(level)
     *   (CSS or null), rgbOf(area) (level -> [r, g, b]), layout() (the
     *   panel layout) and pinGuest(server, vmid).
     */
    constructor(host) {
        this._host = host;
        this._painter = new GraphPainter(host);
        this._idsKey = null;
        this._sections = [];
        this._expanded = new Set(); // names of the expanded servers, kept across rebuilds and openings
        this._collapsed = new Set(); // servers the user collapsed; a lone server is otherwise open
        this._menuKeys = null;
        this._open = false;
        this.section = new PopupMenu.PopupMenuSection();
    }

    // ---------------------------------------------------------------- open / close

    /** The menu opened: ask for the history the expanded sections draw. Render follows. */
    opened() {
        this._open = true;
        this._menuKeys = null;
        this._syncKeys();
    }

    /** The menu closed: no guest detail, no menu-only history. */
    closed() {
        this._open = false;
        for (const sec of this._sections)
            this._hideDetail(sec);
        this._host.needs.menuClosed();
        this._menuKeys = null;
    }

    destroy() {
        this._host.needs.destroy();
    }

    // ---------------------------------------------------------------- render

    /** Draws the servers; `changed` as in the indicator (null: anything may have changed). */
    render(snap, changed) {
        const idsKey = serverIdsKey(snap.servers);
        if (idsKey !== this._idsKey) {
            this._idsKey = idsKey;
            this._host.needs.hideGuest();
            this.section.removeAll();
            this._sections = snap.servers.map(() => this._newSection());
            changed = null;
        }
        const options = this._host.options();
        groupByServer(snap.servers, snap.nodes, snap.guests).forEach((group, i) => {
            const sec = this._sections[i];
            sec.group = group;
            if (!sec.expanded && shouldExpand(group.name, snap.servers.length, this._expanded, this._collapsed))
                this._setExpanded(sec, true); // expanded before the list changed, or the only server
            this._renderHeader(sec, group, snap.values, options);
            if (sec.expanded)
                this._renderBody(sec, group, snap, changed);
        });
        this._syncKeys();
    }

    /** One server's rows, before any node or guest is known. */
    _newSection() {
        const sec = {
            group: null, expanded: false, nodesKey: null, guestsKey: null, detailed: false,
            nodeRows: null, guestRows: [], view: null,
        };
        sec.section = new PopupMenu.PopupMenuSection();
        this.section.addMenuItem(sec.section);

        // The header: the summary and an arrow, like a submenu's title.
        const header = new ActionMenuItem(() => this._toggle(sec));
        header.add_style_class_name('popup-submenu-menu-item');
        const title = new St.Label({
            style_class: 'pve-bar-server-name', x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        });
        const arrow = PopupMenu.arrowIcon(St.Side.RIGHT);
        arrow.pivot_point = new Graphene.Point({x: 0.5, y: 0.6});
        header.add_child(title);
        header.add_child(arrow);
        header.label_actor = title;
        sec.header = header;
        sec.arrow = arrow;
        sec.titleHolder = {label: title, actor: title, text: null, style: null};
        sec.section.addMenuItem(header);

        sec.message = makeInfoRow('');
        sec.message.name.add_style_class_name('pve-bar-menu-dim');
        sec.message.value.text = '';
        sec.section.addMenuItem(sec.message.item);

        sec.body = new PopupMenu.PopupMenuSection();
        sec.body.actor.add_style_class_name('pve-bar-server-body');
        sec.bodyVisible = {actor: sec.body.actor, visible: false};
        sec.body.actor.visible = false;
        sec.section.addMenuItem(sec.body);

        sec.nodeSection = new PopupMenu.PopupMenuSection();
        sec.body.addMenuItem(sec.nodeSection);

        sec.guestsItem = new PopupMenu.PopupSubMenuMenuItem('Guests');
        sec.guestsHolder = {label: sec.guestsItem.label, text: null};
        sec.guestsVisible = {actor: sec.guestsItem, visible: true};
        sec.listSection = new PopupMenu.PopupMenuSection();
        sec.listVisible = {actor: sec.listSection.actor, visible: true};
        sec.guestsItem.menu.addMenuItem(sec.listSection);
        sec.view = new GuestView(this._host, this._painter, () => this._hideDetail(sec));
        sec.guestsItem.menu.addMenuItem(sec.view.section);
        sec.guestsItem.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._renderGuests(sec, this._host.snapshot(), null);
            else
                this._hideDetail(sec);
        });
        sec.body.addMenuItem(sec.guestsItem);
        return sec;
    }

    _renderHeader(sec, group, values, options) {
        const summary = serverSummary(group, values, options.thresholds);
        setText(sec.titleHolder, summary.text);
        setStyle(sec.titleHolder, this._host.styleFor(summary.level));
        setText(sec.message.nameHolder, group.message);
        setVisible(sec.message, group.message !== '');
    }

    /** Expands or collapses a section; one is expanded at a time, so the menu stays short. */
    _toggle(sec) {
        const expand = !sec.expanded;
        if (expand) {
            for (const other of this._sections) {
                if (other !== sec && other.expanded)
                    this._setExpanded(other, false);
            }
        }
        this._setExpanded(sec, expand);
        if (!this._open)
            return;
        this._syncKeys();
        const snap = this._host.snapshot();
        if (expand && sec.group && snap)
            this._renderBody(sec, sec.group, snap, null);
    }

    _setExpanded(sec, expanded) {
        sec.expanded = expanded;
        if (sec.group) {
            if (expanded) {
                this._expanded.add(sec.group.name);
                this._collapsed.delete(sec.group.name);
            } else {
                this._expanded.delete(sec.group.name);
                this._collapsed.add(sec.group.name);
            }
        }
        setVisible(sec.bodyVisible, expanded);
        sec.arrow.rotation_angle_z = expanded ? 90 : 0;
        if (expanded) {
            sec.header.add_style_pseudo_class('open');
            sec.header.add_style_pseudo_class('checked');
        } else {
            sec.header.remove_style_pseudo_class('open');
            sec.header.remove_style_pseudo_class('checked');
            sec.guestsItem.menu.close(false); // hides its guest detail too
        }
    }

    /** The menu's history keys: what the expanded sections draw. */
    _syncKeys() {
        const keys = [];
        for (const sec of this._sections) {
            if (sec.group && sec.expanded)
                keys.push(...nodeHistoryKeys(sec.group));
        }
        const key = keys.join('\n');
        if (key === this._menuKeys)
            return;
        this._menuKeys = key;
        this._host.needs.setMenu(keys, MENU_NODE_WINDOW);
    }

    // ---------------------------------------------------------------- body

    _renderBody(sec, group, snap, changed) {
        const nodesKey = nodeSetKey(group.nodes);
        if (nodesKey !== sec.nodesKey) {
            sec.nodesKey = nodesKey;
            this._buildNodes(sec, group);
            changed = null;
        }
        if (sec.detailed)
            this._renderNode(sec, group, snap.values, changed);
        else
            this._renderCluster(sec, group, snap.values, changed);

        setText(sec.guestsHolder, `Guests (${guestSummary(group.guests)})`);
        setVisible(sec.guestsVisible, group.guests.length > 0);
        const guestsKey = guestSetKey(group.guests);
        if (guestsKey !== sec.guestsKey) {
            sec.guestsKey = guestsKey;
            this._buildGuests(sec, group);
        }
        if (sec.guestsItem.menu.isOpen)
            this._renderGuests(sec, snap, changed);
    }

    /** (Re)creates a server's node rows; only when its set of nodes changed. */
    _buildNodes(sec, group) {
        sec.nodeSection.removeAll();
        // One node: detailed rows. A cluster: one compact row per node.
        sec.detailed = group.nodes.length === 1;
        const add = (title, graph) => {
            const row = makeInfoRow(title, {graph});
            if (graph)
                this._painter.attach(row.graph);
            sec.nodeSection.addMenuItem(row.item);
            return row;
        };
        if (sec.detailed) {
            sec.nodeRows = {
                node: add('Node', false),
                cpu: add('CPU', true),
                mem: add('RAM', true),
                temp: add('Temperature', true),
                disk: add('Disk', false),
            };
        } else {
            sec.nodeRows = group.nodes.map(n => add(n.name, true));
        }
    }

    _levelOf(value, kind) {
        const t = this._host.options().thresholds[kind];
        return level(value, t.warm, t.hot);
    }

    _paintValue(row, text, lvl) {
        setText(row.valueHolder, text);
        setStyle(row.valueHolder, this._host.styleFor(lvl));
    }

    _renderNode(sec, group, values, changed) {
        const node = group.nodes[0];
        const v = what => nodeValue(values, group.name, node.name, what);
        const cpu = v('cpu');
        const mem = v('mem');
        const temp = v('temp');
        const disk = v('disk');
        const rows = sec.nodeRows;
        const prefix = `${group.name}/node/${node.name}/`;
        setText(rows.node.valueHolder, `${node.name} · ${node.status}`);
        this._paintValue(rows.cpu, formatPercent(cpu, 1), this._levelOf(cpu, 'cpu'));
        this._paintValue(rows.mem, `${formatPercent(mem)} · ${formatMemory(v('mem_used'), v('mem_total'))}`,
            this._levelOf(mem, 'mem'));
        this._paintValue(rows.temp, formatTemp(temp), this._levelOf(temp, 'temp'));
        setVisible(rows.temp, temp !== null);
        this._paintValue(rows.disk, formatPercent(disk), this._levelOf(disk, 'disk'));
        this._painter.refresh(rows.cpu.graph, `${prefix}cpu`, 'cpu', MENU_NODE_WINDOW, changed);
        this._painter.refresh(rows.mem.graph, `${prefix}mem`, 'mem', MENU_NODE_WINDOW, changed);
        if (temp !== null)
            this._painter.refresh(rows.temp.graph, `${prefix}temp`, 'temp', MENU_NODE_WINDOW, changed);
    }

    _renderCluster(sec, group, values, changed) {
        group.nodes.forEach((node, i) => {
            const row = sec.nodeRows[i];
            const v = what => nodeValue(values, group.name, node.name, what);
            const online = node.status === 'online';
            const worst = worstLevel([
                this._levelOf(v('cpu'), 'cpu'),
                this._levelOf(v('mem'), 'mem'),
                this._levelOf(v('temp'), 'temp'),
            ]);
            this._paintValue(row, online ? nodeSummary(values, group.name, node.name) : node.status, worst);
            this._painter.refresh(row.graph, `${group.name}/node/${node.name}/cpu`, 'cpu', MENU_NODE_WINDOW,
                changed);
        });
    }

    // ---------------------------------------------------------------- guests

    /** (Re)creates the guest rows; only when the set of guests changed. */
    _buildGuests(sec, group) {
        sec.listSection.removeAll();
        sec.guestRows = group.guests.map(g => {
            const row = makeGuestRow(() => this._showDetail(sec, g));
            sec.listSection.addMenuItem(row.item);
            return row;
        });
        const shown = sec.view.guest;
        if (shown && !group.guests.some(g => g.vmid === shown.vmid))
            this._hideDetail(sec);
    }

    /** The open Guests submenu: the guest list, or the detail of the guest chosen. */
    _renderGuests(sec, snap, changed) {
        if (!this._open || !snap || !sec.group)
            return;
        if (sec.view.guest) {
            if (!sec.view.render(snap, changed))
                this._hideDetail(sec);
            return;
        }
        guestRows(sec.group.guests, snap.values).forEach((data, i) => {
            const row = sec.guestRows[i];
            if (!row)
                return;
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

    _showDetail(sec, guest) {
        for (const other of this._sections) {
            if (other !== sec && other.view.guest)
                this._hideDetail(other);
        }
        if (!this._open)
            return;
        sec.view.show(guest);
        setVisible(sec.listVisible, false);
        this._host.needs.showGuest(guest.server, guest.vmid);
        this._renderGuests(sec, this._host.snapshot(), null);
    }

    _hideDetail(sec) {
        const shown = sec.view.guest;
        if (!shown)
            return;
        sec.view.hide();
        setVisible(sec.listVisible, true);
        const detail = this._host.needs.detail;
        if (detail?.server === shown.server && detail?.vmid === shown.vmid)
            this._host.needs.hideGuest();
        if (sec.guestsItem.menu.isOpen)
            this._renderGuests(sec, this._host.snapshot(), null);
    }
}
