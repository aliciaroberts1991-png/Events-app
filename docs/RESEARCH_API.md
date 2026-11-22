# Research API

Base URL: `https://<your-app>/api/research/v1`
Authentication: `Authorization: Bearer <token>`. `X-Api-Key: <token>` is also accepted. Tokens are created in Settings → Research and updates, or with `node dist/server/cli.js token`.

Machine-readable descriptions:
- `GET /api/research/v1/openapi.json` (no auth): OpenAPI 3.1, suitable for ChatGPT Actions. A copy is in `docs/schemas/openapi.json`.
- `docs/schemas/research-import.schema.json`: JSON Schema of the import payload.

Personal planning data (notes, statuses, bookings, plans) lives on the owner's devices and never
reaches the server. The API cannot change shared listings that were added through the app.

## Protocol for a run

```
1. Obtain a run
   a) POST /runs/claim             → claims the oldest queued run (Search now / internal schedule); 204 if none
   b) POST /runs {type}            → starts a run when your own scheduler triggers research
2. GET /context                    → current watchlist, interests, geographic scopes, coverage, rules
   (verification: GET /verification-queue?limit=50&offset=0, repeat with next_offset)
3. POST /import {run_id, …}        → as many batches as needed (≤ 500 events per batch)
   POST /runs/{id}/heartbeat       → while working, at least every RUN_LEASE_MINUTES (default 45)
4. POST /runs/{id}/complete {outcome, summary, coverage[]}
   or POST /runs/{id}/fail {error, errors[]}
```

If the executor stops without completing, the lease expires. The run becomes `failed` with
"Interrupted", and everything already imported is kept. Re-sending the same batches later is safe.

## Endpoints

| Method and path | Purpose |
| --- | --- |
| `POST /ping` | Authenticated write that records a completed `connection_test` run. Use it to verify a new connection. |
| `GET /context` | Active and paused watchlist (ids, aliases, links, keys), interest weights, cities with coordinates and nearby radius, festival radius, Ibiza, coverage, research rules |
| `GET /watchlist` | Full watchlist |
| `GET /taxonomy` | Valid category and genre slugs |
| `GET /events?upcoming=true&updated_since=…&q=…&limit=…&offset=…` | Researched events with `source_keys` (listings added through the app are excluded) |
| `GET /events/{id}` | Full facts for one event: lineup, sources, change history, occurrences |
| `GET /verification-queue?limit=50&offset=0` | Upcoming listings in priority order: listings a device has shared as booked or going (ids only) → within 7 or 30 days → ticket sale within 14 days → never or not recently verified → flagged |
| `POST /runs` | `{"type":"discovery"\|"verification"\|"adhoc","executor":"…","params":{}}` → a running run |
| `POST /runs/claim` | `{"executor":"…","types":["discovery"]}` → claimed run + brief, or 204 |
| `GET /runs/{id}` | Run and recorded errors |
| `POST /runs/{id}/heartbeat` | Extend the lease |
| `POST /runs/{id}/complete` | See `examples/run-complete.json` |
| `POST /runs/{id}/fail` | See `examples/run-fail.json` |
| `POST /import` | Create or update artists, festivals, residencies and events, and record verification outcomes. Optional `Idempotency-Key` header. |

## Import payload

```jsonc
{
  "idempotency_key": "discovery-2026-11-23-batch-1",  // optional; replays the stored result if re-sent
  "run_id": "run_…",                                   // optional; must be a running run
  "artists": [ … ],       // name, keys, aliases, description, genres, links, country
  "festivals": [ … ],     // festival series: name, keys, website
  "residencies": [ … ],   // Ibiza: season, title, brand, venue, weekday (1=Mon…7=Sun), start/end dates, status, residents
  "events": [ … ],        // see below
  "verifications": [ … ]  // {event_id | source_key, outcome: confirmed|changed|source_missing|check_failed, note}
}
```

### Event fields (all optional on update; `title`, `start` and a timezone are needed to create)

