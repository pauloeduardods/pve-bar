# Architecture

> **Status:** phases 0 and 1 of the roadmap (the MVP): pve-core, pve-sys,
> pved, pvectl, pve-temp-agent, the installer and an extension with three
> fixed indicators and the guest list. pved's side of phases 2 and 3 (the
> history and the per-guest details, D-Bus API 2) is in place; the
> extension's customization, per-VM view and alerts are being built
> ([CUSTOMIZATION.md](CUSTOMIZATION.md)).

## Goals and scope

pve-bar shows a Proxmox VE server in the GNOME top bar. It only reads.

| In scope | Out of scope, never |
|---|---|
| CPU, RAM, disk and status of nodes, VMs (qemu) and containers (LXC) | starting, stopping or changing any guest |
| host temperatures, through a tiny agent on the host | any endpoint that changes state in Proxmox |
| a `PVEAuditor` API token kept in the GNOME Keyring | root on the desktop, passwords, tickets |

## Components

```
   Proxmox host                          your desktop (user session)
┌───────────────────────────┐        ┌───────────────────────────────────────────┐
│ pveproxy :8006            │ HTTPS  │ pved (systemd --user, session bus)        │
│  GET /cluster/resources ◀─┼────────┼─ every 10 s, one call for everything      │
│                           │        │  - diffs values at display resolution     │
│ pve-temp-agent :9101      │ HTTP   │  - one Updated signal per cycle           │
│  GET /temps             ◀─┼────────┼─ same cycle, if configured                │
│  (DynamicUser, no caps)   │        │  - backoff 10→120 s, 60 s when locked     │
└───────────────────────────┘        └──────────────┬────────────────────────────┘
                                                    │ session D-Bus
                                     ┌──────────────▼───────────┐ ┌──────────────┐
                                     │ GNOME extension          │ │ pvectl       │
                                     │ draws only: no network,  │ │ status,      │
                                     │ no files, no timers      │ │ doctor, setup│
                                     └──────────────────────────┘ └──────────────┘
```

- **pve-core**: the pure logic. Parses `/cluster/resources`, turns it into
  rounded values, diffs two cycles, picks the CPU temperature, computes the
  backoff, parses the config file, keeps the hour of history, parses the
  per-guest details (`status/current`, `rrddata`, `get-fsinfo`) and turns
  byte counters into rates, and generates the fake cluster. No network, no
  D-Bus, no files.
- **pve-sys**: the real I/O for it: the Proxmox HTTP client (reqwest + rustls,
  keep-alive, optional certificate pinning), the temperature agent client,
  the Secret Service (GNOME Keyring) client over zbus, and the config file
  location. Shared by pved and pvectl.
- **pved**: the user service. Polls, diffs, records the history, fetches
  the details of the guests clients watch, publishes on the session bus.
  It needs no root and no polkit: it only reads another machine over the
  network, so it runs in your session (`systemd --user`).
- **pvectl**: `status`, `doctor` and `setup`. Talks to Proxmox directly
  with the same config and token, so it works without pved.
- **pve-temp-agent**: a std-only binary for the Proxmox host that serves the
  hwmon temperatures over HTTP, behind its own token.
