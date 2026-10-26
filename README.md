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

## Ways to use it

| | What it does | Needs |
| --- | --- | --- |
| **[VPN mode](#vpn-mode)** `vpngate connect JP` | Sends all your computer's traffic through another country | OpenVPN, sudo |
| **[Proxy mode](#proxy-mode)** `vpngate proxy JP` | A local SOCKS5 proxy in another country. Only the requests you send through it use the VPN. Several countries can run at once. Countries VPN Gate lacks use [Tor](#any-country-with-tor) automatically. | Docker, no sudo |
| **[Browser](#browse-from-another-country)** `vpngate browser JP <url>` | Opens a separate browser window that browses from another country | Docker, no sudo |
| **[Check](#check-what-country-a-site-sees)** `vpngate check <url>` | Shows which country a site detects through a proxy | Docker |
| **[Claude Code plugin](#use-with-claude-code)** | Lets Claude test websites from other countries for you | Docker |

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/devnazir/vpngate-cli/main/install.sh | sh
```

The installer sets up everything:

- **OpenVPN**, using your package manager (Homebrew, apt, dnf, yum, pacman, zypper or apk)
- **Node.js**, only if you don't already have version 18 or newer. It downloads a private copy just for `vpngate`, so your system Node isn't touched.
- the **`vpngate`** command in `/usr/local/bin`

It asks for your password to install OpenVPN. On macOS you need [Homebrew](https://brew.sh). Works on macOS and Linux; Windows is not supported yet.

**To update**, run the same command again. **To uninstall:**

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

## Finding servers

```bash
vpngate countries            # which countries are online right now
vpngate list JP              # servers in Japan, best first
vpngate ip                   # your current public IP and country
```

`vpngate countries` lists VPN Gate and Tor together. Countries marked **(Tor)** have no VPN Gate servers right now, so proxy mode uses [Tor](#any-country-with-tor) for them automatically:

```
Code  Country            Servers  Fastest   Tor exits
JP    Japan              53       932 Mbps  4
KR    South Korea        34       895 Mbps  2
US    United States      3        391 Mbps  1008
NL    Netherlands (Tor)  -        -         613
DE    Germany (Tor)      -        -         342
...
```

Countries can be a code (`JP`) or the start of a name (`japan`).

## VPN mode

Routes all traffic on your computer through another country.

```bash
vpngate connect              # best server anywhere
vpngate connect KR           # best server in Korea
```

Press **Ctrl+C** to disconnect. You'll be asked for your password once, because creating a VPN tunnel needs admin rights. If the connection drops, `vpngate` switches to the next server automatically.

## Proxy mode

Runs the VPN inside a Docker container and gives you a local SOCKS5 proxy. The rest of your computer stays on your normal connection. You need [Docker](https://docs.docker.com/get-docker/) running, but not sudo or OpenVPN.

```bash
vpngate proxy JP                  # socks5://127.0.0.1:1080 exits in Japan
vpngate proxy KR --port 1081      # Korea at the same time, on another port
vpngate proxy status              # list running proxies
vpngate proxy stop                # stop all (or --port 1081 for one)
```

```
$ vpngate proxy JP
[1/5] Japan · public-vpn-202 219.100.37.197 tcp/443 · 161 Mbps
      ✓ Proxy ready  socks5://127.0.0.1:1080
      Exit IP 219.100.37.245 (Japan)
```

The command returns once the proxy works, and the proxy keeps running in the background until you stop it. Use it with anything that supports SOCKS5:

```bash
curl -x socks5h://127.0.0.1:1080 https://example.com
chromium --proxy-server=socks5://127.0.0.1:1080
```

Use `socks5h://` (with the `h`) in curl so DNS is resolved in the VPN country too.

The first run builds a small Docker image (Alpine with OpenVPN and the Dante SOCKS server), which takes a few seconds. The proxy only starts after the tunnel is up, so requests never go out over your real connection.

**Proxies recover by themselves.** Free servers drop now and then. When that happens, the proxy switches to the next server in the same country within a few seconds and keeps the same port, so whatever uses it keeps working. During the switch, requests fail rather than going out over your real connection. `vpngate proxy status` marks a proxy that switched with `(switched)`.

### Any country with Tor

VPN Gate mostly has Japan and Korea. When you ask for a country it doesn't have, such as the Netherlands, proxy mode switches to Tor automatically. Tor has exits in about 50 countries and needs no signup either:

```bash
vpngate proxy NL                  # no VPN Gate servers in NL, so this uses Tor
vpngate proxy germany --port 1081 # names work too
```

```
$ vpngate proxy NL
No VPN Gate servers in Netherlands, using Tor instead.
Tor · exits in Netherlands (can take up to a minute)
      ✓ Proxy ready  socks5://127.0.0.1:1080
      Exit IP 5.255.119.76 (Netherlands)
```

Tor takes 20 to 60 seconds to start, is slower than VPN Gate, and more sites block it or show CAPTCHAs. Countries with only a few Tor exits (see `vpngate countries`) may be slow or fail.

**Many sites can't see Tor's country.** Cloudflare reports every Tor exit as `T1` ("Tor") instead of a country, so sites that rely on Cloudflare's country lookup see no country at all, and their geo features don't change. `vpngate` warns you when this applies. Shopify's own geolocation is an exception and still detects the real country. Use [`vpngate check`](#check-what-country-a-site-sees) to see what a particular site detects.

To choose yourself, use `--via tor` to always use Tor, or `--via vpngate` to never fall back to it.

### Your own OpenVPN config

Have a `.ovpn` file from your own server or a VPN provider, such as [Proton VPN Free](https://protonvpn.com/free-vpn), which has Netherlands servers? Use it with either mode:

```bash
vpngate proxy --config ./nl.ovpn --auth ./login.txt
vpngate connect --config ./nl.ovpn --auth ./login.txt
```

`--auth` is only needed when the config asks for a username and password. Put the username on line 1 and the password on line 2. Proxy mode needs certificates inline in the `.ovpn` file, which is how most providers ship them.

## Check what country a site sees

An exit IP in the right country doesn't guarantee the site sees that country. `vpngate check` asks the site:

```bash
vpngate check https://www.allbirds.com            # through the proxy on port 1080
vpngate check https://www.allbirds.com --direct   # through your own connection, to compare
```

```
$ vpngate check https://www.allbirds.com
Checking https://www.allbirds.com through the Netherlands proxy on port 1080...
  Exit IP              192.42.116.16 (IP database: NL)
  Cloudflare sees      T1 (Tor, no country)
  Site                 HTTP 200  https://www.allbirds.com/  (Shopify, behind Cloudflare)
  Site edge sees       T1 (Tor, no country)
  Shopify geolocation  NL Netherlands
  Shopify market       US · USD · en-US

  ! Cloudflare sees Tor. Sites that use Cloudflare's country lookup see no country.
    Shopify's own geolocation still detected NL.
```

- **Exit IP:** where the proxy's IP is, according to an IP database.
- **Cloudflare sees / Site edge sees:** the country Cloudflare and the site's own edge detected. `T1` means Tor.
- **For Shopify stores:** Shopify's own geolocation (used by its Geolocation app) and the active market: country, currency and language.

Run it with `--port` to check a proxy on another port.

## Browse from another country

One command starts a proxy and opens a separate browser window that browses from that country. Your normal browser stays on your normal connection.

```bash
vpngate browser NL https://example.com
```

```
$ vpngate browser NL https://example.com
No VPN Gate servers in Netherlands, using Tor instead.
Tor · exits in Netherlands (can take up to a minute)
      ✓ Proxy ready  socks5://127.0.0.1:1080
      Exit IP 192.42.116.105 (Netherlands)
✓ Opened Chrome browsing from Netherlands → https://example.com
```

- **Compare countries side by side:** run it again with another country. Each one gets its own proxy on the next free port and its own window.
- **Reuses running proxies:** if a proxy for that country is already running, it opens a window on it instead of starting a new one.
- **Remembers things:** each country has its own browser profile, so logins and storefront passwords are kept between runs.
- **Pick a browser** with `--browser chrome|brave|edge|chromium|firefox` (Chrome by default).
- **Without a country**, `vpngate browser <url>` opens a window on the proxy already running on `--port` (default 1080).

When you're done, close the window and run `vpngate proxy stop`.

### Testing a Shopify theme from another country

Shopify decides the visitor's market from their IP, so open the **theme preview link** through the browser command:

```bash
vpngate browser NL "https://your-store.myshopify.com/?preview_theme_id=123456789"
```

For local development with `shopify theme dev`, use the preview link it prints, not `http://127.0.0.1:9292`. The local server fetches pages from Shopify using your own IP, so the proxy can't change the country there. The preview link shows your development theme and updates live as you edit.

## Options

| Option | What it does |
| --- | --- |
| `--port <n>` | Local port for `proxy` (default 1080). `browser` picks a free one. |
| `--direct` | For `check`: use your own connection instead of a proxy |
| `--browser <name>` | Browser for `browser`: chrome, brave, edge, chromium or firefox (default chrome) |
| `--via tor\|vpngate` | For `proxy`: force Tor or VPN Gate (by default, Tor is used only when VPN Gate lacks the country) |
| `--config <file>` | Use your own `.ovpn` file instead of VPN Gate |
| `--auth <file>` | Username and password for `--config` (line 1 and line 2) |
| `--proto tcp\|udp` | Only use servers with this protocol (almost all are TCP) |
| `--tries <n>` | How many servers to try before giving up (default 5) |
| `--timeout <sec>` | How long to wait for each server (default 20, Tor 90) |
| `--limit <n>` | Rows shown by `list` (default 20) |
| `--refresh` | Fetch a fresh server list (it's cached for 10 minutes) |
| `-v, --verbose` | Show OpenVPN's output, useful when connections keep failing |

## Use with Claude Code

This repo is also a Claude Code plugin. It teaches Claude to test websites from other countries, for example *"check whether the store redirects visitors from Japan"* or *"what currency does the pricing page show in Korea?"*. Install it from inside Claude Code:

```
/plugin install vpngate --marketplace devnazir/vpngate-cli
```

On older Claude Code versions:

```
/plugin marketplace add devnazir/vpngate-cli
/plugin install vpngate@vpngate
```

The plugin includes the CLI, so you only need Node.js 18+ and Docker; the installer above isn't required. Claude starts a proxy for the country, tests through it, and stops the proxy when it's done. It uses curl first, because redirects, currency and prices are usually decided on the server, and a real browser only when something appears after JavaScript runs. The instructions it follows are in [`skills/region-test/SKILL.md`](skills/region-test/SKILL.md).

### Give Claude a browser in another country (optional)

For things like geolocation popups, country selectors or screenshots, Claude needs a browser it can drive. Add a second Playwright MCP server that always goes through the proxy on port 1080:

```bash
claude mcp add playwright-geo -s user -- npx @playwright/mcp@latest --proxy-server socks5://127.0.0.1:1080 --isolated
```

Restart Claude Code afterwards. Then:

- **The country is whatever proxy runs on port 1080.** Claude runs `vpngate proxy NL` and browses with the `playwright-geo` tools. To switch, it runs `vpngate proxy DE`, which replaces the proxy on 1080, so no restart is needed.
- **Your normal `playwright` MCP server is untouched** and keeps working for local URLs like `http://127.0.0.1:9292`.
- **It never leaks your real IP.** If no proxy is running on 1080, pages in `playwright-geo` simply don't load.
- `--isolated` starts each session with a fresh profile, so cookies from one country don't carry over to the next.

Then ask something like *"open the theme preview from the Netherlands and Japan and screenshot the header"*.

## Use with Playwright

Any Playwright setup can use the proxy, because Playwright supports SOCKS5:

```js
// Script
const browser = await chromium.launch({ proxy: { server: 'socks5://127.0.0.1:1080' } });
```

```ts
// playwright.config.ts: run the same tests from several countries
projects: [
  { name: 'NL', use: { proxy: { server: 'socks5://127.0.0.1:1080' } } },
  { name: 'JP', use: { proxy: { server: 'socks5://127.0.0.1:1081' } } },
],
```

Start the matching proxies first, for example `vpngate proxy NL` and `vpngate proxy JP --port 1081`.

## Is it safe?

The OpenVPN software is secure. **The servers are run by volunteers you don't know**, so:

- ✅ Fine for: browsing HTTPS sites, region-locked content, testing public pages.
- ❌ Not for: banking, important logins, or anything where you need real privacy or anonymity.
- Tor exits are also run by volunteers, with the same rules: only use HTTPS and don't log in to anything important.
- The server operator can see which sites you visit and anything not using HTTPS. VPN Gate also keeps connection logs.
- If your browser shows a **certificate warning while connected, disconnect**.
- In VPN mode on macOS, DNS lookups may not go through the VPN. Turn on DNS over HTTPS in your browser for better privacy. Proxy mode doesn't have this problem.

## Limits

- No data cap or time limit, but speed depends on the volunteer server.
- Most VPN Gate servers are in Japan and Korea. Other countries come and go; check `vpngate countries`. Proxy mode uses Tor for the rest.
- Servers can disappear at any time. Just run the command again to get another one.
- VPN Gate IPs are shared by many people, so some sites block them or show CAPTCHAs, and most streaming services won't work.

## Credits

All servers are provided by the [VPN Gate Academic Experiment](https://www.vpngate.net). This project is not affiliated with VPN Gate. Please use it responsibly and follow [their terms](https://www.vpngate.net/en/about_abuse.aspx).

## License

MIT
