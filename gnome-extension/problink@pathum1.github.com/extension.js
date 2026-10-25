import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {NutClient, decodeStatus} from './nut.js';

// upsd on this machine; the first UPS it lists is used.
const NUT_HOST = '127.0.0.1';
const NUT_PORT = 3493;
const POLL_SECONDS = 5;
const POLL_SECONDS_ON_BATTERY = 2;

// Rows shown in the dropdown, in order. Missing variables are hidden.
const ROWS = [
    ['battery.charge', 'Battery charge', v => `${v} %`],
    ['battery.runtime', 'Runtime left', v => formatRuntime(v)],
    ['battery.voltage', 'Battery voltage', v => `${v} V`],
    ['ups.load', 'Load', v => `${v} %`],
    ['input.voltage', 'Input voltage', v => `${v} V`],
    ['output.voltage', 'Output voltage', v => `${v} V`],
    ['output.frequency', 'Frequency', v => `${v} Hz`],
];

function formatRuntime(seconds) {
    const s = Number(seconds);
    if (!Number.isFinite(s))
        return seconds;
    const m = Math.floor(s / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m} min`;
}

function batteryIcon(charge, charging) {
    const level = Math.max(0, Math.min(100, Math.round(Number(charge) / 10) * 10));
    if (!Number.isFinite(level))
        return 'battery-missing-symbolic';
    return `battery-level-${level}${charging ? '-charging' : ''}-symbolic`;
}

const ValueRow = GObject.registerClass(
class ValueRow extends PopupMenu.PopupBaseMenuItem {
    _init(name) {
        super._init({reactive: false, can_focus: false});
        this.add_child(new St.Label({
            text: name,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        }));
        this._value = new St.Label({
            style_class: 'nut-ups-value',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this._value);
    }

    setValue(text) {
        this._value.text = text;
    }
});

const UpsIndicator = GObject.registerClass(
class UpsIndicator extends PanelMenu.Button {
    _init(extension) {
        super._init(0.0, extension.metadata.name);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'ac-adapter-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'nut-ups-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._statusItem = new PopupMenu.PopupMenuItem('Connecting to upsd…', {
            reactive: false,
            can_focus: false,
            style_class: 'nut-ups-status',
        });
        this.menu.addMenuItem(this._statusItem);
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
            style_class: 'nut-ups-model',
        });
        this.menu.addMenuItem(this._modelItem);

        this._client = new NutClient(NUT_HOST, NUT_PORT);
        this._cancellable = new Gio.Cancellable();
        this._upsName = null;
        this._lastFlags = null;
        this._busy = false;

        // Refresh straight away when the menu opens.
        this.menu.connect('open-state-changed', (_menu, open) => {
            if (open)
                this._refresh();
        });

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
        let next = POLL_SECONDS;
        try {
            const data = await this._client.fetch(this._upsName, this._cancellable);
            this._upsName = data.ups;
            if (data.description)
                this._description = data.description;
            const status = this._show(data);
            if (status.onBattery)
                next = POLL_SECONDS_ON_BATTERY;
        } catch (e) {
            if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            // UPS may have been renamed; look it up again next time.
            if (String(e.message).includes('UNKNOWN-UPS'))
                this._upsName = null;
            this._showError(e.message);
        } finally {
            this._busy = false;
        }
        if (!this._cancellable.is_cancelled())
            this._schedule(next);
    }

    _show({ups, vars}) {
        const status = decodeStatus(vars['ups.status']);
        const charge = vars['battery.charge'];
        const load = vars['ups.load'];

        // Mains: show what comes in. Battery: input is ~0, show what goes out.
        const volts = status.onBattery ? vars['output.voltage'] : vars['input.voltage'];

        if (status.onBattery || status.lowBattery)
            this._icon.icon_name = batteryIcon(charge, false);
        else if (status.online)
            this._icon.icon_name = 'ac-adapter-symbolic';
        else
            this._icon.icon_name = 'dialog-warning-symbolic';

        const parts = [];
        if (charge !== undefined)
            parts.push(`${charge}%`);
        if (load !== undefined)
            parts.push(`L ${load}%`);
        if (volts !== undefined)
            parts.push(`${Math.round(Number(volts))}V`);
        this._label.text = parts.join('  ');

        for (const cls of ['nut-ups-on-battery', 'nut-ups-low', 'nut-ups-error'])
            this.remove_style_class_name(cls);
        if (status.lowBattery)
            this.add_style_class_name('nut-ups-low');
        else if (status.onBattery)
            this.add_style_class_name('nut-ups-on-battery');

        this._statusItem.label.text = status.text;
        for (const [key, , format] of ROWS) {
            const row = this._rows.get(key);
            row.visible = vars[key] !== undefined;
            if (row.visible)
                row.setValue(format(vars[key]));
        }

        const model = vars['ups.model'] || vars['device.model'] || this._description || ups;
        const mfr = vars['ups.mfr'] || vars['device.mfr'] || '';
        this._modelItem.label.text = `${mfr} ${model}`.trim() + `  ·  ${ups}@${NUT_HOST}`;

        this._notifyChange(status);
        return status;
    }

    _notifyChange(status) {
        const prev = this._lastFlags;
        this._lastFlags = status;
        if (!prev)
            return;
        if (status.lowBattery && !prev.lowBattery)
            Main.notify('UPS battery LOW', 'Save your work. The PC will shut down soon.');
        else if (status.onBattery && !prev.onBattery)
            Main.notify('UPS on battery', 'Mains power is off. Running on the UPS battery.');
        else if (status.online && prev.onBattery)
            Main.notify('UPS on mains power', 'Mains power is back.');
    }

    _showError(message) {
        this._icon.icon_name = 'dialog-warning-symbolic';
        this._label.text = '—';
        this.remove_style_class_name('nut-ups-on-battery');
        this.remove_style_class_name('nut-ups-low');
        this.add_style_class_name('nut-ups-error');
        this._statusItem.label.text = message.includes('DATA-STALE') || message.includes('DRIVER-NOT-CONNECTED')
            ? 'UPS not responding (check the USB cable)'
            : `Cannot reach upsd: ${message}`;
        for (const row of this._rows.values())
            row.visible = false;
        this._lastFlags = null;
    }

    destroy() {
        this._cancellable.cancel();
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = 0;
        }
        super.destroy();
    }
});

export default class NutUpsExtension extends Extension {
    enable() {
        this._indicator = new UpsIndicator(this);
        Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
