import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { watchTunnel, withCipherFallback } from './openvpn.js';

// Each proxy is a container running OpenVPN plus a SOCKS5 server (Dante) that only starts
// once the tunnel is up. Docker provides the tun device, so no sudo is needed on the host.
const DOCKER_DIR = fileURLToPath(new URL('../docker/', import.meta.url));
const LABEL = 'vpngate-proxy';

const docker = (args) => spawnSync('docker', args, { encoding: 'utf8' });

export const containerName = (port) => `vpngate-proxy-${port}`;

export function dockerStatus() {
  const res = docker(['info', '--format', '{{.ServerVersion}}']);
  if (res.error?.code === 'ENOENT') return 'missing';
  return res.status === 0 ? 'ready' : 'stopped';
}

export const hasImage = (tag) => docker(['image', 'inspect', tag]).status === 0;

export function buildImage(tag) {
  const res = docker(['build', '-q', '-t', tag, DOCKER_DIR]);
  if (res.status !== 0) throw new Error(`Could not build the proxy image:\n${res.stderr.trim()}`);
}

export function removeProxy(name) {
  docker(['rm', '-f', name]);
}

// Resolves like startTunnel: { ok: true } once the tunnel is up, or { ok: false, reason }.
export function startProxy(server, { image, port, timeoutMs, onLog }) {
  const name = containerName(port);
  removeProxy(name);
  const config = Buffer.from(withCipherFallback(server.config)).toString('base64');
  const run = docker([
    'run', '-d', '--name', name,
    '--label', `${LABEL}=1`,
    '--label', `vpngate.country=${server.countryCode}`,
    '--label', `vpngate.server=${server.host}`,
    '--label', `vpngate.ip=${server.ip}`,
    '--label', `vpngate.port=${port}`,
    '--cap-add', 'NET_ADMIN',
    '--device', '/dev/net/tun',
    // Public resolvers are reached through the tunnel, so DNS also resolves from the VPN's country.
    '--dns', '1.1.1.1',
    '--dns', '8.8.8.8',
    '-p', `127.0.0.1:${port}:1080`,
    '-e', `VPN_CONFIG=${config}`,
    image,
  ]);
  if (run.status !== 0) {
    removeProxy(name);
    return Promise.resolve({ ok: false, fatal: true, reason: run.stderr.trim().split('\n').pop() });
  }

  const logs = spawn('docker', ['logs', '-f', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  return watchTunnel(logs, { timeoutMs, onLog, stop: () => removeProxy(name) }).then((result) => {
    if (result.ok) logs.kill();
    else removeProxy(name);
    return result;
  });
}

// Looks up the exit IP through the proxy. Returns null if the proxy doesn't work.
export function checkProxy(port) {
  const res = spawnSync(
    'curl',
    ['-fsS', '-m', '15', '-x', `socks5h://127.0.0.1:${port}`, 'https://www.cloudflare.com/cdn-cgi/trace'],
    { encoding: 'utf8' },
  );
  if (res.error?.code === 'ENOENT') return { skipped: true };
  if (res.status !== 0) return null;
  const trace = Object.fromEntries(res.stdout.split('\n').map((l) => l.split('=')));
  return { ip: trace.ip, country: trace.loc };
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
