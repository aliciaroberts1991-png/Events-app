import type { Kysely } from 'kysely';

// Initial schema. Never edit a released migration: add a new numbered file instead.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function up(db: Kysely<any>): Promise<void> {
  const s = db.schema;

  await s
    .createTable('users')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('email', 'text', (c) => c.notNull().unique())
    .addColumn('display_name', 'text')
    .addColumn('password_hash', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('sessions')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('last_seen_at', 'text', (c) => c.notNull())
    .addColumn('expires_at', 'text', (c) => c.notNull())
    .addColumn('user_agent', 'text')
    .execute();
  await s.createIndex('sessions_user_idx').on('sessions').column('user_id').execute();

  await s
    .createTable('api_tokens')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('token_hash', 'text', (c) => c.notNull().unique())
    .addColumn('token_prefix', 'text', (c) => c.notNull())
    .addColumn('scopes', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('created_by_user_id', 'text')
    .addColumn('last_used_at', 'text')
    .addColumn('revoked_at', 'text')
    .execute();

  await s
    .createTable('venues')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('normalized_name', 'text', (c) => c.notNull())
    .addColumn('address', 'text')
    .addColumn('town', 'text')
    .addColumn('city', 'text')
    .addColumn('region', 'text')
    .addColumn('country', 'text')
    .addColumn('lat', 'double precision')
    .addColumn('lng', 'double precision')
    .addColumn('timezone', 'text')
    .addColumn('website', 'text')
    .addColumn('source_key', 'text', (c) => c.unique())
    .addColumn('is_demo', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('venues_name_idx').on('venues').columns(['normalized_name', 'city']).execute();

  await s
    .createTable('artists')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('normalized_name', 'text', (c) => c.notNull())
    .addColumn('aliases', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('description', 'text')
    .addColumn('description_source', 'text')
    .addColumn('description_verified', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('genres', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('links', 'text', (c) => c.notNull().defaultTo('{}'))
    .addColumn('country', 'text')
    .addColumn('origin', 'text', (c) => c.notNull())
    .addColumn('is_demo', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('artists_name_idx').on('artists').column('normalized_name').execute();

  await s
    .createTable('artist_keys')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('artist_id', 'text', (c) => c.notNull().references('artists.id').onDelete('cascade'))
    .execute();

  await s
    .createTable('festival_series')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('name', 'text', (c) => c.notNull())
    .addColumn('normalized_name', 'text', (c) => c.notNull())
    .addColumn('website', 'text')
    .addColumn('country', 'text')
    .addColumn('description', 'text')
    .addColumn('is_demo', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('festival_keys')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('series_id', 'text', (c) => c.notNull().references('festival_series.id').onDelete('cascade'))
    .execute();

  await s
    .createTable('residencies')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('season', 'integer', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('brand', 'text')
    .addColumn('venue_id', 'text', (c) => c.notNull().references('venues.id'))
    .addColumn('weekday', 'integer')
    .addColumn('start_date', 'text')
    .addColumn('end_date', 'text')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('announced_at', 'text')
    .addColumn('announcement_url', 'text')
    .addColumn('description', 'text')
    .addColumn('ticket_url', 'text')
    .addColumn('sources', 'text', (c) => c.notNull().defaultTo('[]'))
    .addColumn('last_verified_at', 'text')
    .addColumn('is_demo', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('residencies_season_idx').on('residencies').column('season').execute();

  await s
    .createTable('residency_keys')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('residency_id', 'text', (c) => c.notNull().references('residencies.id').onDelete('cascade'))
    .execute();

  await s
    .createTable('residency_artists')
    .addColumn('residency_id', 'text', (c) => c.notNull().references('residencies.id').onDelete('cascade'))
    .addColumn('artist_id', 'text', (c) => c.notNull().references('artists.id').onDelete('cascade'))
    .addPrimaryKeyConstraint('residency_artists_pk', ['residency_id', 'artist_id'])
    .execute();

  await s
    .createTable('events')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('normalized_title', 'text', (c) => c.notNull())
    .addColumn('description', 'text')
    .addColumn('expectation', 'text')
    .addColumn('why_suits_me', 'text')
    .addColumn('why_suits_me_updated_at', 'text')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('status_note', 'text')
    .addColumn('origin', 'text', (c) => c.notNull())
    .addColumn('owner_user_id', 'text', (c) => c.references('users.id').onDelete('cascade'))
    .addColumn('is_demo', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('venue_id', 'text', (c) => c.references('venues.id'))
    .addColumn('location_text', 'text')
    .addColumn('town', 'text')
    .addColumn('city', 'text')
    .addColumn('country', 'text')
    .addColumn('lat', 'double precision')
    .addColumn('lng', 'double precision')
    .addColumn('hub', 'text')
    .addColumn('hub_distance_km', 'double precision')
    .addColumn('timezone', 'text', (c) => c.notNull())
    .addColumn('start_local', 'text', (c) => c.notNull())
    .addColumn('end_local', 'text')
    .addColumn('doors_local', 'text')
    .addColumn('start_utc', 'text', (c) => c.notNull())
    .addColumn('end_utc', 'text', (c) => c.notNull())
    .addColumn('span_end_utc', 'text', (c) => c.notNull())
    .addColumn('start_time_known', 'integer', (c) => c.notNull())
    .addColumn('end_time_known', 'integer', (c) => c.notNull())
    .addColumn('recurrence', 'text')
    .addColumn('festival_series_id', 'text', (c) => c.references('festival_series.id'))
    .addColumn('edition', 'text')
    .addColumn('residency_id', 'text', (c) => c.references('residencies.id').onDelete('set null'))
    .addColumn('occasion', 'text')
    .addColumn('age_restriction', 'text')
    .addColumn('languages', 'text')
    .addColumn('language_importance', 'text')
    .addColumn('participation', 'text')
    .addColumn('performance_format', 'text')
    .addColumn('ticket_url', 'text')
    .addColumn('price_min', 'double precision')
    .addColumn('price_max', 'double precision')
    .addColumn('currency', 'text')
    .addColumn('price_note', 'text')
    .addColumn('booking_fee_note', 'text')
    .addColumn('ticket_status', 'text', (c) => c.notNull())
    .addColumn('ticket_status_checked_at', 'text')
    .addColumn('presale_at', 'text')
    .addColumn('onsale_at', 'text')
    .addColumn('sale_timezone', 'text')
    .addColumn('sale_note', 'text')
    .addColumn('ticket_tiers', 'text')
    .addColumn('camping', 'text')
    .addColumn('accommodation', 'text')
    .addColumn('highlight', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('prominence', 'integer', (c) => c.notNull().defaultTo(30))
    .addColumn('announced_at', 'text')
    .addColumn('first_seen_at', 'text', (c) => c.notNull())
    .addColumn('last_verified_at', 'text')
    .addColumn('verification_state', 'text', (c) => c.notNull())
    .addColumn('last_changed_at', 'text', (c) => c.notNull())
    .addColumn('needs_review', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('review_reason', 'text')
    .addColumn('unverified_fields', 'text')
    .addColumn('tba_fields', 'text')
    .addColumn('conflicts', 'text')
    .addColumn('previous_schedule', 'text')
    .addColumn('travel', 'text')
    .addColumn('dedupe_key', 'text', (c) => c.notNull())
    .addColumn('archived_at', 'text')
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addColumn('created_by_run_id', 'text')
    .addColumn('updated_by_run_id', 'text')
    .execute();
  await s.createIndex('events_start_idx').on('events').column('start_utc').execute();
  await s.createIndex('events_span_idx').on('events').column('span_end_utc').execute();
  await s.createIndex('events_dedupe_idx').on('events').column('dedupe_key').execute();
  await s.createIndex('events_festival_idx').on('events').column('festival_series_id').execute();
  await s.createIndex('events_residency_idx').on('events').column('residency_id').execute();
  await s.createIndex('events_created_idx').on('events').column('created_at').execute();

  await s
    .createTable('event_keys')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .execute();
  await s.createIndex('event_keys_event_idx').on('event_keys').column('event_id').execute();

  await s
    .createTable('event_occurrences')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .addColumn('start_local', 'text', (c) => c.notNull())
    .addColumn('end_local', 'text')
    .addColumn('start_utc', 'text', (c) => c.notNull())
    .addColumn('end_utc', 'text', (c) => c.notNull())
    .addColumn('span_end_utc', 'text', (c) => c.notNull())
    .addColumn('start_time_known', 'integer', (c) => c.notNull())
    .addColumn('end_time_known', 'integer', (c) => c.notNull())
    .execute();
  await s.createIndex('occ_event_idx').on('event_occurrences').column('event_id').execute();
  await s.createIndex('occ_range_idx').on('event_occurrences').columns(['start_utc', 'span_end_utc']).execute();

  await s
    .createTable('event_artists')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .addColumn('artist_id', 'text', (c) => c.notNull().references('artists.id').onDelete('cascade'))
    .addColumn('appearance_key', 'text', (c) => c.notNull())
    .addColumn('billing', 'text', (c) => c.notNull())
    .addColumn('performance_format', 'text', (c) => c.notNull())
    .addColumn('appearance_date', 'text')
    .addColumn('set_start_local', 'text')
    .addColumn('set_end_local', 'text')
    .addColumn('stage', 'text')
    .addColumn('confirmed', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('announced_at', 'text')
    .addColumn('source_url', 'text')
    .addColumn('sort_order', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('event_artists_unique', ['event_id', 'artist_id', 'appearance_key'])
    .execute();
  await s.createIndex('event_artists_artist_idx').on('event_artists').column('artist_id').execute();

  await s
    .createTable('event_categories')
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .addColumn('category', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('event_categories_pk', ['event_id', 'category'])
    .execute();

  await s
    .createTable('event_genres')
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .addColumn('genre', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('event_genres_pk', ['event_id', 'genre'])
    .execute();

  await s
    .createTable('event_sources')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .addColumn('url', 'text', (c) => c.notNull())
    .addColumn('source_type', 'text', (c) => c.notNull())
    .addColumn('name', 'text')
    .addColumn('source_key', 'text')
    .addColumn('claims', 'text')
    .addColumn('retrieved_at', 'text')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('event_sources_unique', ['event_id', 'url'])
    .execute();

  await s
    .createTable('event_changes')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .addColumn('run_id', 'text')
    .addColumn('change_type', 'text', (c) => c.notNull())
    .addColumn('field', 'text')
    .addColumn('old_value', 'text')
    .addColumn('new_value', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('event_changes_event_idx').on('event_changes').column('event_id').execute();

  await s
    .createTable('research_runs')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('trigger', 'text', (c) => c.notNull())
    .addColumn('requested_by_user_id', 'text')
    .addColumn('params', 'text')
    .addColumn('executor', 'text')
    .addColumn('claimed_at', 'text')
    .addColumn('lease_expires_at', 'text')
    .addColumn('heartbeat_at', 'text')
    .addColumn('started_at', 'text')
    .addColumn('finished_at', 'text')
    .addColumn('outcome', 'text')
    .addColumn('summary', 'text')
    .addColumn('coverage', 'text')
    .addColumn('stats', 'text')
    .addColumn('error', 'text')
    .addColumn('dispatch_status', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('runs_status_idx').on('research_runs').columns(['status', 'created_at']).execute();

  await s
    .createTable('run_errors')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('run_id', 'text', (c) => c.notNull().references('research_runs.id').onDelete('cascade'))
    .addColumn('item_ref', 'text')
    .addColumn('message', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('import_batches')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('idempotency_key', 'text', (c) => c.notNull().unique())
    .addColumn('payload_hash', 'text', (c) => c.notNull())
    .addColumn('run_id', 'text')
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('item_count', 'integer', (c) => c.notNull())
    .addColumn('result', 'text')
    .addColumn('received_at', 'text', (c) => c.notNull())
    .addColumn('completed_at', 'text')
    .execute();

  await s
    .createTable('coverage')
    .addColumn('area', 'text', (c) => c.primaryKey())
    .addColumn('last_discovery_at', 'text')
    .addColumn('last_discovery_run_id', 'text')
    .addColumn('last_verification_at', 'text')
    .addColumn('last_verification_run_id', 'text')
    .addColumn('last_outcome', 'text')
    .addColumn('note', 'text')
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('app_settings')
    .addColumn('key', 'text', (c) => c.primaryKey())
    .addColumn('value', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  // ---------- Personal records (never written by the research API) ----------

  await s
    .createTable('user_preferences')
    .addColumn('user_id', 'text', (c) => c.primaryKey().references('users.id').onDelete('cascade'))
    .addColumn('data', 'text', (c) => c.notNull())
    .addColumn('version', 'integer', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('watchlist')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('artist_id', 'text', (c) => c.notNull().references('artists.id'))
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('note', 'text')
    .addColumn('added_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('watchlist_unique', ['user_id', 'artist_id'])
    .execute();

  await s
    .createTable('user_event_state')
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .addColumn('favourite', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('hidden', 'integer', (c) => c.notNull().defaultTo(0))
    .addColumn('plan_status', 'text', (c) => c.notNull())
    .addColumn('occurrence_id', 'text')
    .addColumn('notes', 'text')
    .addColumn('version', 'integer', (c) => c.notNull().defaultTo(1))
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .addPrimaryKeyConstraint('user_event_state_pk', ['user_id', 'event_id'])
    .execute();

  await s
    .createTable('bookings')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('event_id', 'text', (c) => c.notNull().references('events.id').onDelete('cascade'))
    .addColumn('provider', 'text')
    .addColumn('amount', 'double precision')
    .addColumn('currency', 'text')
    .addColumn('reference', 'text')
    .addColumn('quantity', 'integer')
    .addColumn('ticket_type', 'text')
    .addColumn('links', 'text')
    .addColumn('notes', 'text')
    .addColumn('booked_on', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();
  await s.createIndex('bookings_user_idx').on('bookings').columns(['user_id', 'event_id']).execute();

  await s
    .createTable('personal_plans')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('start_local', 'text', (c) => c.notNull())
    .addColumn('end_local', 'text')
    .addColumn('timezone', 'text', (c) => c.notNull())
    .addColumn('start_utc', 'text', (c) => c.notNull())
    .addColumn('end_utc', 'text', (c) => c.notNull())
    .addColumn('start_time_known', 'integer', (c) => c.notNull())
    .addColumn('end_time_known', 'integer', (c) => c.notNull())
    .addColumn('location', 'text')
    .addColumn('notes', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('updated_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('clash_reviews')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('item_a', 'text', (c) => c.notNull())
    .addColumn('item_b', 'text', (c) => c.notNull())
    .addColumn('decision', 'text', (c) => c.notNull())
    .addColumn('reviewed_at', 'text', (c) => c.notNull())
    .addUniqueConstraint('clash_reviews_unique', ['user_id', 'item_a', 'item_b'])
    .execute();

  await s
    .createTable('feedback')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('event_id', 'text', (c) => c.notNull())
    .addColumn('kind', 'text', (c) => c.notNull())
    .addColumn('categories', 'text')
    .addColumn('genres', 'text')
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('ibiza_stays')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('label', 'text')
    .addColumn('start_date', 'text', (c) => c.notNull())
    .addColumn('end_date', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .execute();

  await s
    .createTable('feed_items')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('type', 'text', (c) => c.notNull())
    .addColumn('event_id', 'text')
    .addColumn('artist_id', 'text')
    .addColumn('title', 'text', (c) => c.notNull())
    .addColumn('body', 'text')
    .addColumn('dedupe_key', 'text', (c) => c.notNull())
    .addColumn('email_status', 'text', (c) => c.notNull())
    .addColumn('created_at', 'text', (c) => c.notNull())
    .addColumn('read_at', 'text')
    .addUniqueConstraint('feed_items_dedupe', ['user_id', 'dedupe_key'])
    .execute();
  await s.createIndex('feed_items_user_idx').on('feed_items').columns(['user_id', 'created_at']).execute();

  await s
    .createTable('notification_deliveries')
    .addColumn('id', 'text', (c) => c.primaryKey())
    .addColumn('user_id', 'text', (c) => c.notNull().references('users.id').onDelete('cascade'))
    .addColumn('channel', 'text', (c) => c.notNull())
    .addColumn('status', 'text', (c) => c.notNull())
    .addColumn('item_count', 'integer', (c) => c.notNull())
    .addColumn('provider_response', 'text')
    .addColumn('error', 'text')
    .addColumn('attempted_at', 'text', (c) => c.notNull())
    .execute();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function down(db: Kysely<any>): Promise<void> {
  const tables = [
    'notification_deliveries', 'feed_items', 'ibiza_stays', 'feedback', 'clash_reviews', 'personal_plans', 'bookings',
    'user_event_state', 'watchlist', 'user_preferences', 'app_settings', 'coverage', 'import_batches', 'run_errors',
    'research_runs', 'event_changes', 'event_sources', 'event_genres', 'event_categories', 'event_artists',
    'event_occurrences', 'event_keys', 'events', 'residency_artists', 'residency_keys', 'residencies', 'festival_keys',
    'festival_series', 'artist_keys', 'artists', 'venues', 'api_tokens', 'sessions', 'users',
  ];
  for (const t of tables) await db.schema.dropTable(t).ifExists().execute();
}
