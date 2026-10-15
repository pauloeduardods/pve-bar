// SPDX-License-Identifier: GPL-3.0-or-later
// The top-bar button: host CPU, RAM and temperature in the panel, details and
// the guest list in its menu. Everything comes from pved through PveClient;
// this file only renders. It has no timers: it redraws when pved reports a
// change or a setting changes. Actors are only touched when the value they
// show changed, and the guest rows are created once and updated in place.

import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {PveClient} from '../client.js';
import {
    Level, formatMemory, formatPercent, formatTemp, groupByServer, guestRows, guestSummary,
    level, nodeSummary, nodeValue, pickNode, pickServer, sectionKey, serverIdsKey, stateBadge,
    statusInfo, worstLevel,
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

function makeSegment(iconPath) {
    const box = new St.BoxLayout({style_class: 'pve-bar-segment', y_align: Clutter.ActorAlign.CENTER});
    const icon = new St.Icon({
        gicon: Gio.icon_new_for_string(iconPath),
        style_class: 'system-status-icon pve-bar-icon',
    });
    const label = new St.Label({text: '--', y_align: Clutter.ActorAlign.CENTER});
    // Panel values are short; never let the panel squeeze them into "…".
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
    box.add_child(icon);
    box.add_child(label);
    return {actor: box, box, icon, label, text: '--', style: null, visible: true, iconVisible: true};
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

export const PveIndicator = GObject.registerClass(
class PveIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, 'pve-bar', false);

        this._ext = extension;
        this._settings = extension.getSettings();
        this._idsKey = null;
        this._sections = [];

        this._buildPanel();
        this._buildMenu();

        this._settingsId = this._settings.connect('changed', () => this._render());
        // Not named _onDestroy: PanelMenu.ButtonBox already connects 'destroy' to
        // this._onDestroy, and overriding it would skip destroying the menu.
        this.connect('destroy', () => this._cleanup());

        this._client = new PveClient(() => this._render());
        this._render();
    }

    // ---------------------------------------------------------------- build

    _buildPanel() {
        this._box = new St.BoxLayout({style_class: 'panel-status-menu-box pve-bar-panel-box'});
        this.add_child(this._box);
        const icon = name => `${this._ext.path}/icons/${name}-symbolic.svg`;
        this._seg = {
            cpu: makeSegment(icon('cpu')),
            mem: makeSegment(icon('ram')),
            temp: makeSegment(icon('temp')),
        };
        for (const seg of Object.values(this._seg))
            this._box.add_child(seg.box);

        // Shown instead of the readings while pved or Proxmox is unavailable.
        this._statusSeg = makeSegment(icon('cpu'));
        this._statusSeg.box.opacity = 128;
        this._box.add_child(this._statusSeg.box);
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

    _render() {
        if (!this._client)
            return;
        const snap = this._client.snapshot();
        const server = pickServer(snap.servers, this._settings.get_string('server'));
        const info = statusInfo(snap.daemon, snap.configError, server);
        const icons = this._settings.get_boolean('show-icons');
        const listed = snap.daemon === 'running' && !snap.configError && snap.servers.length > 0;

        setVisible(this._statusVisible, info !== null);
        setVisible(this._serversVisible, listed);
        setVisible(this._fakeRow, snap.fake);
        this._setIcon(this._statusSeg, icons);

        if (info) {
            for (const seg of Object.values(this._seg))
                setVisible(seg, false);
            setVisible(this._statusSeg, true);
            setText(this._statusSeg, info.panel);
            setText(this._statusRow.nameHolder, info.menu);
            setText(this._statusHint.nameHolder, info.hint);
            setVisible(this._statusHint, info.hint !== '');
        } else {
            setVisible(this._statusSeg, false);
            this._renderPanel(snap, server, icons);
        }
        if (listed)
            this._renderServers(snap);
    }

    _renderPanel(snap, server, icons) {
        const nodes = snap.nodes.filter(n => n.server === server.name);
        const node = pickNode(nodes, this._settings.get_string('node'));
        const v = what => nodeValue(snap.values, server.name, node?.name, what);
        const cpu = v('cpu');
        const mem = v('mem');
        const temp = v('temp');
        this._paintSegment(this._seg.cpu, cpu, formatPercent(cpu), 'cpu', icons);
        this._paintSegment(this._seg.mem, mem, formatPercent(mem), 'mem', icons);
        this._paintSegment(this._seg.temp, temp, formatTemp(temp), 'temp', icons);
        // The temperature only exists while pve-temp-agent answers.
        setVisible(this._seg.temp, temp !== null);
    }

    _setIcon(seg, visible) {
        if (seg.iconVisible === visible)
            return;
        seg.iconVisible = visible;
        seg.icon.visible = visible;
    }

    _colorFor(lvl) {
        if (lvl === Level.HOT)
            return this._settings.get_string('color-hot') || null;
        if (lvl === Level.WARM)
            return this._settings.get_string('color-warm') || null;
        return this._settings.get_string('color-normal') || null;
    }

    _levelOf(value, key) {
        return level(value, this._settings.get_int(`${key}-warm`), this._settings.get_int(`${key}-hot`));
    }

    _styleFor(lvl) {
        const color = this._colorFor(lvl);
        return color ? `color: ${color};` : null;
    }

    _paintSegment(seg, value, text, key, icons) {
        this._setIcon(seg, icons);
        setVisible(seg, true);
        setText(seg, text);
        setStyle(seg, this._styleFor(this._levelOf(value, key)));
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
