# Net Identity

GNOME Shell extension: top-panel **network identity** indicator (public IP, VPN/WireGuard/Tailscale, DNS, LAN).

## Features

- Public IP in the panel (auto-refresh every 5 minutes)
- VPN / WireGuard name detection via NetworkManager
- Tailscale up/down (connection name or `tailscale0`)
- DNS resolvers (NM, with `/etc/resolv.conf` fallback)
- Primary connection and LAN addresses
- Click a menu row to copy its value
- Desktop notification when the public IP changes

## Requirements

- GNOME Shell **45–50**
- NetworkManager
- Network access for optional public-IP lookup

## Install (local)

```bash
UUID=net-identity@n0l0g1c.github.io
mkdir -p ~/.local/share/gnome-shell/extensions
cp -a "$UUID" ~/.local/share/gnome-shell/extensions/
gnome-extensions enable "$UUID"
```

On Wayland, log out and back in so the shell discovers a newly copied UUID, then enable it.

## Network use

When refreshing the public IP, the extension may contact one of:

- `https://api.ipify.org`
- `https://ifconfig.me/ip`
- `https://icanhazip.com`

Responses are kept in memory for the session only. Local identity data comes from NetworkManager and `/etc/resolv.conf`. No accounts and no telemetry.

## Publish to extensions.gnome.org

Follows the [EGO review guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html):

| Requirement | How this extension complies |
|---|---|
| GPL-compatible license | GPL-2.0-or-later (`LICENSE`) |
| Lifecycle | Signals, Soup session, and timeouts cleaned up in `disable()` |
| Network disclosure | Declared in `metadata.json` description |
| No telemetry | IP echo only; nothing else leaves the machine |
| Zip contents | Runtime files only (`./pack.sh`) |

### Package for upload

```bash
./pack.sh
# produces: net-identity@n0l0g1c.github.io.shell-extension.zip
```

Upload the zip at [extensions.gnome.org](https://extensions.gnome.org/). The zip root must contain `metadata.json`.

## Development

```bash
cp -a net-identity@n0l0g1c.github.io \
  ~/.local/share/gnome-shell/extensions/
# Wayland: re-login after first install
journalctl -f /usr/bin/gnome-shell
```

## License

[GPL-2.0-or-later](LICENSE)

## Author

[N0L0g1c](https://github.com/N0L0g1c)
