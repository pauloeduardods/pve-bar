# Architecture

> **Status:** phases 0 and 1 of the roadmap (the MVP): pve-core, pve-sys,
> pved, pvectl, pve-temp-agent, the installer and an extension with three
> fixed indicators and the guest list. Customization (phase 2), the per-VM
> view (phase 3) and alerts (phase 4) are planned.

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
  backoff, parses the config file, keeps ring buffers and generates the fake
  cluster. No network, no D-Bus, no files.
- **pve-sys**: the real I/O for it: the Proxmox HTTP client (reqwest + rustls,
  keep-alive, optional certificate pinning), the temperature agent client,
  the Secret Service (GNOME Keyring) client over zbus, and the config file
  location. Shared by pved and pvectl.
- **pved**: the user service. Polls, diffs, publishes on the session bus.
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

## D-Bus API (version 1)

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
| `ApiVersion` | `u` | `1` |
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

### Example

```
$ busctl --user call io.github.pauloeduardods.PveBar1 /io/github/pauloeduardods/PveBar1 \
      io.github.pauloeduardods.PveBar1 GetValues
a{sd} 5 "home/node/pve/cpu" 23.4 "home/node/pve/mem" 61 "home/node/pve/temp" 54 "lab/guest/101/cpu" 87.1 ...
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
  Target: under 0.5% CPU and 15 MB RSS.
- **D-Bus:** at most one `Updated` per poll, only with what changed after rounding.
- **extension:** no Soup, no `Gio.Subprocess`, no file reads, no
  `GLib.timeout_add`. `set_text` only when the text changed. Menu items are
  created once per guest and updated in place; the list is only rebuilt when
  the set of guests changes.