- **extension/**: renders what pved publishes. Zero I/O in gnome-shell.

## Several servers

pve-bar watches any number of independent Proxmox servers (single hosts or
clusters) at once. Each one is a `[name]` section in the config, polled on
its own schedule with its own backoff, so one server being down never delays
or hides the others. The name (`a-z`, `0-9`, `-`, up to 32 characters)
prefixes every D-Bus value key, because VMIDs repeat across servers.

## Configuration

`~/.config/pve-bar/pved.conf` (written by `pvectl setup NAME`), one `[name]`
section per server, `key = value` lines, `#` comments:

```ini
[home]
url = https://pve.lan:8006
token_id = monitor@pve!pve-bar
# SHA-256 fingerprint of the server certificate, as the Proxmox UI shows it
# (Node → System → Certificates). Empty: trust the public CAs.
fingerprint = AB:CD:...
# Optional: the temperature agent on that host.
temp_url = http://pve.lan:9101

[lab]
url = https://lab.lan:8006
token_id = monitor@pve!pve-bar
fingerprint = 12:34:...
```

pved reads the file at start and again on `SIGHUP`
(`systemctl --user reload pved`, which `pvectl setup` runs for you).

Secrets live in the GNOME Keyring (Secret Service), never in this file or in
GSettings:

| Secret | Attributes |
|---|---|
| Proxmox API token secret | `application=pve-bar`, `kind=api-token`, `server=<name>` |
| temperature agent token | `application=pve-bar`, `kind=temp-agent`, `server=<name>` |

## D-Bus API (version 2)

- **Bus:** session bus.
- **Well-known name:** `io.github.pauloeduardods.PveBar1` (the `1` is the API
  major version).
- **Object:** `/io/github/pauloeduardods/PveBar1`.
- **Interface:** `io.github.pauloeduardods.PveBar1`.
- D-Bus activation starts pved on demand (`SystemdService=pved.service`).

### Properties (read-only, emit `PropertiesChanged`)

| Property | Type | Meaning |
|---|---|---|
| `Version` | `s` | pved version, e.g. `0.1.0` |
| `ApiVersion` | `u` | `2` (1 had no `GetHistory`, `Watch` or `Unwatch`; clients should accept it and draw no history) |
| `Fake` | `b` | `true` when pved runs with `--fake` |
| `ConfigError` | `s` | why pved.conf could not be read; `""` when fine. No servers and no error means "not set up yet" |
| `Servers` | `a(sss)` | (server, state, message) in config order. state: `connecting`, `ok`, `offline`, `unauthorized`, `tls-error`, `no-token`; message is `""` when `ok` |
| `Nodes` | `a(sss)` | (server, node, status `online`/`offline`/`unknown`), by server in config order, then node name |
| `Guests` | `a(sussss)` | (server, vmid, kind `qemu`/`lxc`, node, name, status), by server, then vmid; templates left out |

`Nodes` and `Guests` change rarely (a guest starts, stops, is renamed or
created), so they are properties: they are only sent when they change. When a
server fails, its nodes, guests and values are removed until it answers again,
so nothing stale is shown; its entry in `Servers` says why.

### Methods

| Method | Signature | Meaning |
|---|---|---|
| `GetValues` | `() → a{sd}` | every current value; call it once after the name appears |
| `GetHistory` | `(as keys) → a{s(adad)}` | for each requested key (an empty list means every key): (ages in seconds before now, oldest first; values, `NaN` for gaps). Unknown keys are left out. Call it once per connection, then append what `Updated` brings |
| `Watch` | `(s server, u vmid) → ()` | fetch this guest's details every poll (see *Per-guest details*) for as long as the caller watches it |
| `Unwatch` | `(s server, u vmid) → ()` | undo one `Watch` |

### Errors

| Error | When |
|---|---|
| `io.github.pauloeduardods.PveBar1.Error.TooManyWatches` | `Watch` of a 17th different guest by the same caller |

### Signals

| Signal | Signature | Meaning |
|---|---|---|
| `Updated` | `a{sd}` | the values that changed, never empty. A value that no longer exists (guest removed, server down, temperature agent gone) is sent once as `NaN` |

### Value keys

Every key starts with the server name. Values are rounded **in pved** to what
the panel displays, and a value equal to the previous one after rounding is
not sent.

| Key | Unit | Rounding |
|---|---|---|
| `<server>/node/<node>/cpu` | % of all host CPUs | 0.1 |
| `<server>/node/<node>/mem` | % of host RAM used | 1 |
| `<server>/node/<node>/mem_used` | bytes | 0.1 GiB |
| `<server>/node/<node>/mem_total` | bytes | 0.1 GiB |
| `<server>/node/<node>/disk` | % of the root filesystem used | 1 |
| `<server>/node/<node>/temp` | °C, CPU package (from pve-temp-agent) | 1 |
| `<server>/guest/<vmid>/cpu` | % of the guest's own vCPUs | 0.1 |
| `<server>/guest/<vmid>/mem` | % of the guest's max memory | 1 |

Stopped guests report `cpu` = 0 and `mem` = 0. `node/<node>/temp` only exists
while that server's pve-temp-agent is configured and answering, and only for
the node named in the agent's reply.

These exist only while some client watches the guest (`Watch`), and are sent
as `NaN` when the last watcher leaves:

| Key | Unit | Rounding |
|---|---|---|
| `<server>/guest/<vmid>/uptime` | seconds | 1 |
| `<server>/guest/<vmid>/netin`, `netout` | bytes/s, network | 3 significant digits (whole bytes below 1000) |
| `<server>/guest/<vmid>/diskread`, `diskwrite` | bytes/s, virtual disks | 3 significant digits |
| `<server>/guest/<vmid>/maxmem` | bytes | none |
| `<server>/guest/<vmid>/maxcpu` | vCPUs | none |
| `<server>/guest/<vmid>/fs` | % used of the guest's own filesystems (qemu guest agent) | 1 |

The rates need two readings, so they appear on the second poll of a watch
and are left out across a failed request or a guest restart (a counter that
went backwards). `fs` only exists for running VMs with the guest agent
enabled that answer `get-fsinfo`.

### History

Every poll records one sample for every value key of that server, `NaN` when
the key had no value or the server failed, in a ring of 360 points (one hour
at 10 s, about 1.5 KB per key). Each server keeps its own ring of poll times,
since servers poll and back off independently. `GetHistory` returns what is
at most one hour old: after backing off to 120 s an hour is 30 points. A key
with no value for an hour (guest deleted, watch ended) is dropped. When a
watch starts, the guest's `rrddata` (one point a minute) fills the hour
before the guest's first sample and any gaps it covers, for `cpu`, `mem`,
`netin` and `netout`.

### Per-guest details

`Watch` is counted per caller and guest: the same client may watch a guest
twice (its panel segment and its open menu) and must `Unwatch` it twice. A
caller whose bus name goes away (`NameOwnerChanged`) loses all its watches.
A watch of a guest that does not exist (yet) is accepted and does nothing.
While at least one client watches a guest, every poll of its server also
makes these read-only requests, a few at a time, alongside
`/cluster/resources` and on the same keep-alive connections:

| Request | When | Gives |
|---|---|---|
| `GET /nodes/{node}/{qemu\|lxc}/{vmid}/status/current` | every poll | `uptime`, `maxmem`, `maxcpu`, and the byte counters for the rates |
| `GET /nodes/{node}/qemu/{vmid}/agent/get-fsinfo` | on the watch's 1st, 7th, 13th... fetch (once a minute), only when `status/current` says the VM runs with the agent enabled | `fs`; errors are silent and leave it out |
| `GET .../rrddata?timeframe=hour&cf=AVERAGE` | once, when the watch starts | the backfill |

A new watch is fetched at once rather than at the next poll, so a menu that
opens fills in immediately.

### Example

```
$ busctl --user call io.github.pauloeduardods.PveBar1 /io/github/pauloeduardods/PveBar1 \
      io.github.pauloeduardods.PveBar1 GetValues
a{sd} 5 "home/node/pve/cpu" 23.4 "home/node/pve/mem" 61 "home/node/pve/temp" 54 "lab/guest/101/cpu" 87.1 ...

$ busctl --user call io.github.pauloeduardods.PveBar1 /io/github/pauloeduardods/PveBar1 \
      io.github.pauloeduardods.PveBar1 GetHistory as 1 home/node/pve/cpu
a{s(adad)} 1 "home/node/pve/cpu" 360 3590.0 3580.0 ... 0.4 360 21.7 22.0 ... 23.4
```

## pve-temp-agent protocol

`GET /temps` with `Authorization: Bearer <token>`:

```json
{"schema": 1, "node": "pve",
 "sensors": [{"chip": "coretemp", "label": "Package id 0", "celsius": 54.0},
             {"chip": "nvme", "label": "Composite", "celsius": 41.9}]}
```

- `node` is the host name (`/proc/sys/kernel/hostname`), which is the Proxmox
  node name.
- `401` for a missing or wrong token (compared in constant time), `404` for
  any other path, `405` for any other method. Bodies are never read.
- The token is a file passed through systemd `LoadCredential=`.
- pved picks the CPU temperature: `coretemp` "Package id 0", else `k10temp`
  "Tctl"/"Tdie", else the hottest `coretemp`/`k10temp`/`zenpower` sensor, else
  the hottest sensor.

## Performance rules

- **pved:** one `GET /cluster/resources` per server every 10 s (`pvestatd`
  refreshes no faster); servers are polled concurrently, each on its own
  schedule. The temperature agent is read in the same request cycle. tokio
  current-thread runtime, one reqwest client with keep-alive, one D-Bus
  connection. On failure the interval doubles: 10, 20, 40, 80, 120 s. While
  the screen is locked (`org.gnome.ScreenSaver.ActiveChanged`) it is 60 s.
  Guest details only while a client watches the guest, at most 3 requests
  in flight next to the main poll, so the client keeps up to 4 connections
  alive and a steady poll does no TLS handshake. Target: under 0.5% CPU and
  15 MB RSS; measured in [FOOTPRINT.md](FOOTPRINT.md).
- **D-Bus:** at most one `Updated` per poll, only with what changed after
  rounding. History is fetched once per connection (`GetHistory`), never
  polled.
- **extension:** no Soup, no `Gio.Subprocess`, no file reads, no
  `GLib.timeout_add`. `set_text` only when the text changed. Menu items are
  created once per guest and updated in place; the list is only rebuilt when
  the set of guests changes.
