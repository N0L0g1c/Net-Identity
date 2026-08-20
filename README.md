# Net Identity

GNOME Shell extension showing public IP, VPN/WireGuard/Tailscale, DNS, and LAN info in the top panel.

![Screenshot](screenshots/screenshot.png)

## Features

- Public IP in the panel (refresh every 5 minutes)
- VPN / WireGuard detection via NetworkManager
- Tailscale up/down (connection name or `tailscale0`)
- DNS resolvers (NM, falls back to `/etc/resolv.conf`)
- Primary connection and LAN addresses
- Click a menu row to copy its value
- Notification when the public IP changes

## Requirements

- GNOME Shell **45–50**
- NetworkManager
- Network access for public-IP lookup

## Install

```bash
UUID=net-identity@n0l0g1c.github.io
mkdir -p ~/.local/share/gnome-shell/extensions
cp -a "$UUID" ~/.local/share/gnome-shell/extensions/
gnome-extensions enable "$UUID"
```

Log out/in on Wayland (or restart GNOME Shell) so the extension is picked up.

## Network use

Public IP lookups may hit one of:

- `https://api.ipify.org`
- `https://ifconfig.me/ip`
- `https://icanhazip.com`

Responses stay in memory for the session. Local data comes from NetworkManager and `/etc/resolv.conf`. No accounts, no telemetry.

## Packaging

```bash
./pack.sh
# → net-identity@n0l0g1c.github.io.shell-extension.zip
```

## License

[GPL-2.0-or-later](LICENSE). Copyright © 2026 [Vassbrekke AS](https://www.vassbrekke.no). See [COPYRIGHT](COPYRIGHT).

Source: https://github.com/Vassbrekke/Net-Identity
