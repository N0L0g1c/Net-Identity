// SPDX-License-Identifier: GPL-2.0
/* public IP + local connection info */

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import NM from 'gi://NM';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const SOURCES = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
];

var NetButton = GObject.registerClass(
class NetButton extends PanelMenu.Button {
    _init() {
        super._init(0.5, 'Net Identity');

        this.label = new St.Label({
            text: '…',
            y_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this.add_child(this.label);

        this.ip = '';
        this.prev = '';
        this.nm = null;
        this.session = new Soup.Session({timeout: 10});
        this.cancel = null;
        this.sigs = [];
        this.t1 = 0;
        this.t2 = 0;

        this.lines = {};
        for (const name of ['Public IP', 'VPN', 'DNS', 'Connection', 'LAN']) {
            const item = new PopupMenu.PopupMenuItem(`${name}: …`);
            item.connect('activate', () => {
                const v = item._value;
                if (v)
                    St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, v);
            });
            item._value = '';
            this.lines[name] = item;
            this.menu.addMenuItem(item);
        }
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const r = new PopupMenu.PopupMenuItem('Refresh IP');
        r.connect('activate', () => {
            this.fetchIp();
        });
        this.menu.addMenuItem(r);
        this.msg = new PopupMenu.PopupMenuItem('', {reactive: false});
        this.menu.addMenuItem(this.msg);

        this.menu.connect('open-state-changed', (_m, o) => {
            if (o)
                this.refreshLocal();
        });

        this.start();
    }

    async start() {
        try {
            this.nm = await NM.Client.new_async(null);
            this.sigs.push(this.nm.connect('notify::active-connections', () => {
                this.refreshLocal();
            }));
        } catch (e) {
            this.msg.label.text = 'no NetworkManager';
            logError(e);
        }
        this.refreshLocal();
        this.fetchIp();
        this.t1 = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 300, () => {
            this.fetchIp();
            return GLib.SOURCE_CONTINUE;
        });
        this.t2 = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 4, () => {
            this.refreshLocal();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this.t1) {
            GLib.Source.remove(this.t1);
            this.t1 = 0;
        }
        if (this.t2) {
            GLib.Source.remove(this.t2);
            this.t2 = 0;
        }
        if (this.cancel) {
            this.cancel.cancel();
            this.cancel = null;
        }
        if (this.nm) {
            for (const id of this.sigs)
                this.nm.disconnect(id);
            this.sigs = [];
            this.nm = null;
        }
        if (this.session) {
            this.session.abort();
            this.session = null;
        }
        super.destroy();
    }

    setLine(name, value) {
        const item = this.lines[name];
        item._value = value || '';
        item.label.text = `${name}: ${value || '—'}`;
    }

    async refreshLocal() {
        let vpn = false;
        let vpnName = '';
        let dns = [];
        let conn = '—';
        let lan = [];

        if (this.nm) {
            for (const ac of this.nm.get_active_connections()) {
                const type = ac.get_connection_type() || '';
                const id = ac.get_id() || type;
                if (ac.get_default())
                    conn = id;
                if (type === 'vpn' || type === 'wireguard' || type.includes('vpn')) {
                    vpn = true;
                    vpnName = id;
                }
                const cfg = ac.get_ip4_config();
                if (cfg) {
                    for (const a of cfg.get_addresses()) {
                        const addr = a.get_address();
                        if (addr && !addr.startsWith('127.'))
                            lan.push(addr);
                    }
                    for (const n of cfg.get_nameservers()) {
                        if (n && dns.indexOf(n) === -1)
                            dns.push(n);
                    }
                }
            }
            for (const d of this.nm.get_devices()) {
                if (d.get_state() !== NM.DeviceState.ACTIVATED)
                    continue;
                const iface = d.get_iface() || '';
                if (iface.startsWith('wg') || iface.startsWith('tun') || iface === 'tailscale0') {
                    vpn = true;
                    if (!vpnName)
                        vpnName = iface;
                }
            }
        }

        if (!dns.length) {
            try {
                const f = Gio.File.new_for_path('/etc/resolv.conf');
                if (f.query_exists(null)) {
                    const [, b] = await f.load_contents_async(null);
                    for (const line of new TextDecoder().decode(b).split('\n')) {
                        const m = line.match(/nameserver\s+(\S+)/);
                        if (m && dns.indexOf(m[1]) === -1)
                            dns.push(m[1]);
                    }
                }
            } catch (e) { /* ok */ }
        }

        this.setLine('VPN', vpn ? (vpnName || 'yes') : 'no');
        this.setLine('DNS', dns.slice(0, 3).join(', '));
        this.setLine('Connection', conn);
        this.setLine('LAN', lan.slice(0, 2).join(', '));

        if (this.ip)
            this.label.text = this.ip.length > 18 ? `${this.ip.slice(0, 15)}…` : this.ip;
        else
            this.label.text = vpn ? 'vpn' : 'net';
    }

    async fetchIp() {
        if (this.cancel)
            this.cancel.cancel();
        this.cancel = new Gio.Cancellable();
        this.msg.label.text = 'fetching…';

        let err = null;
        for (const url of SOURCES) {
            try {
                const msg = Soup.Message.new('GET', url);
                const bytes = await this.session.send_and_read_async(
                    msg, GLib.PRIORITY_DEFAULT, this.cancel);
                if (msg.status_code < 200 || msg.status_code >= 300)
                    throw new Error(`HTTP ${msg.status_code}`);
                const text = new TextDecoder().decode(bytes.get_data()).trim();
                if (!/^[\d.:a-fA-F]+$/.test(text))
                    throw new Error('bad body');
                if (this.prev && this.prev !== text)
                    Main.notify('Net Identity', `IP changed: ${text}`);
                if (this.ip)
                    this.prev = this.ip;
                this.ip = text;
                this.setLine('Public IP', text);
                this.label.text = text.length > 18 ? `${text.slice(0, 15)}…` : text;
                this.msg.label.text = GLib.DateTime.new_now_local().format('%H:%M:%S');
                return;
            } catch (e) {
                err = e;
            }
        }
        if (err && !(err instanceof GLib.Error &&
            err.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))) {
            this.msg.label.text = 'ip failed';
            if (!this.ip)
                this.setLine('Public IP', 'unavailable');
        }
    }
});

export default class extends Extension {
    enable() {
        this._b = new NetButton();
        Main.panel.addToStatusArea(this.uuid, this._b);
    }

    disable() {
        this._b.destroy();
        this._b = null;
    }
}
