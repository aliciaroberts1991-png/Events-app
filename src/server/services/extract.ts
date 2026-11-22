// Best-effort extraction of event details from a pasted link (schema.org JSON-LD
// and Open Graph). The result is a draft for the editable form; nothing is saved
// automatically. Private and local network addresses are refused.
import dns from 'node:dns/promises';
import net from 'node:net';
import { HttpError } from '../util';
import { COUNTRY_TIMEZONES } from './geo';

function isPrivateIp(ip: string) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const l = ip.toLowerCase();
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:127.') || l.startsWith('::ffff:10.') || l.startsWith('::ffff:192.168.');
}

async function assertPublic(url: URL) {
  if (!['http:', 'https:'].includes(url.protocol)) throw new HttpError(400, 'Only http and https links can be read');
  if (url.port && !['80', '443'].includes(url.port)) throw new HttpError(400, 'Links on unusual ports are not read');
  const addrs = net.isIP(url.hostname) ? [url.hostname] : (await dns.lookup(url.hostname, { all: true })).map((a) => a.address);
  if (!addrs.length || addrs.some(isPrivateIp)) throw new HttpError(400, 'That address is not publicly reachable');
}

export interface ExtractedDraft {
  extracted: boolean;
  method: 'json-ld' | 'open-graph' | 'none';
  message: string;
  draft: Record<string, unknown>;
}

function decodeEntities(s: string) {
  return s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function toLocal(iso: unknown): { local: string; offset: string | null } | null {
  if (typeof iso !== 'string') return null;
  const m = iso.match(/^(\d{4}-\d{2}-\d{2})(?:T(\d{2}:\d{2}))?(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?/);
  if (!m) return null;
  return { local: m[2] ? `${m[1]}T${m[2]}` : m[1], offset: m[3] ?? null };
}

const COUNTRY_CODES: Record<string, string> = { slovakia: 'SK', austria: 'AT', hungary: 'HU', czechia: 'CZ', 'czech republic': 'CZ', spain: 'ES', germany: 'DE', 'united kingdom': 'GB', uk: 'GB', croatia: 'HR', poland: 'PL', netherlands: 'NL', belgium: 'BE', france: 'FR', italy: 'IT' };

export function parseHtml(html: string, url: string): ExtractedDraft {
  const scripts = [...html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
  const events: Record<string, unknown>[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach(walk);
    const o = node as Record<string, unknown>;
    const t = o['@type'];
    const types = Array.isArray(t) ? t : [t];
    if (types.some((x) => typeof x === 'string' && /Event$/.test(x))) events.push(o);
    if (o['@graph']) walk(o['@graph']);
  };
  for (const s of scripts) {
    try {
      walk(JSON.parse(s.trim()));
    } catch {
      /* ignore malformed blocks */
    }
  }
  if (events.length) {
    const e = events[0];
    const loc = (Array.isArray(e.location) ? e.location[0] : e.location) as Record<string, unknown> | undefined;
    const addr = (loc?.address ?? {}) as Record<string, unknown> | string;
    const a = typeof addr === 'string' ? { streetAddress: addr } : addr;
    const countryRaw = typeof a.addressCountry === 'string' ? a.addressCountry : (a.addressCountry as Record<string, string> | undefined)?.name;
    const country = countryRaw ? (countryRaw.length === 2 ? countryRaw.toUpperCase() : COUNTRY_CODES[countryRaw.toLowerCase()]) : undefined;
    const start = toLocal(e.startDate);
    const end = toLocal(e.endDate);
    const offers = (Array.isArray(e.offers) ? e.offers : e.offers ? [e.offers] : []) as Record<string, unknown>[];
    const prices = offers.map((o) => Number(o.price ?? o.lowPrice)).filter((n) => !Number.isNaN(n));
    const performers = (Array.isArray(e.performer) ? e.performer : e.performer ? [e.performer] : []) as Record<string, unknown>[];
    const geo = (loc?.geo ?? {}) as Record<string, unknown>;
    return {
      extracted: true,
      method: 'json-ld',
      message: 'Details read from the page’s structured data. Check them before saving — the page alone does not confirm live ticket availability.',
      draft: {
        title: typeof e.name === 'string' ? decodeEntities(e.name) : undefined,
        description: typeof e.description === 'string' ? decodeEntities(e.description).slice(0, 2000) : undefined,
        start: start?.local,
        end: end?.local,
        timezone: country ? COUNTRY_TIMEZONES[country] : undefined,
        utc_offset_on_page: start?.offset ?? null,
        venue: loc?.name
          ? {
              name: String(loc.name),
              address: [a.streetAddress, a.postalCode].filter(Boolean).join(', ') || undefined,
              city: typeof a.addressLocality === 'string' ? a.addressLocality : undefined,
              country,
              lat: geo.latitude ? Number(geo.latitude) : undefined,
              lng: geo.longitude ? Number(geo.longitude) : undefined,
            }
          : undefined,
        lineup: performers.filter((p) => typeof p.name === 'string').map((p) => ({ name: String(p.name) })),
        tickets: {
          url: typeof offers[0]?.url === 'string' ? offers[0].url : undefined,
          price_min: prices.length ? Math.min(...prices) : undefined,
          price_max: prices.length ? Math.max(...prices) : undefined,
          currency: typeof offers[0]?.priceCurrency === 'string' ? offers[0].priceCurrency : undefined,
        },
        status: typeof e.eventStatus === 'string' && /Cancelled/i.test(e.eventStatus) ? 'cancelled' : typeof e.eventStatus === 'string' && /Postponed/i.test(e.eventStatus) ? 'postponed' : undefined,
        sources: [{ url, type: 'user' }],
      },
    };
  }
  const meta = (prop: string) => {
    const m = html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i')) ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'));
    return m ? decodeEntities(m[1]) : undefined;
  };
  const title = meta('og:title') ?? html.match(/<title[^>]*>([^<]*)<\/title>/i)?.[1]?.trim();
  if (title) {
    return {
      extracted: true,
      method: 'open-graph',
      message: 'Only the title and summary could be read. Please add the date, time and place.',
      draft: { title: decodeEntities(title), description: meta('og:description') ?? meta('description'), sources: [{ url, type: 'user' }] },
    };
  }
  return { extracted: false, method: 'none', message: 'Nothing could be read from that page. Fill in the form instead.', draft: { sources: [{ url, type: 'user' }] } };
}

export async function extractFromUrl(raw: string): Promise<ExtractedDraft> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new HttpError(400, 'That is not a valid link');
  }
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    await assertPublic(current);
    let res: Response;
    try {
      res = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { 'user-agent': 'Mozilla/5.0 (compatible; personal-events-app/1.0)', accept: 'text/html' } });
    } catch (e) {
      return { extracted: false, method: 'none', message: `The page could not be fetched (${e instanceof Error ? e.message : 'network error'}). Fill in the form instead.`, draft: { sources: [{ url: raw, type: 'user' }] } };
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, current);
      continue;
    }
    if (!res.ok) return { extracted: false, method: 'none', message: `The page returned HTTP ${res.status}. Fill in the form instead.`, draft: { sources: [{ url: raw, type: 'user' }] } };
    const reader = res.body?.getReader();
    let html = '';
    if (reader) {
      const dec = new TextDecoder();
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        html += dec.decode(value, { stream: true });
        if (size > 3_000_000) break;
      }
    }
    return parseHtml(html, raw);
  }
  throw new HttpError(400, 'Too many redirects');
}
