// Minimal client for the upsd text protocol (TCP 3493).
// Read-only: LIST UPS / LIST VAR need no login.

import Gio from 'gi://Gio';

Gio._promisify(Gio.SocketClient.prototype, 'connect_to_host_async');
Gio._promisify(Gio.OutputStream.prototype, 'write_all_async');
Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async');

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// One line of a NUT LIST reply: `VAR ups1 battery.charge "100"`.
// Values are quoted, with \" and \\ escaped.
function parseQuoted(raw) {
    return raw.replace(/\\(["\\])/g, '$1');
}

export class NutClient {
    constructor(host = '127.0.0.1', port = 3493) {
        this._host = host;
        this._port = port;
    }

    // Returns {ups, description, vars: {name: value}}.
    // Picks the first UPS upsd knows about when upsName is null.
    async fetch(upsName = null, cancellable = null) {
        const client = new Gio.SocketClient({timeout: 3});
        const conn = await client.connect_to_host_async(
            `${this._host}:${this._port}`, this._port, cancellable);

        const out = conn.get_output_stream();
        const input = new Gio.DataInputStream({
            base_stream: conn.get_input_stream(),
            newline_type: Gio.DataStreamNewlineType.ANY,
        });

        const send = cmd => out.write_all_async(
            encoder.encode(`${cmd}\n`), 0, cancellable);

        // Reads lines until `END LIST <what>`; throws on `ERR ...`.
        const readList = async what => {
            const lines = [];
            for (;;) {
                const [bytes] = await input.read_line_async(0, cancellable);
                if (bytes === null)
                    throw new Error('upsd closed the connection');
                const line = decoder.decode(bytes);
                if (line.startsWith('ERR '))
                    throw new Error(line.slice(4));
                if (line.startsWith(`END LIST ${what}`))
                    return lines;
                if (!line.startsWith('BEGIN LIST'))
                    lines.push(line);
            }
        };

        try {
            let description = '';
            if (!upsName) {
                await send('LIST UPS');
                const upsList = await readList('UPS');
                const m = upsList[0]?.match(/^UPS (\S+) "(.*)"$/);
                if (!m)
                    throw new Error('upsd has no UPS configured');
                upsName = m[1];
                description = parseQuoted(m[2]);
            }

            await send(`LIST VAR ${upsName}`);
            const vars = {};
            for (const line of await readList(`VAR ${upsName}`)) {
                const m = line.match(/^VAR \S+ (\S+) "(.*)"$/);
                if (m)
                    vars[m[1]] = parseQuoted(m[2]);
            }

            await send('LOGOUT').catch(() => {});
            return {ups: upsName, description, vars};
        } finally {
            conn.close_async(0, null, null);
        }
    }
}

// ups.status is a space-separated list of flags, e.g. "OL CHRG" or "OB LB".
export function decodeStatus(status = '') {
    const flags = new Set(status.split(/\s+/).filter(Boolean));
    const onBattery = flags.has('OB');
    const lowBattery = flags.has('LB');

    let text;
    if (lowBattery)
        text = 'On battery — LOW';
    else if (onBattery)
        text = 'On battery';
    else if (flags.has('OL'))
        text = 'On mains power';
    else
        text = 'Unknown';

    const extra = {
        CHRG: 'charging', DISCHRG: 'discharging', RB: 'replace battery',
        OVER: 'overloaded', BYPASS: 'bypass', CAL: 'calibrating',
        OFF: 'output off', TRIM: 'trimming voltage', BOOST: 'boosting voltage',
        FSD: 'forced shutdown',
    };
    const notes = [...flags].filter(f => f in extra).map(f => extra[f]);
    if (notes.length)
        text += ` (${notes.join(', ')})`;

    return {flags, onBattery, lowBattery, online: flags.has('OL'), text};
}
