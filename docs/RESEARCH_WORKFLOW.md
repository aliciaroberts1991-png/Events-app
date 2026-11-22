# Research workflow: daily discovery and weekly verification

The app stores, deduplicates, schedules and displays research. It does not search the web itself.
An **executor** does the researching and talks to the [Research API](RESEARCH_API.md). The executor
can be ChatGPT, a script using an LLM API, or a person doing manual import. Any of them can be
replaced without changing the app.

## How runs are triggered

| Trigger | What happens |
| --- | --- |
| Internal schedule (default on) | Each day at the discovery time (05:30 Bratislava by default), the app queues a `discovery` run. Each week on the chosen day it queues a `verification` run. It never stacks a second run of the same type while one is queued or running. Change the times in Settings → Research. |
| Search now (button) | Queues an `adhoc` run. |
| Executor's own schedule | The executor calls `POST /runs` with `{"type":"discovery"}` and continues. Set `SCHEDULER_ENABLED=false` if you only want this. |
| Webhook (optional) | `RESEARCH_WEBHOOK_URL` receives a signed notice for every queued run. |

Queued runs wait until an executor claims them (`POST /runs/claim`). The status page reports this
honestly:
- *Awaiting connection*: no token has been used yet.
- *Connected*: authenticated, but no research run has completed.
- *Operational*: discovery completed within 36 hours.
- *Stale* or *Failing*: when those apply.

## Daily discovery

1. `GET /context`. Use only the returned **active** watchlist (names, aliases, identifying links), interest weights, city coordinates, nearby radius and festival radius. Do not use a cached copy.
2. Search, in this order of priority:
   - New appearances by active artists anywhere in Europe: tours, club sets, festival bookings, Ibiza dates. Record `format` as `live` or `dj_set` and so on, and distinguish similarly named acts using the links.
   - Electronic music in and around Bratislava, Vienna, Budapest and Prague: drum and bass, techno, house, trance, other electronic. Then major concerts, selected rock, and festivals nearby and across Europe.
   - Other categories from the taxonomy: food and drink, markets, arts and culture, comedy (English-language especially), boxing and MMA, outdoors.
   - Ibiza: residency announcements (`residencies[]`), dated parties with confirmed lineups (`events[]` with `residency_key`), and opening and closing parties.
   - Ticket-sale announcements (`presale_at`, `onsale_at`, `sale_timezone`).
3. Prefer official artist, venue, promoter, festival and ticketing sources. Attach `sources[]` with `claims` for each material fact, and use stable `source_keys`.
4. Send `POST /import` in batches. Include `why_suits_me` (one specific sentence) for strong matches, and `prominence` for every event.
5. `POST /runs/{id}/complete` with `coverage` for each area actually searched: `bratislava`, `vienna`, `budapest`, `prague`, `europe-artists`, `festivals-nearby`, `festivals-europe`, `ibiza`. Leave out any area that was not searched, so freshness stays accurate.

## Weekly verification

1. `GET /verification-queue?limit=50`, then follow `next_offset` until done, or stop when out of time. The queue is ordered: booked/going first, then soonest events, then approaching ticket sales, then stale listings.
2. For each event, re-check the sources.
   - Unchanged: `verifications[]` with `outcome: "confirmed"`.
   - Changed: send the event with `source_keys` and only the changed fields. Possible changes are date, venue, lineup, ticket status, price or sale dates. Add a verification with `outcome: "changed"`.
   - Cancelled or postponed: set `status`, and `status_note` where useful.
   - Source gone: `outcome: "source_missing"`. The listing is kept and flagged for review.
   - The check itself failed (blocked, timeout): `outcome: "check_failed"`. Nothing else changes.
3. Complete the run with `coverage` entries of `kind: "verification"`.

## Uncertainty rules (the app displays these faithfully)

- Use date-only `start` when no time is announced. Do not guess times.
- Use `tba_fields` for details that are genuinely pending, and `unverified_fields` for claims without confirmation.
- Ticket `available` or `sold_out` only after viewing a live ticket page. Otherwise use `unknown`.
- When sources disagree, use `conflicts[]` with each value and its source.
- Distinguish event dates, `announced_at`, sale dates and `verified_at`.
- Artist `description`: brief and factual about their sound, e.g. "melodic dancefloor DnB" or "heavier neurofunk". Include `description_source`.

## Connecting ChatGPT

Use whichever of these your ChatGPT plan and tools currently support. Check the current product.

