import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

const API_URL = 'https://www.vpngate.net/api/iphone/';
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'vpngate-cli');
const CACHE_FILE = join(CACHE_DIR, 'servers.csv');
const CACHE_TTL_MS = 10 * 60 * 1000;

// Returns { servers, stale }. Falls back to an expired cache when VPN Gate is unreachable.
export async function getServers({ refresh = false } = {}) {
  const cached = await readCache();
  if (!refresh && cached && Date.now() - cached.mtime < CACHE_TTL_MS) {
    return { servers: parse(cached.text), stale: false };
  }
  try {
    const text = await download();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, text);
    return { servers: parse(text), stale: false };
  } catch (err) {
    if (cached) return { servers: parse(cached.text), stale: true };
    throw new Error(`Could not fetch the VPN Gate server list: ${err.message}`);
  }
}

async function readCache() {
  try {
    const [text, info] = await Promise.all([readFile(CACHE_FILE, 'utf8'), stat(CACHE_FILE)]);
    return { text, mtime: info.mtimeMs };
  } catch {
    return null;
  }
}

async function download() {
  const res = await fetch(API_URL, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  if (!text.startsWith('*vpn_servers')) throw new Error('unexpected response format');
  return text;
}

// CSV columns: HostName,IP,Score,Ping,Speed,CountryLong,CountryShort,NumVpnSessions,
// Uptime,TotalUsers,TotalTraffic,LogType,Operator,Message,OpenVPN_ConfigData_Base64
export function parse(text) {
  return text
    .split(/\r?\n/)
    .filter((line) => line && !line.startsWith('*') && !line.startsWith('#'))
    .map(parseLine)
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);
}

function parseLine(line) {
  const f = line.split(',');
  if (f.length < 15) return null;
  // The config is always last; taking it from the end tolerates stray commas in Message.
  const config = Buffer.from(f[f.length - 1], 'base64').toString('utf8');
  const remote = config.match(/^\s*remote\s+(\S+)\s+(\d+)/m);
  if (!remote) return null;
  return {
    host: f[0],
    ip: f[1],
    score: Number(f[2]) || 0,
    ping: Number(f[3]) || null,
    speed: Number(f[4]) || 0,
    country: f[5],
    countryCode: f[6],
    sessions: Number(f[7]) || 0,
    logPolicy: f[11],
    operator: f[12],
    proto: config.match(/^\s*proto\s+(\w+)/m)?.[1] ?? 'udp',
    port: Number(remote[2]),
    config,
  };
}

export function filterServers(servers, { country, proto } = {}) {
  const q = country?.toLowerCase();
  return servers.filter(
    (s) =>
      (!q || s.countryCode.toLowerCase() === q || s.country.toLowerCase().startsWith(q)) &&
      (!proto || s.proto === proto),
  );
}

export function groupByCountry(servers) {
  const groups = new Map();
  for (const s of servers) {
    const g = groups.get(s.countryCode) ?? { code: s.countryCode, name: s.country, count: 0, bestSpeed: 0 };
    g.count += 1;
    g.bestSpeed = Math.max(g.bestSpeed, s.speed);
    groups.set(s.countryCode, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}
