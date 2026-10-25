// Prints the UPS values the extension reads, without GNOME Shell.
// Useful to check NUT works before blaming the extension.
//
//   gjs -m tools/check-ups.js [host] [port]

import {NutClient, decodeStatus} from '../gnome-extension/problink@pathum1.github.com/nut.js';
import System from 'system';

const [host = '127.0.0.1', port = '3493'] = ARGV;

try {
    const {ups, description, vars} = await new NutClient(host, Number(port)).fetch();
    print(`UPS:             ${ups} (${description})`);
    print(`Status:          ${decodeStatus(vars['ups.status']).text}  [${vars['ups.status']}]`);
    const show = [
        ['battery.charge', 'Battery charge', '%'],
        ['battery.voltage', 'Battery voltage', 'V'],
        ['ups.load', 'Load', '%'],
        ['input.voltage', 'Input voltage', 'V'],
        ['output.voltage', 'Output voltage', 'V'],
        ['output.frequency', 'Frequency', 'Hz'],
    ];
    for (const [key, name, unit] of show) {
        if (vars[key] !== undefined)
            print(`${`${name}:`.padEnd(17)}${vars[key]} ${unit}`);
    }
} catch (e) {
    printerr(`Cannot read the UPS from upsd at ${host}:${port}: ${e.message}`);
    System.exit(1);
}
