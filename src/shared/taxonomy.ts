// Shared vocabulary used by the server, the client and the research API.
// Slugs are stable identifiers: rename labels freely, but never change a slug
// without a migration, because events and preferences store slugs.

export interface CategoryDef {
  slug: string;
  label: string;
  parent: string | null;
}

export const CATEGORY_GROUPS: { slug: string; label: string; children: [string, string][] }[] = [
  {
    slug: 'music',
    label: 'Music',
    children: [
      ['dnb', 'Drum and bass'],
      ['techno', 'Techno'],
      ['house', 'House'],
      ['trance', 'Trance'],
      ['electronic', 'Other electronic'],
      ['concert', 'Major concerts'],
      ['rock', 'Rock'],
      ['music-festival', 'Music festivals'],
    ],
  },
  {
    slug: 'food-drink',
    label: 'Food and drink',
    children: [
      ['wine', 'Wine festivals and tastings'],
      ['beer', 'Beer festivals'],
      ['street-food', 'Street food'],
      ['food-festival', 'Food festivals'],
      ['food-market', 'Food markets'],
    ],
  },
  {
    slug: 'markets',
    label: 'Markets',
    children: [
      ['christmas-market', 'Christmas markets'],
      ['farmers-market', 'Farmers’ markets'],
      ['flea-market', 'Flea markets'],
      ['vintage-market', 'Vintage markets'],
      ['design-market', 'Design and craft markets'],
      ['other-market', 'Other markets'],
    ],
  },
  {
    slug: 'arts',
    label: 'Arts and culture',
    children: [
      ['cultural-festival', 'Cultural festivals'],
      ['exhibition', 'Exhibitions'],
      ['light-festival', 'Light festivals'],
      ['museum-night', 'Museum evenings'],
      ['theatre-dance', 'Theatre and dance'],
    ],
  },
  {
    slug: 'comedy',
    label: 'Comedy and live entertainment',
    children: [
      ['stand-up', 'Stand-up comedy'],
      ['english-comedy', 'English-language comedy'],
      ['cabaret', 'Cabaret'],
      ['drag', 'Drag'],
      ['fringe', 'Fringe-style performances'],
    ],
  },
  {
    slug: 'sport',
    label: 'Sport',
    children: [
      ['boxing', 'Boxing'],
      ['mma', 'MMA and UFC'],
      ['sport-other', 'Other sporting occasions'],
    ],
  },
  {
    slug: 'outdoors',
    label: 'Outdoors and activities',
    children: [
      ['hike', 'Organised hikes'],
      ['running', 'Running events'],
      ['yoga', 'Yoga'],
      ['workshop', 'Workshops and activities'],
    ],
  },
];

export const CATEGORIES: CategoryDef[] = CATEGORY_GROUPS.flatMap((g) => [
  { slug: g.slug, label: g.label, parent: null },
  ...g.children.map(([slug, label]) => ({ slug, label, parent: g.slug })),
]);

export const CATEGORY_BY_SLUG = new Map(CATEGORIES.map((c) => [c.slug, c]));

/** The top-level group a category slug belongs to (or itself if it is a group). */
export function categoryGroup(slug: string): string | null {
  const c = CATEGORY_BY_SLUG.get(slug);
  if (!c) return null;
  return c.parent ?? c.slug;
}

export interface GenreDef {
  slug: string;
  label: string;
  parent: string | null;
}

export const GENRES: GenreDef[] = [
  { slug: 'dnb', label: 'Drum and bass', parent: null },
  { slug: 'liquid-dnb', label: 'Liquid', parent: 'dnb' },
  { slug: 'dancefloor-dnb', label: 'Dancefloor DnB', parent: 'dnb' },
  { slug: 'neurofunk', label: 'Neurofunk', parent: 'dnb' },
  { slug: 'jump-up', label: 'Jump-up', parent: 'dnb' },
  { slug: 'jungle', label: 'Jungle', parent: 'dnb' },
  { slug: 'minimal-dnb', label: 'Minimal / rollers', parent: 'dnb' },
  { slug: 'techno', label: 'Techno', parent: null },
  { slug: 'melodic-techno', label: 'Melodic techno', parent: 'techno' },
  { slug: 'hard-techno', label: 'Hard techno', parent: 'techno' },
  { slug: 'peak-time-techno', label: 'Peak-time techno', parent: 'techno' },
  { slug: 'house', label: 'House', parent: null },
  { slug: 'deep-house', label: 'Deep house', parent: 'house' },
  { slug: 'tech-house', label: 'Tech house', parent: 'house' },
  { slug: 'afro-house', label: 'Afro house', parent: 'house' },
  { slug: 'organic-house', label: 'Organic / downtempo house', parent: 'house' },
  { slug: 'progressive-house', label: 'Progressive house', parent: 'house' },
  { slug: 'trance', label: 'Trance', parent: null },
  { slug: 'breakbeat', label: 'Breakbeat', parent: 'electronic' },
  { slug: 'uk-garage', label: 'UK garage', parent: 'electronic' },
  { slug: 'bass', label: 'Bass music', parent: 'electronic' },
  { slug: 'downtempo', label: 'Downtempo / electronica', parent: 'electronic' },
  { slug: 'electronic', label: 'Other electronic', parent: null },
  { slug: 'pop', label: 'Pop', parent: null },
  { slug: 'rock', label: 'Rock', parent: null },
  { slug: 'indie', label: 'Indie', parent: 'rock' },
  { slug: 'metal', label: 'Metal', parent: 'rock' },
  { slug: 'hip-hop', label: 'Hip-hop', parent: null },
  { slug: 'jazz', label: 'Jazz', parent: null },
  { slug: 'classical', label: 'Classical', parent: null },
  { slug: 'folk', label: 'Folk and world', parent: null },
];

