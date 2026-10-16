#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
#
# Measures what pve-bar costs. Never changes your session: `live` only reads
# /proc and listens to pved's signals; `bench` runs its own copies on a
# private D-Bus, with a mock keyring and a mock Proxmox, and cleans up.
#
#   tools/footprint.sh live [seconds]
#       The installed pved and gnome-shell as they run now (default 120 s).
#   tools/footprint.sh bench [pved binary] [seconds]
#       A pved build (default target/release/pved) on a private session bus,
#       in three scenarios: --fake (2 servers, 36 guests); one mock HTTPS
#       Proxmox with 100 guests, 8 of them watched; three such servers with
#       8 watched guests each. Needs dbus-daemon, python3, gjs and openssl
#       (default 120 s per scenario).

set -euo pipefail

BUS_NAME=io.github.pauloeduardods.PveBar1
TOOLS=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
TCK=$(getconf CLK_TCK)

# CPU seconds of a process (utime + stime).
cpu_self() { awk -v t="$TCK" '{printf "%.2f", ($14+$15)/t}' "/proc/$1/stat"; }
ctx_switches() { awk '/ctxt_switches/ {s += $2} END {print s}' "/proc/$1/status"; }
rss_kb() { awk '/^VmRSS/ {print $2}' "/proc/$1/status"; }
percent() { awk -v c="$1" -v s="$2" 'BEGIN {printf "%.3f", c / s * 100}'; }
sub() { awk -v a="$1" -v b="$2" 'BEGIN {printf "%.2f", a - b}'; }
per_second() { awk -v n="$1" -v s="$2" 'BEGIN {printf "%.2f", n / s}'; }

live() {
    local seconds=${1:-120} pid shell
    pid=$(pgrep -x pved | head -1) || { echo "pved is not running" >&2; exit 1; }
    shell=$(pgrep -x gnome-shell | head -1 || true)

    local s0 x0 r0 g0
    s0=$(cpu_self "$pid"); x0=$(ctx_switches "$pid"); r0=$(rss_kb "$pid")
    g0=${shell:+$(cpu_self "$shell")}

    echo "Measuring for ${seconds} s…" >&2
    local signals
    signals=$(timeout "$seconds" gdbus monitor --session --dest "$BUS_NAME" 2>/dev/null \
        | grep -c "\.Updated (" || true)

    local s1 x1 r1 g1 self
    s1=$(cpu_self "$pid"); x1=$(ctx_switches "$pid"); r1=$(rss_kb "$pid")
    g1=${shell:+$(cpu_self "$shell")}
    self=$(sub "$s1" "$s0")
    echo "| What | Over ${seconds} s |"
    echo "|---|---|"
    echo "| pved CPU | ${self} s ($(percent "$self" "$seconds") %) |"
    echo "| pved resident memory | ${r0} → ${r1} kB |"
    echo "| pved context switches | $((x1 - x0)) ($(per_second $((x1 - x0)) "$seconds")/s) |"
    echo "| Updated signals | ${signals} ($(per_second "$signals" "$seconds")/s) |"
    if [[ -n $shell ]]; then
        local gs
        gs=$(sub "$g1" "$g0")
        echo "| gnome-shell CPU (everything in it) | ${gs} s ($(percent "$gs" "$seconds") %) |"
    fi
}

# Everything bench starts, killed on exit.
PIDS=()
WORK=

cleanup() {
    local p
    for p in "${PIDS[@]}"; do
        kill "$p" 2>/dev/null || true
    done
    for p in "${PIDS[@]}"; do
        wait "$p" 2>/dev/null || true
    done
    PIDS=()
    [[ -n $WORK ]] && rm -rf "$WORK"
    return 0
}

wait_for_file() {
    local i
    for i in $(seq 100); do
        [[ -s $1 ]] && return 0
        sleep 0.1
    done
    echo "timed out waiting for $1" >&2
    return 1
}

# A private session bus; sets DBUS_SESSION_BUS_ADDRESS for what follows.
# Its own config, without service directories: nothing installed on the
# machine (gnome-shell's ScreenSaver, the real keyring) can be activated.
private_bus() {
    cat > "$WORK/bus.conf" <<'EOF'
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:tmpdir=/tmp</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
    dbus-daemon --config-file="$WORK/bus.conf" --nofork --print-address=1 > "$WORK/bus" &
    PIDS+=($!)
    wait_for_file "$WORK/bus"
    DBUS_SESSION_BUS_ADDRESS=$(head -1 "$WORK/bus")
    export DBUS_SESSION_BUS_ADDRESS
}

