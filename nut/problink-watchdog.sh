#!/bin/sh
# ProBlink watchdog: restarts the NUT driver when it stops answering.
#
# Some ProLink/Voltronic USB UPSes (0665:5161) occasionally make nutdrv_qx
# freeze: the process stays alive but stops polling, and upsd reports
# "Data stale" until the driver is restarted. Run by problink-watchdog.timer.
#
# Set PROBLINK_DRY_RUN=1 to only print what would happen.

UPS="${1:-ups1}"

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

echo "UPS $UPS: upsc says '$status', restarting $unit"
if [ -n "$PROBLINK_DRY_RUN" ]; then
    echo "(dry run, not restarting)"
    exit 0
fi
systemctl restart "$unit"
