<!-- SPDX-License-Identifier: GPL-3.0-or-later -->
# pve-temp-agent

The Proxmox API does not report temperatures, so pve-bar ships a small
agent that runs on the host. It reads `/sys/class/hwmon` and answers
`GET /temps` on port 9101 with JSON, but only to requests that carry its
token. It is written with the Rust standard library only (no dependencies)
and runs under systemd as a throwaway user with no capabilities and a
read-only view of the system.

## 1. Build (on your desktop)

```sh
rustup target add x86_64-unknown-linux-musl
cargo build --release --target x86_64-unknown-linux-musl -p pve-temp-agent
```

The musl target gives a static binary. A normal (glibc) build made on
Ubuntu 24.04 links against a newer glibc than Debian 12 has, so it will not
start on Proxmox VE 8.

## 2. Copy and install (on the host, as root)

```sh
scp target/x86_64-unknown-linux-musl/release/pve-temp-agent \
    deploy/pve-temp-agent/install-agent.sh \
    deploy/pve-temp-agent/pve-temp-agent.service root@pve.lan:/root/
ssh root@pve.lan /root/install-agent.sh /root/pve-temp-agent
```

The script:

- installs the binary to `/usr/local/bin/pve-temp-agent` and the unit to
  `/etc/systemd/system/pve-temp-agent.service`;
- creates `/etc/pve-temp-agent/token` (48 random hex characters, `0600`
  root) if it does not exist yet, so upgrades keep the same token;
- enables and starts the service, then prints the token and the URL.

Run `pvectl setup` on the desktop and paste the URL and token when asked.
Re-run the script with a new binary to upgrade. `install-agent.sh
--uninstall` removes exactly those files.

To bind one LAN address instead of `0.0.0.0`, see the comment at the top of
the unit (`systemctl edit pve-temp-agent`).

## 3. Open port 9101 to your desktop only

First in the service itself, which holds even with the firewall off.
`systemctl edit pve-temp-agent` and paste, with the host's LAN address and
your desktops' network:

```ini
[Service]
ExecStart=
ExecStart=/usr/local/bin/pve-temp-agent --listen 192.168.1.10:9101
IPAddressDeny=any
IPAddressAllow=192.168.1.0/24
```

Then `systemctl restart pve-temp-agent`. `--listen` keeps the port off the
host's other interfaces (VM bridges, VPNs); `IPAddressAllow` makes the
kernel drop packets from anywhere else. Use the narrowest range that covers
your desktops: if your VMs are in it, they can reach the agent too.

Then with the Proxmox firewall enabled for the host (Datacenter → Firewall and
Node → Firewall), allow the desktop and nothing else. In
`/etc/pve/nodes/<node>/host.fw`:

```ini
[OPTIONS]
enable: 1

[RULES]
IN ACCEPT -source 192.168.1.20 -p tcp -dport 9101 -log nolog # pve-bar desktop
```

Make sure the datacenter input policy is `DROP` (or add a matching
`IN DROP -p tcp -dport 9101` rule after it). Check from the desktop:

```sh
curl -H "Authorization: Bearer <token>" http://pve.lan:9101/temps
```

## Security notes

- The token only allows reading temperatures. It is not a Proxmox
  credential and grants nothing else.
- It travels in clear text over plain HTTP. Keep the agent on a trusted LAN
  (or behind a VPN), restrict the port as above, and never expose it to the
  internet.
- One connection is served at a time, with a 5 s deadline and an 8 KiB limit
  on the request head; request bodies are never read.
- Logs (`journalctl -u pve-temp-agent`): one line at startup and one per
  rejected request (status and peer address).
