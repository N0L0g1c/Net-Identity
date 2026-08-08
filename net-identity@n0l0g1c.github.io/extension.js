// SPDX-License-Identifier: GPL-2.0-or-later

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import NM from 'gi://NM';
import Pango from 'gi://Pango';
import Soup from 'gi://Soup';
import St from 'gi://St';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const IP_MS = 5 * 60 * 1000;
const LOCAL_MS = 3000;
const IP_URLS = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
];

class Row extends PopupMenu.PopupBaseMenuItem {
    static { GObject.registerClass(this); }

    constructor(label) {
        super({reactive: true, can_focus: true, style_class: 'ni-row'});
        this.add_child(new St.Label({
            text: label,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ni-key',
        }));
        this._val = new St.Label({
            text: '…',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ni-val',
            x_expand: true,
        });
        this._val.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._val);
        this.connect('activate', () => {
            const t = this._val.text;
            if (!t || t === '…' || t === '—')
                return;
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, t);
            Main.notify('Net Identity', `Copied: ${t}`);
        });
    }

    set(text, extra = '') {
        this._val.text = text;
        this._val.style_class = extra ? `ni-val ${extra}` : 'ni-val';
    }
}

class Indicator extends PanelMenu.Button {
    static { GObject.registerClass(this); }

    constructor() {
        super(0.5, 'Net Identity', false);

        const box = new St.BoxLayout({style_class: 'panel-status-menu-box'});
        this._icon = new St.Icon({
            icon_name: 'network-workgroup-symbolic',
            style_class: 'system-status-icon',
        });
        this._label = new St.Label({
            text: 'Net',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ni-panel-label',
        });
        box.add_child(this._icon);
        box.add_child(this._label);
        this.add_child(box);

        this._ip = '';
        this._prevIp = '';
        this._fetching = false;
        this._nm = null;
        this._nmIds = [];
        this._session = new Soup.Session({
            timeout: 12,
            user_agent: 'net-identity@n0l0g1c.github.io/1.0',
        });
        this._cancel = null;
        this._ipTimer = 0;
        this._localTimer = 0;
        this._openId = 0;

        this._ipRow = new Row('Public IP');
        this._vpnRow = new Row('VPN / WG');
        this._tailRow = new Row('Tailscale');
        this._dnsRow = new Row('DNS');
        this._connRow = new Row('Connection');
        this._lanRow = new Row('LAN IP');
        for (const r of [this._ipRow, this._vpnRow, this._tailRow,
            this._dnsRow, this._connRow, this._lanRow])
            this.menu.addMenuItem(r);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const refresh = new PopupMenu.PopupMenuItem('Refresh public IP');
        refresh.connect('activate', () => this._fetchIp(true).catch(e => logError(e)));
        this.menu.addMenuItem(refresh);

        this._note = new PopupMenu.PopupMenuItem('Starting…', {
            reactive: false, can_focus: false,
        });
        this._note.label.add_style_class_name('ni-status');
        this.menu.addMenuItem(this._note);

        this._openId = this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refreshLocal().catch(e => logError(e));
        });
    }

    async start() {
        try {
            this._nm = await NM.Client.new_async(null);
            this._nmIds.push(this._nm.connect(
                'notify::active-connections',
                () => this._refreshLocal().catch(e => logError(e))
            ));
        } catch (e) {
            logError(e, 'Net Identity: NM unavailable');
            this._note.label.text = 'NetworkManager unavailable';
        }

        this._refreshLocal().catch(e => logError(e));
        this._fetchIp(false).catch(e => logError(e));

        this._ipTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IP_MS, () => {
            this._fetchIp(false).catch(e => logError(e));
            return GLib.SOURCE_CONTINUE;
        });
        this._localTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOCAL_MS, () => {
            this._refreshLocal().catch(e => logError(e));
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._openId) {
            this.menu.disconnect(this._openId);
            this._openId = 0;
        }
        if (this._ipTimer) {
            GLib.Source.remove(this._ipTimer);
            this._ipTimer = 0;
        }
        if (this._localTimer) {
            GLib.Source.remove(this._localTimer);
            this._localTimer = 0;
        }
        if (this._cancel) {
            this._cancel.cancel();
            this._cancel = null;
        }
        if (this._nm) {
            for (const id of this._nmIds)
                this._nm.disconnect(id);
            this._nmIds = [];
            this._nm = null;
        }
        if (this._session) {
            this._session.abort();
            this._session = null;
        }
        super.destroy();
    }

    async _refreshLocal() {
        let vpn = false;
        let names = [];
        let tailscale = false;
        let lan = [];
        let dns = [];
        let primary = '—';

        if (this._nm) {
            for (const ac of this._nm.get_active_connections()) {
                const type = ac.get_connection_type() || '';
                const id = ac.get_id() || type || 'connection';
                if (ac.get_default())
                    primary = id;
                if (type === 'vpn' || type === 'wireguard' || type.includes('vpn')) {
                    vpn = true;
                    names.push(id);
                }
                if (id.toLowerCase().includes('tailscale')) {
                    tailscale = true;
                    vpn = true;
                }
                const ip4 = ac.get_ip4_config();
                if (ip4) {
                    for (const a of ip4.get_addresses()) {
                        const addr = a.get_address();
                        if (addr && !addr.startsWith('127.'))
                            lan.push(addr);
                    }
                    for (const n of ip4.get_nameservers()) {
                        if (n && !dns.includes(n))
                            dns.push(n);
                    }
                }
            }
            for (const dev of this._nm.get_devices()) {
                if (dev.get_state() !== NM.DeviceState.ACTIVATED)
                    continue;
                const iface = dev.get_iface() || '';
                if (iface === 'tailscale0') {
                    tailscale = true;
                    vpn = true;
                }
                if (iface.startsWith('wg') || iface.startsWith('tun')) {
                    vpn = true;
                    if (!names.includes(iface))
                        names.push(iface);
                }
            }
        }

        if (!dns.length) {
            try {
                const file = Gio.File.new_for_path('/etc/resolv.conf');
                if (file.query_exists(null)) {
                    const [, bytes] = await file.load_contents_async(null);
                    for (const line of new TextDecoder().decode(bytes).split('\n')) {
                        const m = line.match(/^\s*nameserver\s+(\S+)/);
                        if (m && !dns.includes(m[1]))
                            dns.push(m[1]);
                    }
                }
            } catch {
                // leave empty
            }
        }

        this._vpnRow.set(vpn ? (names.join(', ') || 'active') : 'down', vpn ? 'ni-ok' : 'ni-warn');
        this._tailRow.set(tailscale ? 'up' : 'down', tailscale ? 'ni-ok' : '');
        this._dnsRow.set(dns.length ? dns.slice(0, 4).join(', ') : '—');
        this._connRow.set(primary);
        this._lanRow.set(lan.length ? lan.slice(0, 3).join(', ') : '—');

        if (!this._ip) {
            this._label.text = vpn ? 'VPN…' : 'Net…';
            this._label.style_class = 'ni-panel-label ni-warn';
            this._icon.icon_name = 'network-workgroup-symbolic';
            return;
        }
        const short = this._ip.length > 15 ? `${this._ip.slice(0, 12)}…` : this._ip;
        this._label.text = short;
        if (vpn || tailscale) {
            this._label.style_class = 'ni-panel-label ni-ok';
            this._icon.icon_name = 'network-vpn-symbolic';
        } else {
            this._label.style_class = 'ni-panel-label ni-warn';
            this._icon.icon_name = 'network-workgroup-symbolic';
        }
    }

    async _fetchIp(force) {
        if (this._fetching)
            return;
        this._fetching = true;
        if (this._cancel)
            this._cancel.cancel();
        this._cancel = new Gio.Cancellable();
        if (force)
            this._note.label.text = 'Refreshing…';

        try {
            let lastErr = null;
            let ip = null;
            for (const url of IP_URLS) {
                try {
                    const msg = Soup.Message.new('GET', url);
                    const bytes = await this._session.send_and_read_async(
                        msg, GLib.PRIORITY_DEFAULT, this._cancel);
                    if (msg.status_code < 200 || msg.status_code >= 300)
                        throw new Error(`HTTP ${msg.status_code}`);
                    const text = new TextDecoder().decode(bytes.get_data()).trim();
                    if (!/^[\d.:a-fA-F]+$/.test(text) || text.length > 45)
                        throw new Error('bad payload');
                    ip = text;
                    break;
                } catch (e) {
                    lastErr = e;
                }
            }
            if (!ip)
                throw lastErr || new Error('no IP');
            if (!this._session)
                return;

            const changed = this._prevIp && this._prevIp !== ip;
            if (this._ip)
                this._prevIp = this._ip;
            this._ip = ip;
            this._ipRow.set(ip, changed ? 'ni-danger' : 'ni-ok');
            this._note.label.text =
                `IP updated ${GLib.DateTime.new_now_local().format('%H:%M:%S')}`;
            if (changed)
                Main.notify('Net Identity', `Public IP changed: ${ip}`);
            this._refreshLocal().catch(e => logError(e));
        } catch (e) {
            if (e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            if (!this._session)
                return;
            logError(e, 'Net Identity: IP fetch failed');
            if (!this._ip)
                this._ipRow.set('unavailable', 'ni-danger');
            this._note.label.text = `IP fetch failed — ${String(e.message || e).slice(0, 40)}`;
        } finally {
            this._fetching = false;
        }
    }
}

export default class NetIdentityExtension extends Extension {
    enable() {
        this._indicator = new Indicator();
        Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right');
        this._indicator.start().catch(e => logError(e));
    }

    disable() {
        this._indicator.destroy();
        this._indicator = null;
    }
}