# measure <name> <pid> <seconds>: one table row for the pved at <pid>, with
# the Updated signals the watch client counted in $WORK/client.
measure() {
    local name=$1 pid=$2 seconds=$3
    sleep 15   # startup, the first polls and the backfill are not what we measure
    local s0 x0 u0 s1 x1 u1 rss self history
    s0=$(cpu_self "$pid"); x0=$(ctx_switches "$pid"); read -r u0 _ < "$WORK/client"
    sleep "$seconds"
    s1=$(cpu_self "$pid"); x1=$(ctx_switches "$pid"); read -r u1 history < "$WORK/client"
    rss=$(rss_kb "$pid")
    self=$(sub "$s1" "$s0")
    echo "| ${name} | ${self} s ($(percent "$self" "$seconds") %) | $((rss / 1024)) MB (${rss} kB) | $(per_second $((u1 - u0)) "$seconds") | $(per_second $((x1 - x0)) "$seconds") | ${history} |"
}

# start_client <file> <watched> <server>...
start_client() {
    : > "$1"
    gjs -m "$TOOLS/mock/watch-client.js" "$@" &
    PIDS+=($!)
}

bench_fake() {
    local binary=$1 seconds=$2 pid
    WORK=$(mktemp -d)
    private_bus
    start_client "$WORK/client" 0
    "$binary" --fake 2>/dev/null &
    pid=$!; PIDS+=("$pid")
    wait_for_file "$WORK/client"
    measure "fake: 2 servers, 36 guests, none watched" "$pid" "$seconds"
    cleanup
}

# bench_mock <servers> <watched per server>
bench_mock() {
    local binary=$1 seconds=$2 servers=$3 watched=$4 pid i names=()
    WORK=$(mktemp -d)
    openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=127.0.0.1 \
        -addext subjectAltName=IP:127.0.0.1 \
        -keyout "$WORK/key.pem" -out "$WORK/cert.pem" 2>/dev/null
    local fingerprint
    fingerprint=$(openssl x509 -in "$WORK/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)
    python3 -I "$TOOLS/mock/proxmox.py" --cert "$WORK/cert.pem" --key "$WORK/key.pem" \
        --guests 100 --port-file "$WORK/port" &
    PIDS+=($!)
    wait_for_file "$WORK/port"
    : > "$WORK/pved.conf"
    for i in $(seq "$servers"); do
        names+=("pve$i")
        printf '[pve%s]\nurl = https://127.0.0.1:%s\ntoken_id = monitor@pve!pve-bar\nfingerprint = %s\n\n' \
            "$i" "$(cat "$WORK/port")" "$fingerprint" >> "$WORK/pved.conf"
    done
    private_bus
    gjs -m "$TOOLS/mock/secret-service.js" 00000000-mock-token &
    PIDS+=($!)
    sleep 1
    # One client per server, like one panel segment set per server (a
    # client may watch 16 guests); the first one counts the signals.
    start_client "$WORK/client" "$watched" "${names[0]}"
    for i in $(seq 2 "$servers"); do
        start_client "$WORK/client$i" "$watched" "${names[i - 1]}"
    done
    "$binary" --config "$WORK/pved.conf" 2>"$WORK/pved.log" &
    pid=$!; PIDS+=("$pid")
    wait_for_file "$WORK/client"
    local label="mock HTTPS: ${servers} server(s) × 100 guests, ${watched} watched each"
    measure "$label" "$pid" "$seconds"
    if grep -v "^config\|serving\|\] ok$" "$WORK/pved.log" >&2; then
        echo "(pved logged the lines above)" >&2
    fi
    cleanup
}

bench() {
    local binary=${1:-target/release/pved} seconds=${2:-120} tool
    [[ -x $binary ]] || { echo "no $binary; build it: cargo build --release -p pved" >&2; exit 1; }
    for tool in dbus-daemon python3 gjs openssl; do
        command -v "$tool" >/dev/null || { echo "$tool is missing" >&2; exit 1; }
    done
    # Only ever the private buses started below.
    unset DBUS_SESSION_BUS_ADDRESS
    trap cleanup EXIT
    echo "| Scenario (${seconds} s each) | pved CPU | pved RSS | Updated/s | Context switches/s | GetHistory keys |"
    echo "|---|---|---|---|---|---|"
    bench_fake "$binary" "$seconds"
    bench_mock "$binary" "$seconds" 1 8
    bench_mock "$binary" "$seconds" 3 8
}

case ${1:-} in
    live) shift; live "$@" ;;
    bench) shift; bench "$@" ;;
    *) sed -n '4,15p' "$0" | sed 's/^# \{0,1\}//'; exit 2 ;;
esac
