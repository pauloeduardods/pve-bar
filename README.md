# pve-bar

Your Proxmox VE servers in the GNOME top bar, next to Wi-Fi:

```
 [▣ 23%] [▤ 61%] [♨ 54°]   ← panel: CPU, RAM and temperature of the server you pick
```

Click it for every server you watch: each node's CPU, RAM, disk and temperature, and a list of VMs and containers with their status and usage. Several independent servers (or clusters) can be watched at once; one being down never hides the others.

pve-bar only reads. It never starts, stops or changes anything in Proxmox.

## How it fits together

- **pved**: a small service in your session (`systemd --user`). Every 10 s it makes one `GET /cluster/resources` call per server, rounds the numbers to what the panel shows, and publishes only what changed on the session D-Bus. It keeps the last hour of every value for the graphs and, while you look at a guest, fetches its details. It uses 6 to 9 MB of RAM and under 0.1 % of one core ([measured](docs/FOOTPRINT.md)).
- **pvectl**: the command line (`pvectl setup`, `status`, `doctor`).
- **The GNOME extension**: draws what pved publishes. It never touches the network, files or timers itself. Without pved it shows `pve off`.
- **pve-temp-agent** (optional): a tiny program on the Proxmox host that serves its temperatures, since the Proxmox API does not. See [deploy/pve-temp-agent](deploy/pve-temp-agent/README.md).

