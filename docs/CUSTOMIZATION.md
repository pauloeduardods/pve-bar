# Customization, history, per-guest view and alerts (phases 2 to 4)

> **Status:** specification. This is the contract the work is split on. Each
> section names the lane that implements it. Where a section and the code
> disagree after a lane merges, the code and `ARCHITECTURE.md` win and this
> file is updated in the same pull request.

The goal is parity with the customization of
[helios-panel](https://github.com/pauloeduardods/Helios-Panel) (layout engine,
merged segments, templates, graphs in the bar, presets, import/export, layout
editor with live preview, alerts, compact menu with inline graphs), adapted to
Proxmox: several servers, nodes and guests instead of one laptop. The helios
code is the reference for structure, naming, style and quality; read it at
`~/Documents/Projetos/helios-panel` (`extension/lib/layout.js`, `draw.js`,
`model.js`, `client.js`, `alerts.js`, `ui/`, `prefs/`, `prefs.js`, the schema,
`tests/`, and `docs/FOOTPRINT.md`, `tools/footprint.sh`).

Performance rules from `ARCHITECTURE.md` stay in force and get stricter:

- gnome-shell never does network or file I/O and runs no timers of its own
  (no `GLib.timeout_add` anywhere in `extension/`).
- Nothing in the menu is updated while the menu is closed; opening it renders
  it first. Graphs repaint only when a value they draw arrives.
- Only the style, markup, text and graph width that changed are applied to an
  actor (cache per actor, as helios does).
- History is loaded once per connection and then appended locally from
  `Updated`; there is no polling of `GetHistory`.
- pved fetches per-guest details only while a client watches that guest.

## 1. History (lane A: pved; lane B: client)

### pved

- Every poll records, for every value key it publishes, one sample in a
  fixed ring buffer (`pve_core::ring::Ring<360>`, f32): 1 hour at 10 s. A key
  whose server failed records a gap (NaN). Memory: about 1.5 KB per key; 300
  guests on 3 servers is about 1 MB. Keys that disappear (guest deleted) drop
  their ring after one hour of gaps.
- Samples carry the poll time; servers poll independently, so each server's
  rings have their own clock.

### D-Bus

| Method | Signature | Meaning |
|---|---|---|
| `GetHistory` | `(as keys) → a{s(adad)}` | for each requested key (empty list = every key): (ages in seconds, oldest first; values, NaN for gaps). Unknown keys are left out. |

`ApiVersion` becomes `2`. Clients must accept a pved without `GetHistory`
(API 1) and simply draw no history.

### Client (extension/lib/client.js)

- After `GetValues`, call `GetHistory` **once** with the keys the current
  layout and menu draw (the client exposes `setHistoryKeys(keys)`; a change
  of keys fetches only the new ones). Store per key a time-stamped step series
  `[(t, v), ...]` with `t` from `GLib.get_monotonic_time()`.
- Every `Updated` appends `(now, v)` for the keys it carries. A key that did
  not change keeps its last value (step semantics), so no tick per poll is
  needed. Trim to the longest span in use (at most 1 hour) on append.
- `snapshot().history` exposes the buffer read-only; the model provides
  `sampleSeries(series, nowUs, spanS, width) → array of width values or null`
  for drawing.

## 2. Per-guest details (lane A: pved; lane E: menu)

| Method | Signature | Meaning |
|---|---|---|
| `Watch` | `(s server, u vmid) → ()` | start fetching this guest's details every poll, for the calling bus name |
| `Unwatch` | `(s server, u vmid) → ()` | stop; also implicit when the caller's bus name vanishes (pved tracks `NameOwnerChanged`) |

While at least one client watches a guest, each poll of its server also does
(read-only, concurrently, same keep-alive client):

- `GET /nodes/{node}/{qemu|lxc}/{vmid}/status/current` →
  `guest/<vmid>/uptime` (s), `netin`, `netout` (bytes/s, from the counter
  difference between two polls; first poll has none), `diskread`,
  `diskwrite` (bytes/s), `maxmem`, `maxcpu`.
- qemu only, when the guest agent is enabled and running:
  `GET /nodes/{node}/qemu/{vmid}/agent/get-fsinfo` every 6th poll (1 min) →
  `guest/<vmid>/fs` (% used of all non-virtual filesystems). Errors (agent
  missing) are silent: the key is absent.
- Once, when the watch starts: `GET .../rrddata?timeframe=hour&cf=AVERAGE` to
  backfill the guest's `cpu` and `mem` rings (and `netin`/`netout`), so the
  graph shows the last hour at once.

