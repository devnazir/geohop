#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { bold, cyan, dim, green, mbps, red, table, yellow } from '../src/format.js';
import { filterServers, getServers, groupByCountry } from '../src/servers.js';
import { getTorExitCounts } from '../src/tor.js';
import { browserLabel, browserNames, openBrowser } from '../src/browser.js';
import { checkSite } from '../src/check.js';
import { loadCustomConfig } from '../src/custom.js';
import {
  buildImage,
  checkProxy,
  containerName,
  currentServer,
  dockerStatus,
  hasImage,
  imageTag,
  listProxies,
  removeProxy,
  startProxy,
  startTorProxy,
} from '../src/proxy.js';
import {
  authorizeSudo,
  findOpenVPN,
  needsSudo,
  startTunnel,
  stopTunnel,
  waitForExit,
  writeConfig,
} from '../src/openvpn.js';

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const HELP = `${bold('geohop')} ${dim(`v${version}`)} - test websites from other countries. Free, no signup.

${bold('Usage')}
  geohop connect [country]   Connect to the best server (optionally in a country)
  geohop countries           List available countries
  geohop list [country]      List servers, best first
  geohop ip                  Show your current public IP and location

  geohop proxy [country]     Start a SOCKS5 proxy that exits in a country (needs Docker, no sudo)
  geohop proxy status        List running proxies
  geohop proxy stop          Stop proxies (all, or the one on --port)

  geohop check <url>         Show which country a site detects through the proxy on --port
                              (default 1080), or with --direct, through your own connection

  geohop browser [country] [url]
                              Open a separate browser window that browses from a country.
                              Starts (or reuses) a proxy for it. Without a country, uses the
                              proxy already running on --port.

${bold('Options')}
  --via <tor|vpngate> For "proxy": force Tor or VPN Gate. By default, countries without
                      VPN Gate servers use Tor automatically.
  --config <file>     Use your own .ovpn file instead of VPN Gate (connect or proxy)
  --auth <file>       Username and password for --config (line 1 and line 2)
  --proto <tcp|udp>   Only use servers with this protocol
  --tries <n>         Servers to try before giving up (default 5)
  --timeout <sec>     Seconds to wait for each server (default 20, Tor 90)
  --limit <n>         Rows to show in "list" (default 20)
  --port <n>          Local port for "proxy" (default 1080; "browser" picks a free one)
  --browser <name>    For "browser": ${browserNames.join(', ')} (default chrome)
  --refresh           Ignore the cached server list
  -v, --verbose       Show OpenVPN output
  -h, --help          Show this help

${bold('Examples')}
  geohop connect JP
  geohop connect korea --proto udp
  geohop list US
  geohop proxy JP && curl -x socks5h://127.0.0.1:1080 https://example.com
  geohop proxy NL                (no VPN Gate servers, so this uses Tor)
  geohop proxy --config ./nl.ovpn --auth ./nl-login.txt
  geohop browser NL https://example.myshopify.com/?preview_theme_id=123
  geohop check https://example.com

Country can be a code (JP) or the start of a name (japan).
Servers are run by volunteers via VPN Gate (https://www.vpngate.net).
Don't use them for banking or anything sensitive.`;

const fail = (message) => {
  console.error(red(`✗ ${message}`));
  process.exit(1);
};

