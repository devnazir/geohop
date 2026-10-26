import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

// Onionoo is the Tor Project's public relay database.
const ONIONOO_URL =
  'https://onionoo.torproject.org/details?search=flag:Exit&running=true&fields=country';
const CACHE_DIR = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'vpngate-cli');
const CACHE_FILE = join(CACHE_DIR, 'tor-exits.json');
const CACHE_TTL_MS = 60 * 60 * 1000;

// Returns a Map of country code (uppercase) to number of running Tor exit relays,
// or null when Onionoo is unreachable and nothing is cached.
export async function getTorExitCounts({ refresh = false } = {}) {
  const cached = await readCache();
  if (!refresh && cached && Date.now() - cached.mtime < CACHE_TTL_MS) return count(cached.relays);
  try {
    const res = await fetch(ONIONOO_URL, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { relays } = await res.json();
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(CACHE_FILE, JSON.stringify(relays));
    return count(relays);
  } catch {
    return cached ? count(cached.relays) : null;
  }
}

async function readCache() {
  try {
    const [text, info] = await Promise.all([readFile(CACHE_FILE, 'utf8'), stat(CACHE_FILE)]);
    return { relays: JSON.parse(text), mtime: info.mtimeMs };
  } catch {
    return null;
  }
}

function count(relays) {
  const counts = new Map();
  for (const { country } of relays) {
    if (!country) continue;
    const code = country.toUpperCase();
    counts.set(code, (counts.get(code) ?? 0) + 1);
  }
  return counts;
}