**A. Custom GPT with Actions (interactive, or scheduled if your plan allows Actions in tasks)**
1. Create a GPT and add an Action. Import the schema from `https://<your-app>/api/research/v1/openapi.json`.
2. Authentication: API key, type **Bearer**, value = a token from Settings → Research.
3. Instructions: paste the "Discovery prompt" below.
4. Run "Start daily discovery". The GPT calls `startRun` (or `claimRun`), `getContext`, `importData` and `completeRun`.
5. Verify: Settings → Research shows the run, its counts and the coverage.

**B. ChatGPT agent, or any tool that can make authenticated HTTPS requests.** Give it the token as a
secret and the same prompt. It follows the protocol above. `scripts/reference-executor.mjs` shows
the exact calls.

**C. A small scheduled worker using an LLM API** (fully automatic, small API cost). A cron job
(GitHub Actions, the host's scheduler, or a VPS crontab) runs a script that:
1. claims or starts a run
2. sends `/context` to the model with the prompt below and web search enabled
3. validates the model's JSON against `docs/schemas/research-import.schema.json`
4. posts it to `/import`
5. completes the run

Store the model API key and the research token as secrets of that worker. Never put them in the app or the repository.

**D. Manual (always available).** Ask ChatGPT to produce the import JSON, then paste it into
Settings → Research → Manual import. The same validation, deduplication and preservation rules apply.

### Discovery prompt (for A/B/C)

> You maintain my events app through its Research API. Start a run (`claimRun`; if nothing is
> queued, `startRun` with type "discovery"). Call `getContext` and use only that watchlist,
> those interest weights and those geographic scopes. Research upcoming events following
> docs/RESEARCH_WORKFLOW.md: followed artists across Europe (tour dates, club sets, festivals,
> Ibiza; mark live vs DJ set), electronic music first around Bratislava, Vienna, Budapest and
> Prague within the nearby radius, then major concerts, festivals, food and drink, markets, arts,
> English-language comedy, boxing/MMA and outdoors. Prefer official sources; include source URLs
> and stable source_keys; never guess times or ticket availability; use tba_fields,
> unverified_fields and conflicts. Write a specific one-sentence why_suits_me for strong matches.
> Send results with `importData` in batches of up to 100 events, then `completeRun` with
> coverage only for the areas you actually searched. If you cannot finish, call `failRun` with
> the reason.

### Verification prompt

> Claim or start a "verification" run. Page through `getVerificationQueue` (limit 50). For each
> event re-check its sources and send `verifications` with confirmed / changed / source_missing /
> check_failed, plus partial event updates for any changes (dates, venue, lineup, status, tickets,
> sale dates). Keep events when a source disappears. Complete the run with verification coverage.

## Adapting the existing Bratislava automation

The current ChatGPT automation keeps a Bratislava event list. To move it onto this app:

1. **Keep its searching, change its output.** Instead of a list in chat, ask it for the import JSON format: see `examples/01-discovery-import.json` and the schema file. Each item needs at least `title`, `start` (event-local), `timezone: "Europe/Bratislava"`, a `venue` with `city` and `country: "SK"`, `categories`, and `sources`.
2. **Give each listing a stable key.** Use `source_keys` such as the ticketing or venue page id, or `"bratislava-list:<slug>-<date>"` if nothing better exists. Repeated runs then update events instead of duplicating them. Title, date and city matching also catches most repeats.
3. **Widen the scope.** Replace its fixed instructions with the Discovery prompt above. It then covers Vienna, Budapest, Prague, the surrounding areas, European artist dates, festivals and Ibiza, and it reads the live watchlist and preferences from `/context` at the start of every run.
4. **Deliver.** If the automation can call the API (option A or B), let it post directly. If it can only produce text, keep it scheduled and paste its JSON into Manual import (option D). The status page then shows when results last arrived.
5. **Import the existing list once.** Convert the current list to the import format and import it. Mark past items as past; the app archives them automatically. Your own bookings and notes are entered in the app, not in research data.

## What the app guarantees for any executor

- Imports never alter notes, statuses, bookings, plans, hidden events or owner-entered events.
- Re-running the same research is idempotent. Partial updates only change the fields sent.
- Failed or interrupted runs keep existing listings. Errors are recorded on the run.
- Listings whose source disappears are kept and flagged, not deleted.
- Rescheduled events keep their id, the owner's booking, and the previous date.
- Alerts are de-duplicated, so unchanged information does not notify twice.
