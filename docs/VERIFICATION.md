# Verification report

Verified on 22 November 2026 in a Linux container: Node 22, SQLite 3.54, PostgreSQL 16.15 and Chromium (Playwright 1.63).

## Automated test results

| Suite | Command | Result |
| --- | --- | --- |
| Type check (server, client, tests) | `npm run typecheck` | Passed |
| Server tests on SQLite | `npm test` | **63/63 passed** |
| Same server tests on PostgreSQL 16 | `npm run test:pg` | **63/63 passed** |
| Browser journeys, desktop 1366×900 and phone 375×812 | `npm run build && npm run test:e2e` | **20/20 passed** |

## Requested journeys, and where each is verified

| Journey | Server tests (`tests/server/…`) | Browser (`scripts/e2e.mjs`) |
| --- | --- | --- |
| Combined city, category, genre and date filters | personal: "Vienna, next weekend, food and drink"; "all four cities, this month, drum and bass"; "Bratislava, English-language comedy…"; nearby radius | "combined filters: Bratislava + next weekend + drum and bass, with explicit dates" |
| Highlights and All events | personal: "highlights prioritise followed artists…"; "fewer like this…" | "Highlights is the default and All events shows more" |
| Watchlist editing and persistence | personal: "adds, edits, pauses and removes artists without touching saved events"; "keeps similarly named acts apart…"; research: `/context` exposes active and paused artists | "watchlist: add, pause and remove an artist through the interface" (persists after reload) |
| European artist dates and festival associations | personal: "European festivals featuring an artist I follow"; "lists European appearances and festival associations per artist" | "European artist dates and festival associations" |
| Ibiza holiday-date filtering | personal: "filters parties to holiday dates and separates residencies from confirmed dates" | "Ibiza: holiday dates show only overlapping parties" |
| Saved statuses and notes across devices | personal: "syncs statuses and notes between two sessions and detects conflicting edits" (409 on stale edits) | "saved status and notes are the same on another device" (separate phone browser) |
| Manual bookings and personal plans | personal: "enters an already-booked show quickly"; "merges a manual booking into the researched listing" | "quick booking: enter an already-booked Chase & Status show"; "add an event manually from the form" |
| Calendar clashes | personal: "detects real overlaps, possible same-day clashes and allows keeping both" | "personal plan and calendar clash, keeping both" |
| Overnight events, timezones, multi-day festivals | dates: overnight roll-over, October and March DST changes, London zone, missing times, multi-day spans; personal: "compares events in different timezones correctly", ICS UTC and all-day output | ICS download in "calendar: Interested toggle, month view and ICS download" |
| Repeated imports and duplicate detection | research: "creates events and reports repeated imports as unchanged"; "matches without source keys by title, date and place"; idempotency replay and conflict | Manual import twice: "1 created" then "1 unchanged" |
| Partial updates and interrupted jobs | research: "applies partial updates: absent fields are kept, null clears"; "marks interrupted runs failed when the lease expires and keeps imported data"; "re-sending an interrupted batch completes it idempotently" | — |
| Personal data preserved after refreshes and migrations | research: "keeps personal data after re-imports, demo refresh and a restart on the same database"; personal: demo removal keeps real records; export → fresh database → import round trip with duplicates | — |
| Private access and protected update endpoints | research: missing, wrong and revoked tokens are refused; personal: sign-in required, CSRF header required, login throttling, logout invalidates the session | "private access: unauthenticated API is refused…" |
| Accurate search and notification status | research: executor *Awaiting connection* → *Connected* after `/ping` → *Operational* only after a completed run; queued → running → completed; schedule queues once; personal: email *Not configured*; feed de-duplication | "accurate research status, Search now queues a real job…"; "notification status is shown accurately" |
| Mobile usability and keyboard access | — | Bottom navigation across all six views; no horizontal scrolling on 13 screens at 375 px; skip link; visible focus outline; arrow keys in the mode toggle; Enter opens a focused card |

The documented example payloads (`examples/`) are validated and imported, in order, by `tests/server/examples.test.ts`.

## Manual checks

- **Research connection with a real token.** Against the running production build, `scripts/reference-executor.mjs` did the following:
  1. made an authenticated `/ping`
  2. claimed the scheduled discovery run that the internal scheduler had queued
  3. read `/context` (5 active artists)
  4. imported `examples/01-discovery-import.json` (4 created)
  5. completed the run with coverage, and a second verification run, with outcomes recorded

  The status page moved from *Awaiting connection* to *Operational*, and coverage showed every area. This check found a real interoperability bug: an empty JSON body was rejected. It is fixed and covered by a test.
- **Visual review.** Screenshots were reviewed at 1366 px and 390 px: Discover, Cities, Festivals, Artists, Ibiza (all tabs), calendar agenda and month, event detail, Settings → Research.
- **Colour contrast.** Every text/background token pair is at least 4.5:1 in both light and dark themes. The lowest is 4.71:1 (accent text on its tinted badge, light theme).

## Not verified here, and why

| Item | Reason | What to do |
| --- | --- | --- |
| Docker image build | No Docker daemon in the build environment | `docker compose up --build`. CI also builds the app. |
| Deployment to a real host | Needs the owner's hosting account | Follow docs/DEPLOYMENT.md, then the "After the first deploy" checklist |
| Real email delivery | No SMTP provider configured | Set `SMTP_URL` and `EMAIL_FROM`, then use **Send a test email**. The status shows *Working* only after acceptance. |
| ChatGPT connection | Needs the owner's ChatGPT account and whichever features it offers | docs/RESEARCH_WORKFLOW.md "Connecting ChatGPT". Verify with `/ping`, then a completed run. |
| Real event listings | No research has been run; only fictional demo data is included | Connect an executor or use manual import with verified sources |
| Screen-reader walkthrough | Not tested with real assistive technology. Semantic roles and labels are exercised by role-based Playwright queries. | Spot-check with VoiceOver (iPhone) and NVDA or VoiceOver (desktop) |
| Push notifications | Not implemented; email covers off-app alerts | Optional future addition |
