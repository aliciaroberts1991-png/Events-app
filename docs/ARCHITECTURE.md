# Architecture

## Stack and why

| Layer | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js 22, TypeScript | One language for server, client and shared rules; runs on any host |
| Server | Fastify 5 | Small, fast, well-typed; serves the API and the built client from one process |
| Database | Kysely query builder on **SQLite** (default) or **PostgreSQL** | SQLite means zero external services (a single file on a volume); PostgreSQL is a drop-in choice via `DATABASE_URL`. All SQL is portable: text ids, ISO-8601 text timestamps, JSON as text, 0/1 booleans. The full test suite runs on both. |
| Migrations | Kysely migrator, numbered files in `src/server/db/migrations/` | Versioned, run automatically at start-up; never edit a released migration |
| Validation | Zod 4 | One schema drives validation, the JSON Schema and the OpenAPI document |
| Client | React 19, Vite, React Router, TanStack Query | Single-page app; queries are invalidated after every personal change so every view shows the same state |
| Dates | Luxon | Correct IANA timezone and daylight-saving handling |
| Email | Nodemailer (any SMTP provider) | No vendor lock-in |
| Fonts/icons | Self-hosted Fraunces and Inter, Lucide icons | No third-party requests from the browser |

One deployable unit: `node dist/server/index.js`. The internal scheduler runs inside it, so it needs
an always-on instance, not a scale-to-zero one.

## Separation of data

**External event facts** come from research and can be refreshed at any time:
- `events`
- `event_occurrences`
- `event_artists`
- `event_categories`
- `event_genres`
- `event_sources`
- `event_keys`
- `event_changes`
- `venues`
- `artists`
- `artist_keys`
- `festival_series`
- `residencies`
- `residency_artists`

**Personal records** are only written by the signed-in owner. The research API cannot read or
write them:
- `user_preferences`
- `watchlist`
- `user_event_state`: favourite, hidden, plan status, chosen date, notes and a version number
- `bookings`
- `personal_plans`
- `clash_reviews`
- `feedback`
- `ibiza_stays`
- `feed_items`
- `notification_deliveries`

Events you add yourself are stored in `events` with `origin = 'manual'` and `owner_user_id`. Research imports refuse to change them, and they are excluded from research matching. If research later finds the official listing, the event page offers **Use this listing**. That moves your notes, status and bookings across.

**Operations:**
- `research_runs`
- `run_errors`
- `import_batches`: idempotency
- `coverage`: freshness per area
- `api_tokens`
- `sessions`
- `users`
- `app_settings`

## Key behaviours

### Identifiers and duplicate detection
- Every record has a stable, prefixed, time-ordered id, for example `evt_…` or `art_…`. Ids never change across updates.
- An import is matched to an existing event in this order:
  1. `id`
  2. any `source_keys` (stable source identifiers)
  3. an official source URL on the same date
  4. normalised title + date + city
  5. a similar title on the same date at the same venue or city
- Artists are matched by id, key, normalised name, then alias. When names collide, a watched artist is preferred. When you add an artist whose identifying link differs from an existing act with the same name, a separate record is created.

### Partial and idempotent updates
- If a field is absent, the stored value is kept. If a field is sent as `null`, the value is cleared.
- Related lists (categories, genres, lineup, sources) are **merged** unless `<field>_mode: "replace"` is sent.
- Each record is written in its own transaction. Re-sending a batch is safe: unchanged records report `unchanged`.
- With an `idempotency_key`, a completed batch returns its stored result. If an interrupted batch is sent again, it is processed to completion. Reusing a key with a different payload is rejected with 409.

### Times
- Events store event-local times (`2026-12-05T23:00` or a date-only `2026-12-05`) with an IANA timezone. They also store derived UTC instants, and flags recording whether the start and end times are known.
- An end time earlier than the start means the event finishes the next morning. For date filters, an overnight event belongs to its start date.
- Daylight-saving changes are handled by Luxon. For example, 23:00–06:00 on the October change night lasts 8 hours.
- Weekends run Friday to Sunday. Date presets are computed in the planning timezone (default `Europe/Bratislava`), and the resolved dates are always shown.
- Recurring markets use a rule (daily, weekly or monthly, with exceptions and extra dates). The rule is expanded into dated occurrences with stable ids, so filters, the calendar and a chosen date all work.

### Highlights
- The score combines:
  - research `prominence` (0–100)
  - the research `highlight` flag
  - followed artists
  - your category and genre weights (−3 to 3)
  - "fewer like this" feedback
  - a language penalty when understanding another language is essential
- Electronic genres get gentle extra prominence.
- Highlights are events with a followed artist or a score at or above your threshold. The stored `why_suits_me` text comes from research. Computed match reasons are shown alongside it.

### Calendar and clashes
- The calendar shows Going and Tickets booked events by default, with an option to include Interested. Personal plans are always shown.
- An **overlap** means both items have known start and end times and the times intersect.
- A **possible clash** means the items share a calendar day but at least one time is missing.
- Cancelled events are excluded from clash checks. Reviewing a clash ("Keep both") is remembered per pair.

### Research jobs
- A run moves through `queued` → `running` → `completed` or `failed`. It can also be `cancelled` while queued.
- Runs are queued by Search now, by the internal schedule, or by the executor itself (`POST /runs`).
- Claiming a run is atomic. A running run holds a lease, renewed by heartbeats. If the lease expires, the run is marked failed ("Interrupted"), and everything it imported is kept.
- Discovery and verification are tracked separately: last success timestamps, coverage per area, outcomes and errors.
- Past events are archived a day after they end. They and their bookings stay in History.

### Notifications
- The feed is generated from material changes:
  - new relevant events
  - followed-artist appearances
  - sale dates
  - headliner additions
  - date and venue changes
  - cancellations and postponements
- Each item has a de-duplication key derived from the new information, so unchanged re-checks never repeat an alert.
- Email goes through SMTP. The status is derived from real delivery outcomes: Not configured, Configured — not yet tested, Working, or Last delivery failed.

### Security
- Sign-in uses a scrypt password hash and a random session token. The cookie is httpOnly, `SameSite=Lax` and `Secure` in production.
- Sessions are stored server-side, hashed, with a sliding 90-day expiry. Login attempts are throttled.
- Cookie-authenticated writes require a custom header (CSRF defence). A strict Content-Security-Policy is set.
- Research tokens are random and stored only as SHA-256 hashes. They can be revoked, and they are shown once.
- Link extraction refuses private and local addresses.
