# How it works

ProBlink does not contain its own UPS driver. It uses the driver that already
ships with [Network UPS Tools (NUT)](https://networkupstools.org/),
`nutdrv_qx`, and sets it up correctly for ProLink USB UPSes. This page explains
the chain from the UPS to the panel, and what was found by inspecting the
shipped driver binary.

## The chain

```
 ProLink UPS
     │  USB (0665:5161, "INNO TECH USB to Serial")
     │  text commands: QS, Q1, QGS, F, I ...
     ▼
 nutdrv_qx            /usr/lib/nut/nutdrv_qx   (one process per UPS)
     │  local Unix socket  <statepath>/nutdrv_qx-ups1
     │  SETINFO battery.charge "100", DATAOK / DATASTALE, PING / PONG
     ▼
 upsd                 NUT data server, TCP 127.0.0.1:3493
     │  text protocol: LIST UPS, LIST VAR ups1, GET VAR ...
     ├──────────────► upsmon   (shuts the PC down on low battery)
     ├──────────────► upsc     (command line)
     └──────────────► ProBlink GNOME extension (top panel)
```

1. **UPS → driver.** The UPS has a Voltronic-based "USB to Serial" chip. It
   presents itself as a USB HID device, but really carries a serial text
   protocol. The driver sends short commands and parses the replies. For the
   PRO2000SFCU, NUT detects the protocol as **Voltronic-QS 0.10**
   (`driver.version.data`).
2. **Driver → upsd.** The driver keeps every value it reads in a table and
   pushes changes to `upsd` over a local Unix socket, as `SETINFO <var> "<value>"`
   lines. It also tells `upsd` whether the UPS is answering (`DATAOK` /
   `DATASTALE`), and they check each other with `PING` / `PONG`.
3. **upsd → clients.** `upsd` serves the values on TCP port 3493 with a
   simple line-based text protocol. Reading values needs no login. This is the
   API the extension uses.

## Talking to upsd yourself

```
$ printf 'LIST VAR ups1\nLOGOUT\n' | nc 127.0.0.1 3493
BEGIN LIST VAR ups1
VAR ups1 battery.charge "100"
VAR ups1 battery.voltage "26.9"
VAR ups1 input.voltage "224.4"
VAR ups1 output.voltage "224.4"
VAR ups1 output.frequency "50.1"
VAR ups1 ups.load "13"
VAR ups1 ups.status "OL"
...
END LIST VAR ups1
OK Goodbye
```

Errors come back as one line starting with `ERR`, for example
`ERR UNKNOWN-UPS` or `ERR DATA-STALE` (the driver lost contact with the UPS).

`ups.status` is a list of flags separated by spaces:

| Flag | Meaning |
|---|---|
| `OL` | On line (mains power) |
| `OB` | On battery |
| `LB` | Low battery (upsmon shuts the PC down) |
| `CHRG` / `DISCHRG` | Charging / discharging |
| `RB` | Replace battery |
| `OVER` | Overloaded |
| `BYPASS`, `TRIM`, `BOOST`, `CAL`, `OFF`, `FSD` | Other states |

The extension's client is [`nut.js`](../gnome-extension/problink@pathum1.github.com/nut.js).
It opens one connection, sends `LIST UPS` (only the first time, to find the UPS
name), then `LIST VAR <ups>`, then `LOGOUT`.

## What was found in the driver binary

The installed `nutdrv_qx` (NUT 2.8.5, CachyOS package) was opened with the
[REA](https://github.com/morluto/rea) reverse-engineering tools (Ghidra
backend). The binary is stripped, so the findings come from its strings, and
were then confirmed against the running system.

Observed in the binary:

- Protocol tables named `Voltronic-QS 0.10` and `Voltronic-QS-Hex 0.11`.
- UPS commands `QS`, `Q1`, `QGS` (status queries) among others.
- The driver-to-upsd messages `SETINFO %s "%s"`, `DUMPALL`, `DATAOK`,
  `DATASTALE`, `PING`, `PONG`.
- The socket name pattern `%s/%s-%s` (state path / driver name / UPS name).
- Variable names such as `battery.charge`, `battery.voltage`,
  `input.voltage`, `output.voltage`, `output.frequency`, `ups.status`.

Observed in `upsd`: the client protocol verbs `LIST`, `GET`, `HELP`,
`NETVER`, `LOGOUT`, `STARTTLS`, and the reply framing
`BEGIN LIST VAR %s` / `END LIST VAR %s`.

Confirmed on the running system: `upsc ups1` and a raw `LIST VAR ups1` over
TCP both return the values above, with `driver.version.data` =
`Voltronic-QS 0.10`.

Not covered: the exact reply format of each UPS command. That is documented in
the NUT source (`drivers/nutdrv_qx_voltronic-qs.c`) and was not needed, because
the extension only talks to `upsd`.

## Things that went wrong during setup (and the fixes)

- **The UPS kept disappearing from USB.** The kernel log showed
  `device not accepting address, error -71` on one front USB port. Moving the
  cable to a port on the back of the PC fixed it.
- **NUT never started at boot.** `nut.target` was disabled, so nothing pulled
  in the driver, `upsd` or `upsmon`. `install.sh` enables it.
- **The driver froze.** About 19 minutes after one boot, `nutdrv_qx` stopped
  polling: the process stayed alive but did nothing (no CPU time, no context
  switches), the USB device stayed connected, and `upsd` reported
  `Data stale` from then on. The driver logged nothing about it. Restarting
  the driver alone failed with `Device not supported!`: the UPS's USB-serial
  chip itself had stopped answering. NUT does not recover from this, so
  ProBlink adds `problink-watchdog` (a systemd timer). When `upsc` reports
  `Data stale` or `Driver not connected`, it stops the driver, resets the USB
  device with `usbreset` (falling back to a software unplug/replug through
  sysfs `authorized`), and starts the driver again.
- **ViewPower.** ProLink's own Java tool (`upsMonitor.service`) wants the same
  USB device. Use either ViewPower or NUT, not both.
