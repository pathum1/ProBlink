import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {NutClient, decodeStatus} from './nut.js';

const SCHEMA = 'org.gnome.shell.extensions.problink';

const POSITIONS = [['left', 'Left'], ['center', 'Centre'], ['right', 'Right']];
const BLINK_MODES = [
    ['never', 'Never'],
    ['on-battery', 'While on battery'],
    ['critical', 'Only when the battery is critical'],
];

function switchRow(settings, key, title, subtitle = '') {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings, key, title, subtitle, lower, upper) {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: 1, page_increment: 5}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// Drop-down for a string key with fixed choices: [[value, label], ...].
function choiceRow(settings, key, title, choices) {
    const row = new Adw.ComboRow({
        title,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const i = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, i);
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected][0];
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });
    return row;
}

function toHex(rgba) {
    const byte = v => Math.round(v * 255).toString(16).padStart(2, '0');
    return `#${byte(rgba.red)}${byte(rgba.green)}${byte(rgba.blue)}`;
}

// Colour button plus a reset button for a '#rrggbb' string key.
function colorRow(settings, key, title) {
    const row = new Adw.ActionRow({title});
    const button = new Gtk.ColorDialogButton({
        dialog: new Gtk.ColorDialog({with_alpha: false, title}),
        valign: Gtk.Align.CENTER,
    });
    const reset = new Gtk.Button({
        icon_name: 'edit-undo-symbolic',
        tooltip_text: 'Reset to default',
        valign: Gtk.Align.CENTER,
        css_classes: ['flat'],
    });
    const sync = () => {
        const rgba = new Gdk.RGBA();
        if (rgba.parse(settings.get_string(key)) && toHex(rgba) !== toHex(button.rgba))
            button.rgba = rgba;
        reset.sensitive = settings.get_user_value(key) !== null;
    };
    sync();
    settings.connect(`changed::${key}`, sync);
    button.connect('notify::rgba', () => {
        const hex = toHex(button.rgba);
        if (settings.get_string(key) !== hex)
            settings.set_string(key, hex);
    });
    reset.connect('clicked', () => settings.reset(key));
    row.add_suffix(reset);
    row.add_suffix(button);
    row.activatable_widget = button;
    return row;
}

function group(page, title, description, rows) {
    const g = new Adw.PreferencesGroup({title, description});
    for (const row of rows)
        g.add(row);
    page.add(g);
    return g;
}

export default class ProBlinkPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings(SCHEMA);
        window._settings = settings;
        window.set_default_size(620, 760);

        // ---- Display
        const display = new Adw.PreferencesPage({
            title: 'Display',
            icon_name: 'preferences-desktop-display-symbolic',
        });
        group(display, 'Top panel', 'What the indicator shows next to its icon.', [
            choiceRow(settings, 'panel-position', 'Position', POSITIONS),
            switchRow(settings, 'show-charge', 'Battery charge'),
            switchRow(settings, 'show-load', 'Load'),
            switchRow(settings, 'show-voltage', 'Voltage',
                'Input voltage on mains power, output voltage on battery'),
            switchRow(settings, 'show-runtime', 'Runtime left',
                'Only while on battery, and only if the UPS reports it'),
        ]);
        group(display, 'Updates',
            'How often the indicator asks NUT for new values. NUT itself reads the UPS ' +
            'every few seconds (pollinterval in ups.conf), so updating faster than that ' +
            'shows nothing new.', [
                spinRow(settings, 'update-interval', 'On mains power', 'Seconds between updates', 1, 60),
                spinRow(settings, 'update-interval-on-battery', 'On battery', 'Seconds between updates', 1, 60),
            ]);
        window.add(display);

        // ---- Alerts
        const alerts = new Adw.PreferencesPage({
            title: 'Alerts',
            icon_name: 'dialog-warning-symbolic',
        });
        const warning = spinRow(settings, 'warning-level', 'Warning level',
            'At or below this charge (%), the indicator turns the warning colour', 2, 99);
        const critical = spinRow(settings, 'critical-level', 'Critical level',
            'At or below this charge (%), the indicator turns the critical colour', 1, 98);
        // Keep critical below warning.
        settings.connect('changed::warning-level', () => {
            const w = settings.get_int('warning-level');
            if (settings.get_int('critical-level') >= w)
                settings.set_int('critical-level', Math.max(1, w - 1));
        });
        settings.connect('changed::critical-level', () => {
            const c = settings.get_int('critical-level');
            if (settings.get_int('warning-level') <= c)
                settings.set_int('warning-level', Math.min(99, c + 1));
        });
        group(alerts, 'Battery levels', null, [
            warning,
            colorRow(settings, 'warning-color', 'Warning colour'),
            critical,
            colorRow(settings, 'critical-color', 'Critical colour'),
        ]);
        group(alerts, 'Power failure', null, [
            choiceRow(settings, 'blink-mode', 'Blink the panel icon', BLINK_MODES),
            switchRow(settings, 'notifications', 'Notifications',
                'When the power goes off, comes back, or the battery runs low'),
        ]);
        window.add(alerts);

        // ---- Connection
        const connection = new Adw.PreferencesPage({
            title: 'Connection',
            icon_name: 'network-server-symbolic',
        });
        const host = new Adw.EntryRow({title: 'Host', show_apply_button: true});
        host.text = settings.get_string('nut-host');
        host.connect('apply', () => settings.set_string('nut-host', host.text.trim() || '127.0.0.1'));

        const upsName = new Adw.EntryRow({title: 'UPS name (empty: first UPS found)', show_apply_button: true});
        upsName.text = settings.get_string('ups-name');
        upsName.connect('apply', () => settings.set_string('ups-name', upsName.text.trim()));

        const test = new Adw.ActionRow({
            title: 'Test the connection',
            subtitle: 'Asks upsd for the current values',
        });
        const testButton = new Gtk.Button({
            label: 'Test',
            valign: Gtk.Align.CENTER,
        });
        testButton.connect('clicked', () => this._test(settings, test, testButton));
        test.add_suffix(testButton);
        test.activatable_widget = testButton;

        group(connection, 'NUT server',
            'Where upsd runs. The defaults fit a UPS connected to this PC.', [
                host,
                spinRow(settings, 'nut-port', 'Port', 'upsd listens on 3493 by default', 1, 65535),
                upsName,
                test,
            ]);
        const reset = new Gtk.Button({
            label: 'Reset all settings',
            halign: Gtk.Align.CENTER,
            css_classes: ['destructive-action', 'pill'],
            margin_top: 12,
        });
        reset.connect('clicked', () => {
            for (const key of settings.settings_schema.list_keys())
                settings.reset(key);
            host.text = settings.get_string('nut-host');
            upsName.text = settings.get_string('ups-name');
        });
        const resetGroup = new Adw.PreferencesGroup();
        resetGroup.add(reset);
        connection.add(resetGroup);
        window.add(connection);
    }

    async _test(settings, row, button) {
        button.sensitive = false;
        row.subtitle = 'Connecting…';
        try {
            const client = new NutClient(settings.get_string('nut-host'), settings.get_int('nut-port'));
            const {ups, vars} = await client.fetch(settings.get_string('ups-name') || null);
            const status = decodeStatus(vars['ups.status']);
            const charge = vars['battery.charge'] !== undefined ? `, ${vars['battery.charge']} %` : '';
            row.subtitle = `OK: ${ups}, ${status.text}${charge}`;
        } catch (e) {
            row.subtitle = `Failed: ${e.message}`;
        } finally {
            button.sensitive = true;
        }
    }
}
