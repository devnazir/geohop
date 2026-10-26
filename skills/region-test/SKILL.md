---
name: region-test
description: Test a website or API as if the request came from another country (Japan, Korea, US, ...) through a free VPN Gate proxy. Use when asked to check geo-redirects, geo-blocking, localized prices or currency, language detection, cookie/consent banners, CDN or edge behavior per country, or "how does this look from <country>".
---

# Testing from another country

`geohop proxy` starts a SOCKS5 proxy on localhost whose traffic exits in the chosen country. It
runs in Docker, needs no sudo, and only affects requests you explicitly send through it, so your
own connection is untouched.

## 1. Find the CLI

Run the CLI bundled with this plugin, which always matches these instructions: it is at
`bin/geohop.js` two directories above this skill's base directory, so call
`node <base>/../../bin/geohop.js`. Don't use a `geohop` found on PATH, which may be an older
version without `proxy`. Below, `geohop` means the bundled CLI.

Requirements: Node.js 18+ and Docker running. If `geohop proxy status` says Docker is not
running, ask the user to start Docker. Do not try to install Docker yourself.

## 2. Pick a country and start the proxy

```bash
geohop countries                 # countries online now; "(Tor)" marks Tor-only countries
geohop proxy JP                  # socks5://127.0.0.1:1080, returns once the proxy works
geohop proxy US --port 1081      # another country at the same time, on another port
```

The command tries up to 5 servers and exits 0 when the proxy is ready, printing the exit IP and
country. It takes 5-30 seconds.

**Countries marked `(Tor)`** have no VPN Gate servers. `geohop proxy <country>` uses Tor for
them automatically and prints "using Tor instead". Tor takes 20-60 seconds to start.

**Tor results are often invalid.** Cloudflare reports Tor exits as country `T1`, so any site that
detects the country through Cloudflare sees no country at all, and geo features silently don't
trigger. The CLI prints a warning when this applies. Shopify is an exception for its own
geolocation, which still detects the real country over Tor. Always run `geohop check` (step 3)
and only report results if the site actually sees the intended country. Otherwise tell the user
Tor can't test this site, and consider simulating the country (step 3).

Tor is also slower and blocked or CAPTCHA'd by more sites than VPN Gate. Countries with only a few
Tor exits (the "Tor exits" column) may be slow or fail. If a country isn't listed at all, or the
proxy fails, tell the user. Do not substitute another country silently.

**If the user has their own OpenVPN config** (their own server or a provider like Proton VPN),
use it instead. It is faster and more reliable than both:

```bash
geohop proxy --config ./nl.ovpn --auth ./login.txt   # --auth only if the config needs a login
```

Only use config and login files the user points you to.

## 3. Test through the proxy

**First, confirm which country the site detects.** An exit IP in the right country is not
enough, so run this before testing anything else:

```bash
geohop check https://example.com              # through the proxy on port 1080
geohop check https://example.com --port 1081  # another proxy
geohop check https://example.com --direct     # the user's own connection, for comparison
```

It shows the exit IP, what Cloudflare sees, the site's final URL and status and, for Shopify
stores, Shopify's own geolocation and the active market (country, currency, locale). If the
site's detected country isn't the one you want, stop and tell the user rather than reporting
results for the wrong country.

Then test. Always use `socks5h://` (with the `h`) so DNS is resolved in the VPN country too.

```bash

# Redirects and headers (geo-redirects, Vary, Set-Cookie, cache headers)
curl -sI -L -x socks5h://127.0.0.1:1080 https://example.com

# Page content, e.g. which currency is shown
curl -sL -x socks5h://127.0.0.1:1080 https://example.com | grep -o 'JPY\|¥[0-9,]*' | head
```

Start with curl. Redirects, currency and prices in the HTML, and headers are decided on the
server, so curl usually answers the question and can check several countries in parallel.

### When no real IP is available: simulate the country

If a country has no working proxy, or the site can't see the proxy's country (Tor and
Cloudflare), you can often still test the site's *reaction* to a country. Many sites decide
client-side, from a geo API they call (for example `/api/geo-market` returning
`{"market":"en","country":"NL"}`):

1. Find how the site detects the country. Look at the network requests in the browser, or search
   its JavaScript for the geo call and the logic that uses it.
2. Learn the real response format from a country you *can* reach (or `--direct`).
3. In the browser, intercept that request and answer with the country you want, for example with
   Playwright: `await page.route('**/api/geo-market', r => r.fulfill({ json: { market: 'en', country: 'NL' } }))`.
   With `playwright-geo`, use its run-code tool for this.
4. Clearly label these results as **simulated** in your report, and say which values you assumed.

This only works when the decision happens in the browser. Server-side redirects and prices (such
as Shopify Markets) can't be simulated this way. Don't fake the visitor's location in other ways,
such as headers that pretend to come from a CDN.

### When you need a real browser

Use a browser only for things that appear after JavaScript runs: geolocation popups, country
selectors, consent banners, client-side redirects, or when the user wants screenshots.

**If a `playwright-geo` MCP server is available** (tools named `mcp__playwright-geo__*`), use it.
Its browser always goes through `socks5://127.0.0.1:1080`, so the country is whatever proxy runs
on port 1080:

1. Start the country on port 1080: `geohop proxy NL`. This replaces any proxy already on 1080.
2. Use the `playwright-geo` tools to navigate, snapshot, click and screenshot.
3. To switch country, run `geohop proxy DE` (it swaps the proxy on 1080), then navigate again.
4. If its pages fail to load, the proxy on 1080 isn't running. It never falls back to the real IP.

Use the normal `playwright` MCP server for everything else, such as local URLs. It doesn't go
through the proxy.

**If there is no `playwright-geo` server**, write a short Playwright script instead:

```js
const browser = await chromium.launch({ proxy: { server: 'socks5://127.0.0.1:1080' } });
```

The normal `playwright` MCP browser can't switch to a proxy. Don't use it for region tests. If the
user wants a browser Claude can drive, suggest adding `playwright-geo`:
`claude mcp add playwright-geo -s user -- npx @playwright/mcp@latest --proxy-server socks5://127.0.0.1:1080 --isolated`

Geolocation by IP and language are separate things. Sites often decide language from the
`Accept-Language` header, so send it if you want to simulate a real local visitor, for example
`-H 'Accept-Language: ja-JP,ja;q=0.9'`. Report which of the two caused a difference.

If the user wants to look at it themselves, open a separate browser window for them that
browses from the country (it starts or reuses the proxy):

```bash
geohop browser NL "https://example.com"
```

## 4. Stop when done

```bash
geohop proxy stop                # all proxies
geohop proxy stop --port 1081    # just one
```

Always stop the proxies you started before finishing the task, even if the test failed.

## Things to keep in mind

- **VPN Gate IPs are shared and often flagged.** A 403, CAPTCHA or "unusual traffic" page may be
  the site blocking VPN traffic, not a bug in the site under test. Say so in your report rather
  than calling it a regression.
- **The servers are run by unknown volunteers.** Never send credentials, API keys, session
  cookies or personal data through the proxy. Testing public pages is fine.
- Servers can drop. A VPN Gate proxy switches to the next server by itself after a few seconds,
  on the same port, and requests fail (never leak) during the switch. `geohop proxy status` shows
  `(switched)` when this happened. Re-run `geohop check` after a switch, and if the proxy is gone
  start a new one.
- Run `geohop proxy JP -v` to see OpenVPN output when a connection keeps failing.
