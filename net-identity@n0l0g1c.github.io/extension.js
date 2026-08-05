// Net Identity — public IP, VPN, DNS, connection identity
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

const IP_POLL_MS = 5 * 60 * 1000;
const LOCAL_POLL_MS = 3 * 1000;
const IP_URLS = [
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
];
const USER_AGENT = 'net-identity@n0l0g1c.github.io/1.0';

/**
 * @param {string} key
 * @param {string} value
 * @param {string} [style]
 */
class StatusRow extends PopupMenu.PopupBaseMenuItem {
    static {
        GObject.registerClass(this);
    }

    constructor(key, value, style = '') {
        super({
            reactive: true,
            can_focus: true,
            style_class: 'ni-row',
        });

        this._keyLabel = new St.Label({
            text: key,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ni-key',
        });
        this.add_child(this._keyLabel);

        this._val = new St.Label({
            text: value,
            y_align: Clutter.ActorAlign.CENTER,
            style_class: `ni-val ${style}`.trim(),
            x_expand: true,
        });
        this._val.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this.add_child(this._val);

        this.connect('activate', () => {
            const text = this._val.text;
            if (!text || text === '…' || text === '—')
                return;
            St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
            Main.notify('Net Identity', `Copied: ${text}`);
        });
    }

    /**
     * @param {string} text
     * @param {string} [style]
     */
    setValue(text, style = '') {
        this._val.text = text;
        this._val.style_class = `ni-val ${style}`.trim();
    }
}

class NetIdentityIndicator extends PanelMenu.Button {
    static {
        GObject.registerClass(this);
    }

