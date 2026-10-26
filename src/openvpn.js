import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { createInterface } from 'node:readline';

// Homebrew and distro packages install openvpn into sbin, which is often not on PATH.
const EXTRA_DIRS = ['/opt/homebrew/sbin', '/usr/local/sbin', '/usr/sbin', '/sbin'];
const FALLBACK_CIPHERS = 'AES-256-GCM:AES-128-GCM:CHACHA20-POLY1305:AES-128-CBC';
const READY = /Initialization Sequence Completed/;
const FATAL = /AUTH_FAILED|TLS Error|Connection refused|Exiting due to fatal error|Cannot resolve|Network is unreachable/;

export function findOpenVPN() {
  const dirs = [...(process.env.PATH || '').split(delimiter), ...EXTRA_DIRS];
  for (const dir of dirs) {
    const candidate = dir && join(dir, 'openvpn');
    if (candidate && existsSync(candidate)) return candidate;
  }
  return null;
}

export const needsSudo = () => process.getuid?.() !== 0;

// Prompts for the password once up front so later spawns can use `sudo -n`.
export function authorizeSudo() {
  const { status } = spawnSync('sudo', ['-v'], { stdio: 'inherit' });
  return status === 0;
}

// OpenVPN 2.6+ rejects the legacy CBC cipher many VPN Gate servers use unless it is allowed.
export const withCipherFallback = (config) =>
  /^\s*data-ciphers\s/m.test(config) ? config : `${config}\ndata-ciphers ${FALLBACK_CIPHERS}\n`;

export async function writeConfig(server) {
  const dir = await mkdtemp(join(tmpdir(), 'geohop-'));
  const file = join(dir, 'config.ovpn');
  await writeFile(file, withCipherFallback(server.config), { mode: 0o600 });
  return { file, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

// Resolves { ok: true, child } once the tunnel is up, or { ok: false, reason } on failure.
// `cwd` is where relative file paths inside the config (ca, cert, ...) are resolved from.
export function startTunnel(openvpnPath, configFile, { sudo, timeoutMs, onLog, cwd }) {
  // One connect attempt per server, so failover moves on quickly instead of retrying forever.
  const ovpnArgs = [
    openvpnPath,
    ...(cwd ? ['--cd', cwd] : []),
    '--config', configFile,
    '--connect-retry-max', '1',
  ];
  const [cmd, ...args] = sudo ? ['sudo', '-n', ...ovpnArgs] : ovpnArgs;
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  return watchTunnel(child, { timeoutMs, onLog });
}

// Follows output from `child` (openvpn itself, or `docker logs -f`) until a line matches `ready`.
// `stop` must make `child` exit; it is called on timeout.
export function watchTunnel(
  child,
  { timeoutMs, onLog, stop = () => child.kill('SIGTERM'), ready = READY, fatal = FATAL },
) {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let lastError = '';
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    // Settles via the exit handler below, so the caller never races a still-running openvpn.
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, timeoutMs);

    const onLine = (line) => {
      onLog?.(line);
      if (ready.test(line)) settle({ ok: true, child });
      else if (fatal.test(line)) lastError = line.replace(/^.*?\d{2}:\d{2}:\d{2}( \d{4})? /, '');
    };
    createInterface({ input: child.stdout }).on('line', onLine);
    createInterface({ input: child.stderr }).on('line', onLine);

    child.on('error', (err) => settle({ ok: false, reason: err.message }));
    child.on('exit', (code) => {
      const reason = timedOut
        ? `no connection after ${timeoutMs / 1000}s`
        : lastError || `exited with code ${code}`;
      settle({ ok: false, reason });
    });
  });
}

export function stopTunnel(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('exit', resolve);
    child.kill('SIGTERM');
  });
}

export const waitForExit = (child) =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise((resolve) => child.once('exit', resolve));
