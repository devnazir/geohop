import { spawnSync } from 'node:child_process';

// Asks a site, through a proxy (or directly), which country it thinks the visitor is in.
// An exit IP in the right country isn't enough: Cloudflare reports Tor exits as "T1", so
// sites that rely on Cloudflare see no country at all.

function curl(args, { port, timeout = 60 }) {
  const proxy = port ? ['-x', `socks5h://127.0.0.1:${port}`] : [];
  return spawnSync('curl', ['-sS', '-m', String(timeout), ...proxy, ...args], {
    encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024,
  });
}

async function ipCountry(ip) {
  try {
    const res = await fetch(`https://api.country.is/${ip}`, { signal: AbortSignal.timeout(8_000) });
    return (await res.json()).country;
  } catch {
    return undefined;
  }
}

function lastHeaderBlock(raw) {
  const blocks = raw.split(/\r?\n\r?\n/).filter((b) => /^HTTP\//.test(b.trim()));
  return blocks.at(-1) ?? '';
}

export async function checkSite(url, { port } = {}) {
  const result = { url };

  const trace = curl(['https://www.cloudflare.com/cdn-cgi/trace'], { port, timeout: 20 });
  if (trace.status === 0) {
    const t = Object.fromEntries(trace.stdout.split('\n').map((l) => l.split('=')));
    result.exitIp = t.ip;
    result.cloudflareCountry = t.loc;
    result.ipCountry = await ipCountry(t.ip);
  }

  const marker = '\n__geohop_meta__ ';
  const page = curl(['-L', '-D', '-', '-w', `${marker}%{url_effective} %{http_code}`, url], { port });
  const metaAt = page.stdout.lastIndexOf(marker);
  if (page.status !== 0 || metaAt === -1) {
    result.error = page.stderr.trim().split('\n').pop() || `curl exited with ${page.status}`;
    return result;
  }
  const [finalUrl, status] = page.stdout.slice(metaAt + marker.length).trim().split(' ');
  const raw = page.stdout.slice(0, metaAt);
  const headers = lastHeaderBlock(raw);
  const body = raw.slice(raw.indexOf(headers) + headers.length);
  Object.assign(result, {
    finalUrl,
    status: Number(status),
    cloudflare: /^(server: cloudflare|cf-ray:)/im.test(headers),
    shopify: /^(powered-by: shopify|x-shopid:)/im.test(headers),
    // Shopify (and some other platforms) report the country their edge detected here.
    edgeCountry: headers.match(/country;desc="([^"]+)"/i)?.[1],
  });

  if (result.shopify) {
    result.market = {
      country: body.match(/Shopify\.country\s*=\s*"([A-Z]{2})"/)?.[1],
      currency: body.match(/Shopify\.currency\s*=\s*\{[^}]*"active"\s*:\s*"([A-Z]{3})"/)?.[1],
      locale: body.match(/Shopify\.locale\s*=\s*"([^"]+)"/)?.[1],
    };
    const origin = new URL(finalUrl).origin;
    const geo = curl([`${origin}/browsing_context_suggestions.json`], { port, timeout: 30 });
    try {
      result.shopifyGeolocation = JSON.parse(geo.stdout).detected_values?.country?.handle;
    } catch {
      // Not every store answers this; leave it out.
    }
  }
  return result;
}
