// SPDX-License-Identifier: GPL-3.0-or-later
// Renders sample top-bar layouts to a PNG with the extension's own layout
// engine and Cairo helpers, so the bar can be looked at without GNOME Shell.
// Runs with gjs only (no shell, no D-Bus, no settings):
//
//   gjs -m tools/render-bar.js [out.png]
//
// Text, colors and graphs come from lib/layout.js, lib/model.js and
// lib/draw.js with the sample snapshot the Settings preview uses; St's
// theme is approximated (Cantarell 11, white text on the panel's black).

import Cairo from 'cairo';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {paintBars, paintPieces} from '../extension/lib/draw.js';
import {
    addSegment, defaultLayout, pinGuest, presetLayout, renderLayout, renderOptions, sampleSnapshot,
    sanitizeLayout, segmentColor, segmentMarkup, setSegment,
} from '../extension/lib/layout.js';
import {Level, barPieces, barSlots, parseColor, sampleSeries, sparklinePieces} from '../extension/lib/model.js';

let Rsvg = null;
try {
    Rsvg = (await import('gi://Rsvg?version=2.0')).default;
} catch {
    // No librsvg typelib: icons are drawn as small squares.
}

const ROOT = GLib.path_get_dirname(GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]));
const out = ARGV[0] ?? 'pve-bar-sample.png';

const NOW = 3600e6;
const snap = sampleSnapshot(NOW);
const STYLE = {normal: '', warm: '#f8e45c', hot: '#f66151', bold: false};
const WHITE = [1, 1, 1];
const LEVEL_RGB = {[Level.NORMAL]: WHITE, [Level.WARM]: parseColor(STYLE.warm), [Level.HOT]: parseColor(STYLE.hot)};

let custom = pinGuest(defaultLayout(), 'home', 100);
custom = setSegment(custom, 3, {graph: {reading: 'netin', kind: 'bars', width: 'narrow'}});
custom = addSegment(custom, 'disk');
custom = setSegment(custom, 4, {graph: {kind: 'area', only: true, width: 'wide', color: '#62a0ea', window: 3600}});
const hotLayout = sanitizeLayout({segments: [
    {target: {server: '', node: ''}, items: ['cpu', 'mem', 'temp'],
        graph: {reading: 'temp', kind: 'line', width: 'medium', window: 900}},
    {target: {server: 'home', guest: 102}, items: ['name', 'status']},
    {target: {server: 'home', node: 'gone'}, items: ['cpu']},
]});

const ROWS = [
    ['Default', presetLayout('default'), {}],
    ['Minimal', presetLayout('minimal'), {}],
    ['Graphs', presetLayout('graphs'), {}],
    ['Cluster', presetLayout('cluster', snap), {}],
    ['Pinned guest, bars, fixed color', custom, {}],
    ['Warm/hot, stopped, missing', hotLayout, {thresholds: {cpu: {warm: 20, hot: 50}, temp: {warm: 50, hot: 70}}}],
];

const W = 900;
const ROW_H = 30;
const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, W, ROWS.length * ROW_H + 10);
const cr = new Cairo.Context(surface);
cr.setSourceRGB(0, 0, 0);
cr.paint();

const font = Pango.FontDescription.from_string('Cantarell 11');

function text(markup, x, yMid, rgb = WHITE, alpha = 1) {
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(font);
    layout.set_markup(markup, -1);
    const [w, h] = layout.get_pixel_size();
    cr.setSourceRGBA(...rgb, alpha);
    cr.moveTo(x, yMid - h / 2);
    PangoCairo.show_layout(cr, layout);
    return w;
}

function icon(name, x, yMid, rgb, alpha) {
    const size = 14;
    cr.save();
    cr.translate(x, yMid - size / 2);
    if (Rsvg) {
        const handle = Rsvg.Handle.new_from_file(`${ROOT}/extension/icons/${name}-symbolic.svg`);
        cr.pushGroup();
        const viewport = new Rsvg.Rectangle({x: 0, y: 0, width: size, height: size});
        handle.render_document(cr, viewport);
        const mask = cr.popGroup();
        cr.setSourceRGBA(...rgb, alpha);
        cr.mask(mask);
    } else {
        cr.setSourceRGBA(...rgb, alpha);
        cr.rectangle(2, 2, size - 4, size - 4);
        cr.fill();
    }
    cr.restore();
    return size;
}

function graph(spec, x, yMid) {
    const width = spec.width;
    const height = 16;
    const series = snap.history.get(spec.key);
    const columns = spec.kind === 'bars' ? barSlots(width) : width;
    const samples = sampleSeries(series, NOW, spec.window, columns);
    if (samples) {
        const fixed = spec.color === 'follow' ? null : parseColor(spec.color);
        const rgbOf = lvl => fixed ?? LEVEL_RGB[lvl] ?? WHITE;
        const options = {levelOf: spec.levelOf, minRange: spec.minRange, percent: spec.percent};
        cr.save();
        cr.translate(x, yMid - height / 2);
        if (spec.kind === 'bars')
            paintBars(cr, barPieces(samples, width, height, options), rgbOf);
        else
            paintPieces(cr, height, sparklinePieces(samples, width, height, options), rgbOf, {fill: spec.kind === 'area'});
        cr.restore();
    }
    return width;
}

ROWS.forEach(([title, layout, options], row) => {
    const yMid = 5 + row * ROW_H + ROW_H / 2;
    text(title, 10, yMid, [0.6, 0.6, 0.6]);
    let x = 260;
    for (const r of renderLayout(layout, snap, renderOptions(options))) {
        if (!r.visible)
            continue;
        const alpha = r.dim ? 0.5 : 1;
        if (r.icon) {
            x += icon(r.icon, x, yMid, parseColor(segmentColor(r, STYLE)) ?? WHITE, alpha);
            x += 3;
        }
        if (r.showText) {
            x += text(segmentMarkup(r, STYLE), x, yMid, WHITE, alpha);
            x += 3;
        }
        if (r.graph)
            x += graph(r.graph, x, yMid) + 3;
        x += 10;
    }
});

surface.writeToPNG(out);
print(`wrote ${out}`);
