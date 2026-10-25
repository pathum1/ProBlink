#!/usr/bin/env bash
# ProBlink installer: sets up Network UPS Tools (NUT) for a ProLink USB UPS
# and installs the GNOME panel extension.
#
# Run as your normal user (not root). It asks for your sudo password
# for the system parts.
#
#   ./install.sh                 everything
#   ./install.sh --nut-only      only the NUT driver/server/monitor
#   ./install.sh --extension-only  only the GNOME extension
#   ./install.sh --dry-run       show what would happen, change nothing
#   ./install.sh --yes           do not ask before overwriting NUT config

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UUID="problink@pathum1.github.com"
UPS_NAME="ups1"
VENDOR_ID="0665"
PRODUCT_ID="5161"

DO_NUT=1
DO_EXT=1
DRY_RUN=0
ASSUME_YES=0

for arg in "$@"; do
    case "$arg" in
        --nut-only) DO_EXT=0 ;;
        --extension-only) DO_NUT=0 ;;
        --dry-run) DRY_RUN=1 ;;
        --yes|-y) ASSUME_YES=1 ;;
        -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "Unknown option: $arg" >&2; exit 2 ;;
    esac
done

bold() { printf '\033[1m%s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
warn() { printf '\033[33m  ! %s\033[0m\n' "$*"; }
die()  { printf '\033[31m  x %s\033[0m\n' "$*" >&2; exit 1; }

# Runs a command, or only prints it in dry-run mode.
run() {
    if (( DRY_RUN )); then
        printf '    [dry-run] %s\n' "$*"
    else
        "$@"
    fi
}

STAGE_DIR=$(mktemp -d)
trap 'rm -rf "$STAGE_DIR"' EXIT

if [[ $EUID -eq 0 ]]; then
    die "Run this as your normal user, not with sudo. It will ask for sudo when needed."
fi

# ---------------------------------------------------------------- NUT ----

install_nut_package() {
    if command -v upsd >/dev/null 2>&1 || [[ -x /usr/sbin/upsd ]] || [[ -x /usr/bin/upsd ]]; then
        info "NUT is already installed."
        return
    fi
    bold "Installing NUT"
    if command -v pacman >/dev/null; then
        run sudo pacman -S --needed --noconfirm nut
    elif command -v apt-get >/dev/null; then
        run sudo apt-get update
        run sudo apt-get install -y nut
    elif command -v dnf >/dev/null; then
        run sudo dnf install -y nut nut-client
    elif command -v zypper >/dev/null; then
        run sudo zypper --non-interactive install nut
    else
        die "Unknown package manager. Install NUT (Network UPS Tools) yourself, then run this again."
    fi
}

nut_config_dir() {
    # Fedora uses /etc/ups, everyone else /etc/nut.
    if [[ -d /etc/nut ]]; then echo /etc/nut
    elif [[ -d /etc/ups ]]; then echo /etc/ups
    else echo /etc/nut
    fi
}

nut_group() {
    if getent group nut >/dev/null; then echo nut
    elif getent group ups >/dev/null; then echo ups
    else echo root
    fi
}

# NUT 2.8 renamed upsmon "master" to "primary"; 2.7 only knows "master".
upsmon_role() {
    local upsd ver
    upsd=$(command -v upsd 2>/dev/null || echo /usr/sbin/upsd)
    ver=$("$upsd" -V 2>/dev/null | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -1 || true)
    if [[ -n $ver ]] && [[ $(printf '%s\n2.8.0\n' "$ver" | sort -V | head -1) != 2.8.0 ]]; then
        echo master
    else
        echo primary
    fi
}

check_usb() {
    bold "Looking for the UPS on USB"
    if lsusb 2>/dev/null | grep -qi "${VENDOR_ID}:${PRODUCT_ID}"; then
        info "Found $(lsusb | grep -i "${VENDOR_ID}:${PRODUCT_ID}" | cut -d' ' -f6-)"
    else
        warn "No USB device ${VENDOR_ID}:${PRODUCT_ID} found."
        warn "Plug the UPS USB cable into a port on the back of the PC, then check with: lsusb"
        warn "Continuing anyway; NUT will pick it up once it is connected."
    fi
}

write_nut_config() {
    local dir group role password stage
    dir=$(nut_config_dir)
    group=$(nut_group)
    role=$(upsmon_role)
    password=$(head -c 18 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 20)
    stage="$STAGE_DIR"

    cp "$REPO_DIR/nut/ups.conf" "$REPO_DIR/nut/nut.conf" "$REPO_DIR/nut/upsd.conf" "$stage/"
    sed -e "s/@PASSWORD@/$password/" -e "s/@ROLE@/$role/" \
        "$REPO_DIR/nut/upsd.users.template" > "$stage/upsd.users"
    sed -e "s/@PASSWORD@/$password/" -e "s/@ROLE@/$role/" \
        "$REPO_DIR/nut/upsmon.conf.template" > "$stage/upsmon.conf"

    bold "Writing NUT config to $dir"
    info "group: $group, upsmon role: $role"

    local existing=()
    for f in ups.conf nut.conf upsd.conf upsd.users upsmon.conf; do
        [[ -e $dir/$f ]] && existing+=("$f")
    done
    if (( ${#existing[@]} )) && (( ! ASSUME_YES )) && (( ! DRY_RUN )); then
        echo "  These files already exist and will be replaced (a backup is kept):"
        printf '    %s\n' "${existing[@]}"
        read -r -p "  Continue? [y/N] " answer
        [[ $answer =~ ^[Yy] ]] || die "Stopped. Nothing was changed."
    fi

    local stamp
    stamp=$(date +%Y%m%d-%H%M%S)
    run sudo mkdir -p "$dir"
    for f in "${existing[@]}"; do
        run sudo cp -a "$dir/$f" "$dir/$f.problink-backup-$stamp"
    done
    for f in ups.conf nut.conf upsd.conf; do
        run sudo install -m 644 -o root -g root "$stage/$f" "$dir/$f"
    done
    for f in upsd.users upsmon.conf; do
        run sudo install -m 640 -o root -g "$group" "$stage/$f" "$dir/$f"
    done
    if (( DRY_RUN )); then
        info "Rendered upsmon.conf would be:"
        sed 's/^/      /' "$stage/upsmon.conf" | grep -v '^      #' | grep -v '^      $'
    fi
}

start_nut() {
    bold "Starting NUT"
    # Make sure the udev rule (0665:5161 -> group nut) applies to a plugged-in UPS.
    run sudo udevadm control --reload-rules
    run sudo udevadm trigger --subsystem-match=usb --attr-match=idVendor="$VENDOR_ID"

    if systemctl cat nut-driver@.service >/dev/null 2>&1; then
        # NUT 2.8+: one driver unit per UPS, all grouped under nut.target.
        run sudo systemctl enable nut.target nut-driver.target "nut-driver@${UPS_NAME}.service" nut-server.service nut-monitor.service
        run sudo systemctl restart "nut-driver@${UPS_NAME}.service"
        run sudo systemctl restart nut-server.service nut-monitor.service
    elif systemctl cat nut-driver.service >/dev/null 2>&1; then
        # NUT 2.7 (e.g. Ubuntu 22.04).
        run sudo systemctl enable nut-driver.service nut-server.service nut-monitor.service
        run sudo systemctl restart nut-driver.service nut-server.service nut-monitor.service
    else
        die "Could not find NUT's systemd units. Is NUT installed correctly?"
    fi

    if systemctl list-unit-files upsMonitor.service >/dev/null 2>&1 \
        && systemctl is-enabled upsMonitor.service >/dev/null 2>&1; then
        warn "ViewPower (upsMonitor.service) is also enabled. Two programs cannot share the UPS."
        warn "Disable it with: sudo systemctl disable --now upsMonitor.service"
    fi
}

verify_nut() {
    (( DRY_RUN )) && return
    bold "Checking that NUT can read the UPS"
    local status=""
    for _ in $(seq 1 15); do
        status=$(upsc "${UPS_NAME}@localhost" ups.status 2>/dev/null || true)
        [[ -n $status ]] && break
        sleep 1
    done
    if [[ -z $status ]]; then
        warn "NUT is not answering yet. Check: upsc ${UPS_NAME}@localhost"
        warn "and: journalctl -u nut-driver@${UPS_NAME} -u nut-server -n 30"
        return
    fi
    info "ups.status:     $status"
    info "battery.charge: $(upsc "${UPS_NAME}@localhost" battery.charge 2>/dev/null)%"
    info "ups.load:       $(upsc "${UPS_NAME}@localhost" ups.load 2>/dev/null)%"
    info "input.voltage:  $(upsc "${UPS_NAME}@localhost" input.voltage 2>/dev/null) V"
}

# ---------------------------------------------------------- extension ----

enable_extension() {
    # The shell only sees a newly copied extension after the next login,
    # so `gnome-extensions enable` can fail. Fall back to the gsettings list.
    if gnome-extensions enable "$UUID" >/dev/null 2>&1; then
        return
    fi
    local current
    current=$(gsettings get org.gnome.shell enabled-extensions)
    if [[ $current == *"'$UUID'"* ]]; then
        return
    elif [[ $current == "@as []" || $current == "[]" ]]; then
        gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    else
        gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']"
    fi
}

install_extension() {
    bold "Installing the GNOME extension"
    if ! command -v gnome-shell >/dev/null; then
        warn "GNOME Shell not found; skipping the extension."
        return
    fi
    local dest="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"
    run mkdir -p "$dest"
    run cp -r "$REPO_DIR/gnome-extension/$UUID/." "$dest/"
    if (( DRY_RUN )); then
        printf '    [dry-run] enable %s in org.gnome.shell enabled-extensions\n' "$UUID"
    else
        enable_extension
    fi
    info "Installed to $dest"
    if [[ ${XDG_SESSION_TYPE:-} == wayland ]]; then
        info "Log out and log back in to load it (Wayland cannot reload the shell)."
    else
        info "Press Alt+F2, type r, press Enter to reload the shell (or log out and in)."
    fi
}

# --------------------------------------------------------------- main ----

(( DRY_RUN )) && bold "DRY RUN: nothing will be changed"

if (( DO_NUT )); then
    install_nut_package
    check_usb
    write_nut_config
    start_nut
    verify_nut
fi
(( DO_EXT )) && install_extension

bold "Done."