let parsed;
try {
  parsed = parseArgs({
    allowPositionals: true,
    options: {
      proto: { type: 'string' },
      via: { type: 'string' },
      config: { type: 'string' },
      auth: { type: 'string' },
      tries: { type: 'string', default: '5' },
      timeout: { type: 'string' },
      limit: { type: 'string', default: '20' },
      port: { type: 'string' },
      browser: { type: 'string' },
      direct: { type: 'boolean', default: false },
      refresh: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
  });
} catch (err) {
  fail(`${err.message}\n  Run "geohop --help" for usage.`);
}
const { values: opts, positionals } = parsed;
const [command = 'help', countryArg] = positionals;

async function loadServers() {
  const { servers, stale } = await getServers({ refresh: opts.refresh });
  if (stale) console.error(yellow('! VPN Gate is unreachable, using an older cached server list'));
  return servers;
}

async function matchingServers(country = countryArg) {
  if (opts.proto && !['tcp', 'udp'].includes(opts.proto)) fail('--proto must be tcp or udp');
  return filterServers(await loadServers(), { country, proto: opts.proto });
}

async function selectServers(country = countryArg) {
  const servers = await matchingServers(country);
  if (servers.length === 0) {
    const torHint = country
      ? `\n  It may be available through Tor, which works in proxy mode: geohop proxy ${country}`
      : '';
    fail(`No VPN Gate servers found${country ? ` for "${country}"` : ''}. Run "geohop countries" to see what's available.${torHint}`);
  }
  return servers;
}

// Resolves a country code or name ("nl", "netherlands") to a code with running Tor exits.
// Returns null if Tor has no exits there. Trusts any two-letter code if the exit list is unavailable.
async function resolveTorCountry(query) {
  const q = query.toLowerCase();
  const exits = await getTorExitCounts({ refresh: opts.refresh });
  if (!exits) return /^[a-z]{2}$/.test(q) ? q.toUpperCase() : null;
  const codes = [...exits.keys()];
  // Exact codes win over name prefixes, so "in" is India rather than Indonesia.
  return (
    codes.find((code) => code.toLowerCase() === q) ??
    codes.find((code) => countryName(code).toLowerCase().startsWith(q)) ??
    null
  );
}

async function loadCustom({ forProxy }) {
  const server = await loadCustomConfig(opts.config, opts.auth);
  if (forProxy && server.usesExternalFiles) {
    fail(
      `${opts.config} refers to separate certificate or key files. Proxy mode needs them inline ` +
        'in the .ovpn file. Inline them, or use "geohop connect --config" instead.',
    );
  }
  return server;
}

async function candidateServers({ forProxy, country = countryArg }) {
  if (opts.auth && !opts.config) fail('--auth only works together with --config');
  if (opts.config) return [await loadCustom({ forProxy })];
  return (await selectServers(country)).slice(0, Math.max(1, Number(opts.tries) || 5));
}

const countryNames = new Intl.DisplayNames(['en'], { type: 'region' });
const countryName = (code) => {
  try {
    return countryNames.of(code);
  } catch {
    return code;
  }
};

// Cloudflare's trace endpoint has no rate limit, unlike most IP APIs, which matters on shared VPN IPs.
async function lookupIp() {
  try {
    const res = await fetch('https://www.cloudflare.com/cdn-cgi/trace', { signal: AbortSignal.timeout(8_000) });
    const trace = Object.fromEntries((await res.text()).split('\n').map((l) => l.split('=')));
    return { ip: trace.ip, country: trace.loc };
  } catch {
    return null;
  }
}

const describe = (s) =>
  `${s.country} · ${s.host} ${dim(`${s.ip} ${s.proto}/${s.port}${s.speed ? ` · ${mbps(s.speed)}` : ''}`)}`;

async function cmdCountries() {
  const [groups, torExits] = await Promise.all([
    loadServers().then(groupByCountry),
    getTorExitCounts({ refresh: opts.refresh }),
  ]);
  const rows = groups.map((g) => [
    cyan(g.code),
    countryName(g.code),
    g.count,
    mbps(g.bestSpeed),
    torExits?.get(g.code) ?? '-',
  ]);
  // Countries only reachable through Tor, most exits first.
  const vpngateCodes = new Set(groups.map((g) => g.code));
  const torOnly = [...(torExits ?? [])]
    .filter(([code]) => !vpngateCodes.has(code))
    .sort((a, b) => b[1] - a[1]);
  for (const [code, exits] of torOnly) {
    rows.push([cyan(code), `${countryName(code)} ${yellow('(Tor)')}`, '-', '-', exits]);
  }

  console.log(table(['Code', 'Country', 'Servers', 'Fastest', 'Tor exits'], rows));
  if (torExits) {
    console.log(dim(`\n(Tor) countries work with proxy mode only and use Tor automatically: geohop proxy <code>`));
    console.log(dim(`Sites that detect country through Cloudflare can't see Tor's country, so geo tests may not work there.`));
  } else {
    console.error(yellow('\n! Could not load the Tor exit list, showing VPN Gate countries only'));
  }
}

async function cmdList() {
  const servers = (await selectServers()).slice(0, Number(opts.limit) || 20);
  const rows = servers.map((s, i) => [
    i + 1,
    cyan(s.countryCode),
    s.host,
    s.ip,
    `${s.proto}/${s.port}`,
    s.ping ? `${s.ping} ms` : '-',
    mbps(s.speed),
    s.sessions,
  ]);
  console.log(table(['#', 'CC', 'Host', 'IP', 'Proto', 'Ping', 'Speed', 'Users'], rows));
}

async function cmdIp() {
  const info = await lookupIp();
  if (!info?.ip) fail('Could not look up your IP');
  console.log(`${bold(info.ip)}  ${countryName(info.country)}`);
}

async function cmdConnect() {
  const openvpn = findOpenVPN();
  if (!openvpn) {
    fail(
      'OpenVPN is not installed.\n' +
        '  macOS:         brew install openvpn\n' +
        '  Debian/Ubuntu: sudo apt install openvpn\n' +
        '  Fedora:        sudo dnf install openvpn',
    );
  }

  if (opts.via === 'tor') fail('Tor works only with "geohop proxy <country> --via tor"');
  const candidates = await candidateServers({ forProxy: false });
  const timeoutMs = (Number(opts.timeout) || 20) * 1000;
  const sudo = needsSudo();
  if (sudo) {
    console.log(dim('OpenVPN needs admin rights to create the network tunnel.'));
    if (!authorizeSudo()) fail('sudo authorization failed');
  }

  let stopping = false;
  let current = null;
  process.on('SIGINT', () => {
    if (stopping) process.exit(130);
    stopping = true;
    if (current) stopTunnel(current);
  });

  const onLog = opts.verbose ? (line) => console.log(dim(`  ${line}`)) : undefined;

  for (const [i, server] of candidates.entries()) {
    if (stopping) break;
    console.log(`${dim(`[${i + 1}/${candidates.length}]`)} ${describe(server)}`);
    const config = await writeConfig(server);
    try {
      const result = await startTunnel(openvpn, config.file, { sudo, timeoutMs, onLog, cwd: server.dir });
      if (!result.ok) {
        if (!stopping) console.log(`      ${red('✗')} ${result.reason}`);
        continue;
      }
      current = result.child;
      console.log(`      ${green('✓ Connected')}`);
      const info = await lookupIp();
      if (info?.ip) console.log(`      Your IP is now ${bold(info.ip)} (${countryName(info.country)})`);
      console.log(dim('      Press Ctrl+C to disconnect'));
      await waitForExit(current);
      current = null;
      if (!stopping) console.log(yellow('! Connection lost, trying the next server'));
    } finally {
      await config.cleanup();
    }
  }

  if (stopping) {
    console.log('Disconnected.');
    process.exit(0);
  }
  fail('Could not connect to any server. Try another country, --proto tcp, or --refresh.');
}

function cmdProxyStatus() {
  const proxies = listProxies();
  if (proxies.length === 0) return console.log('No proxies running.');
  const rows = proxies.map((p) => {
    const started = `${p.server} ${p.ip}`.trim();
    const current = p.state === 'running' && p.server !== 'tor' ? currentServer(p.name) : null;
    const server = current && current !== started ? `${current} ${yellow('(switched)')}` : `${p.server} ${dim(p.ip)}`;
    return [
    `socks5://127.0.0.1:${p.port}`,
    cyan(p.country),
    server,
    p.state === 'running' ? green('running') : red(p.state),
    p.age,
  ];
  });
  console.log(table(['Proxy', 'CC', 'Server', 'State', 'Started'], rows));
}

function cmdProxyStop() {
  const proxies = listProxies().filter((p) => !opts.port || p.port === Number(opts.port));
  for (const p of proxies) {
    removeProxy(p.name);
    console.log(`Stopped proxy on port ${p.port} (${p.country})`);
  }
  if (proxies.length === 0) console.log('No proxies to stop.');
}

// Verifies the proxy end to end and prints how to use it. Returns false if it doesn't work.
// Many sites geolocate visitors with Cloudflare, which reports Tor exits as "T1" instead of a
// country, so geo features silently don't trigger. Found on urbanarrow.com: country = null.
const TOR_GEO_WARNING = [
  '! Tor: Cloudflare sees this exit as "T1" (Tor), not a country.',
  '  Sites that use Cloudflare to detect the country will see no country, so',
  '  geo redirects, banners and prices may not change. Check the site\'s own geo',
  '  detection before trusting results, or use a VPN Gate country or --config.',
];
const warnTor = () => console.log(yellow(TOR_GEO_WARNING.map((l) => `      ${l}`).join('\n')));

async function reportProxy(port, expectedCountry) {
  // Slow servers sometimes miss the first check even though the tunnel works.
  let exit = null;
  for (let attempt = 1; attempt <= 3 && !exit; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, 3000));
    exit = await checkProxy(port);
  }
  if (!exit) {
    removeProxy(containerName(port));
    console.log(`      ${red('✗')} tunnel is up but the proxy is not reachable`);
    return false;
  }
  console.log(`      ${green('✓ Proxy ready')}  ${bold(`socks5://127.0.0.1:${port}`)}`);
  if (exit.ip) console.log(`      Exit IP ${bold(exit.ip)} (${exit.country ? countryName(exit.country) : 'unknown country'})`);
  if (expectedCountry && exit.country && exit.country !== expectedCountry) {
    console.log(yellow(`      ! Expected ${expectedCountry} but the exit is in ${exit.country}`));
  }
  if (exit.cloudflareSeesTor) warnTor();
  console.log(dim(`      curl -x socks5h://127.0.0.1:${port} https://example.com`));
  console.log(dim(`      Stop it with: geohop proxy stop${port === 1080 ? '' : ` --port ${port}`}`));
  return true;
}

