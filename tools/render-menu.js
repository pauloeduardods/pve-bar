// SPDX-License-Identifier: GPL-3.0-or-later
// Renders a sample of the menu to a PNG with the extension's own menu logic
// (lib/menuModel.js) and Cairo helpers, so it can be looked at without GNOME
// Shell. Runs with gjs only (no shell, no D-Bus, no settings):
//
//   gjs -m tools/render-menu.js [out.png]
//
// Left: the server titles with "home" expanded (node rows with inline
// graphs) and the cluster "lab" compact. Right: the detail view of guest
// 100. The texts, levels and graphs are the menu's; the GNOME theme is
// approximated (Cantarell 11, white on the menu's dark grey).

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {paintPieces} from '../extension/lib/draw.js';
import {defaultLayout, levelColor, renderOptions, sampleSnapshot, seriesLevelOf} from '../extension/lib/layout.js';
import {
    GUEST_WINDOW, MENU_GRAPHS, MENU_NODE_WINDOW, guestDetail, pinLabel, pinState, serverSummary,
} from '../extension/lib/menuModel.js';
import {
    Level, formatMemory, formatPercent, formatTemp, groupByServer, guestRows, guestSummary, level, nodeSummary,
    nodeValue, parseColor, sampleSeries, sparklinePieces, worstLevel,
} from '../extension/lib/model.js';

const out = ARGV[0] ?? 'pve-bar-menu.png';
const NOW = 3600e6;
const GIB = 1024 ** 3;
const snap = sampleSnapshot(NOW);
snap.servers.push({name: 'office', state: 'offline', message: 'connection refused (192.168.1.20:8006)'});
for (const [k, v] of Object.entries({
    'home/guest/100/uptime': 3 * 86400 + 4 * 3600 + 12 * 60,
    'home/guest/100/maxmem': 4 * GIB,
    'home/guest/100/maxcpu': 2,
    'home/node/pve/temp': 74,
}))
    snap.values.set(k, v);
const opts = renderOptions({});
const T = opts.thresholds;
const STYLE = {normal: '', warm: '#f8e45c', hot: '#f66151'};
const WHITE = [1, 1, 1];
const DIM = [0.62, 0.62, 0.62];
const rgbOfLevel = lvl => parseColor(levelColor(lvl, STYLE)) ?? WHITE;

const W = 980;
const COL = 470;
const ROW = 32;
const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, W, 560);
const cr = new Cairo.Context(surface);
cr.setSourceRGB(0.12, 0.12, 0.12);
cr.paint();

function panel(x, y, w, h) {
    cr.setSourceRGB(0.19, 0.19, 0.19);
    cr.rectangle(x, y, w, h);
    cr.fill();
}

function text(str, x, yMid, {rgb = WHITE, bold = false, size = 11, right = false} = {}) {
    const layout = PangoCairo.create_layout(cr);
    layout.set_font_description(Pango.FontDescription.from_string(`Cantarell ${bold ? 'Bold ' : ''}${size}`));
    layout.set_text(str, -1);
    const [w, h] = layout.get_pixel_size();
    cr.setSourceRGB(...rgb);
    cr.moveTo(right ? x - w : x, yMid - h / 2);
    PangoCairo.show_layout(cr, layout);
    return w;
}

function graph(key, kind, window, x, yMid) {
    const series = snap.history.get(key);
    const samples = series ? sampleSeries(series, NOW, window, 70) : null;
    if (!samples)
        return;
    const spec = MENU_GRAPHS[kind];
    cr.save();
    cr.translate(x, yMid - 8);
    paintPieces(cr, 16, sparklinePieces(samples, 70, 16,
        {levelOf: seriesLevelOf(spec.levelKind, opts), minRange: spec.minRange}), rgbOfLevel, {alpha: 0.85});
    cr.restore();
}

/** One menu row: name, optional graph, value on the right. */
function row(x, y, name, value, {lvl = Level.NORMAL, g = null, nameRgb = WHITE, w = COL - 20, bold = false} = {}) {
    const yMid = y + ROW / 2;
    text(name, x + 24, yMid, {rgb: nameRgb, bold});
    // As in the menu's box layout: the graph sits just left of the value.
    const valueW = value ? text(value, x + w - 12, yMid, {rgb: rgbOfLevel(lvl), bold: true, right: true}) : 0;
    if (g)
        graph(g.key, g.kind, g.window, x + w - 12 - valueW - 10 - 70, yMid);
    return y + ROW;
}

function arrow(x, yMid, open) {
    cr.setSourceRGB(...DIM);
    cr.moveTo(x, yMid - (open ? 2 : 5));
    if (open) {
        cr.lineTo(x + 10, yMid - 2);
        cr.lineTo(x + 5, yMid + 4);
    } else {
        cr.lineTo(x + 6, yMid);
        cr.lineTo(x, yMid + 5);
    }
    cr.closePath();
    cr.fill();
}

