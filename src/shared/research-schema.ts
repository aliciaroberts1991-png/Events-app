// Validation schemas for the research integration (and manual JSON import).
//
// Partial-update rule: a field that is ABSENT keeps its stored value; a field
// sent as null is CLEARED. Lists of related records (categories, genres, lineup,
// sources) are merged by default; send "<field>_mode": "replace" to replace them.
import { z } from 'zod';
import {
  BILLINGS,
  EVENT_KINDS,
  EVENT_STATUSES,
  LANGUAGE_IMPORTANCE,
  PARTICIPATION,
  PERFORMANCE_FORMATS,
  SOURCE_TYPES,
  TICKET_STATUSES,
} from './taxonomy';

const localDateTime = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/, 'Use event-local "YYYY-MM-DD" or "YYYY-MM-DDTHH:mm" (no offset)');
const localDateTimeOrTime = z
  .string()
  .regex(/^(\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?|\d{2}:\d{2})$/, 'Use "YYYY-MM-DD", "YYYY-MM-DDTHH:mm" or "HH:mm"');
const localDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use "YYYY-MM-DD"');
const instant = z.iso.datetime({ offset: true }).describe('ISO 8601 instant with offset, e.g. 2026-11-22T09:00:00Z');
const timezone = z.string().refine((tz) => {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}, 'Unknown IANA timezone');
const url = z.url().max(2000);
const shortText = z.string().trim().min(1).max(300);
const longText = z.string().trim().max(5000);
const currency = z.string().regex(/^[A-Z]{3}$/, 'ISO 4217 code, e.g. EUR');
const mode = z.enum(['merge', 'replace']).optional();

export const venueInput = z.object({
  key: z.string().max(200).optional().describe('Stable venue identifier from a source, e.g. "ra:venue:12345"'),
  name: shortText,
  address: z.string().max(500).nullable().optional(),
  town: z.string().max(200).nullable().optional().describe('Actual town or district'),
  city: z.string().max(200).nullable().optional(),
  region: z.string().max(200).nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2, e.g. SK').nullable().optional(),
  lat: z.number().min(-90).max(90).nullable().optional(),
  lng: z.number().min(-180).max(180).nullable().optional(),
  website: url.nullable().optional(),
  timezone: timezone.optional(),
});

export const sourceInput = z.object({
  url,
  type: z.enum(SOURCE_TYPES).default('other'),
  name: z.string().max(200).optional(),
  key: z.string().max(200).optional().describe('Stable source identifier, also used for duplicate detection'),
  claims: z.array(z.string().max(60)).max(30).optional().describe('Fields this source supports, e.g. ["date","lineup","price"]'),
  retrieved_at: instant.optional(),
});

export const lineupInput = z
  .object({
    artist_id: z.string().max(60).optional(),
    artist_key: z.string().max(200).optional(),
    name: z.string().trim().min(1).max(200).optional(),
    billing: z.enum(BILLINGS).optional(),
    format: z.enum(PERFORMANCE_FORMATS).optional().describe('live, dj_set, hybrid, av_show, b2b, talk or unknown'),
    date: localDate.nullable().optional().describe('Appearance date (festival day), event-local'),
    set_start: localDateTimeOrTime.nullable().optional(),
    set_end: localDateTimeOrTime.nullable().optional(),
    stage: z.string().max(120).nullable().optional(),
    confirmed: z.boolean().optional().describe('false = reported but unverified'),
    announced_at: instant.nullable().optional(),
    source_url: url.nullable().optional(),
    remove: z.boolean().optional().describe('true removes this artist (on that date) from the lineup'),
  })
  .refine((v) => v.artist_id || v.artist_key || v.name, 'Give artist_id, artist_key or name');

export const ticketTierInput = z.object({
  name: shortText,
  price: z.number().min(0).nullable().optional(),
  price_max: z.number().min(0).nullable().optional(),
  currency: currency.optional(),
  status: z.enum(TICKET_STATUSES).optional(),
  day: localDate.nullable().optional().describe('For day tickets'),
  note: z.string().max(500).optional(),
});

export const ticketsInput = z.object({
  url: url.nullable().optional().describe('Official booking link'),
  price_min: z.number().min(0).nullable().optional(),
  price_max: z.number().min(0).nullable().optional(),
  currency: currency.nullable().optional().describe('Original currency'),
  price_note: z.string().max(500).nullable().optional(),
  booking_fee_note: z.string().max(500).nullable().optional(),
  status: z.enum(TICKET_STATUSES).optional().describe('Only "available"/"sold_out" when verified on a live ticket page'),
  status_checked_at: instant.nullable().optional(),
  presale_at: localDateTime.nullable().optional().describe('Presale start, local to sale_timezone'),
  onsale_at: localDateTime.nullable().optional().describe('General sale start, local to sale_timezone'),
  sale_timezone: timezone.nullable().optional(),
  sale_note: z.string().max(500).nullable().optional(),
  tiers: z.array(ticketTierInput).max(40).nullable().optional(),
});