| Field | Meaning |
| --- | --- |
| `id` / `source_keys[]` | Identify an existing event. Use stable source identifiers such as `ra:event:123`, `tm:event:abc` or `festival:slug:2027`. |
| `kind` | `event`, `festival` (one card per edition) or `recurring` |
| `title`, `description`, `expectation` | Text. `expectation` is a short "what to expect". |
| `why_suits_me` | Concise and specific. Stored and shown as "Why this might suit you". |
| `status`, `status_note` | `scheduled`, `cancelled`, `postponed` or `rescheduled`. Kept separate from ticket status. |
| `start`, `end`, `doors`, `timezone` | Event-local `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, plus an IANA zone. Leave the time out if it is not announced. `end: "05:00"` after a 22:00 start means the next morning. |
| `recurrence` | `{freq: daily\|weekly\|monthly, byweekday:["SA"], setpos, from, until, start_time, end_time, exceptions[], extra_dates[]}` |
| `venue` | `{key, name, address, town, city, region, country (ISO-2), lat, lng, website}`. Coordinates enable the nearby-radius filters. |
| `location_text` | For events without a venue, e.g. a meeting point |
| `categories[]`, `genres[]` (+ `_mode`) | Slugs from `GET /taxonomy`. Unknown genres are kept as free tags. |
| `lineup[]` (+ `lineup_mode`) | `{artist_id\|artist_key\|name, billing, format: live\|dj_set\|hybrid\|av_show\|b2b\|talk\|unknown, date (festival day), set_start, set_end, stage, confirmed, remove}` |
| `festival` | `{name, edition, series_key, website}` links the event to its festival series |
| `residency_id` / `residency_key`, `occasion` | Ibiza party dates linked to a residency. `occasion`: `opening` or `closing`. |
| `tickets` | `{url, price_min, price_max, currency, price_note, booking_fee_note, status, status_checked_at, presale_at, onsale_at, sale_timezone, sale_note, tiers[]}` |
| `languages[]`, `language_importance` | ISO codes (`none` for no spoken language). Importance is `none`, `helpful`, `essential` or `unknown`. |
| `participation` | `spectator`, `participant` or `both` (sport and running) |
| `age_restriction`, `performance_format`, `camping`, `accommodation`, `travel` | Optional details. `travel` needs `source` and `label`. |
| `highlight`, `prominence` | Research's view of how notable the event is (0–100) |
| `sources[]` (+ `sources_mode`) | `{url, type: official_artist\|venue\|promoter\|festival\|ticketing\|listing\|media\|social\|other, name, key, claims[], retrieved_at}` |
| `announced_at`, `verified_at` | Announcement date and verification date. Both are separate from event dates and sale dates. |
| `unverified_fields[]`, `tba_fields[]` | For example `["end","price"]`. Shown as "Unverified" and "To be announced". |
| `conflicts[]` | `{field, note, values:[{value, source_url}]}` when sources disagree |
| `needs_review`, `review_reason` | Flag the listing for the owner |

**Rules:**
- Absent fields keep their stored value. `null` clears a field.
- Lists merge unless `"<field>_mode": "replace"` is sent.
- Only report ticket `available` or `sold_out` after checking a live ticket page. A listing page alone does not establish inventory. Otherwise use `unknown` or `sale_not_started`.
- A changed `start` keeps the event id and records the previous date. Bookings and notes held on the owner's devices refer to that id, so they stay attached. Set `status: "rescheduled"` when that is what happened.

### Response

```json
{
  "batch_id": "imp_…", "idempotency_key": "…", "replayed": false, "run_id": "run_…",
  "counts": { "created": 3, "updated": 1, "unchanged": 5, "error": 0 },
  "items": [ { "type": "event", "index": 0, "ref": "…", "status": "created", "id": "evt_…", "changes": [], "warnings": [] } ],
  "feed_items_created": 2
}
```

**Status codes:**
- `401`: missing or invalid token
- `422`: the payload failed validation (`details` lists paths and messages). Nothing is written.
- `409`: the idempotency key was reused with a different payload, or the run is not running

An error on one item does not stop the others. Each item is applied atomically.

## Examples

See `examples/`. Every file there is validated and imported by the test suite.

```bash
TOKEN=qrt_…; API=https://your-app/api/research/v1
curl -s -X POST $API/ping -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"executor":"curl"}'
curl -s $API/context -H "Authorization: Bearer $TOKEN"
RUN=$(curl -s -X POST $API/runs -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"type":"discovery"}' | jq -r .run.id)
curl -s -X POST $API/import -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -H 'Idempotency-Key: demo-1' \
  -d "$(jq --arg r $RUN '. + {run_id: $r}' examples/01-discovery-import.json)"
curl -s -X POST $API/runs/$RUN/complete -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d @examples/run-complete.json
```

`scripts/reference-executor.mjs` runs the same protocol. It is the simplest way to test a deployment.

## Push mode (optional)

When `RESEARCH_WEBHOOK_URL` is set, every queued run triggers
`POST {"event":"run.queued","run_id","type","params","api_base"}` to that URL. If
`RESEARCH_WEBHOOK_SECRET` is set, the request carries `X-Quartet-Signature: sha256=<HMAC of body>`.
The executor then claims the run as usual. The delivery outcome is shown on the run.
