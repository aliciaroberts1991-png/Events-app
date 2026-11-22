export interface Occurrence {
  id: string;
  start_local: string;
  end_local: string | null;
  start_utc: string;
  end_utc: string;
  start_time_known: boolean;
  end_time_known: boolean;
  past?: boolean;
}

export interface LineupEntry {
  id: string;
  artist_id: string;
  name: string;
  billing: string;
  format: string;
  date: string | null;
  set_start: string | null;
  set_end: string | null;
  stage: string | null;
  confirmed: boolean;
  followed: boolean;
  watch_status: string | null;
  description: string | null;
  description_verified: boolean;
  genres: string[];
}

export interface EventState {
  favourite: boolean;
  hidden: boolean;
  plan_status: 'none' | 'interested' | 'going' | 'booked';
  occurrence_id: string | null;
  notes: string | null;
  version: number;
  booking_count: number;
}

export interface EventSummary {
  id: string;
  kind: string;
  title: string;
  status: string;
  status_note: string | null;
  origin: string;
  is_demo: boolean;
  timezone: string;
  start_local: string;
  end_local: string | null;
  start_utc: string;
  end_utc: string;
  start_time_known: boolean;
  end_time_known: boolean;
  recurring: boolean;
  next_occurrence: Occurrence | null;
  occurrence_count: number;
  venue: { id: string; name: string; town: string | null; city: string | null; country: string | null } | null;
  location_text: string | null;
  town: string | null;
  city: string | null;
  country: string | null;
  hub: string | null;
  hub_distance_km: number | null;
  categories: string[];
  genres: string[];
  artists: LineupEntry[];
  festival: { series_id: string; name: string; edition: string | null } | null;
  residency_id: string | null;
  occasion: string | null;
  languages: string[] | null;
  language_importance: string | null;
  participation: string | null;
  performance_format: string | null;
  ticket_status: string;
  price_min: number | null;
  price_max: number | null;
  currency: string | null;
  presale_at: string | null;
  onsale_at: string | null;
  sale_timezone: string | null;
  highlight: boolean;
  research_highlight: boolean;
  score: number;
  reasons: string[];
  why_suits_me: string | null;
  verification_state: string;
  last_verified_at: string | null;
  needs_review: boolean;
  camping: { available: boolean | null; note?: string; url?: string } | null;
  created_at: string;
  first_seen_at: string;
  archived: boolean;
  state: EventState;
}

export interface EventDetail extends EventSummary {
  description: string | null;
  expectation: string | null;
  why_suits_me_updated_at: string | null;
  doors_local: string | null;
  age_restriction: string | null;
  ticket_url: string | null;
  price_note: string | null;
  booking_fee_note: string | null;
  ticket_status_checked_at: string | null;
  sale_note: string | null;
  ticket_tiers: { name: string; price?: number | null; price_max?: number | null; currency?: string; status?: string; day?: string | null; note?: string }[];
  accommodation: { url?: string; note?: string } | null;
  announced_at: string | null;
  review_reason: string | null;
  unverified_fields: string[];
  tba_fields: string[];
  conflicts: { field: string; note?: string; values: { value: string; source_url?: string }[] }[];
  previous_schedule: { start_local: string; end_local: string | null; replaced_at: string }[];
  travel: { from: string; mode: string; duration_minutes: number; source: string; label?: string } | null;
  recurrence: any;
  last_changed_at: string;
  updated_at: string;
  version: number;
  source_keys: string[];
  venue_detail: { id: string; name: string; address: string | null; town: string | null; city: string | null; country: string | null; website: string | null; map_url: string | null } | null;
  map_url: string | null;
  sources: { id: string; url: string; source_type: string; name: string | null; claims: string[]; retrieved_at: string | null; status: string }[];
  changes: { id: string; change_type: string; field: string | null; old_value: unknown; new_value: unknown; created_at: string }[];
  bookings: Booking[];
  occurrences: Occurrence[];
  residency: { id: string; title: string; brand: string | null; season: number; status: string; weekday: number | null; start_date: string | null; end_date: string | null } | null;
  possible_matches: { id: string; title: string; start_local: string; city: string | null }[];
}

export interface Booking {
  id: string;
  event_id: string;
  provider: string | null;
  amount: number | null;
  currency: string | null;
  reference: string | null;
  quantity: number | null;
  ticket_type: string | null;
  links: string[];
  notes: string | null;
  booked_on: string | null;
}

export interface ListResult {
  items: EventSummary[];
  total: number;
  range: { preset: string; fromDate: string; toDate: string | null; label: string };
  counts: { highlights: number; all: number };
}

export interface Meta {
  app_name: string;
  category_groups: { slug: string; label: string; children: [string, string][] }[];
  genres: { slug: string; label: string; parent: string | null }[];
  hubs: { slug: string; name: string; country: string }[];
  demo: { loaded: boolean; events: number };
}
