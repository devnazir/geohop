#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { bold, cyan, dim, green, mbps, red, table, yellow } from '../src/format.js';
import { filterServers, getServers, groupByCountry } from '../src/servers.js';
import { loadCustomConfig } from '../src/custom.js';
import {
  buildImage,
  checkProxy,
  containerName,
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

const HELP = `${bold('vpngate')} ${dim(`v${version}`)} - free, no-signup VPN from your terminal

${bold('Usage')}
  vpngate connect [country]   Connect to the best server (optionally in a country)
  vpngate countries           List available countries
  vpngate list [country]      List servers, best first
  vpngate ip                  Show your current public IP and location

  vpngate proxy [country]     Start a SOCKS5 proxy that exits in a country (needs Docker, no sudo)
  vpngate proxy status        List running proxies
  vpngate proxy stop          Stop proxies (all, or the one on --port)

${bold('Options')}
  --via tor           For "proxy": exit through Tor in any country (slower, no VPN Gate needed)
  --config <file>     Use your own .ovpn file instead of VPN Gate (connect or proxy)
  --auth <file>       Username and password for --config (line 1 and line 2)
  --proto <tcp|udp>   Only use servers with this protocol
  --tries <n>         Servers to try before giving up (default 5)
  --timeout <sec>     Seconds to wait for each server (default 20, Tor 90)
  --limit <n>         Rows to show in "list" (default 20)
  --port <n>          Local port for "proxy" (default 1080)
  --refresh           Ignore the cached server list
  -v, --verbose       Show OpenVPN output
  -h, --help          Show this help

${bold('Examples')}
  vpngate connect JP
  vpngate connect korea --proto udp
  vpngate list US
  vpngate proxy JP && curl -x socks5h://127.0.0.1:1080 https://example.com
  vpngate proxy NL --via tor
  vpngate proxy --config ./nl.ovpn --auth ./nl-login.txt

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
      refresh: { type: 'boolean', default: false },
      verbose: { type: 'boolean', short: 'v', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', default: false },
    },
  });
} catch (err) {
  fail(`${err.message}\n  Run "vpngate --help" for usage.`);
}
const { values: opts, positionals } = parsed;
const [command = 'help', countryArg] = positionals;

async function loadServers() {
  const { servers, stale } = await getServers({ refresh: opts.refresh });
  if (stale) console.error(yellow('! VPN Gate is unreachable, using an older cached server list'));
  return servers;
}

async function selectServers() {
  if (opts.proto && !['tcp', 'udp'].includes(opts.proto)) fail('--proto must be tcp or udp');
  const servers = filterServers(await loadServers(), { country: countryArg, proto: opts.proto });
  if (servers.length === 0) {
    const torHint = /^[a-z]{2}$/i.test(countryArg ?? '')
      ? `\n  For countries VPN Gate doesn't have, try: vpngate proxy ${countryArg.toUpperCase()} --via tor`
      : '';
    fail(`No servers found${countryArg ? ` for "${countryArg}"` : ''}. Run "vpngate countries" to see what's available.${torHint}`);
  }
  return servers;
}

async function loadCustom({ forProxy }) {
  const server = await loadCustomConfig(opts.config, opts.auth);
  if (forProxy && server.usesExternalFiles) {
    fail(
      `${opts.config} refers to separate certificate or key files. Proxy mode needs them inline ` +
        'in the .ovpn file. Inline them, or use "vpngate connect --config" instead.',
    );
  }
  return server;
}

async function candidateServers({ forProxy }) {
  if (opts.auth && !opts.config) fail('--auth only works together with --config');
  if (opts.config) return [await loadCustom({ forProxy })];
  return (await selectServers()).slice(0, Math.max(1, Number(opts.tries) || 5));
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
  const rows = groupByCountry(await loadServers()).map((g) => [cyan(g.code), g.name, g.count, mbps(g.bestSpeed)]);
  console.log(table(['Code', 'Country', 'Servers', 'Fastest'], rows));
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

  if (opts.via === 'tor') fail('Tor works only with "vpngate proxy <country> --via tor"');
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
  const rows = proxies.map((p) => [
    `socks5://127.0.0.1:${p.port}`,
    cyan(p.country),
    `${p.server} ${dim(p.ip)}`,
    p.state === 'running' ? green('running') : red(p.state),
    p.age,
  ]);
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
async function reportProxy(port, expectedCountry) {
  const exit = await checkProxy(port);
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
  console.log(dim(`      curl -x socks5h://127.0.0.1:${port} https://example.com`));
  console.log(dim(`      Stop it with: vpngate proxy stop${port === 1080 ? '' : ` --port ${port}`}`));
  return true;
}

async function cmdProxy() {
  const status = dockerStatus();
  if (status === 'missing') fail('Proxy mode needs Docker. Install it from https://docs.docker.com/get-docker/');
  if (status === 'stopped') fail('Docker is not running. Start Docker and try again.');

  if (countryArg === 'status') return cmdProxyStatus();
  if (countryArg === 'stop') return cmdProxyStop();

  if (opts.via && !['vpngate', 'tor'].includes(opts.via)) fail('--via must be vpngate or tor');
  const tor = opts.via === 'tor';
  if (tor && opts.config) fail('--via tor and --config cannot be combined');
  if (tor && !/^[a-z]{2}$/i.test(countryArg ?? '')) {
    fail('Tor needs a two-letter country code, for example: vpngate proxy NL --via tor');
  }

  // Resolve servers before building anything, so a missing country fails fast.
  const candidates = tor ? [] : await candidateServers({ forProxy: true });
  const port = Number(opts.port) || 1080;
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
    const country = countryArg.toUpperCase();
    console.log(`Tor · exits in ${countryName(country)} ${dim('(can take up to a minute)')}`);
    const result = await startTorProxy(country, { image, port, timeoutMs, onLog });
    if (!result.ok) fail(result.reason);
    if (!(await reportProxy(port, country))) {
      fail(`Tor started but couldn't reach the internet. There may be no Tor exits in ${country} right now.`);
    }
    return;
  }

  for (const [i, server] of candidates.entries()) {
    console.log(`${dim(`[${i + 1}/${candidates.length}]`)} ${describe(server)}`);
    const result = await startProxy(server, { image, port, timeoutMs, onLog });
    if (!result.ok) {
      if (result.fatal) fail(result.reason);
      console.log(`      ${red('✗')} ${result.reason}`);
      continue;
    }
    if (await reportProxy(port)) return;
  }
  fail(
    opts.config
      ? `Could not connect with ${opts.config}. Run again with -v to see OpenVPN's output.`
      : 'Could not start a proxy on any server. Try another country, --via tor, or --refresh.',
  );
}

const commands = {
  connect: cmdConnect,
  c: cmdConnect,
  countries: cmdCountries,
  list: cmdList,
  ls: cmdList,
  ip: cmdIp,
  proxy: cmdProxy,
};

if (opts.version) console.log(version);
else if (opts.help || command === 'help') console.log(HELP);
else if (!commands[command]) fail(`Unknown command "${command}". Run "vpngate --help".`);
else commands[command]().catch((err) => fail(err.message));
