#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { bold, cyan, dim, green, mbps, red, table, yellow } from '../src/format.js';
import { filterServers, getServers, groupByCountry } from '../src/servers.js';
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

${bold('Options')}
  --proto <tcp|udp>   Only use servers with this protocol
  --tries <n>         Servers to try before giving up (default 5)
  --timeout <sec>     Seconds to wait for each server (default 20)
  --limit <n>         Rows to show in "list" (default 20)
  --refresh           Ignore the cached server list
  -v, --verbose       Show OpenVPN output
  -h, --help          Show this help

${bold('Examples')}
  vpngate connect JP
  vpngate connect korea --proto udp
  vpngate list US

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
      tries: { type: 'string', default: '5' },
      timeout: { type: 'string', default: '20' },
      limit: { type: 'string', default: '20' },
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
    fail(`No servers found${countryArg ? ` for "${countryArg}"` : ''}. Run "vpngate countries" to see what's available.`);
  }
  return servers;
}

async function lookupIp() {
  try {
    const res = await fetch('https://ipinfo.io/json', { signal: AbortSignal.timeout(8_000) });
    return await res.json();
  } catch {
    return null;
  }
}

const describe = (s) =>
  `${s.country} · ${s.host} ${dim(`${s.ip} ${s.proto}/${s.port} · ${mbps(s.speed)}`)}`;

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
  console.log(`${bold(info.ip)}  ${[info.city, info.region, info.country].filter(Boolean).join(', ')}  ${dim(info.org ?? '')}`);
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

  const candidates = (await selectServers()).slice(0, Math.max(1, Number(opts.tries) || 5));
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
      const result = await startTunnel(openvpn, config.file, { sudo, timeoutMs, onLog });
      if (!result.ok) {
        if (!stopping) console.log(`      ${red('✗')} ${result.reason}`);
        continue;
      }
      current = result.child;
      console.log(`      ${green('✓ Connected')}`);
      const info = await lookupIp();
      if (info?.ip) console.log(`      Your IP is now ${bold(info.ip)} (${[info.city, info.country].filter(Boolean).join(', ')})`);
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

const commands = {
  connect: cmdConnect,
  c: cmdConnect,
  countries: cmdCountries,
  list: cmdList,
  ls: cmdList,
  ip: cmdIp,
};

if (opts.version) console.log(version);
else if (opts.help || command === 'help') console.log(HELP);
else if (!commands[command]) fail(`Unknown command "${command}". Run "vpngate --help".`);
else commands[command]().catch((err) => fail(err.message));
