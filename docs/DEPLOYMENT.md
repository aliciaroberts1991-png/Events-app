# Deployment

The app is one Node.js process with either a SQLite file or a PostgreSQL database. It must stay
running, because the scheduler and run leases work inside the process. Do not use a platform that
scales the app to zero.

## Accounts, credentials and costs

| What | Needed? | Notes | Typical cost (check current pricing) |
| --- | --- | --- | --- |
| A host for one small always-on container | **Yes** | Fly.io, Render, Railway or a small VPS (e.g. Hetzner). 256–512 MB RAM is enough. | about €4–8 per month |
| Persistent storage | **Yes** | A 1 GB volume or disk for SQLite, **or** a managed PostgreSQL database | Volume: cents per month. Managed Postgres: €0–15 per month |
| A domain with HTTPS | Recommended | The platform's own subdomain also works | €0–15 per year |
| SMTP email provider | Optional (email alerts) | Any provider with SMTP credentials, e.g. Brevo, Resend, Mailgun, or your mail host. Set `SMTP_URL` and `EMAIL_FROM`. | Free tiers usually suffice |
| Research executor | Needed for automatic updates | ChatGPT (see RESEARCH_WORKFLOW.md) or any script calling the API. Without it, use manual import. | Your ChatGPT plan, or API usage if you use the OpenAI API |
| GitHub | Optional | CI workflow included (`.github/workflows/ci.yml`) | Free |

There are no other external services. Fonts and icons are bundled, and no analytics are included.

## Environment variables

See `.env.example` for all variables. The minimum for production:

```
OWNER_EMAIL=…            # first start creates the owner account
OWNER_PASSWORD=…         # at least 10 characters; can be removed after the first start
PUBLIC_URL=https://…     # used in emails, ICS links and the OpenAPI document
DATABASE_URL=sqlite:/data/quartet.db   # or postgres://…
```

`COOKIE_SECURE` defaults to `true` when `NODE_ENV=production`. That is correct behind HTTPS. Set it to `false` only for plain-http testing.

## Option A — Docker on any host (SQLite)

```bash
cp .env.example .env      # edit values
docker compose up -d --build
# visit http://server:3000 (put it behind HTTPS, e.g. Caddy or the platform's proxy)
```

Data lives in the `quartet-data` volume, mounted at `/data`.

## Option B — Fly.io (SQLite on a volume)

```bash
fly launch --no-deploy          # accept the existing fly.toml or edit app name/region
fly volumes create quartet_data --size 1 --region vie
fly secrets set OWNER_EMAIL=… OWNER_PASSWORD=… PUBLIC_URL=https://<app>.fly.dev
fly deploy
```

Keep `min_machines_running = 1` and `auto_stop_machines = "off"`. Use a single machine: SQLite is
single-writer. For more than one machine, use PostgreSQL.

## Option C — Render (Docker, persistent disk)

Use `render.yaml` as a Blueprint, or create a Docker web service with a 1 GB disk mounted at `/data`.
Then set `OWNER_EMAIL`, `OWNER_PASSWORD` and `PUBLIC_URL`. A persistent disk needs a paid instance
type.

## Option D — PostgreSQL

Set `DATABASE_URL=postgres://user:pass@host:5432/dbname`. Migrations run automatically at start-up.
Any managed PostgreSQL 13+ works (Neon, Supabase, Railway, Render, RDS). Docker Compose includes an
optional `postgres` profile.

## Without Docker

```bash
npm ci
npm run build
npm prune --omit=dev
NODE_ENV=production DATABASE_URL=sqlite:/var/lib/quartet/quartet.db node dist/server/index.js
```

Building `better-sqlite3` needs a C toolchain only if no prebuilt binary is available for the
platform.

## After the first deploy

1. Open the site and sign in with `OWNER_EMAIL` / `OWNER_PASSWORD`.
2. Settings → Research and updates → **Create token**. Store the token as a secret in the research executor.
3. Verify the connection with a real authenticated write:
   ```bash
   RESEARCH_API=https://your-app/api/research/v1 RESEARCH_TOKEN=qrt_… node scripts/reference-executor.mjs --ping
   ```
   The status changes from *Awaiting connection* to *Connected*. It reads *Operational* only after a discovery or verification run has completed.
4. Optional email: set `SMTP_URL` and `EMAIL_FROM`, restart, then Settings → Notifications → **Send a test email**. The status shows *Working* only after the provider accepts a message.
5. Optional demo data: Settings → Your data → Load demo data. Remove it before relying on real listings.

## Command-line maintenance

Use `npm run <script>` in development. In production, use `node dist/server/cli.js <command>`.

| Command | Purpose |
| --- | --- |
| `owner --email you@x --password …` | Create the owner, or reset the password |
| `token --name "ChatGPT"` | Create a research API token (printed once) |
| `migrate` | Run migrations (they also run at start-up) |
| `backup [--dir backups]` | Consistent SQLite backup file |
| `demo-load` / `demo-remove` | Load or remove fictional demo data |

## Health and logs

- `GET /api/health` returns `{ ok, database }`. Use it for platform health checks.
- In production, logs are JSON on stdout.
