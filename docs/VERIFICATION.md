# Verification report

Verified on 22 November 2026, after the requirements revision. Environment: a Linux container with Node 22, SQLite 3.54, PostgreSQL 16.15 and Chromium (Playwright 1.63).

Requirements revision being verified:
- discovery comes first
- the followed-artist list and settings are central, and editing them is protected
- browsing works without sign-in
- personal planning data stays on each device, with export and import

## Automated test results

| Suite | Command | Result |
| --- | --- | --- |
| Type check (server, client, tests) | `npm run typecheck` | Passed |
| Server and shared-logic tests on SQLite | `npm test` | **67/67 passed** |
| Same tests on PostgreSQL 16 | `npm run test:pg` | **67/67 passed** |
| Browser journeys: laptop 1366×900 plus a separate phone context at 375×812, acting as two devices | `npm run build && npm run test:e2e` | **22/22 passed** |

## Revised requirements

| Requirement | Where verified |
| --- | --- |
| Browse without signing in | browse.test "lists, filters, searches and opens events anonymously"; e2e "browsing works without signing in" |
| Central followed-artist list, editable in the app; a change on either device appears on both and reaches scheduled searches | browse.test "changes made on one device appear on another and in the research context"; e2e: an artist added and paused on the laptop is seen paused on the phone and in `/research/v1/context`, then resumed from the phone |
| Protected editing of central data | browse.test "refuses writes without an unlocked editor session"; unlock with throttling and lock; editing stays locked with no passphrase configured; e2e "protected endpoints refuse changes…" |
| Personal data stays on the device | e2e: a favourite, Going and notes set on the laptop are absent on the phone; the server returns no `state` or `bookings` (browse.test) |
| Optional export and import for backup and moving between devices | device-data.test: round trip, validation, merge without duplicates, stronger status kept, both notes kept, bookings re-pointed to an existing entry; e2e: export on the laptop, import on the phone, notes appear, and a re-import adds nothing |
| Calendar and bookings secondary in the interface | e2e: five discovery tabs on the phone, My plans in the header, plan controls collapsed until used |
| Central data preserved across restarts and migrations | research.test "keeps the central artist list, settings and editor sessions after re-imports and a restart"; "migration 0002 keeps any rows from the earlier server-side personal tables" |
| Optional sharing of Going/Booked ids for verification priority | browse.test "shared Going/Booked ids raise verification priority and trigger change alerts; each device replaces only its own set" |

## Original journeys, still covered

| Journey | Where |
| --- | --- |
| Combined city, category, genre and date filters | browse.test (four combinations); e2e combined filters |
| Highlights and All events | browse.test; e2e |
| European artist dates and festival associations | browse.test; e2e |
| Ibiza holiday-date filtering | browse.test; e2e (the stay is saved on the device) |
| Manual bookings and personal plans | e2e: Chase & Status booking entered on the device; personal plan |
| Calendar clashes, overnight events, time zones, multi-day festivals | device-data.test: overlap, possible clash, overnight tail, cancelled, cross-zone, reviewed pairs, needs-a-date; dates.test: DST and overnight; e2e: clash, Keep both, Interested toggle, month view, ICS |
| ICS format | device-data.test: UTC, all-day, escaping, line folding; e2e download |
| Repeated imports, duplicate detection, partial updates, interrupted jobs | research.test (unchanged from before) |
| Accurate research and notification status | research.test; e2e: *Connected* after a token is used, Search now queues, manual import; notifications *Not configured* |
| Mobile usability and keyboard access | e2e: no horizontal scrolling on 13 screens, a Filters toggle on phones, skip link, visible focus, arrow keys, Enter opens a card |

## Not verified here

| Item | Reason | What to do |
| --- | --- | --- |
| Docker image build; deployment to a real host | No Docker daemon or hosting account here | docs/DEPLOYMENT.md |
| Real email delivery | No SMTP provider configured | Set `SMTP_URL` and `EMAIL_FROM`, then use Send a test email |
| ChatGPT connection | Needs the owner's account | docs/RESEARCH_WORKFLOW.md, then `/ping` and a completed run |
| Safari on a real iPhone (storage clean-up behaviour, Home Screen) | Only Chromium was available | Open the deployed site on the iPhone, save a favourite, export a backup |
| Screen-reader walkthrough | Not tested with real assistive technology | Spot-check with VoiceOver and NVDA |
| Real event listings | Only fictional demo data is included | Connect research or use manual import |