    constructor() {
        super(0.5, 'Net Identity', false);

        const box = new St.BoxLayout({
            style_class: 'panel-status-menu-box',
        });

        this._panelIcon = new St.Icon({
            icon_name: 'network-workgroup-symbolic',
            style_class: 'system-status-icon',
        });
        box.add_child(this._panelIcon);

        this._panelLabel = new St.Label({
            text: 'Net',
            y_align: Clutter.ActorAlign.CENTER,
            style_class: 'ni-panel-label',
        });
        box.add_child(this._panelLabel);

        this.add_child(box);

        this._publicIp = '';
        this._prevPublicIp = '';
        this._fetchingIp = false;
        this._nmClient = null;
        this._nmSignalIds = [];
        this._session = new Soup.Session({
            timeout: 12,
            user_agent: USER_AGENT,
        });
        this._cancellable = null;
        this._ipSource = 0;
        this._localSource = 0;

        this._ipRow = new StatusRow('Public IP', '…');
        this._vpnRow = new StatusRow('VPN / WG', '…');
        this._tailRow = new StatusRow('Tailscale', '…');
        this._dnsRow = new StatusRow('DNS', '…');
        this._connRow = new StatusRow('Connection', '…');
        this._lanRow = new StatusRow('LAN IP', '…');

        this.menu.addMenuItem(this._ipRow);
        this.menu.addMenuItem(this._vpnRow);
        this.menu.addMenuItem(this._tailRow);
        this.menu.addMenuItem(this._dnsRow);
        this.menu.addMenuItem(this._connRow);
        this.menu.addMenuItem(this._lanRow);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this._refreshItem = new PopupMenu.PopupMenuItem('Refresh public IP');
        this._refreshItem.connect('activate', () => {
            this._fetchPublicIp(true).catch(e => logError(e));
        });
        this.menu.addMenuItem(this._refreshItem);

        this._statusItem = new PopupMenu.PopupMenuItem('Starting…', {
            reactive: false,
            can_focus: false,
        });
        this._statusItem.label.add_style_class_name('ni-status');
        this.menu.addMenuItem(this._statusItem);

        const hint = new PopupMenu.PopupMenuItem(
            'Click a row to copy its value',
            {reactive: false, can_focus: false}
        );
        hint.label.add_style_class_name('ni-hint');
        this.menu.addMenuItem(hint);

        this.menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._refreshLocal();
        });
    }

    async start() {
        try {
            this._nmClient = await NM.Client.new_async(null);
            this._nmSignalIds.push(
                this._nmClient.connect('notify::active-connections', () => this._refreshLocal())
            );
            this._nmSignalIds.push(
                this._nmClient.connect('device-added', () => this._refreshLocal())
            );
            this._nmSignalIds.push(
                this._nmClient.connect('device-removed', () => this._refreshLocal())
            );
        } catch (e) {
            logError(e, 'Net Identity: NetworkManager unavailable');
            this._statusItem.label.text = 'NetworkManager unavailable';
        }

        this._refreshLocal();
        this._fetchPublicIp(false).catch(e => logError(e));

        this._ipSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, IP_POLL_MS, () => {
            this._fetchPublicIp(false).catch(e => logError(e));
            return GLib.SOURCE_CONTINUE;
        });
        this._localSource = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LOCAL_POLL_MS, () => {
            this._refreshLocal();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        if (this._ipSource) {
            try { GLib.Source.remove(this._ipSource); } catch { /* already removed */ }
            this._ipSource = 0;
        }
        if (this._localSource) {
            try { GLib.Source.remove(this._localSource); } catch { /* already removed */ }
            this._localSource = 0;
        }
        if (this._cancellable) {
            this._cancellable.cancel();
            this._cancellable = null;
        }
        if (this._nmClient) {
            for (const id of this._nmSignalIds)
                this._nmClient.disconnect(id);
            this._nmSignalIds = [];
        }
        this._session = null;
        this._nmClient = null;
        super.destroy();
    }

    /**
     * @returns {{vpn: boolean, names: string[], tailscale: boolean, lan: string[], dns: string[], primary: string}}
     */
    _collectNm() {
        const result = {
            vpn: false,
            names: [],
            tailscale: false,
            lan: [],
            dns: [],
            primary: '—',
        };
        if (!this._nmClient)
            return result;

        const connections = this._nmClient.get_active_connections() || [];
        for (const ac of connections) {
            const type = ac.get_connection_type?.() || ac.connection_type || '';
            const id = ac.get_id?.() || ac.id || type || 'connection';
            const default4 = ac.get_default?.() || ac.default;
            if (default4)
                result.primary = id;

            if (type === 'vpn' || type === 'wireguard' || String(type).includes('vpn')) {
                result.vpn = true;
                result.names.push(id);
            }
            const low = String(id).toLowerCase();
            if (low.includes('vpn') || low.includes('wireguard') || low.includes('mullvad') ||
                low.includes('proton') || low.includes('wg-')) {
                result.vpn = true;
                if (!result.names.includes(id))
                    result.names.push(id);
            }
            if (low.includes('tailscale')) {
                result.tailscale = true;
                result.vpn = true;
            }

            try {
                const ip4 = ac.get_ip4_config?.() || ac.ip4_config;
                if (ip4) {
                    const addrs = ip4.get_addresses?.() || [];
                    for (const a of addrs) {
                        const addr = a.get_address?.() || a.address;
                        if (addr && !addr.startsWith('127.'))
                            result.lan.push(addr);
                    }
                    const ns = ip4.get_nameservers?.() || ip4.nameservers || [];
                    for (const n of ns) {
                        if (n && !result.dns.includes(n))
                            result.dns.push(n);
                    }
                }
            } catch {
                // ignore per-connection IP parse errors
            }
        }

        const devices = this._nmClient.get_devices?.() || [];
        for (const dev of devices) {
            const iface = dev.get_iface?.() || dev.interface || '';
            const state = dev.get_state?.() || dev.state;
            if (state !== NM.DeviceState.ACTIVATED)
                continue;
            if (iface === 'tailscale0') {
                result.tailscale = true;
                result.vpn = true;
            }
            if (iface.startsWith('wg') || iface.startsWith('tun') || iface.startsWith('nordlynx')) {
                result.vpn = true;
                if (!result.names.includes(iface))
                    result.names.push(iface);
            }
            try {
                const ip4 = dev.get_ip4_config?.() || dev.ip4_config;
                if (ip4) {
                    const addrs = ip4.get_addresses?.() || [];
                    for (const a of addrs) {
                        const addr = a.get_address?.() || a.address;
                        if (addr && !addr.startsWith('127.') && !result.lan.includes(addr))
                            result.lan.push(addr);
                    }
                }
            } catch {
                // ignore
            }
        }

        // resolv.conf fallback for DNS
        if (result.dns.length === 0)
            result.dns = this._readResolvConf();

        return result;
    }

    /**
     * @returns {string[]}
     */
    _readResolvConf() {
        const dns = [];
        try {
            const file = Gio.File.new_for_path('/etc/resolv.conf');
            if (!file.query_exists(null))
                return dns;
            const [, bytes] = file.load_contents(null);
            const text = new TextDecoder().decode(bytes);
            for (const line of text.split('\n')) {
                const m = line.match(/^\s*nameserver\s+(\S+)/);
                if (m && !dns.includes(m[1]))
                    dns.push(m[1]);
            }
        } catch {
            // ignore
        }
        return dns;
    }

    _refreshLocal() {
        const info = this._collectNm();

        if (info.vpn) {
            this._vpnRow.setValue(
                info.names.length ? info.names.join(', ') : 'active',
                'ni-ok'
            );
        } else {
            this._vpnRow.setValue('down', 'ni-warn');
        }

        this._tailRow.setValue(
            info.tailscale ? 'up' : 'down',
            info.tailscale ? 'ni-ok' : ''
        );

        this._dnsRow.setValue(
            info.dns.length ? info.dns.slice(0, 4).join(', ') : '—',
            ''
        );
        this._connRow.setValue(info.primary || '—', '');
        this._lanRow.setValue(
            info.lan.length ? info.lan.slice(0, 3).join(', ') : '—',
            ''
        );

        this._updatePanel(info);
    }

    /**
     * @param {{vpn: boolean, tailscale: boolean}} info
     */
    _updatePanel(info) {
        const ip = this._publicIp || '…';
        const shortIp = ip.length > 15 ? `${ip.slice(0, 12)}…` : ip;

        if (!this._publicIp) {
            this._panelLabel.text = info.vpn ? 'VPN…' : 'Net…';
            this._panelLabel.style_class = 'ni-panel-label ni-warn';
            this._panelIcon.icon_name = 'network-workgroup-symbolic';
            return;
        }

        if (info.vpn || info.tailscale) {
            this._panelLabel.text = shortIp;
            this._panelLabel.style_class = 'ni-panel-label ni-ok';
            this._panelIcon.icon_name = 'network-vpn-symbolic';
        } else {
            this._panelLabel.text = shortIp;
            this._panelLabel.style_class = 'ni-panel-label ni-warn';
            this._panelIcon.icon_name = 'network-workgroup-symbolic';
        }
    }

    /**
     * @param {boolean} force
     */
    async _fetchPublicIp(force) {
        if (this._fetchingIp)
            return;
        this._fetchingIp = true;
        if (this._cancellable)
            this._cancellable.cancel();
        this._cancellable = new Gio.Cancellable();

        if (force)
            this._statusItem.label.text = 'Refreshing public IP…';

        try {
            const ip = await this._downloadIp(this._cancellable);
            if (!this._session)
                return;

            const changed = this._prevPublicIp && this._prevPublicIp !== ip;
            if (this._publicIp)
                this._prevPublicIp = this._publicIp;
            this._publicIp = ip;
            this._ipRow.setValue(ip, 'ni-ok');

            const now = GLib.DateTime.new_now_local();
            this._statusItem.label.text = `IP updated ${now.format('%H:%M:%S')}`;

            if (changed) {
                Main.notify('Net Identity', `Public IP changed: ${ip}`);
                this._ipRow.setValue(ip, 'ni-danger');
            }

            this._refreshLocal();
        } catch (e) {
            const cancelled = e instanceof GLib.Error &&
                e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
            if (cancelled || !this._session)
                return;
            logError(e, 'Net Identity: public IP fetch failed');
            if (!this._publicIp)
                this._ipRow.setValue('unavailable', 'ni-danger');
            this._statusItem.label.text =
                `IP fetch failed — ${String(e.message || e).slice(0, 40)}`;
        } finally {
            this._fetchingIp = false;
        }
    }

    /**
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<string>}
     */
    async _downloadIp(cancellable) {
        let lastError = null;
        for (const url of IP_URLS) {
            try {
                const message = Soup.Message.new('GET', url);
                if (!message)
                    throw new Error('Invalid URL');
                const bytes = await this._session.send_and_read_async(
                    message,
                    GLib.PRIORITY_DEFAULT,
                    cancellable
                );
                const status = message.status_code;
                if (status < 200 || status >= 300)
                    throw new Error(`HTTP ${status}`);
                const text = new TextDecoder().decode(bytes.get_data()).trim();
                // IPv4 or IPv6-ish
                if (!/^[\d.:a-fA-F]+$/.test(text) || text.length > 45)
                    throw new Error('Unexpected IP payload');
                return text;
            } catch (e) {
                lastError = e;
            }
        }
        throw lastError || new Error('All IP sources failed');
    }
}

export default class NetIdentityExtension extends Extension {
    /**
     * @param {string} role
     * @param {import('resource:///org/gnome/shell/ui/panelMenu.js').Button} indicator
     */
    /**
     * @param {string} role
     * @param {import('resource:///org/gnome/shell/ui/panelMenu.js').Button} indicator
     * @param {number} [position]
     * @param {'left'|'center'|'right'} [box] center = near the clock
     */
    _addToPanel(role, indicator, position = 0, box = 'right') {
        const existing = Main.panel.statusArea[role];
        if (existing) {
            try {
                existing.destroy();
            } catch {
                // ignore
            }
            if (Main.panel.statusArea[role])
                delete Main.panel.statusArea[role];
        }
        Main.panel.addToStatusArea(role, indicator, position, box);
    }

    enable() {
        this._indicator = new NetIdentityIndicator();
        this._addToPanel(this.uuid, this._indicator, 0, 'right');
        this._indicator.start().catch(e => logError(e));
    }

    disable() {
        this._indicator?.destroy();
        this._indicator = null;
    }
}