These keys use the same `Updated` / `GetValues` / `GetHistory` paths and are
removed (NaN) when the last watcher leaves. A misbehaving client can watch at
most 16 guests; further calls fail with `...Error.TooManyWatches`.

## 3. Layout engine (lane B)

`extension/lib/layout.js`: pure, no GNOME imports, never throws on bad input;
the indicator and the Settings preview render through it. Port helios'
engine and adapt it.

### Targets

Every segment has a target; its readings come from that target.

```json
{"server": "", "node": ""}          // a node; "" = the selected server / first online node
{"server": "home", "guest": 101}     // a guest
{"server": "lab"}                    // a server as a whole
```

`""` for the server means the `server` setting (else the first server); `""`
for the node means the `node` setting (else the first online node of that
server). Targets that no longer exist render `--` (and their graphs nothing).

### Readings and placeholders

| Target | Reading id | Template default | Series (value key suffix) | Icon |
|---|---|---|---|---|
| node | `cpu` | `{cpu}%` | `node/<n>/cpu` | cpu |
| node | `mem` | `{mem}%` | `node/<n>/mem` | ram |
| node | `mem-used` | `{mem-used}/{mem-total} GiB` | `node/<n>/mem` | ram |
| node | `mem-total` | `{mem-total} GiB` | — | ram |
| node | `disk` | `{disk}%` | `node/<n>/disk` | disk |
| node | `temp` | `{temp}°` | `node/<n>/temp` | temp |
| node | `status` | `{status}` | — | server |
| guest | `cpu`, `mem` | as above | `guest/<id>/cpu`, `mem` | cpu, ram |
| guest | `name`, `status` | `{name}`, `{status}` | — | vm |
| guest | `netin`, `netout` | `{netin}` (auto B/s, KB/s, MB/s) | `guest/<id>/netin` | net |
| guest | `fs` | `{fs}%` | `guest/<id>/fs` | disk |
| server | `running` | `{running}/{guests}` | — | server |
| server | `state` | `{state}` | — | server |

Guest details (`netin`, `netout`, `fs`, `uptime`) exist only while the
guest is watched; a segment that uses them makes the extension `Watch` that
guest for as long as the segment exists (counts toward the 16).

Template syntax, limits and fallbacks are helios': `{cpu:1}` for one decimal,
`{{`/`}}` literal braces, unknown placeholder → `--`, units glued to a missing
value are dropped, at most 12 segments × 8 readings, 200-char templates,
120-char text.

### Layout JSON (`panel-layout` setting)

```json
{"version": 1, "segments": [
  {"target": {"server": "", "node": ""}, "items": ["cpu"], "template": "", "icon": "auto",
   "graph": {"reading": "cpu", "kind": "line", "only": false, "width": "narrow", "window": 600, "color": "follow"}},
  {"target": {"server": "", "node": ""}, "items": ["mem", "temp"], "template": "{mem}% · {temp}°", "icon": "auto", "graph": null}
]}
```

- `graph.kind`: `line`, `area`, `bars`. `graph.window`: 300, 900, 1800 or 3600
  s. `graph.width`: `narrow` 30, `medium` 45, `wide` 70 px. `graph.color`:
  `follow` (threshold colors on the line, as helios) or `#rrggbb`.
- Thresholds per reading kind (cpu, mem, disk, temp, fs) come from the
  existing `*-warm`/`*-hot` keys plus new `disk-*` and `fs-*`.
- **Migration:** `panel-layout` defaults to `''`; on first run it is built
  once from the MVP settings (`server`, `node`, `show-icons`, thresholds:
  segments CPU, RAM, temperature of the selected node) and stored.
- **Presets:** Minimal (CPU · RAM in one segment), Default (MVP look), Graphs
  (CPU line + RAM area + temperature), Cluster (one compact segment per
  server: `{running}/{guests}` + CPU of its first node), with Undo.
- **Import/export** as JSON (functions here; file dialogs in lane C).

### Drawing (`extension/lib/draw.js`)

Port helios' Cairo helpers (`paintPieces`, `paintBars`); bar graphs in
`St.DrawingArea`, repainted only when one of their series got a value.

## 4. Layout editor (lane C, after lane B)

`extension/lib/prefs/layoutPage.js`, as helios': segments list (move,
add, remove), per reading (merge with previous/next, split, remove, add),
target picker (server → node or guest, from pved's `Servers`/`Nodes`/`Guests`
read over D-Bus by the prefs process, or free text when pved is down),
template entry with live validation, icon, graph controls, presets with Undo,
import/export via `Gtk.FileDialog`, and a **live preview** rendered by
`layout.js` + `draw.js` from pved's values and history (or sample values when
pved is not running). Also: a Thresholds page (all `*-warm`/`*-hot`), and the
existing General settings.

