# ProBlink

Monitor a **ProLink USB UPS on Linux**, with a GNOME top-panel indicator.

ProBlink sets up [Network UPS Tools (NUT)](https://networkupstools.org/) for
ProLink UPSes and adds a small GNOME Shell extension that shows:

- battery charge
- load
- input / output voltage
- an icon for **mains power** or **battery power** (yellow on battery, red when low)
- a dropdown with all values, and notifications when power goes off or comes back

```
 [plug]  100%  L 14%  226V          ← top panel, on mains
 [batt]   87%  L 15%  230V          ← on battery (yellow)
```

NUT also shuts the PC down cleanly when the UPS battery runs low.

> **Tested only on the ProLink PRO2000SFCU (2 kVA)** from the
> [SFCU series](https://prolink2u.com/products/sfcu-series?variant=40573923000393),
> on CachyOS with GNOME Shell 51 and NUT 2.8.5.
> Other models and distributions have not been tested yet.

## Quick setup

1. Connect the UPS to the PC with its USB cable. Use a port on the back of the PC.
2. Check that Linux sees it: run `lsusb` and look for `0665:5161`.
3. Download ProBlink and run the installer as your normal user:
   ```
   git clone https://github.com/pathum1/ProBlink.git
   cd ProBlink
   ./install.sh
   ```
4. Enter your sudo password when it asks.
5. Log out and log back in. The UPS indicator appears in the top panel.

The sections below explain each step in more detail.

## Supported hardware

| Model | Status |
|---|---|
| ProLink PRO2000SFCU (2 kVA, SFCU series) | Tested |
| Other ProLink models that show `0665:5161` in `lsusb` | Not tested. Should work (same chip and driver) |

Check your UPS: plug in its USB cable and run `lsusb`. You should see a line like:

```
ID 0665:5161 Cypress Semiconductor USB to Serial
```

If you see that, ProBlink will probably work for you. Other UPS brands with the
same ID (many Voltronic-based units) often work too. If you try another model,
please open an issue and say whether it worked.

The extension itself works with **any UPS that NUT supports**. Only the
`nut/ups.conf` file is ProLink-specific.

## Requirements

- Linux with systemd
- GNOME Shell 46 to 51 (for the extension)
- Arch / CachyOS / Manjaro, Debian / Ubuntu, Fedora, or openSUSE
  (the installer uses `pacman`, `apt-get`, `dnf` or `zypper` to install NUT)

## Install (details)

1. Plug the UPS USB cable into a port **on the back of the PC**.
   (Front-panel ports and hubs can drop the connection. See Troubleshooting.)
2. Download ProBlink:
   ```
   git clone https://github.com/pathum1/ProBlink.git
   cd ProBlink
   ```
3. See what the installer will do, without changing anything:
   ```
   ./install.sh --dry-run
   ```
4. Run the installer as your normal user (it asks for your sudo password):
   ```
   ./install.sh
   ```
5. Log out and log back in. The indicator appears in the top panel.

The installer:

- installs NUT if it is missing
- writes `ups.conf`, `nut.conf`, `upsd.conf`, `upsd.users`, `upsmon.conf`
  (existing files are backed up as `*.problink-backup-<date>`)
- creates a random password for `upsmon`
- enables NUT so it starts at every boot, and starts it now
- installs a small watchdog that restarts the NUT driver if it freezes
  (see "The panel shows a grey warning icon" below)
- copies the extension to `~/.local/share/gnome-shell/extensions/` and enables it

Options:

| Option | What it does |
|---|---|
| `--dry-run` | Show every step, change nothing |
| `--nut-only` | Only set up NUT (for servers or other desktops) |
| `--extension-only` | Only install the GNOME extension |
| `--watchdog-only` | Only install the driver watchdog (keeps your NUT config) |
| `--yes` | Do not ask before replacing NUT config files |

## Check that it works

1. Read the UPS from the command line:
   ```
   upsc ups1
   ```
   Look for `ups.status: OL` (mains) and `battery.charge`.
2. Read it the same way the extension does:
   ```
   gjs -m tools/check-ups.js
   ```

## Troubleshooting

**The UPS is not in `lsusb`, or it appears and disappears.**

1. Run `journalctl -k -n 30 | grep -i usb`.
2. If you see `error -71` or `device not accepting address`, the port or cable
   is bad. Move the cable to a port on the back of the PC, or try another cable.

**The panel shows a grey warning icon.**

1. Run `upsc ups1`.
2. If it says `Data stale` or `Driver not connected`, the driver lost the UPS.
   On the PRO2000SFCU the driver sometimes freezes after a while, even with a
   good USB connection. The ProBlink watchdog checks every minute and restarts
   the driver, so it should come back by itself within about a minute.
   See what the watchdog did with:
   ```
   journalctl -u problink-watchdog
   ```
   To restart the driver by hand:
   ```
   sudo systemctl restart nut-driver@ups1 nut-server
   ```
3. If it says `Connection refused`, `upsd` is not running. Run:
   ```
   sudo systemctl enable --now nut.target
   ```

**ProLink ViewPower is installed.**

ViewPower and NUT both want the same USB device. Use one of them.

On new kernels (tested on 7.2), ViewPower's bundled Java 17.0.4 crashes at
start with `NullPointerException ... "anyController" is null`, because
`/proc/cgroups` is empty. If you want to keep ViewPower instead of NUT, add
this line to `/opt/ViewPower/upsMonitor.vmoptions`:

```
-XX:-UseContainerSupport
```

To turn ViewPower off and use NUT:

```
sudo systemctl disable --now upsMonitor.service
```

**The extension does not appear after logging back in.**

1. Run `gnome-extensions info problink@pathum1.github.com`.
2. If `State` is `ERROR`, run `journalctl --user -b | grep -i problink` and
   open an issue with the output.

## Change the settings

The extension reads from `127.0.0.1:3493` and uses the first UPS that `upsd`
lists. To read a UPS on another machine, edit the constants at the top of
`extension.js`:

```js
const NUT_HOST = '127.0.0.1';
const NUT_PORT = 3493;
const POLL_SECONDS = 5;
const POLL_SECONDS_ON_BATTERY = 2;
```

## Uninstall

```
gnome-extensions disable problink@pathum1.github.com
rm -r ~/.local/share/gnome-shell/extensions/problink@pathum1.github.com
sudo systemctl disable --now problink-watchdog.timer nut.target nut-driver@ups1
sudo rm /etc/systemd/system/problink-watchdog.{service,timer} /usr/local/sbin/problink-watchdog
```

Your old NUT config files are kept next to the new ones as
`/etc/nut/*.problink-backup-<date>`.

## How it works

See [docs/how-it-works.md](docs/how-it-works.md): the chain from the UPS over
USB, through the `nutdrv_qx` driver and `upsd`, to the panel, plus what was
found by inspecting the driver binary.

## Repository layout

```
install.sh                         installer
nut/                               NUT config for ProLink UPSes + driver watchdog
gnome-extension/problink@…/        the GNOME Shell extension
  nut.js                             upsd protocol client (no GNOME Shell code)
  extension.js                       the panel indicator
tools/check-ups.js                 command-line test using the same client
docs/how-it-works.md               protocol notes
```

## License

GPL-2.0-or-later. See [LICENSE](LICENSE).

ProBlink is not made by or affiliated with ProLink. NUT is a separate project
under its own license; ProBlink only configures it.