export const GENRE_BY_SLUG = new Map(GENRES.map((g) => [g.slug, g]));

/** The genre itself plus its ancestors, e.g. neurofunk -> [neurofunk, dnb]. */
export function genreLineage(slug: string): string[] {
  const out: string[] = [];
  let cur: string | null | undefined = slug;
  let guard = 0;
  while (cur && guard++ < 5) {
    out.push(cur);
    cur = GENRE_BY_SLUG.get(cur)?.parent;
  }
  return out;
}

export const ELECTRONIC_GENRES = new Set(
  GENRES.filter((g) => {
    const root = genreLineage(g.slug).at(-1);
    return root && ['dnb', 'techno', 'house', 'trance', 'electronic'].includes(root);
  }).map((g) => g.slug),
);

export interface Hub {
  slug: string;
  name: string;
  country: string;
  lat: number;
  lng: number;
  aliases: string[];
  timezone: string;
}

/** The four home cities plus Ibiza. Coordinates are city centres. */
export const HUBS: Hub[] = [
  { slug: 'bratislava', name: 'Bratislava', country: 'SK', lat: 48.1486, lng: 17.1077, aliases: ['bratislava', 'pressburg', 'pozsony'], timezone: 'Europe/Bratislava' },
  { slug: 'vienna', name: 'Vienna', country: 'AT', lat: 48.2082, lng: 16.3738, aliases: ['vienna', 'wien', 'viedeň', 'vieden'], timezone: 'Europe/Vienna' },
  { slug: 'budapest', name: 'Budapest', country: 'HU', lat: 47.4979, lng: 19.0402, aliases: ['budapest', 'budapešť', 'budapest'], timezone: 'Europe/Budapest' },
  { slug: 'prague', name: 'Prague', country: 'CZ', lat: 50.0755, lng: 14.4378, aliases: ['prague', 'praha', 'prag'], timezone: 'Europe/Prague' },
];

export const IBIZA = { slug: 'ibiza', name: 'Ibiza', country: 'ES', lat: 38.98, lng: 1.43, radiusKm: 45, timezone: 'Europe/Madrid' };

export const HUB_SLUGS = HUBS.map((h) => h.slug);

export const EUROPEAN_COUNTRIES = new Set([
  'AL', 'AD', 'AT', 'BA', 'BE', 'BG', 'BY', 'CH', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FO', 'FR', 'GB', 'GE', 'GI', 'GR',
  'HR', 'HU', 'IE', 'IS', 'IT', 'LI', 'LT', 'LU', 'LV', 'MC', 'MD', 'ME', 'MK', 'MT', 'NL', 'NO', 'PL', 'PT', 'RO', 'RS', 'SE',
  'SI', 'SK', 'SM', 'TR', 'UA', 'VA', 'XK', 'AM', 'AZ',
]);

export const COUNTRY_NAMES: Record<string, string> = {
  AT: 'Austria', BE: 'Belgium', BG: 'Bulgaria', CH: 'Switzerland', CZ: 'Czechia', DE: 'Germany', DK: 'Denmark', EE: 'Estonia',
  ES: 'Spain', FI: 'Finland', FR: 'France', GB: 'United Kingdom', GR: 'Greece', HR: 'Croatia', HU: 'Hungary', IE: 'Ireland',
  IT: 'Italy', LT: 'Lithuania', LV: 'Latvia', MT: 'Malta', NL: 'Netherlands', NO: 'Norway', PL: 'Poland', PT: 'Portugal',
  RO: 'Romania', RS: 'Serbia', SE: 'Sweden', SI: 'Slovenia', SK: 'Slovakia', UA: 'Ukraine', ME: 'Montenegro', BA: 'Bosnia and Herzegovina',
  AL: 'Albania', IS: 'Iceland', LU: 'Luxembourg', CY: 'Cyprus', MK: 'North Macedonia', TR: 'Türkiye', GE: 'Georgia',
};

