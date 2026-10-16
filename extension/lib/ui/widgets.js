// SPDX-License-Identifier: GPL-3.0-or-later
// Small building blocks shared by the panel button and its menu: cached
// setters (GNOME is only called when what an actor shows changed), menu
// rows with an optional inline graph, and a menu item that runs an action
// without closing the menu.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

// Each holder caches what its actor shows, so GNOME is only called on a change.
export function setText(holder, text) {
    if (holder.text === text)
        return;
    holder.text = text;
    holder.label.set_text(text);
}

export function setStyle(holder, style) {
    if (holder.style === style)
        return;
    holder.style = style;
    holder.actor.set_style(style);
}

export function setVisible(holder, visible) {
    if (holder.visible === visible)
        return;
    holder.visible = visible;
    holder.actor.visible = visible;
}

/**
 * A menu item that calls `onActivate` when clicked or chosen with the
 * keyboard, and keeps the menu open (a plain item closes it).
 */
export const ActionMenuItem = GObject.registerClass(
class PveBarActionMenuItem extends PopupMenu.PopupBaseMenuItem {
    _init(onActivate, params = {}) {
        super._init(params);
        this._onActivate = onActivate;
    }

    activate(_event) {
        this._onActivate?.();
    }
});

/**
 * A menu row: name, then (with `graph`) a small history graph on the same
 * line, then the value. `item` is the row's menu item (pass an
 * ActionMenuItem to make it clickable). The holders cache what each label
 * shows; `graph` is null or {area, ...} for the caller's painter.
 */
export function makeInfoRow(title, {graph = false, item = null} = {}) {
    item ??= new PopupMenu.PopupBaseMenuItem({reactive: false, can_focus: false});
    const name = new St.Label({text: title, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    const value = new St.Label({
        text: '--', style_class: 'pve-bar-menu-value', y_align: Clutter.ActorAlign.CENTER,
    });
    item.add_child(name);
    let area = null;
    if (graph) {
        area = new St.DrawingArea({style_class: 'pve-bar-inline-graph', y_align: Clutter.ActorAlign.CENTER});
        item.add_child(area);
    }
    item.add_child(value);
    return {
        actor: item, item, name, value,
        nameHolder: {label: name, actor: name, text: title, style: null},
        valueHolder: {label: value, actor: value, text: '--', style: null},
        graph: area ? {area, key: null, spec: null, lastPaintUs: 0, samples: null, shown: false} : null,
        visible: true,
    };
}