## 5. Alerts (lane D)

All in the extension, pure engine (`extension/lib/alerts.js`, no GNOME
imports, `AlertEngine.update(snapshot, nowSeconds, settings) → actions`), UI
in `extension/lib/ui/alerts.js` (own `PveClient`, `Main.notify`, created in
`extension.js`), page in `extension/lib/prefs/alerts.js`. Episodes with
hysteresis and "held for N s" exactly like helios, measured between `Updated`
signals, no timers.

| Alert | Default | Fires when | Ends when |
|---|---|---|---|
| Host temperature | on, 85 °C for 60 s | `node/*/temp` ≥ limit for the hold time | < limit − 3 |
| Host RAM | on, 95 % for 120 s | `node/*/mem` | < limit − 5 |
| Host disk | on, 90 % | `node/*/disk` ≥ limit (no hold) | < limit − 2 |
| Server unreachable | on, 120 s | a server's state is not `ok` for the hold time | `ok` again |
| Guest stopped | off; list of watched guests (`server/vmid`), empty = all running ones | a guest goes from `running` to anything else | it is running again |
| Guest started | off | a guest goes to `running` | — |

The first snapshot after connecting is never a transition. Each alert names
the server and node or guest. A "Test notification" button in the page.

## 6. Menu (lane E, after lanes A and B)

- One collapsed section per server whose title carries a summary
  (`home · 23% · 61% · 54° · 23/30`, coloured by the worst level; a down
  server shows its state).
- Inside: per node, CPU, RAM, temperature with the history graph inline on
  the same row (as helios #23); disk without graph.
- Guests submenu; each guest row opens a per-guest submenu (or expander)
  that `Watch`es it while open and shows CPU and RAM graphs (backfilled from
  `rrddata`), network in/out, disk inside the VM (agent), uptime, and a **Pin
  to bar** button that appends a segment with that guest as target to
  `panel-layout`. `Unwatch` when the submenu closes or the menu closes.
- Nothing updates while the menu is closed.

## 7. Footprint (lane A)

`tools/footprint.sh` as helios': `live` (installed pved and gnome-shell,
read-only, CPU and RSS over N s), `bench` (pved release on a private session
bus, `--fake` and against a local HTTPS mock, as in the MVP measurement).
`docs/FOOTPRINT.md` with the numbers. Budgets: pved under 0.5 % of a core
and 15 MB with 3 servers and 100 guests watched in the bar; the extension adds
nothing measurable to gnome-shell with 8 segments and graphs.

## Lanes, files and order

| Lane | Owns | Starts |
|---|---|---|
| A: pved history, watch, footprint | `crates/**`, `tools/`, `docs/ARCHITECTURE.md` (API section), `docs/FOOTPRINT.md` | now |
| B: client history, layout engine, bar | `extension/lib/{client,layout,draw,model}.js`, `extension/lib/ui/indicator.js` (panel part), schema, `tests/{client,layout,model}.test.js`, gi-stubs | now |
| D: alerts | `extension/lib/{alerts.js,ui/alerts.js,prefs/alerts.js}`, `tests/alerts.test.js`, schema `<!-- Alerts -->` block, one line each in `extension.js` and `prefs.js` | now |
| C: layout editor | `extension/prefs.js`, `extension/lib/prefs/**` (except alerts) | after B merges |
| E: menu | `extension/lib/ui/indicator.js` (menu part), menu tests | after A and B merge |

Every lane works on its own branch in its own worktree and lands through a
pull request (main is protected: CI `checks` must pass). A lane rebases on
main before opening its pull request.

## Safety rules for every lane (this machine froze twice)

- Never start gnome-shell (nested or not), never reload the real shell, never
  run `gsettings`/`dconf` writes against the real database (use
  `GSETTINGS_BACKEND=memory`), never install into the real `~` (installer
  tests use a fake `HOME`), never `systemctl --user` start/stop/enable.
- GTK/prefs smoke tests only under `xvfb-run` with `GSETTINGS_BACKEND=memory`
  and a scratch `HOME`/`XDG_*`, and only if needed.
- Every build, test or lint runs under the shared lock and a memory cap:
  `flock -w 900 ~/.cache/claude-heavy.lock systemd-run --user --scope -q -p MemoryMax=6G -p MemorySwapMax=0 <cmd>`,
  with `cargo -j 4`.
- Kill every process you start (dbus-daemon, pved, mocks) before finishing.
