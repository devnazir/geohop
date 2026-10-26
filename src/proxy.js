import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchTunnel, withCipherFallback } from './openvpn.js';

// Each proxy is a container exposing SOCKS5 on port 1080:
// - openvpn: OpenVPN plus Dante, which only starts once the tunnel is up. Docker provides the
//   tun device, so no sudo is needed on the host.
// - tor: Tor restricted to exit relays in one country.
const DOCKER_DIR = fileURLToPath(new URL('../docker/', import.meta.url));
const LABEL = 'vpngate-proxy';

const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' });

export const containerName = (port) => `vpngate-proxy-${port}`;
export const imageTag = (kind, version) => `vpngate-${kind}:${version}`;

export function dockerStatus() {
  const res = docker(['info', '--format', '{{.ServerVersion}}']);
  if (res.error?.code === 'ENOENT') return 'missing';
  return res.status === 0 ? 'ready' : 'stopped';
}

export const hasImage = (tag) => docker(['image', 'inspect', tag]).status === 0;

export function buildImage(kind, tag) {
  const res = docker(['build', '-q', '-t', tag, `${DOCKER_DIR}${kind}`]);
  if (res.status !== 0) throw new Error(`Could not build the ${kind} image:\n${res.stderr.trim()}`);
}

export function removeProxy(name) {
  docker(['rm', '-f', name]);
}

// Resolves { ok: true } once the container logs a `ready` line, or { ok: false, reason, fatal? }.
function runProxy({ port, image, labels, args = [], ready, fatal, timeoutMs, onLog }) {
  const name = containerName(port);
  removeProxy(name);
  const labelArgs = Object.entries({ [LABEL]: '1', 'vpngate.port': port, ...labels }).flatMap(
    ([k, v]) => ['--label', `${k}=${v}`],
  );
  const run = docker(['run', '-d', '--name', name, ...labelArgs, '-p', `127.0.0.1:${port}:1080`, ...args, image]);
  if (run.status !== 0) {
    removeProxy(name);
    return Promise.resolve({ ok: false, fatal: true, reason: run.stderr.trim().split('\n').pop() });
  }

  const logs = spawn('docker', ['logs', '-f', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  return watchTunnel(logs, { timeoutMs, onLog, ready, fatal, stop: () => removeProxy(name) }).then(
    (result) => {
      if (result.ok) logs.kill();
      else removeProxy(name);
      return result;
    },
  );
}

export function startProxy(server, { image, port, timeoutMs, onLog }) {
  const config = Buffer.from(withCipherFallback(server.config)).toString('base64');
  return runProxy({
    port,
    image,
    timeoutMs,
    onLog,
    labels: { 'vpngate.country': server.countryCode, 'vpngate.server': server.host, 'vpngate.ip': server.ip },
    args: [
      '--cap-add', 'NET_ADMIN',
      '--device', '/dev/net/tun',
      // Public resolvers are reached through the tunnel, so DNS also resolves from the VPN's country.
      '--dns', '1.1.1.1',
      '--dns', '8.8.8.8',
      '-e', `VPN_CONFIG=${config}`,
    ],
  });
}

export function startTorProxy(countryCode, { image, port, timeoutMs, onLog }) {
  return runProxy({
    port,
    image,
    timeoutMs,
    onLog,
    labels: { 'vpngate.country': countryCode, 'vpngate.server': 'tor', 'vpngate.ip': '' },
    args: ['-e', `TOR_COUNTRY=${countryCode.toLowerCase()}`],
    ready: /Bootstrapped 100%/,
    fatal: /\[err\]/,
  });
}

// Looks up the exit IP and country through the proxy. Returns null if the proxy doesn't work.
export async function checkProxy(port) {
  const res = spawnSync(
    'curl',
    ['-fsS', '-m', '20', '-x', `socks5h://127.0.0.1:${port}`, 'https://www.cloudflare.com/cdn-cgi/trace'],
    { encoding: 'utf8' },
  );
  if (res.error?.code === 'ENOENT') return { skipped: true };
  if (res.status !== 0) return null;
  const trace = Object.fromEntries(res.stdout.split('\n').map((l) => l.split('=')));
  // Cloudflare reports Tor exits as "T1" rather than a country, so look those up separately.
  let country = trace.loc;
  if (!/^[A-Z]{2}$/.test(country ?? '') || country === 'T1') {
    try {
      const geo = await fetch(`https://api.country.is/${trace.ip}`, { signal: AbortSignal.timeout(8_000) });
      country = (await geo.json()).country;
    } catch {
      country = undefined;
    }
  }
  // `cloudflareSeesTor`: sites that geolocate with Cloudflare see no country for this exit.
  return { ip: trace.ip, country, cloudflareSeesTor: trace.loc === 'T1' };
}

export function listProxies() {
  const format = [
    '{{.Names}}',
    '{{.State}}',
    '{{.Label "vpngate.port"}}',
    '{{.Label "vpngate.country"}}',
    '{{.Label "vpngate.server"}}',
    '{{.Label "vpngate.ip"}}',
    '{{.RunningFor}}',
  ].join('\t');
  const res = docker(['ps', '-a', '--filter', `label=${LABEL}`, '--format', format]);
  if (res.status !== 0) return [];
  return res.stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, state, port, country, server, ip, age] = line.split('\t');
      return { name, state, port: Number(port), country, server, ip, age };
    });
}