export const EVENT_KINDS = ['event', 'festival', 'recurring'] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const EVENT_STATUSES = ['scheduled', 'cancelled', 'postponed', 'rescheduled'] as const;
export type EventStatus = (typeof EVENT_STATUSES)[number];
export const EVENT_STATUS_LABELS: Record<EventStatus, string> = {
  scheduled: 'Scheduled',
  cancelled: 'Cancelled',
  postponed: 'Postponed',
  rescheduled: 'Rescheduled',
};

export const TICKET_STATUSES = ['available', 'limited', 'sold_out', 'sale_not_started', 'free', 'door_only', 'unknown'] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];
export const TICKET_STATUS_LABELS: Record<TicketStatus, string> = {
  available: 'Available',
  limited: 'Limited availability',
  sold_out: 'Sold out',
  sale_not_started: 'Sale not started',
  free: 'Free entry',
  door_only: 'Tickets on the door',
  unknown: 'Availability unknown',
};

export const PERFORMANCE_FORMATS = ['live', 'dj_set', 'hybrid', 'av_show', 'b2b', 'talk', 'unknown'] as const;
export type PerformanceFormat = (typeof PERFORMANCE_FORMATS)[number];
export const FORMAT_LABELS: Record<PerformanceFormat, string> = {
  live: 'Live show',
  dj_set: 'DJ set',
  hybrid: 'Hybrid live/DJ',
  av_show: 'Audio-visual show',
  b2b: 'Back-to-back',
  talk: 'Talk / Q&A',
  unknown: 'Format unconfirmed',
};

export const BILLINGS = ['headliner', 'support', 'resident', 'host', 'special_guest', 'unknown'] as const;

export const PLAN_STATUSES = ['none', 'interested', 'going', 'booked'] as const;
export type PlanStatus = (typeof PLAN_STATUSES)[number];
export const PLAN_STATUS_LABELS: Record<PlanStatus, string> = {
  none: 'Not planned',
  interested: 'Interested',
  going: 'Going',
  booked: 'Tickets booked',
};
export const PLAN_STATUS_HELP: Record<PlanStatus, string> = {
  none: 'No plans yet',
  interested: 'Keeping an eye on it — not in your calendar unless you choose to include Interested',
  going: 'You intend to go — shown in your calendar and checked for clashes',
  booked: 'You hold tickets — shown in your calendar, checked for clashes and kept in your history',
};

export const LANGUAGE_IMPORTANCE = ['none', 'helpful', 'essential', 'unknown'] as const;
export type LanguageImportance = (typeof LANGUAGE_IMPORTANCE)[number];
export const LANGUAGE_IMPORTANCE_LABELS: Record<LanguageImportance, string> = {
  none: 'Language not important',
  helpful: 'Understanding the language helps',
  essential: 'Understanding the language is essential',
  unknown: 'Language importance unknown',
};

export const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English', sk: 'Slovak', cs: 'Czech', hu: 'Hungarian', de: 'German', es: 'Spanish', ca: 'Catalan', fr: 'French',
  it: 'Italian', pl: 'Polish', nl: 'Dutch', pt: 'Portuguese', none: 'No spoken language',
};

export const PARTICIPATION = ['spectator', 'participant', 'both'] as const;
export const PARTICIPATION_LABELS: Record<(typeof PARTICIPATION)[number], string> = {
  spectator: 'Watch as a spectator',
  participant: 'Take part',
  both: 'Take part or watch',
};

export const SOURCE_TYPES = ['official_artist', 'venue', 'promoter', 'festival', 'ticketing', 'listing', 'media', 'social', 'user', 'other'] as const;
export const SOURCE_TYPE_LABELS: Record<(typeof SOURCE_TYPES)[number], string> = {
  official_artist: 'Official artist source',
  venue: 'Venue',
  promoter: 'Promoter',
  festival: 'Official festival source',
  ticketing: 'Ticketing',
  listing: 'Listings site',
  media: 'Media',
  social: 'Social media',
  user: 'Added by you',
  other: 'Other',
};

export const FEED_TYPES = [
  'new_event',
  'new_appearance',
  'ticket_sale',
  'lineup_addition',
  'date_change',
  'venue_change',
  'cancellation',
  'postponement',
] as const;
export type FeedType = (typeof FEED_TYPES)[number];
export const FEED_TYPE_LABELS: Record<FeedType, string> = {
  new_event: 'New relevant events',
  new_appearance: 'New appearances by followed artists',
  ticket_sale: 'Ticket-sale announcements',
  lineup_addition: 'Significant lineup additions',
  date_change: 'Date changes',
  venue_change: 'Venue changes',
  cancellation: 'Cancellations',
  postponement: 'Postponements',
};

export const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

export const DEFAULT_PLANNING_TIMEZONE = 'Europe/Bratislava';
