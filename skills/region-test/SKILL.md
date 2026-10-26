---
name: region-test
description: Test a website or API as if the request came from another country (Japan, Korea, US, ...) through a free VPN Gate proxy. Use when asked to check geo-redirects, geo-blocking, localized prices or currency, language detection, cookie/consent banners, CDN or edge behavior per country, or "how does this look from <country>".
---

# Testing from another country

`vpngate proxy` starts a SOCKS5 proxy on localhost whose traffic exits in the chosen country. It
runs in Docker, needs no sudo, and only affects requests you explicitly send through it, so your
own connection is untouched.

## 1. Find the CLI

Run the CLI bundled with this plugin, which always matches these instructions: it is at
`bin/vpngate.js` two directories above this skill's base directory, so call
`node <base>/../../bin/vpngate.js`. Don't use a `vpngate` found on PATH, which may be an older
version without `proxy`. Below, `vpngate` means the bundled CLI.

Requirements: Node.js 18+ and Docker running. If `vpngate proxy status` says Docker is not
running, ask the user to start Docker. Do not try to install Docker yourself.

## 2. Pick a country and start the proxy

```bash
vpngate countries                 # what is online right now (mostly JP and KR, others vary)
vpngate proxy JP                  # socks5://127.0.0.1:1080, returns once the proxy works
vpngate proxy US --port 1081      # another country at the same time, on another port
```

The command tries up to 5 servers and exits 0 when the proxy is ready, printing the exit IP and
country. It takes 5-30 seconds. If the country you need isn't listed, tell the user. Do not
substitute another country silently.

## 3. Test through the proxy

Always use `socks5h://` (with the `h`) so DNS is resolved in the VPN country too.

```bash
# Confirm where you appear to be
curl -s -x socks5h://127.0.0.1:1080 https://www.cloudflare.com/cdn-cgi/trace | grep loc

# Redirects and headers (geo-redirects, Vary, Set-Cookie, cache headers)
curl -sI -L -x socks5h://127.0.0.1:1080 https://example.com

# Page content, e.g. which currency is shown
curl -sL -x socks5h://127.0.0.1:1080 https://example.com | grep -o 'JPY\|¥[0-9,]*' | head
```

For a real browser (JavaScript, consent banners, client-side redirects), write a short
Playwright script and launch Chromium with the proxy:

```js
const browser = await chromium.launch({ proxy: { server: 'socks5://127.0.0.1:1080' } });
```

An already running Playwright MCP browser cannot switch proxies, so use a script for this.

Geolocation by IP and language are separate things. Sites often decide language from the
`Accept-Language` header, so send it if you want to simulate a real local visitor, for example
`-H 'Accept-Language: ja-JP,ja;q=0.9'`. Report which of the two caused a difference.

## 4. Stop when done

```bash
vpngate proxy stop                # all proxies
vpngate proxy stop --port 1081    # just one
```

Always stop the proxies you started before finishing the task, even if the test failed.

## Things to keep in mind

- **VPN Gate IPs are shared and often flagged.** A 403, CAPTCHA or "unusual traffic" page may be
  the site blocking VPN traffic, not a bug in the site under test. Say so in your report rather
  than calling it a regression.
- **The servers are run by unknown volunteers.** Never send credentials, API keys, session
  cookies or personal data through the proxy. Testing public pages is fine.
- Servers can drop. If requests start failing, check `vpngate proxy status` and start a new proxy.
- Run `vpngate proxy JP -v` to see OpenVPN output when a connection keeps failing.
