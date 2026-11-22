# Backup and recovery

Personal records are the irreplaceable part: watchlist, preferences, statuses, notes, bookings,
your own events and plans. Research data can always be collected again.

## 1. Personal data export (any database, from the app)

Settings → Your data → **Export my data** downloads a JSON file (format `quartet-personal-export`,
version 1, schema in `docs/schemas/personal-export.schema.json`). It contains:
- preferences
- watchlist, with aliases, links and keys
- your own events, in full
- statuses, favourites, hidden flags and notes
- bookings
- personal plans
- clash reviews
- "fewer like this" feedback
- Ibiza stays

Event references carry the id **and** identifying facts (title, date, city, source keys).

**Import** (Settings → Your data → Choose export file):
- A **preview** comes first. It shows what will be added, what is already present and what cannot be matched.
- **Merge** never deletes anything. Duplicates are skipped:
  - bookings with the same reference, provider and amount
  - plans with the same title and start
  - your own events with the same title, date and city
- Existing notes are kept; differing notes are appended.
- Preferences are only replaced if you choose "Import and replace preferences".
- An event that no longer exists is matched by its source keys, or by title, date and city. Anything still unmatched is reported, not lost: re-import after research has collected the event again.

Export after significant changes, and keep copies off the server.

## 2. Full database backups

### SQLite (default)
- Consistent online backup (safe while running):
  `node dist/server/cli.js backup --dir /data/backups`. In development: `npm run backup`.
- Copy the file off the server, e.g. to object storage or your computer.
- Alternatively, stop the app and copy `quartet.db`. The database uses WAL mode, so copy `quartet.db-wal` and `quartet.db-shm` too if they exist.
- Example nightly cron on a VPS:
  `0 3 * * * cd /app && node dist/server/cli.js backup --dir /backups && find /backups -name 'quartet-*.db' -mtime +30 -delete`
- On Fly.io, volume snapshots are taken daily by default. Check `fly volumes snapshots list`.

### PostgreSQL
- Backup: `pg_dump --format=custom "$DATABASE_URL" > quartet-$(date +%F).dump`
- Restore into an empty database: `pg_restore --no-owner --dbname "$DATABASE_URL" quartet-YYYY-MM-DD.dump`
- Managed providers usually offer point-in-time recovery; enable it.

## 3. Recovery procedures

| Situation | Steps |
| --- | --- |
| Server or volume lost | Deploy again, restore the latest database backup to the volume (or `pg_restore`), then start. Migrations bring an older backup up to date automatically. |
| No database backup, but a personal export | Deploy fresh, sign in, import the export (merge). Let research run to rebuild listings, then import the export again to attach any statuses that could not yet be matched. |
| Bad research import | Listings can be corrected by a further import, because partial updates and `null` clear fields. Personal data is unaffected. To roll back completely, restore the database backup taken before the import. |
| Forgotten password | `node dist/server/cli.js owner --email you@example.com --password '<new>'` |
| Leaked research token | Settings → Research → Revoke, then create a new token. |
| Moving SQLite to PostgreSQL | Export personal data, deploy with `DATABASE_URL=postgres://…`, import the export. Research data is collected again, or re-imported from your research JSON files. |

## 4. Upgrades

- Migrations are numbered and run at start-up.
- Back up before deploying a new version.
- Never edit an existing migration: add `0002_….ts` and register it in `src/server/db/index.ts`.