Details are in [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Requirements

- GNOME Shell 46 to 50 (Ubuntu 24.04 or newer), with the GNOME Keyring (standard).
- Proxmox VE 7 or newer.
- To build: a Rust toolchain, 1.88 or newer ([rustup](https://rustup.rs)).

## 1. Create a read-only API token in Proxmox

Do this once per server, in the Proxmox web UI (or the shell commands below, as root on the host).

1. **Datacenter → Permissions → Users → Add**: user `monitor`, realm `Proxmox VE authentication server` (`pve`). No password is needed.
2. **Datacenter → Permissions → API Tokens → Add**: user `monitor@pve`, token id `pve-bar`. Leave **Privilege Separation** checked. Copy the **secret**: Proxmox shows it only once.
3. **Datacenter → Permissions → Add → API Token Permission**: path `/`, token `monitor@pve!pve-bar`, role **PVEAuditor**, Propagate checked.

The same from the host shell:

```bash
pveum user add monitor@pve --comment "pve-bar (read-only)"
pveum user token add monitor@pve pve-bar --privsep 1    # prints the secret once
pveum acl modify / --tokens 'monitor@pve!pve-bar' --roles PVEAuditor
```

`PVEAuditor` can only read. `pvectl doctor` warns if a token can change anything.

## 2. Install

```bash
./install.sh
```

That builds pved and pvectl, installs them with the extension for your user, and enables the extension. Nothing needs root or sudo. Run it again to upgrade.

GNOME Shell keeps the extension code it loaded, so a new version shows up after the shell reloads:

- **X11:** press **Alt+F2**, type `r`, Enter. Your windows stay open.
- **Wayland:** log out and back in.

What goes where (all recorded in a manifest; `./install.sh --uninstall` removes exactly those files):

| File | Destination |
|---|---|
| pved | `~/.local/libexec/pve-bar/pved` |
| pvectl | `~/.local/bin/pvectl` |
| systemd user unit | `~/.config/systemd/user/pved.service` |
| D-Bus activation | `~/.local/share/dbus-1/services/io.github.pauloeduardods.PveBar1.service` |
| extension | `~/.local/share/gnome-shell/extensions/pve-bar@paulo/` |

Your servers (`~/.config/pve-bar/pved.conf`) and their tokens (GNOME Keyring) are kept on uninstall.

## 3. Add your servers

```bash
pvectl setup home     # any short name: a-z, 0-9 and -
pvectl setup lab      # as many as you like
```

`setup` asks for the URL, the token id and the secret, and then:

- **Certificate:** Proxmox uses a self-signed certificate, so pve-bar pins its SHA-256 fingerprint. `setup` shows the fingerprint the server presents and asks you to compare it with **Node → System → Certificates** (or `openssl x509 -in /etc/pve/local/pve-ssl.pem -noout -fingerprint -sha256` on the host). A server with a public certificate (Let's Encrypt) needs no pinning.
- **Test:** it tries the token before saving anything and warns if the token can do more than read.
- **Storage:** the secret goes to the GNOME Keyring, never to a file. The config file holds only the URL, token id, fingerprint and agent URL.
- **Reload:** it tells pved to re-read the config.

Run `pvectl setup NAME` again to change a server (Enter keeps each value), and `pvectl remove NAME` to forget it and its secrets.

## 4. Temperature (optional)

The Proxmox API has no temperatures. To show them, install pve-temp-agent on each host: it is a 500 KB static binary with no dependencies, sandboxed by systemd, that serves `/sys/class/hwmon` readings behind its own token. Follow [deploy/pve-temp-agent/README.md](deploy/pve-temp-agent/README.md), then run `pvectl setup NAME` again and give it the agent URL and token.

## The menu

Click the bar to open the menu. Each server is a collapsed line with a summary, coloured by its worst reading: `home · 23% · 61% · 54° · 23/30` is CPU, RAM, the hottest temperature and running/total guests (a server that is down shows its state and why). Click it to see its node with CPU, RAM and temperature graphed inline over the last 15 minutes and the disk, or one compact line per node of a cluster, and a **Guests** list. Click a guest to see its details in place of the list: status, uptime, CPU and RAM over the last hour, network in and out, the disk inside the VM, and **Pin to bar**, which adds a segment for that guest to the bar. **← Guests** goes back.

pved fetches a guest's details only while its view is open (or a bar segment shows them), and the menu is not updated while it is closed.

The disk inside a VM (`fs`) comes from the QEMU guest agent, so the VM needs the agent installed and enabled. On Proxmox VE 8 reading it also needs the `VM.Monitor` privilege, which `PVEAuditor` does not have. pve-bar does **not** recommend granting it: `VM.Monitor` allows QEMU monitor commands, and `pvectl doctor` flags it as more than read access. With the recommended read-only token the disk inside VMs is simply absent, and the guest view says what it would need. Containers have no such reading.

## Customizing the bar

The bar is a list of segments stored as JSON in the `panel-layout` setting. Each segment reads one target (the selected node, a given node, a guest, or a whole server), shows one or more readings through a template, and can draw a graph of the last 5, 15, 30 or 60 minutes:

```
 [▣ 23% ╱╲╱] [▤ 61% ▁▃▅] [♨ 54°] [▭ web · 6% · 45%] [▤ home 2/3 · 23%]
```

- **Readings**: node `cpu`, `mem`, `mem-used`, `mem-total`, `disk`, `temp`, `status`, `name`; guest `cpu`, `mem`, `name`, `status`, `netin`, `netout`, `fs` (disk inside the VM, see [The menu](#the-menu)); server `running`, `guests`, `state`, `name`, `cpu`, `mem`.
- **Templates**: `{cpu}% · {temp}°`, `{cpu:1}` for one decimal, `{{` and `}}` for braces. A mistake shows `--` instead of breaking the bar; a target that no longer exists shows `--`.
- **Graphs**: line, area or bars, 30, 45 or 70 px wide, in the warm/hot colors of their thresholds or one fixed color. History comes from pved (one call when the extension connects, then every update is appended), so graphs cost no polling.
- **Presets**: Minimal, Default, Graphs and Cluster (one segment per server).
- Thresholds: `cpu-*`, `mem-*`, `disk-*`, `temp-*` and `fs-*` (`-warm` and `-hot`).

Edit it in Settings (Extensions, pve-bar): the **Layout** page lists the segments (move, add, remove; merge a reading into the next segment that reads the same target, split it out), picks each segment's target from the servers, nodes and guests pved lists (or takes typed names while pved is not running), and has the template, icon and graph controls, the presets with Undo, and import/export of the layout as a JSON file. A preview at the top draws the bar with the same code, from pved's live values and history or sample values. **Thresholds** holds the warm/hot limits and colors, **General** the selected server and node and the position in the top bar.

On the first start after an upgrade, the layout is built once from the older `server`, `node` and `show-icons` settings, so the bar looks the same. Details are in [docs/CUSTOMIZATION.md](docs/CUSTOMIZATION.md). To look at the bar without GNOME Shell: `gjs -m tools/render-bar.js bar.png`; the menu: `gjs -m tools/render-menu.js menu.png`.

## Alerts

pve-bar sends a GNOME notification (source "pve-bar") when something needs attention. Settings: Extensions, pve-bar, Alerts, which also has a **Test notification** button. Each alert names the server and the node or guest, and fires once per episode.

| Alert | Default | Fires when | Ends when |
|---|---|---|---|
| Host temperature | on, 85 °C for 60 s | a node stays at or above the limit | below limit − 3 |
| Host RAM | on, 95 % for 120 s | a node's RAM stays at or above the limit | below limit − 5 |
| Host disk | on, 90 % | a node's disk reaches the limit | below limit − 2 |
| Server unreachable | on, 120 s | a server's state is not `ok` for that long | `ok` again |
| Guest stopped | off | a guest that was running or paused stops; pausing alone is silent (optionally only the listed `server/vmid`) | it runs again |
| Guest started | off | a guest starts | n/a |

Nothing fires for the state found when pve-bar connects, and a missing reading (for example no temperature agent) never alerts.

## Command line

```bash
pvectl status            # every server: nodes and guests
pvectl status home       # one server
pvectl status --json     # machine-readable
pvectl status --watch    # redraw every 10 s, with graphs of the last 5 minutes
pvectl doctor            # check config, keyring, TLS, token, privileges, agent, pved, extension
```

`status` and `doctor` talk to Proxmox directly with the same config and keyring, so they work without pved. `status --watch` draws each node's CPU, RAM and temperature and each running guest's CPU as text sparklines (`▁▃▅█`); when pved is already running, its history fills them at once. `doctor` only reads; when something is wrong it prints what to run. It exits with 1 when something needs attention.

```
[ ok ] config                 /home/you/.config/pve-bar/pved.conf: home, lab
[ ok ] home: token            monitor@pve!pve-bar found in the GNOME Keyring
[ ok ] home: api              https://pve.lan:8006 answers, Proxmox VE 9.0.3 (pinned certificate)
[ ok ] home: privileges       read-only (Audit privileges only)
[ ok ] home: temperature      http://pve.lan:9101: node pve at 54°C (12 sensors)
[ ok ] pved                   running, version 0.1.0
[ ok ] pved: home             ok
[ ok ] extension              installed (gnome-extensions info pve-bar@paulo)

Nothing to fix.
```

## Development

```bash
cargo test --workspace                                    # Rust tests (private D-Bus, local HTTP, never the real ones)
cargo clippy --workspace --all-targets -- -D warnings
cargo fmt --all --check
cargo bench -p pve-core                                   # ring buffer, snapshot and diff timings
tools/footprint.sh bench                                  # pved's CPU, RAM and signals on a private bus (mock Proxmox)
tools/footprint.sh live                                   # the installed pved and gnome-shell, read-only
npm test          # extension and installer tests (node, fake D-Bus, no GNOME needed)
npm run check     # syntax check of every module

# pved with two synthetic servers (home: 30 guests, lab: 6), no Proxmox needed:
~/.local/libexec/pve-bar/pved --fake     # or: systemctl --user edit pved and add --fake

# logs:
journalctl --user -f -u pved
journalctl -f -o cat /usr/bin/gnome-shell | grep -i pve-bar
```

The pved integration tests need `dbus-daemon` (package `dbus-daemon` on Ubuntu); each test starts its own private bus.

pve-bar is licensed under the [GNU GPL v3.0 or later](LICENSE). Commits follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/); see [CONTRIBUTING.md](CONTRIBUTING.md).
