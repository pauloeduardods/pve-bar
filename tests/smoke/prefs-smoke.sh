#!/bin/bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Smoke test of the Settings pages, headless and isolated: Xvfb, a private
# session bus with no activatable services, a memory GSettings backend, and
# scratch HOME/XDG directories. Never touches the real session bus or dconf.
#
#   tests/smoke/prefs-smoke.sh               # without pved: sample values
#   tests/smoke/prefs-smoke.sh PVED [OUT.png] # with PVED --fake on the private bus
#
# Needs gjs, Xvfb (xvfb-run), dbus-daemon and glib-compile-schemas.
set -euo pipefail

root=$(cd "$(dirname "$0")/../.." && pwd)
pved=${1:-}
png=${2:-}
scratch=$(mktemp -d)
bus_pid=
pved_pid=

cleanup() {
    [ -n "$pved_pid" ] && kill "$pved_pid" 2>/dev/null || true
    [ -n "$bus_pid" ] && kill "$bus_pid" 2>/dev/null || true
    wait 2>/dev/null || true
    rm -rf "$scratch"
}
trap cleanup EXIT

mkdir -p "$scratch"/{home,config,data,cache,runtime,schemas}
chmod 700 "$scratch/runtime"
cp "$root"/extension/schemas/*.gschema.xml "$scratch/schemas/"
glib-compile-schemas --strict "$scratch/schemas"

# A session bus of our own, with no service directories: nothing can be
# D-Bus activated on it (no real pved, no dconf service).
cat > "$scratch/bus.conf" <<EOF
<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN"
 "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <listen>unix:path=$scratch/runtime/bus</listen>
  <auth>EXTERNAL</auth>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
EOF
dbus-daemon --config-file="$scratch/bus.conf" --nofork --nopidfile &
bus_pid=$!
for _ in $(seq 50); do [ -S "$scratch/runtime/bus" ] && break; sleep 0.1; done
address="unix:path=$scratch/runtime/bus"

run_env=(env -i
    PATH=/usr/local/bin:/usr/bin:/bin LANG=C.UTF-8
    HOME="$scratch/home" XDG_CONFIG_HOME="$scratch/config" XDG_DATA_HOME="$scratch/data"
    XDG_CACHE_HOME="$scratch/cache" XDG_RUNTIME_DIR="$scratch/runtime"
    DBUS_SESSION_BUS_ADDRESS="$address"
    GSETTINGS_BACKEND=memory GSETTINGS_SCHEMA_DIR="$scratch/schemas"
    NO_AT_BRIDGE=1 GTK_A11Y=none GDK_BACKEND=x11 GSK_RENDERER=cairo)

mode=sample
if [ -n "$pved" ]; then
    mode=live
    "${run_env[@]}" "$pved" --fake &
    pved_pid=$!
fi

log="$scratch/smoke.log"
status=0
"${run_env[@]}" xvfb-run -a -s "-screen 0 1280x1024x24" \
    gjs -m "$root/tests/smoke/prefs-smoke.js" "$mode" "$png" >"$log" 2>&1 || status=$?
cat "$log"
if grep -qE 'JS ERROR|Gjs-CRITICAL|Gtk-CRITICAL|Adw-CRITICAL|TypeError|ReferenceError' "$log"; then
    echo "errors in the log"
    status=1
fi
exit "$status"
