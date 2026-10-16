// SPDX-License-Identifier: GPL-3.0-or-later
// A guest's detail view, shown in place of a server's guest list (see
// ui/menu.js): status, uptime, CPU and RAM with their last hour inline,
// network in and out, the disk inside the VM, and "Pin to bar". The view
// only draws; ServerMenu decides when it is shown and MenuNeeds watches the
// guest meanwhile, so pved fetches its details only while it is on screen.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {GUEST_WINDOW, guestDetail, pinLabel, pinState} from '../menuModel.js';
import {pickServer} from '../model.js';
import {ActionMenuItem, makeInfoRow, setStyle, setText, setVisible} from './widgets.js';

function labelItem(text, onActivate, styleClass = null) {
    const item = new ActionMenuItem(onActivate);
    const label = new St.Label({text, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    if (styleClass)
        label.add_style_class_name(styleClass);
    item.add_child(label);
    return {item, label};
}

export class GuestView {
    /**
     * @param {object} host what ServerMenu passes on (snapshot, options,
     *   styleFor, layout, pinGuest)
     * @param {object} painter ServerMenu's GraphPainter
     * @param {() => void} onBack the "← Guests" item was chosen
     */
    constructor(host, painter, onBack) {
        this._host = host;
        this._painter = painter;
        this.guest = null; // {server, vmid} while shown

        this.section = new PopupMenu.PopupMenuSection();
        this._visible = {actor: this.section.actor, visible: false};
        this.section.actor.visible = false;

        this._back = labelItem('← Guests', onBack, 'pve-bar-menu-dim');
        this.section.addMenuItem(this._back.item);

        this._header = makeInfoRow('');
        this._header.name.add_style_class_name('pve-bar-server-name');
        this._dot = new St.Label({style_class: 'pve-bar-guest-dot', y_align: Clutter.ActorAlign.CENTER});
        this._header.item.insert_child_below(this._dot, this._header.name);
        this._dotClass = '';
        this._dotHolder = {label: this._dot, text: null};
        this._header.value.style_class = 'pve-bar-guest-badge';

        this._rows = {
            status: makeInfoRow('Status'),
            uptime: makeInfoRow('Uptime'),
            cpu: makeInfoRow('CPU', {graph: true}),
            mem: makeInfoRow('RAM', {graph: true}),
            netin: makeInfoRow('Network in', {graph: true}),
            netout: makeInfoRow('Network out', {graph: true}),
            fs: makeInfoRow('Disk (inside)'),
        };
        this._hint = makeInfoRow('');
        this._hint.name.add_style_class_name('pve-bar-menu-dim');
        this._hint.name.add_style_class_name('pve-bar-menu-hint');
        this._hint.value.text = '';
        this._pin = labelItem('Pin to bar', () => this._pinIt());
        this._pinState = null;

        this.section.addMenuItem(this._header.item);
        for (const row of Object.values(this._rows)) {
            this.section.addMenuItem(row.item);
            if (row.graph)
                painter.attach(row.graph);
        }
        this.section.addMenuItem(this._hint.item);
        this.section.addMenuItem(this._pin.item);
    }

    get visible() {
        return this._visible.visible;
    }

    /** Shows `guest` ({server, vmid}); its graphs repaint on the next render. */
    show(guest) {
        this.guest = {server: guest.server, vmid: guest.vmid};
        for (const row of Object.values(this._rows)) {
            if (row.graph)
                row.graph.key = null;
        }
        setVisible(this._visible, true);
    }

    hide() {
        this.guest = null;
        setVisible(this._visible, false);
    }

    /**
     * Draws the guest shown from the snapshot; only what changed reaches
     * GNOME. Returns false when the guest no longer exists.
     */
    render(snap, changed) {
        const id = this.guest;
        if (!id)
            return true;
        const guest = snap.guests.find(g => g.server === id.server && g.vmid === id.vmid);
        if (!guest)
            return false;
        const options = this._host.options();
        const d = guestDetail(guest, snap.values, options.thresholds);
        const rows = this._rows;
        const styleFor = lvl => this._host.styleFor(lvl);

        setText(this._header.nameHolder, d.title);
        setText(this._header.valueHolder, d.badge);
        setText(this._dotHolder, d.dot);
        if (this._dotClass !== d.dotClass) {
            if (this._dotClass)
                this._dot.remove_style_class_name(`pve-bar-dot-${this._dotClass}`);
            this._dot.add_style_class_name(`pve-bar-dot-${d.dotClass}`);
            this._dotClass = d.dotClass;
        }
        setText(rows.status.valueHolder, d.status);
        setText(rows.uptime.valueHolder, d.uptime);
        setText(rows.cpu.valueHolder, d.cpu.text);
        setStyle(rows.cpu.valueHolder, styleFor(d.cpu.level));
        setText(rows.mem.valueHolder, d.mem.text);
        setStyle(rows.mem.valueHolder, styleFor(d.mem.level));
        setText(rows.netin.valueHolder, d.netin);
        setText(rows.netout.valueHolder, d.netout);
        setVisible(rows.fs, d.fs.visible);
        setText(rows.fs.valueHolder, d.fs.text);
        setStyle(rows.fs.valueHolder, styleFor(d.fs.level));
        setText(this._hint.nameHolder, d.fs.hint);
        setVisible(this._hint, d.fs.hint !== '');

        const prefix = `${id.server}/guest/${id.vmid}/`;
        for (const what of ['cpu', 'mem', 'netin', 'netout'])
            this._painter.refresh(rows[what].graph, `${prefix}${what}`, what, GUEST_WINDOW, changed);

        const selected = pickServer(snap.servers, options.server)?.name ?? null;
        const state = pinState(this._host.layout(), id.server, id.vmid, selected);
        if (state !== this._pinState) {
            this._pinState = state;
            this._pin.label.set_text(pinLabel(state));
            this._pin.item.setSensitive(state === 'available');
        }
        return true;
    }

    _pinIt() {
        if (this.guest && this._pinState === 'available')
            this._host.pinGuest(this.guest.server, this.guest.vmid);
    }
}
