# vpngate-cli

Free VPN from your terminal. No signup, no account, multiple countries.

```
$ vpngate connect JP
[1/5] Japan · public-vpn-187 219.100.37.179 tcp/443 · 221 Mbps
      ✓ Connected
      Your IP is now 219.100.37.179 (Japan)
      Press Ctrl+C to disconnect
```

It uses the public server list from [VPN Gate](https://www.vpngate.net), an academic project at the University of Tsukuba in Japan. Volunteers around the world run the servers. `vpngate` picks the best server, connects with OpenVPN and moves on to the next server automatically if one is down.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/devnazir/vpngate-cli/main/install.sh | sh
```

The installer sets up everything:

- **OpenVPN**, using your package manager (Homebrew, apt, dnf, yum, pacman, zypper or apk)
- **Node.js**, only if you don't already have version 18 or newer. It downloads a private copy just for `vpngate`, so your system Node isn't touched.
- the **`vpngate`** command in `/usr/local/bin`

It asks for your password to install OpenVPN. On macOS you need [Homebrew](https://brew.sh). Windows is not supported yet.

To uninstall:

```bash
curl -fsSL https://raw.githubusercontent.com/devnazir/vpngate-cli/main/install.sh | sh -s -- --uninstall
```

<details>
<summary>Manual install</summary>

Install **Node.js 18+** and **OpenVPN** (`brew install openvpn` or `sudo apt install openvpn`), then:

```bash
git clone https://github.com/devnazir/vpngate-cli.git
cd vpngate-cli
npm link
```

</details>

## Usage

```bash
vpngate countries            # which countries are available right now
vpngate list JP              # servers in Japan, best first
vpngate connect              # connect to the best server anywhere
vpngate connect KR           # connect to Korea
vpngate connect japan        # country names work too
vpngate ip                   # check your current IP and location
```

Press **Ctrl+C** to disconnect.

You'll be asked for your password once, because creating a VPN tunnel needs admin rights.

| Option | What it does |
| --- | --- |
| `--proto tcp\|udp` | Only use servers with this protocol |
| `--tries <n>` | How many servers to try before giving up (default 5) |
| `--timeout <sec>` | How long to wait for each server (default 20) |
| `--limit <n>` | Rows shown by `list` (default 20) |
| `--refresh` | Fetch a fresh server list (it's cached for 10 minutes) |
| `-v, --verbose` | Show OpenVPN's output |

## Proxy mode (no sudo, multiple countries at once)

`vpngate proxy` runs the VPN inside a Docker container and gives you a local SOCKS5 proxy. Only requests you send through the proxy use the VPN, and the rest of your computer stays on your normal connection. You need [Docker](https://docs.docker.com/get-docker/), but not sudo or OpenVPN.

```bash
vpngate proxy JP                  # socks5://127.0.0.1:1080 exits in Japan
vpngate proxy KR --port 1081      # Korea at the same time on another port
vpngate proxy status              # list running proxies
vpngate proxy stop                # stop all (or --port 1081 for one)
```

```
$ vpngate proxy JP
[1/5] Japan · public-vpn-202 219.100.37.197 tcp/443 · 161 Mbps
      ✓ Proxy ready  socks5://127.0.0.1:1080
      Exit IP 219.100.37.245 (Japan)
```

Use it with anything that supports SOCKS5:

```bash
curl -x socks5h://127.0.0.1:1080 https://example.com
chromium --proxy-server=socks5://127.0.0.1:1080
```

The first run builds a small Docker image (Alpine with OpenVPN and the Dante SOCKS server), which takes a few seconds. The proxy only starts after the tunnel is up, and DNS goes through the tunnel too, so requests never go out over your real connection.

## Use with Claude Code

This repo is also a Claude Code plugin. It teaches Claude to test websites from other countries, for example *"check whether the store redirects visitors from Japan"*. Install it from inside Claude Code:

```
/plugin install vpngate --marketplace devnazir/vpngate-cli
```

On older Claude Code versions:

```
/plugin marketplace add devnazir/vpngate-cli
/plugin install vpngate@vpngate
```

The plugin includes the CLI, so you only need Node.js 18+ and Docker. Claude starts a proxy for the country, tests through it with curl or a Playwright browser, and stops the proxy when it's done. The instructions it follows are in [`skills/region-test/SKILL.md`](skills/region-test/SKILL.md).

## Is it safe?

The OpenVPN software is secure. **The servers are run by volunteers you don't know**, so:

- ✅ Fine for: everyday browsing on HTTPS sites, accessing region-locked content.
- ❌ Not for: banking, important logins, or anything where you need real privacy or anonymity.
- The server operator can see which sites you visit and anything not using HTTPS. VPN Gate also keeps connection logs.
- If your browser shows a **certificate warning while connected, disconnect**.
- Your DNS lookups may not go through the VPN. Turn on DNS over HTTPS in your browser for better privacy.

## Limits

- No data cap or time limit, but speed depends on the volunteer server.
- Most servers are in Japan and Korea. Other countries come and go.
- Servers can disappear at any time. Just run `connect` again.

## Credits

All servers are provided by the [VPN Gate Academic Experiment](https://www.vpngate.net). This project is not affiliated with VPN Gate. Please use it responsibly and follow [their terms](https://www.vpngate.net/en/about_abuse.aspx).

## License

MIT
