import { HUBS, IBIZA } from '../../shared/taxonomy';
import { haversineKm, normalize } from '../util';

const IBIZA_TOWNS = ['ibiza', 'eivissa', 'sant antoni', 'san antonio', 'sant josep', 'san jose', 'santa eularia', 'santa eulalia',
  'sant joan', 'san juan', 'playa d en bossa', 'platja d en bossa', 'es canar', 'portinatx', 'talamanca', 'cala de bou'];

export const COUNTRY_TIMEZONES: Record<string, string> = {
  SK: 'Europe/Bratislava', AT: 'Europe/Vienna', HU: 'Europe/Budapest', CZ: 'Europe/Prague', DE: 'Europe/Berlin',
  PL: 'Europe/Warsaw', SI: 'Europe/Ljubljana', HR: 'Europe/Zagreb', RS: 'Europe/Belgrade', RO: 'Europe/Bucharest',
  BG: 'Europe/Sofia', GR: 'Europe/Athens', IT: 'Europe/Rome', CH: 'Europe/Zurich', FR: 'Europe/Paris', BE: 'Europe/Brussels',
  NL: 'Europe/Amsterdam', LU: 'Europe/Luxembourg', GB: 'Europe/London', IE: 'Europe/Dublin', DK: 'Europe/Copenhagen',
  SE: 'Europe/Stockholm', NO: 'Europe/Oslo', FI: 'Europe/Helsinki', EE: 'Europe/Tallinn', LV: 'Europe/Riga',
  LT: 'Europe/Vilnius', ES: 'Europe/Madrid', PT: 'Europe/Lisbon', MT: 'Europe/Malta', ME: 'Europe/Podgorica',
  BA: 'Europe/Sarajevo', MK: 'Europe/Skopje', AL: 'Europe/Tirane', UA: 'Europe/Kyiv', CY: 'Asia/Nicosia', IS: 'Atlantic/Reykjavik',
  TR: 'Europe/Istanbul', GE: 'Asia/Tbilisi',
};

export function hubForCityName(city: string | null | undefined): string | null {
  if (!city) return null;
  const n = normalize(city);
  for (const h of HUBS) if (h.aliases.some((a) => normalize(a) === n)) return h.slug;
  if (IBIZA_TOWNS.includes(n)) return 'ibiza';
  return null;
}

export function isIbizaPlace(town?: string | null, city?: string | null, region?: string | null): boolean {
  return [town, city, region].some((v) => v && (IBIZA_TOWNS.includes(normalize(v)) || normalize(v) === 'ibiza'));
}

/** Nearest hub (four cities + Ibiza) and its distance. */
export function nearestHub(lat: number | null, lng: number | null, town?: string | null, city?: string | null, region?: string | null) {
  if (lat != null && lng != null) {
    let best: { hub: string; km: number } | null = null;
    for (const h of [...HUBS, IBIZA]) {
      const km = haversineKm(lat, lng, h.lat, h.lng);
      if (!best || km < best.km) best = { hub: h.slug, km };
    }
    if (best && best.km <= (best.hub === 'ibiza' ? IBIZA.radiusKm : 400)) return { hub: best.hub, km: Math.round(best.km * 10) / 10 };
    return { hub: null, km: null };
  }
  const byName = hubForCityName(city) ?? hubForCityName(town) ?? (isIbizaPlace(town, city, region) ? 'ibiza' : null);
  return { hub: byName, km: byName ? 0 : null };
}

export function distanceToHub(hubSlug: string, lat: number | null, lng: number | null): number | null {
  const h = hubSlug === 'ibiza' ? IBIZA : HUBS.find((x) => x.slug === hubSlug);
  if (!h || lat == null || lng == null) return null;
  return haversineKm(lat, lng, h.lat, h.lng);
}

export function mapLink(opts: { lat?: number | null; lng?: number | null; name?: string | null; address?: string | null; city?: string | null }) {
  if (opts.lat != null && opts.lng != null) {
    return `https://www.openstreetmap.org/?mlat=${opts.lat}&mlon=${opts.lng}#map=16/${opts.lat}/${opts.lng}`;
  }
  const q = [opts.name, opts.address, opts.city].filter(Boolean).join(', ');
  return q ? `https://www.openstreetmap.org/search?query=${encodeURIComponent(q)}` : null;
}
