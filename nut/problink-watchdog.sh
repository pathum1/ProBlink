#!/bin/sh
# ProBlink watchdog: brings the UPS back when NUT loses it.
#
# The USB-serial chip in some ProLink/Voltronic UPSes (0665:5161) can stop
# answering after a while. nutdrv_qx then freezes, upsd reports "Data stale",
# and restarting the driver alone fails with "Device not supported!".
# Resetting the USB device (a software unplug/replug) brings the chip back.
#
#   problink-watchdog [ups-name] [vendor:product]
#
# Run every minute by problink-watchdog.timer.
# Set PROBLINK_DRY_RUN=1 to only print what would happen.

UPS="${1:-ups1}"
USBID="${2:-0665:5161}"

status=$(upsc "$UPS@localhost" ups.status 2>&1)
case "$status" in
    *"Data stale"*|*"Driver not connected"*) ;;
    *) exit 0 ;;
esac

if systemctl cat "nut-driver@$UPS.service" >/dev/null 2>&1; then
    unit="nut-driver@$UPS.service"
else
    unit="nut-driver.service"
fi

# sysfs directory of the UPS, e.g. /sys/bus/usb/devices/1-1
usb_dir() {
    for d in /sys/bus/usb/devices/*; do
        [ -r "$d/idVendor" ] || continue
        if [ "$(cat "$d/idVendor"):$(cat "$d/idProduct")" = "$USBID" ]; then
            echo "$d"
            return
        fi
    done
}

dir=$(usb_dir)
echo "UPS $UPS: upsc says '$status'. USB device $USBID: ${dir:-not found}"

if [ -z "$dir" ]; then
    echo "The UPS is not on USB. Check the cable; nothing to reset."
    exit 0
fi

if [ -n "$PROBLINK_DRY_RUN" ]; then
    echo "(dry run) would stop $unit, reset $dir, start $unit"
    exit 0
fi

systemctl stop "$unit"

echo "Resetting USB device $USBID"
usbreset "$USBID" >/dev/null 2>&1 || echo "usbreset failed or is not installed"
sleep 2

if systemctl start "$unit"; then
    echo "Driver started after USB reset"
    exit 0
fi

# Stronger: tell the kernel to drop the device and add it back.
echo "Driver still failing; unplugging and replugging $dir in software"
systemctl stop "$unit"
echo 0 > "$dir/authorized"
sleep 2
echo 1 > "$dir/authorized"
sleep 3

if systemctl start "$unit"; then
    echo "Driver started after software replug"
    exit 0
fi

echo "Could not bring the UPS back. Unplug and replug the USB cable by hand."
exit 1
