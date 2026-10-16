// SPDX-License-Identifier: GPL-3.0-or-later
// The live preview of the top bar on the Layout page. Rendered by the same
// engine as the bar (layout.js for the text and colors, draw.js for the
// graphs), and updated the way the bar is: a widget is touched only when
// what it shows changed, and a graph repaints only when its series got a
// value or a column of time passed (graphNeedsRepaint). No timers.

import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {paintBars, paintPieces} from '../draw.js';
import {colorHex, levelColor, renderLayout, segmentMarkup} from '../layout.js';
import {
    Level, barPieces, barSlots, graphNeedsRepaint, parseColor, sampleSeries, sparklinePieces,
} from '../model.js';

const GRAPH_HEIGHT = 16;
const WHITE = [1, 1, 1];

let provider = null;
let providerCss = '';

/** The preview's look: the panel's black, and the level colors for the icons. */
export function setPreviewColors(style) {
    const normal = colorHex(style.normal) ?? '#ffffff';
    const warm = colorHex(style.warm) ?? normal;
    const hot = colorHex(style.hot) ?? normal;
    const css = `
.pve-bar-preview { background-color: #1e1e1e; color: ${normal}; border-radius: 9px; padding: 6px 14px; font-weight: bold; }
.pve-bar-preview .pve-bar-warm { color: ${warm}; }
.pve-bar-preview .pve-bar-hot { color: ${hot}; }
.pve-bar-preview-empty { color: alpha(#ffffff, 0.5); font-weight: normal; }
`;
    if (css === providerCss)
        return;
    const display = Gdk.Display.get_default();
    if (!display)
        return;
    if (!provider) {
        provider = new Gtk.CssProvider();
        Gtk.StyleContext.add_provider_for_display(display, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    }
    if (provider.load_from_string)
        provider.load_from_string(css);
    else
        provider.load_from_data(css, -1);
    providerCss = css;
}

function sameGraph(a, b) {
    return a !== null && b !== null && a.key === b.key && a.kind === b.kind && a.window === b.window &&
        a.color === b.color && a.width === b.width && a.levelOf === b.levelOf;
}

/** Sets `slot.shown[key]` and calls `apply` only when the value changed. */
function update(slot, key, value, apply) {
    if (slot.shown[key] === value)
        return;
    slot.shown[key] = value;
    apply(value);
}

export class Preview {
    /** @param {string} extensionPath where the icons are */
    constructor(extensionPath) {
        this._path = extensionPath;
        this.widget = new Gtk.Box({
            spacing: 10, halign: Gtk.Align.CENTER, css_classes: ['pve-bar-preview'], margin_bottom: 6,
        });
        this._empty = new Gtk.Label({label: 'Nothing to show', css_classes: ['pve-bar-preview-empty'], visible: false});
        this.widget.append(this._empty);
        this._slots = [];
        this._history = null;
        this._style = {normal: '', warm: '', hot: ''};
        this._now = () => GLib.get_monotonic_time();
        /** How many graphs were painted, for the smoke test. */
        this.paints = 0;
    }

    /**
     * Renders `layout` from `snap` and returns what renderLayout gave.
     * `changed` is the client's Updated dictionary, or null when anything
     * may have changed (an edit, a setting, the data source). `now()` is
     * the time graphs end at (the sample history's own time for samples).
     */
    render(layout, snap, options, style, changed, now) {
        this._history = snap.history;
        this._now = now;
        if (changed === null)
            this._style = style;
        const rendered = renderLayout(layout, snap, options);
        while (this._slots.length < rendered.length)
            this._slots.push(this._makeSlot());
        while (this._slots.length > rendered.length)
            this.widget.remove(this._slots.pop().box);

        let shown = 0;
        let mono = 0;
        for (let i = 0; i < rendered.length; i++) {
            const r = rendered[i];
            const slot = this._slots[i];
            update(slot, 'visible', r.visible, v => (slot.box.visible = v));
            if (!r.visible) {
                slot.spec = null;
                continue;
            }
            shown++;
            update(slot, 'opacity', r.dim ? 0.5 : 1, v => (slot.box.opacity = v));
            update(slot, 'icon', r.icon, name => {
                slot.icon.gicon = name ? Gio.icon_new_for_string(`${this._path}/icons/${name}-symbolic.svg`) : null;
                slot.icon.visible = name !== null;
            });
            const lvl = r.level === Level.HOT || r.level === Level.WARM ? r.level : null;
            update(slot, 'level', lvl, v => {
                slot.icon.remove_css_class('pve-bar-warm');
                slot.icon.remove_css_class('pve-bar-hot');
                if (v)
                    slot.icon.add_css_class(`pve-bar-${v}`);
            });
            update(slot, 'labelVisible', r.showText, v => (slot.label.visible = v));
            if (r.showText)
                update(slot, 'markup', segmentMarkup(r, style), m => slot.label.set_markup(m));

            const spec = r.graph;
            update(slot, 'graphVisible', spec !== null, v => (slot.area.visible = v));
            if (!spec) {
                slot.spec = null;
                continue;
            }
            update(slot, 'graphWidth', spec.width, w => (slot.area.content_width = w));
            let repaint = changed === null || !sameGraph(slot.spec, spec);
            if (!repaint && spec.key !== null) {
                mono ||= GLib.get_monotonic_time();
                const columns = spec.kind === 'bars' ? barSlots(spec.width) : spec.width;
                repaint = graphNeedsRepaint(slot.lastPaintUs, mono, spec.window, columns,
                    Object.hasOwn(changed, spec.key));
            }
            slot.spec = spec;
            if (repaint)
                slot.area.queue_draw();
        }
        if (this._empty.visible !== (shown === 0))
            this._empty.visible = shown === 0;
        return rendered;
    }

    _makeSlot() {
        const box = new Gtk.Box({spacing: 3, valign: Gtk.Align.CENTER});
        const icon = new Gtk.Image({pixel_size: 14, visible: false});
        const label = new Gtk.Label();
        const area = new Gtk.DrawingArea({content_height: GRAPH_HEIGHT, valign: Gtk.Align.CENTER, visible: false});
        box.append(icon);
        box.append(label);
        box.append(area);
        const slot = {box, icon, label, area, shown: {}, spec: null, samples: null, lastPaintUs: 0};
        area.set_draw_func((_area, cr, width, height) => {
            try {
                this._paint(slot, cr, width, height);
            } finally {
                cr.$dispose();
            }
        });
        // Before the "Nothing to show" label, which stays last.
        this.widget.insert_child_after(box, this._slots.length ? this._slots[this._slots.length - 1].box : null);
        return slot;
    }

    _rgbOf(spec) {
        const fixed = spec.color === 'follow' ? null : parseColor(spec.color);
        const style = this._style;
        return lvl => fixed ?? parseColor(levelColor(lvl, style)) ?? parseColor(style.normal) ?? WHITE;
    }

    _paint(slot, cr, width, height) {
        slot.lastPaintUs = GLib.get_monotonic_time();
        const spec = slot.spec;
        const series = spec?.key ? this._history?.get(spec.key) : null;
        if (!series)
            return;
        const columns = spec.kind === 'bars' ? barSlots(width) : Math.max(1, Math.round(width));
        if (slot.samples?.length !== columns)
            slot.samples = new Array(columns);
        const samples = sampleSeries(series, this._now(), spec.window, columns, slot.samples);
        if (!samples)
            return;
        this.paints++;
        const options = {levelOf: spec.levelOf, minRange: spec.minRange, percent: spec.percent};
        const rgbOf = this._rgbOf(spec);
        if (spec.kind === 'bars')
            paintBars(cr, barPieces(samples, width, height, options), rgbOf);
        else
            paintPieces(cr, height, sparklinePieces(samples, width, height, options), rgbOf, {fill: spec.kind === 'area'});
    }
}
