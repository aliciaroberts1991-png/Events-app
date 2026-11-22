# Architecture

## Stack and why

| Layer | Choice | Reason |
| --- | --- | --- |
| Runtime | Node.js 22, TypeScript | One language for server, client and shared rules; runs on any host |
| Server | Fastify 5 | Small, fast, well-typed; serves the API and the built client from one process |
| Database | Kysely query builder on **SQLite** (default) or **PostgreSQL** | SQLite means zero external services (a single file on a volume); PostgreSQL is a drop-in choice via `DATABASE_URL`. All SQL is portable: text ids, ISO-8601 text timestamps, JSON as text, 0/1 booleans. The full test suite runs on both. |
| Migrations | Kysely migrator, numbered files in `src/server/db/migrations/` | Versioned, run automatically at start-up; never edit a released migration |
| Validation | Zod 4 | One schema drives validation, the JSON Schema and the OpenAPI document |
| Client | React 19, Vite, React Router, TanStack Query | Single-page app. Device data sits in one store (`useSyncExternalStore`), so every view shows the same state, and it syncs across tabs. |
| Dates | Luxon | Correct IANA timezone and daylight-saving handling |
| Email | Nodemailer (any SMTP provider) | No vendor lock-in |
| Fonts/icons | Self-hosted Fraunces and Inter, Lucide icons | No third-party requests from the browser |

One deployable unit: `node dist/server/index.js`. The internal scheduler runs inside it, so it needs
an always-on instance, not a scale-to-zero one.

## Where data lives (revised requirements)

The app is mainly for **discovering events** on a phone and a laptop. Personal planning comes second.

**Central (server database), visible to every device without signing in:**
- External event facts, maintained by research:
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
- Central settings, owned by one "site" record (`users` row):
  - `watchlist` (the followed-artist list)
  - `user_preferences` (interests, places, planning timezone, schedule, notification settings)
- The central update feed: `feed_items`, `notification_deliveries`
- Operations:
  - `research_runs`
  - `run_errors`
  - `import_batches`
  - `coverage`
  - `api_tokens`
  - `sessions`, used for editor sessions
  - `app_settings`
- `priority_events`: optional ids of listings that devices are Going to or have booked. Ids and status only. It lets verification check them first and send alerts about changes to them.

**Changing central data needs the editor passphrase.** That covers:
- the artist list
- interests and places
- schedule and notifications
- manual import
- research tokens
- shared listings
- demo data
- Search now

Unlocking creates a long-lived editor session for that device (an httpOnly cookie). Research executors use bearer tokens instead. Because the artist list is central, a change on either device shows up on both, and the next scheduled search reads it from `GET /research/v1/context`.

**On each device (browser localStorage, `src/client/lib/local.ts`, schema in `src/shared/local-data.ts`):**
- favourites, hidden events and Interested/Going/Booked statuses, each with a readable snapshot of the listing
- private notes and bookings
- your own entries, such as a show you have already booked, and personal plans
- clash reviews
- "fewer like this" feedback, applied in the browser to the central highlight score
- Ibiza stays
- read state of the update feed

This data never reaches the server. The one exception is the optional, id-only `priority_events` sharing above. That needs the device to be unlocked for editing, and it can be turned off in Settings → This device.

- Export and import (Settings → This device) produce a validated JSON file (`docs/schemas/device-data-export.schema.json`). Use it for backup, or to copy plans to another device.
- Merging never deletes anything. Duplicates are skipped:
  - entries with the same title, start and city
  - bookings with the same target, reference, provider and amount
  - plans with the same title and start
- When both copies of an event state differ, the stronger plan status is kept and differing notes are kept side by side.
- The calendar, clash detection and ICS export run in the browser, using shared pure functions (`src/shared/calendar.ts`).

Migration `0002_device_local_personal_data` renamed the earlier server-side personal tables to `legacy_*` (preserving any rows) and added `priority_events`.

Shared listings added through the app are stored in `events` with `origin = 'manual'`. Research imports never change them and never match against them.

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

### Calendar and clashes (computed in the browser from device data)
- The calendar shows Going and Tickets booked events by default, with an option to include Interested. Personal plans and your own entries are always shown.
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
- Browsing is open; there is no account to sign in to.
- Editing is unlocked with a passphrase, stored as a scrypt hash and set from `EDITOR_PASSWORD` or `npm run editor:password`. Unlocking issues a random session token. The cookie is httpOnly, `SameSite=Lax` and `Secure` in production.
- Editor sessions are stored server-side, hashed, with a sliding 90-day expiry, and can be locked per device. Unlock attempts are throttled.
- Anyone with the link can see listings, the artist list and research status. The notification email address is never shown publicly.
- Cookie-authenticated writes require a custom header (CSRF defence). A strict Content-Security-Policy is set.
- Research tokens are random and stored only as SHA-256 hashes. They can be revoked, and they are shown once.
- Link extraction refuses private and local addresses.