function requireDocker() {
  const status = dockerStatus();
  if (status === 'missing') fail('Proxy mode needs Docker. Install it from https://docs.docker.com/get-docker/');
  if (status === 'stopped') fail('Docker is not running. Start Docker and try again.');
}

async function cmdProxy() {
  requireDocker();
  if (countryArg === 'status') return cmdProxyStatus();
  if (countryArg === 'stop') return cmdProxyStop();
  await launchProxy(countryArg, Number(opts.port) || 1080);
}

// Starts a proxy for `country` (code or name) on `port` and returns the country code it exits in
// ("custom" for --config). Exits the process on failure.
async function launchProxy(country, port) {
  if (opts.via && !['vpngate', 'tor'].includes(opts.via)) fail('--via must be vpngate or tor');
  if (opts.via === 'tor' && opts.config) fail('--via tor and --config cannot be combined');
  if (opts.via === 'tor' && !country) fail('Tor needs a country, for example: geohop proxy NL --via tor');

  // Decide between VPN Gate and Tor before building anything, so a missing country fails fast.
  // Without --via, countries VPN Gate doesn't have fall back to Tor automatically.
  let torCountry = null;
  let candidates = [];
  if (opts.via === 'tor') {
    torCountry = await resolveTorCountry(country);
    if (!torCountry) fail(`Tor has no exits in "${country}" right now. Run "geohop countries" to see what's available.`);
  } else if (opts.config || !country || opts.via === 'vpngate') {
    candidates = await candidateServers({ forProxy: true, country });
  } else if ((await matchingServers(country)).length > 0) {
    candidates = await candidateServers({ forProxy: true, country });
  } else {
    torCountry = await resolveTorCountry(country);
    if (!torCountry) fail(`"${country}" isn't available on VPN Gate or Tor right now. Run "geohop countries" to see what's available.`);
    console.log(dim(`No VPN Gate servers in ${countryName(torCountry)}, using Tor instead.`));
  }
  const tor = torCountry !== null;
  const kind = tor ? 'tor' : 'openvpn';
  const image = imageTag(kind, version);
  if (!hasImage(image)) {
    console.log(dim(`Building the ${kind} proxy image (first run only)...`));
    buildImage(kind, image);
  }

  const timeoutMs = (Number(opts.timeout) || (tor ? 90 : 20)) * 1000;
  const onLog = opts.verbose ? (line) => console.log(dim(`  ${line}`)) : undefined;

  // A half-started container would otherwise keep running after Ctrl+C.
  process.on('SIGINT', () => {
    removeProxy(containerName(port));
    process.exit(130);
  });

  if (tor) {
    console.log(`Tor · exits in ${countryName(torCountry)} ${dim('(can take up to a minute)')}`);
    const result = await startTorProxy(torCountry, { image, port, timeoutMs, onLog });
    if (!result.ok) fail(result.reason);
    if (!(await reportProxy(port, torCountry))) {
      fail(`Tor started but couldn't reach the internet. There may be no Tor exits in ${torCountry} right now.`);
    }
    return torCountry;
  }

  for (const [i, server] of candidates.entries()) {
    console.log(`${dim(`[${i + 1}/${candidates.length}]`)} ${describe(server)}`);
    // Servers not tried yet become fallbacks the proxy switches to if this one drops later.
    const fallbacks = candidates.slice(i + 1);
    const result = await startProxy(server, { image, port, timeoutMs, onLog, fallbacks });
    if (!result.ok) {
      if (result.fatal) fail(result.reason);
      console.log(`      ${red('✗')} ${result.reason}`);
      continue;
    }
    if (await reportProxy(port)) return server.countryCode;
  }
  fail(
    opts.config
      ? `Could not connect with ${opts.config}. Run again with -v to see OpenVPN's output.`
      : 'Could not start a proxy on any server. Try another country, --via tor, or --refresh.',
  );
}

