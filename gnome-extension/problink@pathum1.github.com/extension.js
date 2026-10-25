import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as BarLevel from 'resource:///org/gnome/shell/ui/barLevel.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {NutClient, decodeStatus} from './nut.js';

const SCHEMA = 'org.gnome.shell.extensions.problink';

// How often the icon fades in and out while blinking (ms).
const BLINK_MS = 800;
const BLINK_DIM_OPACITY = 60;

// Rows shown in the dropdown, in order. Missing variables are hidden.
// battery.charge has its own bar at the top.
const ROWS = [
    ['battery.runtime', 'Runtime left', v => formatRuntime(v)],
    ['battery.voltage', 'Battery voltage', v => `${v} V`],
    ['ups.load', 'Load', v => `${v} %`],
    ['input.voltage', 'Input voltage', v => `${v} V`],
    ['output.voltage', 'Output voltage', v => `${v} V`],
    ['output.frequency', 'Frequency', v => `${v} Hz`],
];

// Settings that only need the current values drawn again.
const REDRAW_KEYS = [
    'show-charge', 'show-load', 'show-voltage', 'show-runtime',
    'warning-level', 'critical-level', 'warning-color', 'critical-color',
    'blink-mode',
];

function formatRuntime(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s))
        return seconds;
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function formatDuration(microseconds) {
    const s = Math.max(0, Math.round(microseconds / 1e6));
    if (s < 60)
        return `${s} s`;
    return formatRuntime(s);
}

function batteryIconName(charge) {
    const level = Math.max(0, Math.min(100, Math.round(Number(charge) / 10) * 10));
    if (!Number.isFinite(level))
        return 'battery-missing-symbolic';
    return `battery-level-${level}-symbolic`;
}

// St.BoxLayout got `orientation` in GNOME 48; older shells only have `vertical`.
function verticalBox(params) {
    const box = new St.BoxLayout(params);
    if ('orientation' in box)
        box.orientation = Clutter.Orientation.VERTICAL;
    else
        box.vertical = true;
    return box;
}

