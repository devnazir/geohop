import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';

const PROFILES_DIR = join(
  process.env.XDG_CACHE_HOME || join(homedir(), '.cache'),
  'geohop',
  'browsers',
);

const BROWSERS = {
  chrome: { label: 'Chrome', mac: 'Google Chrome', linux: ['google-chrome', 'google-chrome-stable'] },
  brave: { label: 'Brave', mac: 'Brave Browser', linux: ['brave-browser', 'brave'] },
  edge: { label: 'Edge', mac: 'Microsoft Edge', linux: ['microsoft-edge', 'microsoft-edge-stable'] },
  chromium: { label: 'Chromium', mac: 'Chromium', linux: ['chromium', 'chromium-browser'] },
  firefox: { label: 'Firefox', mac: 'Firefox', linux: ['firefox'] },
};

export const browserNames = Object.keys(BROWSERS);
export const browserLabel = (name) => BROWSERS[name].label;

function findOnPath(bin) {
  return (process.env.PATH || '').split(delimiter).some((dir) => dir && existsSync(join(dir, bin)));
}

// Firefox has no proxy command-line flags, so the proxy goes into the profile's preferences.
async function writeFirefoxPrefs(profileDir, port) {
  const prefs = {
    'network.proxy.type': 1,
    'network.proxy.socks': '"127.0.0.1"',
    'network.proxy.socks_port': port,
    'network.proxy.socks_version': 5,
    'network.proxy.socks_remote_dns': true,
    'media.peerconnection.ice.proxy_only': true,
    'browser.shell.checkDefaultBrowser': false,
  };
  const lines = Object.entries(prefs).map(([k, v]) => `user_pref("${k}", ${v});`);
  await writeFile(join(profileDir, 'user.js'), `${lines.join('\n')}\n`);
}

// Opens a separate browser window whose traffic all goes through the SOCKS5 proxy on `port`.
// Each country + port gets its own profile, so it never mixes with the user's normal browser
// and an already open window for the same profile keeps using the right proxy.
export async function openBrowser(name, { port, country, url }) {
  const browser = BROWSERS[name];
  const profileDir = join(PROFILES_DIR, `${name}-${country}-${port}`);
  await mkdir(profileDir, { recursive: true });

  let args;
  if (name === 'firefox') {
    await writeFirefoxPrefs(profileDir, port);
    args = ['-profile', profileDir, '-no-remote'];
  } else {
    args = [
      `--proxy-server=socks5://127.0.0.1:${port}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // Keeps WebRTC from revealing the real IP outside the proxy.
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
    ];
  }
  if (url) args.push(url);

  if (process.platform === 'darwin') {
    if (spawnSync('open', ['-Ra', browser.mac]).status !== 0) {
      throw new Error(`${browser.mac} is not installed. Pick another with --browser (${browserNames.join(', ')}).`);
    }
    spawn('open', ['-na', browser.mac, '--args', ...args], { stdio: 'ignore', detached: true }).unref();
  } else {
    const bin = browser.linux.find(findOnPath);
    if (!bin) {
      throw new Error(`${browser.label} was not found. Pick another with --browser (${browserNames.join(', ')}).`);
    }
    spawn(bin, args, { stdio: 'ignore', detached: true }).unref();
  }
}