// ---- left: servers ----------------------------------------------------------------
const groups = groupByServer(snap.servers, snap.nodes, snap.guests);
panel(10, 10, COL - 10, 540);
let y = 20;
for (const group of groups) {
    const s = serverSummary(group, snap.values, T);
    const open = group.name === 'home';
    const yMid = y + ROW / 2;
    text(s.text, 34, yMid, {rgb: s.level === Level.UNKNOWN ? WHITE : rgbOfLevel(s.level), bold: true});
    arrow(COL - 30, yMid, open);
    y += ROW;
    if (group.message)
        y = row(10, y, group.message, '', {nameRgb: DIM});
    if (open) {
        cr.setSourceRGBA(1, 1, 1, 0.04);
        cr.rectangle(14, y, COL - 18, ROW * 6);
        cr.fill();
        const n = group.nodes[0];
        const v = what => nodeValue(snap.values, group.name, n.name, what);
        const p = `${group.name}/node/${n.name}/`;
        const lv = (val, k) => level(val, T[k].warm, T[k].hot);
        y = row(10, y, 'Node', `${n.name} · ${n.status}`);
        y = row(10, y, 'CPU', formatPercent(v('cpu'), 1),
            {lvl: lv(v('cpu'), 'cpu'), g: {key: `${p}cpu`, kind: 'cpu', window: MENU_NODE_WINDOW}});
        y = row(10, y, 'RAM', `${formatPercent(v('mem'))} · ${formatMemory(v('mem_used'), v('mem_total'))}`,
            {lvl: lv(v('mem'), 'mem'), g: {key: `${p}mem`, kind: 'mem', window: MENU_NODE_WINDOW}});
        y = row(10, y, 'Temperature', formatTemp(v('temp')),
            {lvl: lv(v('temp'), 'temp'), g: {key: `${p}temp`, kind: 'temp', window: MENU_NODE_WINDOW}});
        y = row(10, y, 'Disk', formatPercent(v('disk')), {lvl: lv(v('disk'), 'disk')});
        text(`Guests (${guestSummary(group.guests)})`, 34, y + ROW / 2);
        arrow(COL - 30, y + ROW / 2, true);
        y += ROW;
        for (const g of guestRows(group.guests, snap.values))
            y = row(30, y, `${g.dot}  ${g.title}  ${g.badge}`, g.usage, {nameRgb: g.dotClass === 'running' ? WHITE : DIM, w: COL - 40});
    } else if (group.name === 'lab') {
        // What "lab" shows expanded: one compact row per node with its CPU graph.
        for (const n of group.nodes) {
            const v = what => nodeValue(snap.values, group.name, n.name, what);
            const worst = worstLevel(['cpu', 'mem', 'temp'].map(k => level(v(k), T[k].warm, T[k].hot)));
            y = row(10, y, `  ${n.name}`, nodeSummary(snap.values, group.name, n.name),
                {lvl: worst, nameRgb: DIM, g: {key: `${group.name}/node/${n.name}/cpu`, kind: 'cpu', window: MENU_NODE_WINDOW}});
        }
    }
}
y = row(10, y + 8, 'Settings', '');

// ---- right: guest 100's detail view -------------------------------------------------
const guest = snap.guests.find(g => g.vmid === 100);
const d = guestDetail(guest, snap.values, T);
const X = COL + 10;
panel(X, 10, COL - 10, 540);
y = 20;
y = row(X, y, '← Guests', '', {nameRgb: DIM});
y = row(X, y, `${d.dot}  ${d.title}`, d.badge, {bold: true});
y = row(X, y, 'Status', d.status);
y = row(X, y, 'Uptime', d.uptime);
const gp = 'home/guest/100/';
y = row(X, y, 'CPU', d.cpu.text, {lvl: d.cpu.level, g: {key: `${gp}cpu`, kind: 'cpu', window: GUEST_WINDOW}});
y = row(X, y, 'RAM', d.mem.text, {lvl: d.mem.level, g: {key: `${gp}mem`, kind: 'mem', window: GUEST_WINDOW}});
y = row(X, y, 'Network in', d.netin, {g: {key: `${gp}netin`, kind: 'netin', window: GUEST_WINDOW}});
y = row(X, y, 'Network out', d.netout, {g: {key: `${gp}netout`, kind: 'netout', window: GUEST_WINDOW}});
y = row(X, y, 'Disk (inside)', d.fs.text, {lvl: d.fs.level});
y = row(X, y, pinLabel(pinState(defaultLayout(), 'home', 100)), '');

// The same view for a VM without the guest agent: the hint.
snap.values.delete('home/guest/100/fs');
const noAgent = guestDetail(guest, snap.values, T);
y += 16;
text('Without the guest agent / VM.Monitor:', X + 24, y + ROW / 2, {rgb: DIM, size: 9});
y += ROW - 8;
y = row(X, y, 'Disk (inside)', noAgent.fs.text);
row(X, y - 8, noAgent.fs.hint, '', {nameRgb: DIM});

surface.writeToPNG(out);
print(`wrote ${out}`);
