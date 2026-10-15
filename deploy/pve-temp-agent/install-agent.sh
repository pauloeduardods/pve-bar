#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Installs pve-temp-agent on the Proxmox host. Run as root on the host:
#
#   ./install-agent.sh ./pve-temp-agent     install or upgrade
#   ./install-agent.sh --uninstall          remove everything it installed
#
# The unit file is expected next to this script.
set -euo pipefail

readonly BIN=/usr/local/bin/pve-temp-agent
readonly UNIT=/etc/systemd/system/pve-temp-agent.service
readonly CONF_DIR=/etc/pve-temp-agent
readonly TOKEN="$CONF_DIR/token"
readonly PORT=9101

die() {
    echo "install-agent: $*" >&2
    exit 1
}

usage() {
    echo "Usage: $0 PATH-TO-pve-temp-agent | --uninstall" >&2
    exit 2
}

[[ $# -eq 1 ]] || usage
[[ $(id -u) -eq 0 ]] || die "run this as root on the Proxmox host"

if [[ $1 == --uninstall ]]; then
    systemctl disable --now pve-temp-agent.service 2>/dev/null || true
    rm -f "$UNIT" "$BIN" "$TOKEN"
    rmdir "$CONF_DIR" 2>/dev/null || true
    systemctl daemon-reload
    echo "pve-temp-agent removed."
    exit 0
fi

case $1 in
    -h | --help) usage ;;
    -*) usage ;;
esac

src_bin=$1
src_unit="$(dirname "$(readlink -f "$0")")/pve-temp-agent.service"
[[ -f $src_bin ]] || die "no such binary: $src_bin"
[[ -f $src_unit ]] || die "pve-temp-agent.service not found next to this script"
"$src_bin" --version >/dev/null 2>&1 ||
    die "$src_bin does not run here (build it for x86_64-unknown-linux-musl, see README.md)"

install -m 0755 -o root -g root "$src_bin" "$BIN"
install -m 0644 -o root -g root "$src_unit" "$UNIT"

install -d -m 0700 -o root -g root "$CONF_DIR"
if [[ ! -s $TOKEN ]]; then
    # 24 random bytes as 48 hex characters.
    (
        umask 077
        od -An -N24 -tx1 /dev/urandom | tr -d ' \n' >"$TOKEN"
    )
fi
chown root:root "$TOKEN"
chmod 0600 "$TOKEN"

systemctl daemon-reload
systemctl enable pve-temp-agent.service
systemctl restart pve-temp-agent.service

sleep 1
systemctl is-active --quiet pve-temp-agent.service ||
    die "the service did not start; see: journalctl -u pve-temp-agent"

host=$(hostname -f 2>/dev/null || hostname)
cat <<EOF

pve-temp-agent is running on port $PORT.

Token (keep it secret; it only allows reading temperatures):
  $(cat "$TOKEN")

On your desktop, run 'pvectl setup' and give it:
  temperature agent URL:   http://$host:$PORT
  temperature agent token: the token above

Open port $PORT only to your desktop (see README.md).
EOF
