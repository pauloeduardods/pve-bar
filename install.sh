#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-3.0-or-later
# Installs pve-bar for your user: pved (a systemd --user service on the
# session bus), pvectl and the GNOME extension. Nothing needs root.
#
#   ./install.sh               install, or upgrade an earlier install
#   ./install.sh --uninstall   remove exactly what install put there
#
# Every file and directory it creates is recorded in a manifest, and
# --uninstall removes those and nothing else. Your servers
# (~/.config/pve-bar) and their tokens (GNOME Keyring) are kept.
# The temperature agent for the Proxmox host is separate: deploy/pve-temp-agent.
set -euo pipefail

UUID="pve-bar@paulo"
BUS_NAME="io.github.pauloeduardods.PveBar1"
REPO="$(cd "$(dirname "$0")" && pwd)"

# Test hooks: prebuilt binaries can come from PVE_BAR_BIN_DIR, and
# PVE_BAR_NO_SYSTEMD=1 skips systemctl, busctl and gnome-extensions.
DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
EXT_DIR="$DATA_HOME/gnome-shell/extensions/$UUID"
LIBEXEC="$HOME/.local/libexec/pve-bar"
PVED="$LIBEXEC/pved"
MANIFEST="$DATA_HOME/pve-bar/install-manifest"
NO_SYSTEMD="${PVE_BAR_NO_SYSTEMD:-}"

# destination|source|mode. "bin:" sources come from the build, "tpl:" from
# the repository with @PVED@ replaced, the rest from the repository as is.
FILES=(
    "$PVED|bin:pved|755"
    "$HOME/.local/bin/pvectl|bin:pvectl|755"
    "$CONFIG_HOME/systemd/user/pved.service|tpl:data/pved.service|644"
    "$DATA_HOME/dbus-1/services/$BUS_NAME.service|tpl:data/$BUS_NAME.service|644"
)