export const conflictInput = z.object({
  field: z.string().max(60),
  note: z.string().max(500).optional(),
  values: z.array(z.object({ value: z.string().max(300), source_url: url.optional() })).max(10),
});

export const recurrenceInput = z.object({
  freq: z.enum(['daily', 'weekly', 'monthly']),
  interval: z.number().int().min(1).max(12).optional(),
  byweekday: z.array(z.enum(['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'])).optional(),
  setpos: z.number().int().min(-1).max(5).optional(),
  monthday: z.number().int().min(1).max(31).optional(),
  from: localDate,
  until: localDate.nullable().optional(),
  start_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  end_time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional(),
  exceptions: z.array(localDate).max(400).optional(),
  extra_dates: z.array(localDate).max(400).optional(),
});

export const festivalLink = z.object({
  series_id: z.string().max(60).optional(),
  series_key: z.string().max(200).optional(),
  name: shortText,
  edition: z.string().max(100).nullable().optional().describe('e.g. "2027" or "25th edition"'),
  website: url.nullable().optional(),
});

export const eventInput = z.object({
  ref: z.string().max(200).optional().describe('Your own reference, echoed back in results'),
  id: z.string().max(60).optional().describe('Existing event id (from a previous result or GET)'),
  source_keys: z.array(z.string().min(3).max(200)).max(20).optional().describe('Stable source identifiers, e.g. "ra:event:2041234"'),
  kind: z.enum(EVENT_KINDS).optional(),
  title: shortText.optional(),
  description: longText.nullable().optional(),
  expectation: longText.nullable().optional().describe('Short "what to expect"'),
  why_suits_me: z.string().max(600).nullable().optional().describe('Concise, specific reason this might suit the owner'),
  status: z.enum(EVENT_STATUSES).optional(),
  status_note: z.string().max(500).nullable().optional(),
  start: localDateTime.optional().describe('Event-local start. Date only when the time is not known'),
  end: localDateTimeOrTime.nullable().optional().describe('Event-local end; "HH:mm" earlier than start means next day'),
  doors: localDateTimeOrTime.nullable().optional(),
  timezone: timezone.optional().describe('IANA zone of the event, e.g. Europe/Vienna'),
  recurrence: recurrenceInput.nullable().optional(),
  venue: venueInput.nullable().optional(),
  location_text: z.string().max(300).nullable().optional(),
  categories: z.array(z.string().max(40)).max(12).optional(),
  categories_mode: mode,
  genres: z.array(z.string().max(40)).max(20).optional(),
  genres_mode: mode,
  lineup: z.array(lineupInput).max(300).optional(),
  lineup_mode: mode,
  festival: festivalLink.nullable().optional(),
  residency_id: z.string().max(60).nullable().optional(),
  residency_key: z.string().max(200).optional(),
  occasion: z.enum(['opening', 'closing']).nullable().optional().describe('Opening or closing party'),
  age_restriction: z.string().max(60).nullable().optional(),
  languages: z.array(z.string().min(2).max(10)).max(6).nullable().optional().describe('ISO 639-1 codes, or "none"'),
  language_importance: z.enum(LANGUAGE_IMPORTANCE).nullable().optional(),
  participation: z.enum(PARTICIPATION).nullable().optional(),
  performance_format: z.enum(PERFORMANCE_FORMATS).nullable().optional(),
  tickets: ticketsInput.optional(),
  camping: z.object({ available: z.boolean().nullable(), note: z.string().max(500).optional(), url: url.optional() }).nullable().optional(),
  accommodation: z.object({ url: url.optional(), note: z.string().max(500).optional() }).nullable().optional(),
  highlight: z.boolean().optional(),
  prominence: z.number().int().min(0).max(100).optional().describe('How notable the event is (0–100)'),
  announced_at: instant.nullable().optional(),
  sources: z.array(sourceInput).max(30).optional(),
  sources_mode: mode,
  verified_at: instant.optional().describe('When these facts were last checked'),
  unverified_fields: z.array(z.string().max(60)).max(40).nullable().optional(),
  tba_fields: z.array(z.string().max(60)).max(40).nullable().optional(),
  conflicts: z.array(conflictInput).max(20).nullable().optional(),
  travel: z
    .object({
      from: z.string().max(100),
      mode: z.string().max(60),
      duration_minutes: z.number().int().min(1).max(3000),
      source: z.string().max(200),
      label: z.string().max(200).optional(),
    })
    .nullable()
    .optional(),
  needs_review: z.boolean().optional(),
  review_reason: z.string().max(500).nullable().optional(),
});

