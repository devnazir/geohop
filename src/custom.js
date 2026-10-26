import { readFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';

// Directives that point at a separate file instead of an inline <block>.
const FILE_DIRECTIVES =
  /^[ \t]*(ca|cert|key|tls-auth|tls-crypt|tls-crypt-v2|pkcs12|secret|crl-verify|auth-user-pass)[ \t]+(?!\[inline\])\S/m;

async function read(path) {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error(`Cannot read ${path}`);
  }
}

// Turns a user's own .ovpn file into the same shape as a VPN Gate server.
// `authPath` is a file with the username on line 1 and the password on line 2.
export async function loadCustomConfig(configPath, authPath) {
  const path = resolve(configPath);
  let config = await read(path);
  const remote = config.match(/^[ \t]*remote[ \t]+(\S+)(?:[ \t]+(\d+))?/m);
  if (!remote) throw new Error(`${configPath} has no "remote" line. Is it an OpenVPN config?`);

  if (authPath) {
    const [user, pass] = (await read(resolve(authPath))).split(/\r?\n/);
    if (!user || !pass) {
      throw new Error(`${authPath} must have the username on line 1 and the password on line 2`);
    }
    // Inline credentials (OpenVPN 2.6+) so the config is self-contained, also inside Docker.
    config = `${config.replace(/^[ \t]*auth-user-pass\b.*$/gm, '')}\n<auth-user-pass>\n${user}\n${pass}\n</auth-user-pass>\n`;
  } else if (/^[ \t]*auth-user-pass[ \t]*$/m.test(config)) {
    throw new Error(
      'This config needs a username and password. Put them in a file (username on line 1, ' +
        'password on line 2) and pass --auth <file>.',
    );
  }

  return {
    host: basename(path),
    ip: remote[1],
    port: Number(remote[2]) || 1194,
    proto: config.match(/^[ \t]*proto[ \t]+(\w+)/m)?.[1] ?? 'udp',
    country: 'Custom',
    countryCode: 'custom',
    speed: 0,
    config,
    dir: dirname(path),
    usesExternalFiles: FILE_DIRECTIVES.test(config),
  };
}