info() { printf '%s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- manifest

declare -A OLD=() # path -> kind, from the previous install
OLD_ENTRIES=()
NEW_ENTRIES=()

read_manifest() {
    [[ -f "$MANIFEST" ]] || return 1
    local kind path
    while IFS=$'\t' read -r kind path; do
        [[ -n "$kind" && -n "$path" ]] || continue
        OLD["$path"]="$kind"
        OLD_ENTRIES+=("$kind"$'\t'"$path")
    done <"$MANIFEST"
}

record() { NEW_ENTRIES+=("$1"$'\t'"$2"); }

# Creates the missing parents of $1 top-down, recording each one.
make_dirs() {
    local dir="$1" missing=()
    while [[ ! -d "$dir" ]]; do
        missing=("$dir" "${missing[@]}")
        dir="$(dirname "$dir")"
    done
    for dir in "${missing[@]}"; do
        mkdir -m 755 "$dir"
        record dir "$dir"
    done
}

# Removes every entry of the previous install: files first, then the
# directories it created (deepest first), and only if they are empty.
remove_entries() {
    local i kind path
    for ((i = ${#OLD_ENTRIES[@]} - 1; i >= 0; i--)); do
        IFS=$'\t' read -r kind path <<<"${OLD_ENTRIES[$i]}"
        [[ "$kind" == file ]] && rm -f -- "$path"
    done
    for ((i = ${#OLD_ENTRIES[@]} - 1; i >= 0; i--)); do
        IFS=$'\t' read -r kind path <<<"${OLD_ENTRIES[$i]}"
        if [[ "$kind" == dir ]]; then
            rmdir -- "$path" 2>/dev/null || warn "kept $path (not empty)"
        fi
    done
}

user_systemctl() {
    [[ -n "$NO_SYSTEMD" ]] || systemctl --user "$@"
}

# ---------------------------------------------------------------- uninstall

uninstall() {
    if ! read_manifest; then
        info "Nothing to uninstall: no manifest at $MANIFEST"
        return 0
    fi
    if [[ -z "$NO_SYSTEMD" ]]; then
        gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
        systemctl --user stop pved.service >/dev/null 2>&1 || true
    fi
    remove_entries
    user_systemctl daemon-reload || warn "systemctl --user daemon-reload failed"
    info "pve-bar removed. Your servers in $CONFIG_HOME/pve-bar and their tokens in the GNOME Keyring were kept."
    info "GNOME Shell unloads the extension at the next shell restart (X11: Alt+F2, r; Wayland: log out)."
}

# ---------------------------------------------------------------- install

need() {
    command -v "$1" >/dev/null || die "$1 is missing. Install it with: $2"
}

find_cargo() {
    if command -v cargo >/dev/null; then
        command -v cargo
    elif [[ -x "$HOME/.cargo/bin/cargo" ]]; then
        printf '%s\n' "$HOME/.cargo/bin/cargo"
    else
        die "cargo is missing. Install Rust with: curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
    fi
}

install_all() {
    [[ $EUID -ne 0 ]] || die "run this as your own user, not with sudo: pve-bar needs no root"

    # 1. Checks first: nothing is changed if anything is missing.
    need glib-compile-schemas "sudo apt install libglib2.0-bin"
    [[ -n "$NO_SYSTEMD" ]] || need systemctl "sudo apt install systemd"

    read_manifest || true
    local entry dest src mode file targets=("$MANIFEST")
    for entry in "${FILES[@]}"; do
        targets+=("${entry%%|*}")
    done
    while IFS= read -r -d '' file; do
        targets+=("$EXT_DIR/${file#"$REPO/extension/"}")
    done < <(find "$REPO/extension" -type f ! -name gschemas.compiled -print0 | sort -z)
    for dest in "${targets[@]}"; do
        if [[ -e "$dest" && -z "${OLD[$dest]:-}" ]]; then
            die "$dest already exists and was not installed by this script. Move it away and run again."
        fi
    done

    # 2. Build.
    local bin="${PVE_BAR_BIN_DIR:-}"
    if [[ -z "$bin" ]]; then
        local cargo
        cargo="$(find_cargo)"
        info "Building pved and pvectl..."
        (cd "$REPO" && "$cargo" build --release --locked -p pved -p pvectl)
        bin="$REPO/target/release"
    fi
    [[ -x "$bin/pved" && -x "$bin/pvectl" ]] || die "no pved/pvectl binaries in $bin"

    # 3. Replace the previous install, if any.
    if [[ ${#OLD_ENTRIES[@]} -gt 0 ]]; then
        info "Replacing the previous install..."
        remove_entries
    fi

    # 4. Binaries, the systemd unit and the D-Bus activation file.
    for entry in "${FILES[@]}"; do
        IFS='|' read -r dest src mode <<<"$entry"
        make_dirs "$(dirname "$dest")"
        case "$src" in
        bin:*) install -m "$mode" "$bin/${src#bin:}" "$dest" ;;
        tpl:*)
            sed "s|@PVED@|$PVED|g" "$REPO/${src#tpl:}" >"$dest"
            chmod "$mode" "$dest"
            ;;
        *) install -m "$mode" "$REPO/$src" "$dest" ;;
        esac
        record file "$dest"
    done

    # 5. The extension.
    while IFS= read -r -d '' file; do
        dest="$EXT_DIR/${file#"$REPO/extension/"}"
        make_dirs "$(dirname "$dest")"
        install -m 644 "$file" "$dest"
        record file "$dest"
    done < <(find "$REPO/extension" -type f ! -name gschemas.compiled -print0 | sort -z)
    glib-compile-schemas "$EXT_DIR/schemas"
    record file "$EXT_DIR/schemas/gschemas.compiled"

    # 6. The manifest, recording itself last so it is removed last.
    make_dirs "$(dirname "$MANIFEST")"
    record file "$MANIFEST"
    printf '%s\n' "${NEW_ENTRIES[@]}" >"$MANIFEST"

    # 7. Let systemd see the unit; restart an older pved. The session bus
    #    picks up the activation file by itself.
    user_systemctl daemon-reload || warn "systemctl --user daemon-reload failed"
    user_systemctl try-restart pved.service || warn "could not restart pved"

    if [[ -z "$NO_SYSTEMD" ]]; then
        if busctl --user get-property "$BUS_NAME" /io/github/pauloeduardods/PveBar1 \
            "$BUS_NAME" Version >/dev/null 2>&1; then
            info "pved is running."
        else
            warn "pved did not start; see: journalctl --user -u pved"
        fi
        if gnome-extensions enable "$UUID" >/dev/null 2>&1; then
            info "Extension enabled. To load a new version: on X11 press Alt+F2, type r, Enter (no logout); on Wayland, log out and back in."
        else
            info "Restart GNOME Shell (X11: Alt+F2, r; Wayland: log out), then run: gnome-extensions enable $UUID"
        fi
    fi
    case ":$PATH:" in
    *":$HOME/.local/bin:"*) ;;
    *) warn "$HOME/.local/bin is not in your PATH; run pvectl as $HOME/.local/bin/pvectl" ;;
    esac
    if [[ ! -f "$CONFIG_HOME/pve-bar/pved.conf" ]]; then
        info "Next: add your first server with: pvectl setup NAME   (e.g. pvectl setup home)"
    fi
    info "Done. To remove everything: ./install.sh --uninstall"
}

case "${1:-}" in
"") install_all ;;
--uninstall) uninstall ;;
-h | --help) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//' ;;
*) die "unknown option: $1 (try --help)" ;;
esac
