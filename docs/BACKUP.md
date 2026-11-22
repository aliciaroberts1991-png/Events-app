# Backup and recovery

There are two kinds of data, backed up in different ways:

- **Personal data on each device**, in browser storage. It covers:
  - favourites, hidden events and Interested/Going/Booked
  - notes and bookings
  - your own entries and personal plans
  - clash reviews, "fewer like this" and Ibiza stays

  It is not on the server, so a server backup does not contain it.
- **Central data on the server.** It covers:
  - the followed-artist list
  - interests, places, schedule and notification settings
  - listings, research history and the update feed

## 1. Device data: export and import (from the app, no editing access needed)

Settings → This device → **Export this device's data** downloads a JSON file. Its format is `quartet-device-data`, version 1, with the schema in `docs/schemas/device-data-export.schema.json`. Event references are the central ids, which are the same on every device, together with a readable snapshot of each listing's title and date.

**Import** (Settings → This device → Import a file):
- A **preview** comes first.
- **Merge** never deletes anything. Duplicates are skipped:
  - entries with the same title, start and city
  - bookings with the same target, reference, provider and amount
  - plans with the same title and start
  - stays with the same dates
- For an event saved on both devices:
  - the stronger plan status is kept
  - favourites are combined
  - the more recent hidden/date choice wins
  - differing notes are kept side by side
- Importing the same file twice changes nothing.

The same file also moves your plans between your phone and your laptop: export on one, import on the other.

**Keeping device data safe:**
- Browsers can clear website storage. Safari on iPhone does so after weeks without a visit, and private windows keep nothing.
- The app asks the browser for persistent storage and shows the result under Settings → This device.
- Adding the app to the iPhone Home Screen and exporting a backup now and then is recommended. Settings shows the last backup date.
- If stored data can ever not be read, it is copied to a recovery key in localStorage rather than discarded.

## 2. Central data: database backups

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
| Server or volume lost | Deploy again and restore the latest database backup (or `pg_restore`), then start. Migrations bring an older backup up to date automatically. Device data is unaffected. |
| No database backup | Deploy fresh. Re-add the followed artists and settings (unlock editing first), then let research rebuild the listings. Saved events on your devices refer to the old ids, so they show under "no longer available" with their remembered titles until research finds them again. |
| Phone or browser data lost | Import your latest device export (Settings → This device). |
| Bad research import | Correct it with a further import: partial updates work, and `null` clears fields. For a full rollback, restore the database backup taken before the import. |
| Forgotten editor passphrase | Set `EDITOR_PASSWORD` and restart, or run `node dist/server/cli.js editor-password --password '<new>'`. |
| Lost or stolen device that was unlocked for editing | Settings → Editing access → lock that device, or change the passphrase (which locks every other device). |
| Leaked research token | Settings → Research → Revoke, then create a new token. |
| Moving SQLite to PostgreSQL | Back up first. Then copy the central tables with a migration script of your choice, or start fresh as in "No database backup". Device data is unaffected either way. |

## 4. Upgrades

- Migrations are numbered and run at start-up.
- Back up before deploying a new version.
- Never edit an existing migration: add the next number, e.g. `0003_….ts`, and register it in `src/server/db/index.ts`.