export const artistInput = z.object({
  ref: z.string().max(200).optional(),
  id: z.string().max(60).optional(),
  keys: z.array(z.string().min(3).max(200)).max(10).optional(),
  name: shortText,
  aliases: z.array(z.string().max(200)).max(20).optional(),
  description: z.string().max(1500).nullable().optional().describe('Brief factual introduction to their sound'),
  description_source: url.nullable().optional(),
  genres: z.array(z.string().max(40)).max(12).optional(),
  links: z.record(z.string().max(40), url).optional().describe('e.g. {"official":"…","resident_advisor":"…","musicbrainz":"…"}'),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
});

export const festivalSeriesInput = z.object({
  ref: z.string().max(200).optional(),
  id: z.string().max(60).optional(),
  keys: z.array(z.string().min(3).max(200)).max(10).optional(),
  name: shortText,
  website: url.nullable().optional(),
  country: z.string().regex(/^[A-Z]{2}$/).nullable().optional(),
  description: z.string().max(1500).nullable().optional(),
});

export const residencyInput = z.object({
  ref: z.string().max(200).optional(),
  id: z.string().max(60).optional(),
  keys: z.array(z.string().min(3).max(200)).max(10).optional(),
  season: z.number().int().min(2000).max(2100),
  title: shortText,
  brand: z.string().max(200).nullable().optional().describe('Party brand or host'),
  venue: venueInput,
  weekday: z.number().int().min(1).max(7).nullable().optional().describe('1 = Monday … 7 = Sunday'),
  start_date: localDate.nullable().optional(),
  end_date: localDate.nullable().optional(),
  status: z.enum(['announced', 'confirmed', 'cancelled']).optional(),
  announced_at: instant.nullable().optional(),
  announcement_url: url.nullable().optional(),
  description: z.string().max(1500).nullable().optional(),
  residents: z
    .array(z.object({ artist_id: z.string().optional(), artist_key: z.string().optional(), name: z.string().optional() }))
    .max(60)
    .optional(),
  residents_mode: mode,
  ticket_url: url.nullable().optional(),
  sources: z.array(sourceInput).max(20).optional(),
  verified_at: instant.optional(),
});

export const verificationInput = z
  .object({
    event_id: z.string().max(60).optional(),
    source_key: z.string().max(200).optional(),
    outcome: z.enum(['confirmed', 'changed', 'source_missing', 'check_failed']),
    checked_at: instant.optional(),
    note: z.string().max(1000).optional(),
    source_url: url.optional(),
  })
  .refine((v) => v.event_id || v.source_key, 'Give event_id or source_key');

export const importPayload = z.object({
  idempotency_key: z.string().min(8).max(200).optional().describe('Re-sending the same key returns the stored result'),
  run_id: z.string().max(60).optional(),
  artists: z.array(artistInput).max(500).optional(),
  festivals: z.array(festivalSeriesInput).max(200).optional(),
  residencies: z.array(residencyInput).max(500).optional(),
  events: z.array(eventInput).max(500).optional(),
  verifications: z.array(verificationInput).max(1000).optional(),
});

export const coverageInput = z.object({
  area: z.enum([
    'bratislava',
    'vienna',
    'budapest',
    'prague',
    'europe-artists',
    'festivals-nearby',
    'festivals-europe',
    'ibiza',
  ]),
  kind: z.enum(['discovery', 'verification']),
  checked_at: instant.optional(),
  items_checked: z.number().int().min(0).optional(),
  note: z.string().max(500).optional(),
});

export const runCreateInput = z.object({
  type: z.enum(['discovery', 'verification', 'adhoc']),
  executor: z.string().max(100).optional(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const runCompleteInput = z.object({
  outcome: z.enum(['success', 'partial']).default('success'),
  summary: z.string().max(4000).optional(),
  coverage: z.array(coverageInput).max(50).optional(),
  stats: z.record(z.string(), z.number()).optional(),
  errors: z.array(z.object({ item_ref: z.string().max(200).optional(), message: z.string().max(2000) })).max(500).optional(),
});

export const runFailInput = z.object({
  error: z.string().min(1).max(4000),
  coverage: z.array(coverageInput).max(50).optional(),
  errors: z.array(z.object({ item_ref: z.string().max(200).optional(), message: z.string().max(2000) })).max(500).optional(),
});

export type VenueInput = z.infer<typeof venueInput>;
export type EventInput = z.infer<typeof eventInput>;
export type LineupInput = z.infer<typeof lineupInput>;
export type ArtistInput = z.infer<typeof artistInput>;
export type FestivalSeriesInput = z.infer<typeof festivalSeriesInput>;
export type ResidencyInput = z.infer<typeof residencyInput>;
export type VerificationInput = z.infer<typeof verificationInput>;
export type ImportPayload = z.infer<typeof importPayload>;
export type CoverageInput = z.infer<typeof coverageInput>;
