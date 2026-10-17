# Footprint

What pved costs with the history (D-Bus API 2) and the per-guest details,
measured with [`tools/footprint.sh`](../tools/footprint.sh) on 2026-10-16 on
a 32-thread desktop (Ubuntu, GNOME), release build of this branch. Budgets
from [ARCHITECTURE.md](ARCHITECTURE.md#performance-rules): pved under 0.5 %
of one core and under 15 MB resident.

## Results

`tools/footprint.sh bench target/release/pved 120`: each scenario on its own
private session bus, measured for 120 s after 15 s of warm-up (startup, the
first polls and the rrddata backfill are not counted). Default 10 s polling.

| Scenario | pved CPU | pved RSS | `Updated`/s | Context switches/s | Keys in the history |
|---|---|---|---|---|---|
| `--fake`: 2 servers, 36 guests, none watched | < 0.01 s (< 0.01 %) | 5.8 MB | 0.10 | 0.4 | 84 |
| mock HTTPS: 1 server, 100 guests, 8 watched | 0.03 s (0.025 %) | 7.0 MB | 0.10 | 1.7 | 205 + details |
| mock HTTPS: 3 servers, 100 guests each, 8 watched on each | 0.09 s (0.075 %) | 8.6 MB | 0.28 | 4.5 | 615 + details |

- **CPU** is a twentieth of the budget or less. The kernel counts CPU time
  in 10 ms ticks, so the `--fake` figure is below what 120 s can resolve.
- **Memory** grows with the history: about 1.5 KB per key (a 360-point f32
  ring), so 300 guests on 3 servers keep about 1 MB of history. The rest is
  the runtime, TLS and HTTP state. All flat over the run.
- **Signals**: one `Updated` per server poll at most (3 servers polling
  independently give up to 3 per 10 s), only with what changed after
  rounding.
- **Requests**: per server and poll, one `/cluster/resources` plus one
  `status/current` per watched guest, and `get-fsinfo` once a minute for
  watched VMs with the agent. At most 3 detail requests are in flight next
  to the main poll and the HTTP client keeps 4 connections alive, so a
  steady poll does no TLS handshake.

The hot path in pure code (`cargo bench -p pve-core`, same machine):

| Operation | Time |
|---|---|
| history record, one cycle (66 keys) | 4.3 µs |
| `GetHistory` of one key (360 points) | 2.2 µs |
| snapshot build (1 node, 30 guests) | 15.9 µs |
| diff of one cycle of changes | 1.4 µs |

## A real Proxmox host

On 2026-10-17, the installed build against a real Proxmox VE 9.2.5 host (one
node, 12 guests, the temperature agent with 18 sensors), 120 s each:

| What | Result |
|---|---|
| pved CPU (`tools/footprint.sh live`) | 0.02 s, 0.017 % of one core |
| pved resident memory | 6.3 MB, flat |
| `Updated` signals to the shell | 12 (0.1/s) |
| Requests to `pveproxy` (its access log) | 6 a minute, 4.4 KB each |
| pve-temp-agent CPU (systemd `CPUUsageNSec`) | 0.066 % of one core, about 6 ms per reading |
| pve-temp-agent memory (systemd `MemoryCurrent`) | 0.9 MB |

The agent's time is almost all the kernel reading sensors (some drivers, such
as NVMe's, send the drive a command per read). `pveproxy` closes an idle
connection after about 5 s, so at a 10 s interval each poll opens a new TLS
connection: about a millisecond of the host's CPU, not worth polling faster
to keep the connection open. `pveproxy`'s total CPU over the same window also
counts every other API client (the web UI, monitoring tools), so it is not
pve-bar's share.

On the host, as root:

```bash
S=120
cpu() { systemctl show -p CPUUsageNSec --value "$1"; }
p0=$(cpu pveproxy); a0=$(cpu pve-temp-agent); l0=$(wc -l < /var/log/pveproxy/access.log)
sleep $S
p1=$(cpu pveproxy); a1=$(cpu pve-temp-agent)
tail -n +$((l0+1)) /var/log/pveproxy/access.log | grep -F 'monitor@pve!pve-bar' |
  awk -v s=$S '{n++; b+=$NF} END {printf "pve-bar requests: %d (%.1f/min), %.1f KB each\n", n, n*60/s, n ? b/n/1024 : 0}'
awk -v p=$((p1-p0)) -v a=$((a1-a0)) -v s=$S 'BEGIN {printf "pveproxy CPU (everything): %.3f%%\npve-temp-agent CPU: %.4f%%\n", p/1e7/s, a/1e7/s}'
systemctl show -p MemoryCurrent --value pve-temp-agent | awk '{printf "pve-temp-agent RAM: %.1f MB\n", $1/1048576}'
```

## How it is measured

- `bench` runs a copy of pved as you on a **private** dbus-daemon with its
  own config, which has no service directories: nothing installed on the
  machine (the real keyring, gnome-shell's ScreenSaver) can be activated on
  it. The real session bus and keyring are never touched.
- The Proxmox server is [`tools/mock/proxmox.py`](../tools/mock/proxmox.py):
  Python's `http.server` behind TLS with a throw-away RSA-2048 certificate,
  pinned by fingerprint in the generated `pved.conf`, as in real use. It
  serves `/cluster/resources`, `status/current`, `rrddata` and `get-fsinfo`
  in the shapes of the Proxmox API, with wandering numbers.
- The keyring is [`tools/mock/secret-service.js`](../tools/mock/secret-service.js),
  a gjs `Gio.DBusExportedObject` that owns `org.freedesktop.secrets` on the
  private bus and answers the token lookups.
- The client is [`tools/mock/watch-client.js`](../tools/mock/watch-client.js):
  like the extension, it calls `GetHistory` once, watches its guests (one
  client per server, since a client may watch 16) and counts `Updated`.
- Only pved's own CPU (`utime + stime` from `/proc`) and RSS are reported;
  the mocks' cost is not pved's.

`live` reads the installed pved and gnome-shell from `/proc` and counts the
`Updated` signals on your session bus without sending anything; it was not
run for this page (no installed build of this branch).

```bash
cargo build --release -p pved
tools/footprint.sh bench target/release/pved 120   # needs dbus-daemon, python3, gjs, openssl
tools/footprint.sh live 120                        # the installed pved and gnome-shell, read-only
```

## Not measured here

- **The extension's cost in gnome-shell** with 8 segments and graphs: that
  is lanes B and E's part of the budget, measured once they land.
- **pve-bar's exact share of `pveproxy`'s CPU**: it needs the measurement
  above with pved stopped, to subtract every other API client.