const ValueRow = GObject.registerClass(
class ValueRow extends PopupMenu.PopupBaseMenuItem {
    _init(name) {
        super._init({reactive: false, can_focus: false, style_class: 'problink-item'});
        this.add_child(new St.Label({
            text: name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._value = new St.Label({
            style_class: 'problink-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
    }

    setValue(text) {
        this._value.text = text;
    }
});

// Big icon, status line and a short line under it.
const HeaderItem = GObject.registerClass(
class HeaderItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false, style_class: 'problink-item problink-header'});
        this.icon = new St.Icon({
            icon_size: 32,
            style_class: 'problink-header-icon',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.icon);

        const text = verticalBox({x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this.title = new St.Label({style_class: 'problink-title'});
        this.subtitle = new St.Label({style_class: 'problink-subtitle'});
        text.add_child(this.title);
        text.add_child(this.subtitle);
        this.add_child(text);
    }
});

// Battery charge as a bar with the percentage next to it.
const ChargeItem = GObject.registerClass(
class ChargeItem extends PopupMenu.PopupBaseMenuItem {
    _init() {
        super._init({reactive: false, can_focus: false, style_class: 'problink-item problink-charge'});
        this.bar = new BarLevel.BarLevel({
            style_class: 'problink-bar',
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.label = new St.Label({
            style_class: 'problink-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.bar);
        this.add_child(this.label);
    }

    setCharge(charge, color) {
        this.bar.value = Math.max(0, Math.min(100, charge)) / 100;
        this.bar.set_style(color ? `-barlevel-active-background-color: ${color};` : null);
        this.label.text = `${charge} %`;
    }
});

const UpsIndicator = GObject.registerClass(
class UpsIndicator extends PanelMenu.Button {
    _init(extension, settings) {
        super._init(0.0, extension.metadata.name);
        this._extension = extension;
        this._settings = settings;

        this._mainsIcon = Gio.FileIcon.new(
            extension.dir.get_child('icons').get_child('problink-mains-symbolic.svg'));

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            gicon: this._mainsIcon,
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'problink-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._header = new HeaderItem();
        this._header.title.text = 'Connecting to upsd…';
        this.menu.addMenuItem(this._header);

        this._charge = new ChargeItem();
        this._charge.visible = false;
        this.menu.addMenuItem(this._charge);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._rows = new Map();
        for (const [key, name] of ROWS) {
            const row = new ValueRow(name);
            row.visible = false;
            this._rows.set(key, row);
            this.menu.addMenuItem(row);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._modelItem = new PopupMenu.PopupMenuItem('', {
            reactive: false,
            can_focus: false,
            style_class: 'problink-model',
        });
        this.menu.addMenuItem(this._modelItem);

        const prefsItem = new PopupMenu.PopupImageMenuItem('Settings', 'emblem-system-symbolic');
        prefsItem.connect('activate', () => this._extension.openPreferences());
        this.menu.addMenuItem(prefsItem);

        this._cancellable = new Gio.Cancellable();
        this._makeClient();
        this._lastStatus = null;
        this._lastData = null;
        this._busy = false;
        this._onBatterySince = 0;
        this._blinkId = 0;

        // Refresh straight away when the menu opens.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });

        this._settings.connectObject(
            'changed::update-interval', () => this._refresh(),
            'changed::update-interval-on-battery', () => this._refresh(),
            'changed::nut-host', () => this._reconnect(),
            'changed::nut-port', () => this._reconnect(),
            'changed::ups-name', () => this._reconnect(),
            this);
        for (const key of REDRAW_KEYS)
            this._settings.connectObject(`changed::${key}`, () => this._redraw(), this);

        this._refresh();
    }

    _makeClient() {
        this._host = this._settings.get_string('nut-host').trim() || '127.0.0.1';
        this._client = new NutClient(this._host, this._settings.get_int('nut-port'));
        this._upsName = this._settings.get_string('ups-name').trim() || null;
    }

    _reconnect() {
        this._makeClient();
        this._lastStatus = null;
        this._refresh();
    }

    _schedule(seconds) {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            this._timeoutId = 0;
            this._refresh();
            return GLib.SOURCE_REMOVE;
        });
    }

    async _refresh() {
        if (this._busy)
            return;
        this._busy = true;
        let onBattery = false;
        try {
            const data = await this._client.fetch(this._upsName, this._cancellable);
            this._upsName = data.ups;
            if (data.description)
                this._description = data.description;
            this._lastData = data;
            onBattery = this._show(data).onBattery;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // UPS may have been renamed; look it up again next time.
            if (String(e.message).includes('UNKNOWN-UPS') && !this._settings.get_string('ups-name'))
                this._upsName = null;
            this._lastData = null;
            this._showError(e.message);
        } finally {
            this._busy = false;
        }
        if (!this._cancellable.is_cancelled()) {
            this._schedule(this._settings.get_int(
                onBattery ? 'update-interval-on-battery' : 'update-interval'));
        }
    }

    // A setting changed: draw the last values again without asking upsd.
    _redraw() {
        if (this._lastData)
            this._show(this._lastData, false);
    }

    // Colour for this charge level, or null for the normal panel colour.
    _levelColor(charge, status) {
        const c = Number(charge);
        if (status.lowBattery || (Number.isFinite(c) && c <= this._settings.get_int('critical-level')))
            return {level: 'critical', color: this._settings.get_string('critical-color')};
        if (Number.isFinite(c) && c <= this._settings.get_int('warning-level'))
            return {level: 'warning', color: this._settings.get_string('warning-color')};
        return {level: 'normal', color: null};
    }

    _show({ups, vars}, notify = true) {
        const s = this._settings;
        const status = decodeStatus(vars['ups.status']);
        const charge = vars['battery.charge'];
        const load = vars['ups.load'];
        const runtime = vars['battery.runtime'];
        const {level, color} = this._levelColor(charge, status);

        if (status.onBattery && !this._onBatterySince)
            this._onBatterySince = GLib.get_monotonic_time();
        else if (!status.onBattery)
            this._onBatterySince = 0;

        // Mains: show what comes in. Battery: input is ~0, show what goes out.
        const volts = status.onBattery ? vars['output.voltage'] : vars['input.voltage'];

        let icon;
        if (status.onBattery || status.lowBattery)
            icon = Gio.ThemedIcon.new(batteryIconName(charge));
        else if (status.online)
            icon = this._mainsIcon;
        else
            icon = Gio.ThemedIcon.new('dialog-warning-symbolic');
        this._icon.gicon = icon;
        this._header.icon.gicon = icon;

        const parts = [];
        if (s.get_boolean('show-charge') && charge !== undefined)
            parts.push(`${charge}%`);
        if (s.get_boolean('show-runtime') && status.onBattery && runtime !== undefined)
            parts.push(formatRuntime(runtime));
        if (s.get_boolean('show-load') && load !== undefined)
            parts.push(`L ${load}%`);
        if (s.get_boolean('show-voltage') && volts !== undefined)
            parts.push(`${Math.round(Number(volts))}V`);
        this._label.text = parts.join('  ');
        this._label.visible = parts.length > 0;

        this.remove_style_class_name('problink-error');
        const style = color ? `color: ${color};` : null;
        this._icon.set_style(style);
        this._label.set_style(style);
        this._header.icon.set_style(style);

        const blink = s.get_string('blink-mode');
        this._setBlinking((blink === 'on-battery' && status.onBattery) ||
            (blink === 'critical' && status.onBattery && level === 'critical'));

        this._header.title.text = status.text;
        if (status.onBattery) {
            const since = formatDuration(GLib.get_monotonic_time() - this._onBatterySince);
            this._header.subtitle.text = runtime !== undefined
                ? `For ${since} · about ${formatRuntime(runtime)} left`
                : `Running on battery for ${since}`;
        } else {
            this._header.subtitle.text = `Updated ${GLib.DateTime.new_now_local().format('%H:%M:%S')}`;
        }

        this._charge.visible = charge !== undefined;
        if (charge !== undefined)
            this._charge.setCharge(Number(charge), color);

        for (const [key, , format] of ROWS) {
            const row = this._rows.get(key);
            row.visible = vars[key] !== undefined;
            if (row.visible)
                row.setValue(format(vars[key]));
        }

        const model = vars['ups.model'] || vars['device.model'] || this._description || ups;
        const mfr = vars['ups.mfr'] || vars['device.mfr'] || '';
        this._modelItem.label.text = `${mfr} ${model}`.trim() + `  ·  ${ups}@${this._host}`;

        if (notify)
            this._notifyChange(status, level);
        return status;
    }

    _notifyChange(status, level) {
        const prev = this._lastStatus;
        this._lastStatus = {...status, level};
        if (!prev || !this._settings.get_boolean('notifications'))
            return;
        if (status.lowBattery && !prev.lowBattery)
            Main.notify('UPS battery LOW', 'Save your work. The PC will shut down soon.');
        else if (status.onBattery && level === 'critical' && prev.level !== 'critical')
            Main.notify('UPS battery critical', 'The battery is almost empty. Save your work.');
        else if (status.onBattery && !prev.onBattery)
            Main.notify('UPS on battery', 'Mains power is off. Running on the UPS battery.');
        else if (status.online && prev.onBattery)
            Main.notify('UPS on mains power', 'Mains power is back.');
    }

    _showError(message) {
        const icon = Gio.ThemedIcon.new('dialog-warning-symbolic');
        this._icon.gicon = icon;
        this._header.icon.gicon = icon;
        this._icon.set_style(null);
        this._label.set_style(null);
        this._header.icon.set_style(null);
        this._setBlinking(false);
        this._label.text = '—';
        this._label.visible = true;
        this.add_style_class_name('problink-error');

        const stale = message.includes('DATA-STALE') || message.includes('DRIVER-NOT-CONNECTED');
        this._header.title.text = stale ? 'UPS not responding' : 'Cannot reach upsd';
        this._header.subtitle.text = stale ? 'Check the USB cable' : message;
        this._charge.visible = false;
        for (const row of this._rows.values())
            row.visible = false;
        this._lastStatus = null;
        this._onBatterySince = 0;
    }

    // Fades the panel icon in and out. Works with animations turned off too
    // (it then switches straight between the two opacities).
    _setBlinking(on) {
        if (on === Boolean(this._blinkId))
            return;
        if (on) {
            let dim = false;
            this._blinkId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, BLINK_MS, () => {
                dim = !dim;
                this._icon.ease({
                    opacity: dim ? BLINK_DIM_OPACITY : 255,
                    duration: BLINK_MS - 100,
                    mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                });
                return GLib.SOURCE_CONTINUE;
            });
        } else {
            GLib.source_remove(this._blinkId);
            this._blinkId = 0;
            this._icon.remove_all_transitions();
            this._icon.opacity = 255;
        }
    }

    destroy() {
        this._cancellable.cancel();
        this._settings.disconnectObject(this);
        this._setBlinking(false);
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super.destroy();
    }
});

export default class ProBlinkExtension extends Extension {
    enable() {
        this._settings = this.getSettings(SCHEMA);
        this._settings.connectObject('changed::panel-position', () => {
            this._removeIndicator();
            this._addIndicator();
        }, this);
        this._addIndicator();
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._removeIndicator();
        this._settings = null;
    }

    _addIndicator() {
        this._indicator = new UpsIndicator(this, this._settings);
        const position = this._settings.get_string('panel-position');
        Main.panel.addToStatusArea(this.uuid, this._indicator, position === 'right' ? 0 : -1, position);
    }

    _removeIndicator() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
