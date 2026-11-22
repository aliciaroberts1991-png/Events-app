# Quartet

A personal **events discovery** app for phone and laptop, built around Bratislava, Vienna, Budapest
and Prague and their surrounding areas. It also covers European appearances by followed artists,
European music festivals and Ibiza. Personal planning (saved events, plans, bookings, clashes) is a
secondary feature.

The app is named Quartet after the four cities. Change the name with `APP_NAME`.

## Where data lives

| Data | Where | Who can change it |
| --- | --- | --- |
| Event listings, research results, festivals, Ibiza residencies, run history | Central database | Research executor (API token), or the editor via manual import and shared listings |
| **Followed-artist list**, interests, places, schedule, notification settings | Central database, shared by every device and read by every scheduled search | Anyone browsing can view it; changes need the **editor passphrase** |
| Favourites, hidden events, Interested/Going/Booked, notes, bookings, your own entries, personal plans, clash reviews, "fewer like this", Ibiza stays | **Each device's browser storage** | That device. Export and import a file to back up or copy to another device. |

**Browsing needs no sign-in.** Editing central data is unlocked once per device with the editor
passphrase (`EDITOR_PASSWORD`), and the device stays unlocked for 90 days of use.

## Features

- **Discover:** a Highlights / All events toggle. Filters for city, nearby radius, dates (Today, This weekend, Next weekend, This month, custom), categories, genres and English-friendly events can be combined. Results sort by date, relevance or recently added.
- **Cities:** browse city by city or all four together, grouped by category.
- **Festivals:** two scopes, Nearby and Across Europe. Each festival edition gets one card, showing your artists' days and formats.
- **Artists:** the central followed-artist list, with aliases and identifying links. Artists can be added, paused or removed. Each one shows upcoming European appearances.
- **Ibiza:** a season selector and residencies by venue and weekday. Enter your holiday dates to see the parties that overlap them. Openings and closings are listed separately.
- **Event pages:** lineup with set times and live/DJ-set format, ticket and sale details, sources and verification status.
- **My plans** (secondary): favourites, agenda and month calendar, clash detection, ICS download, history, personal plans and hidden events. Everything here is stored on the device.
- **Research integration:** an authenticated API with a job queue. Daily discovery and weekly verification can be scheduled. Imports are idempotent and accept partial updates, and manual JSON import is also available.

## Quick start (local)

Requirements: Node.js 22.12 or newer. Nothing else is needed, because the default database is a SQLite file.

```bash
npm install
cp .env.example .env
# edit .env for local use:
#   EDITOR_PASSWORD                passphrase that unlocks editing of shared data
#   DATABASE_URL=sqlite:./data/quartet.db
#   COOKIE_SECURE=false            (plain http on localhost)
#   SEED_DEMO=true                 (optional fictional demo data)
npm run build
npm start                       # reads .env; open http://localhost:3000
```

For development with hot reload, run `npm run dev`. The API runs on :3000 and Vite on :5173.

`SEED_DEMO=true` loads **fictional demo data**. It is labelled "Demo" everywhere, and you can
remove it in Settings → Research and updates.

## Tests

```bash
npm test                 # server and shared-logic tests on SQLite
npm run test:pg          # the same tests on PostgreSQL (needs TEST_PG_ADMIN_URL or local postgres)
npm run build && npm run test:e2e   # browser journeys on desktop and phone (Playwright + Chromium)
npm run typecheck
```

## Documentation

| Document | For |
| --- | --- |
| [docs/HANDOVER.md](docs/HANDOVER.md) | **Start here** (ChatGPT or another developer): what exists, what still needs configuring, in order |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Stack choice, data model, key behaviours |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Hosting options, environment variables, accounts and costs |
| [docs/RESEARCH_API.md](docs/RESEARCH_API.md) | Research API reference, JSON schema, examples |
| [docs/RESEARCH_WORKFLOW.md](docs/RESEARCH_WORKFLOW.md) | Daily discovery, weekly verification, connecting ChatGPT, adapting the existing Bratislava automation |
| [docs/BACKUP.md](docs/BACKUP.md) | Backups, restore, export/import of personal data |
| [docs/VERIFICATION.md](docs/VERIFICATION.md) | What has been verified, and how |
| [examples/](examples/) | Example import payloads (validated by the tests) |
| [docs/schemas/](docs/schemas/) | Generated JSON Schema and OpenAPI files |

## Project layout

```
src/shared/      taxonomy, date/time rules, research JSON schemas (used by server and client)
src/server/      Fastify app, database (Kysely), migrations, services, routes, CLI
src/client/      React app (pages, components, styles)
tests/server/    API and service tests (SQLite and PostgreSQL)
scripts/         dev runner, server build, schema generation, reference executor, e2e tests
docs/            documentation and generated schemas
examples/        example research payloads
```
