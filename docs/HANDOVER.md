# Handover (for ChatGPT or another developer)

## What this is

**Quartet** is a complete, tested web app for **discovering events** on a phone and a laptop. It covers:
- events in Bratislava, Vienna, Budapest and Prague, plus surrounding areas
- a followed-artist list tracked across Europe
- music festivals, nearby and across Europe
- Ibiza residencies and parties

Personal planning is secondary: saved events, plans, bookings, clashes and ICS.

- **Central:** listings, research results and the followed-artist list, plus interests, places, schedule and notification settings. A change on either device shows up on both and is read by every scheduled search.
- **On each device:** favourites, statuses, notes, bookings, own entries and plans, in browser storage, with export and import for backup and copying between devices.
- **Access:** browsing needs no sign-in. Changing central data needs the editor passphrase (`EDITOR_PASSWORD`), unlocked once per device.

It is designed to be fed by an external research executor through an authenticated API.

- Stack: Node 22, TypeScript, Fastify, Kysely, React. Database: SQLite (default) or PostgreSQL.
- Run: `npm ci && npm run build && npm start`. It is one process serving the API and the web app.
- Tests: `npm test` (67), `npm run test:pg` (67), `npm run test:e2e` (22 browser journeys). All pass. See docs/VERIFICATION.md.

## Your tasks, in order

1. **Choose hosting and the database** (docs/DEPLOYMENT.md).
   - Simplest: one always-on container with a 1 GB volume at `/data` and SQLite.
   - Fly.io, Render and Docker Compose configs are included.
   - Do not use scale-to-zero hosting.
2. **Set secrets** on the host: `EDITOR_PASSWORD` (at least 10 characters) and `PUBLIC_URL`. Set `DATABASE_URL` only if using PostgreSQL.
3. **Deploy and smoke test.**
   - `GET /api/health` returns `ok: true`.
   - The site opens and can be browsed without signing in.
   - Settings → Editing access → Unlock editing works with the passphrase.
   - Settings → Research shows *Awaiting connection*. That is the correct state at this point.
4. **Create a research token** (Settings → Research → Create token, with editing unlocked). Store it as a secret where the executor runs.
5. **Verify the connection with a real authenticated update:**
   ```bash
   RESEARCH_API=$PUBLIC_URL/api/research/v1 RESEARCH_TOKEN=qrt_… node scripts/reference-executor.mjs --ping
   ```
   Expect *Connected*. Then run one real discovery (step 6). The status becomes *Operational* only after a run completes.
6. **Connect scheduled research** (docs/RESEARCH_WORKFLOW.md).
   - Pick option A (Custom GPT Actions using `/api/research/v1/openapi.json`), B (an agent with HTTPS access), C (a scheduled worker using an LLM API) or D (manual import).
   - The app queues daily discovery (05:30) and weekly verification (Monday 06:30) itself, in Europe/Bratislava time. The executor claims those runs, or starts its own with `POST /runs`.
   - Adapt the existing Bratislava automation as described in that document.
7. **Optional email alerts.** Set `SMTP_URL` and `EMAIL_FROM`. Settings → Notifications → Send a test email. The status must read *Working*.
8. **Tell the owner what is operational.** Only report hosting, database, research scheduling and email as working after you have seen each succeed. The app shows each state honestly in Settings.

## Account-owner steps (cannot be done by an assistant without the owner)

| Step | Who |
| --- | --- |
| Create or choose the hosting account and payment method | Owner |
| Domain and DNS (optional) | Owner |
| SMTP provider account and sender-domain verification (optional) | Owner |
| ChatGPT plan, and enabling Actions, agents or tasks as available | Owner |
| Choosing the editor passphrase | Owner (set as `EDITOR_PASSWORD`) |
| Entering the real Chase & Status booking | Owner, in the app on the device they want it on: Artists → Chase & Status → "Add a show you've already booked". It is stored on that device; export and import to copy it to the other device. |
| Removing demo data before real use | Owner: Settings → Research and updates → Remove demo data (editing unlocked) |

## Where things are

| Need | Location |
| --- | --- |
| Research API reference and schema | docs/RESEARCH_API.md, docs/schemas/research-import.schema.json, `/api/research/v1/openapi.json` |
| Example requests | examples/ (validated by tests) |
| Discovery and verification prompts | docs/RESEARCH_WORKFLOW.md |
| Data model and behaviour | docs/ARCHITECTURE.md, src/server/db/migrations/ |
| Device data (local storage, export and import, merge) | src/client/lib/local.ts, src/shared/local-data.ts |
| Access model (open browsing, editor passphrase) | src/server/auth.ts, src/server/routes/api.ts |
| Import engine (dedupe, partial updates, idempotency) | src/server/services/import.ts |
| Highlight scoring | src/server/services/preferences.ts (`scoreEvent`) |
| Taxonomy (categories, genres, cities) | src/shared/taxonomy.ts |
| Date and time rules | src/shared/dates.ts |
| Backups and recovery | docs/BACKUP.md |

## Rules to keep when changing the code

- Never edit `0001_initial.ts`. Add a new numbered migration and register it in `src/server/db/index.ts`.
- Personal planning data belongs on devices (`src/client/lib/local.ts`). Do not add server storage for notes, statuses or bookings: the requirements keep them local, with export and import.
- Research must never write `watchlist`, `user_preferences` or listings added through the app (`origin = 'manual'`).
- Every write route in `src/server/routes/api.ts` that changes central data belongs inside the editor-only block.
- Keep SQL portable across SQLite and PostgreSQL. Run both test suites.
- After changing `src/shared/research-schema.ts`, run `npm run docs:schema` and update examples/.
- Use British English in the interface.