const looksLikeUrl = (s) => /^[a-z]+:\/\//i.test(s) || /^[^\s/]+\.[a-z]{2,}(?:[/:?#]|$)/i.test(s);

// Lowest port from 1080 up that no running geohop proxy uses.
function nextFreePort(proxies) {
  const used = new Set(proxies.map((p) => p.port));
  let port = 1080;
  while (used.has(port)) port += 1;
  return port;
}

async function cmdBrowser() {
  const name = (opts.browser ?? 'chrome').toLowerCase();
  if (!browserNames.includes(name)) fail(`--browser must be one of: ${browserNames.join(', ')}`);
  let [, country, url] = positionals;
  if (country && looksLikeUrl(country)) [country, url] = [undefined, country];
  if (url && !/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;

  requireDocker();
  const running = listProxies().filter((p) => p.state === 'running');
  let port;
  let code;
  if (!country) {
    port = Number(opts.port) || 1080;
    const proxy = running.find((p) => p.port === port);
    if (!proxy) fail(`No proxy running on port ${port}. Add a country, for example: geohop browser NL ${url ?? '<url>'}`);
    code = proxy.country;
    if (proxy.server === 'tor') warnTor();
  } else {
    const q = country.toLowerCase();
    const reusable =
      !opts.port &&
      !opts.config &&
      !opts.via &&
      running.find((p) => p.country.toLowerCase() === q || countryName(p.country).toLowerCase().startsWith(q));
    if (reusable) {
      ({ port, country: code } = reusable);
      console.log(dim(`Using the ${countryName(code)} proxy already running on port ${port}`));
      if (reusable.server === 'tor') warnTor();
    } else {
      port = Number(opts.port) || nextFreePort(running);
      code = await launchProxy(country, port);
    }
  }

  await openBrowser(name, { port, country: code, url });
  console.log(`${green('✓')} Opened ${browserLabel(name)} browsing from ${bold(countryName(code))}${url ? dim(` → ${url}`) : ''}`);
  console.log(dim('  Only that window uses the proxy. Your normal browser is unaffected.'));
  console.log(dim(`  When you're done, close the window and run: geohop proxy stop${port === 1080 ? '' : ` --port ${port}`}`));
}

async function cmdCheck() {
  let url = positionals[1];
  if (!url) fail('Give a URL, for example: geohop check https://example.com');
  if (!/^[a-z]+:\/\//i.test(url)) url = `https://${url}`;

  let port = null;
  let via = 'your own connection';
  if (!opts.direct) {
    requireDocker();
    port = Number(opts.port) || 1080;
    const proxy = listProxies().find((p) => p.port === port && p.state === 'running');
    if (!proxy) fail(`No proxy running on port ${port}. Start one (geohop proxy NL) or use --direct.`);
    via = `the ${countryName(proxy.country)} proxy on port ${port}`;
  }
  console.log(dim(`Checking ${url} through ${via}...`));
  const r = await checkSite(url, { port });

  const row = (label, value) => console.log(`  ${label.padEnd(20)} ${value}`);
  const country = (code) => (code ? `${bold(code)} ${dim(countryName(code))}` : dim('none'));
  if (r.exitIp) row('Exit IP', `${r.exitIp} ${dim(`(IP database: ${r.ipCountry ?? '?'})`)}`);
  row('Cloudflare sees', r.cloudflareCountry === 'T1' ? `${bold('T1')} ${dim('(Tor, no country)')}` : country(r.cloudflareCountry));
  if (r.error) {
    row('Site', red(`didn't load: ${r.error}`));
    if (port) console.log(dim('  Slow free servers and Tor often time out. Try again, or another server.'));
    process.exit(1);
  }
  const platform = [r.shopify && 'Shopify', r.cloudflare && 'behind Cloudflare'].filter(Boolean).join(', ');
  row('Site', `HTTP ${r.status}  ${r.finalUrl}${platform ? dim(`  (${platform})`) : ''}`);
  if (r.edgeCountry) row('Site edge sees', r.edgeCountry === 'T1' ? `${bold('T1')} ${dim('(Tor, no country)')}` : country(r.edgeCountry));
  if (r.shopify) {
    row('Shopify geolocation', country(r.shopifyGeolocation));
    const m = r.market ?? {};
    row('Shopify market', [m.country, m.currency, m.locale].map((v) => v ?? '?').join(' · '));
  }

  // The country the site's own detection reports, most specific first.
  const detected = r.shopifyGeolocation ?? r.edgeCountry ?? r.cloudflareCountry;
  if (r.cloudflareCountry === 'T1') {
    console.log(yellow(`\n  ! Cloudflare sees Tor. Sites that use Cloudflare's country lookup see no country.`));
    if (r.shopifyGeolocation) console.log(yellow(`    Shopify's own geolocation still detected ${r.shopifyGeolocation}.`));
  } else if (r.ipCountry && detected && detected !== r.ipCountry) {
    console.log(yellow(`\n  ! The site detects ${detected}, but the exit IP is in ${r.ipCountry}.`));
  }
  if (r.shopify && r.market?.country && detected && r.market.country !== detected) {
    console.log(dim(`  Note: the Shopify market (${r.market.country}) differs from the detected country (${detected}).`));
    console.log(dim('  That can be the store\'s setup, for example a domain that always uses one market.'));
  }
}

const commands = {
  connect: cmdConnect,
  c: cmdConnect,
  countries: cmdCountries,
  list: cmdList,
  ls: cmdList,
  ip: cmdIp,
  proxy: cmdProxy,
  browser: cmdBrowser,
  check: cmdCheck,
};

if (opts.version) console.log(version);
else if (opts.help || command === 'help') console.log(HELP);
else if (!commands[command]) fail(`Unknown command "${command}". Run "geohop --help".`);
else commands[command]().catch((err) => fail(err.message));
