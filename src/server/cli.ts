// Maintenance commands. Run with `npm run <script>` (development) or
// `node dist/server/cli.js <command>` (production build).
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { loadConfig } from './config';
import { migrateToLatest, openDatabase } from './db';
import type { AppContext } from './context';
import { createApiToken, setEditorPassword, siteId } from './auth';
import { loadDemo, removeDemo, seedWatchlist } from './services/seed';
import { nowIso } from './util';

const [, , command, ...rest] = process.argv;
const arg = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

async function ctxOpen(): Promise<{ ctx: AppContext; close: () => Promise<void> }> {
  const config = loadConfig();
  const h = await openDatabase(config.databaseUrl);
  await migrateToLatest(h.db);
  return { ctx: { db: h.db, dialect: h.dialect, config, now: () => new Date(), sqlitePath: h.sqlitePath }, close: h.close };
}

async function prompt(q: string) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const a = await rl.question(q);
  rl.close();
  return a;
}

const { ctx, close } = await ctxOpen();
try {
  switch (command) {
    case 'migrate':
      console.log('Database is up to date.');
      break;
    case 'editor-password':
    case 'owner': {
      const password = arg('password') ?? process.env.EDITOR_PASSWORD ?? (await prompt('New editor passphrase (min 10 characters): '));
      await siteId(ctx);
      await setEditorPassword(ctx, password);
      await seedWatchlist(ctx, await siteId(ctx));
      console.log('Editor passphrase set. Unlock editing in the app with it (Settings → Editing).');
      break;
    }
    case 'token': {
      const name = arg('name') ?? 'Research executor';
      const t = await createApiToken(ctx, name, null);
      console.log(`Research API token for "${name}" (shown once — store it as a secret):\n${t.token}`);
      break;
    }
    case 'demo-load':
      console.log(JSON.stringify((await loadDemo(ctx)).counts));
      break;
    case 'demo-remove':
      console.log(JSON.stringify(await removeDemo(ctx)));
      break;
    case 'backup': {
      if (ctx.dialect !== 'sqlite' || !ctx.sqlitePath) {
        console.log('For PostgreSQL use: pg_dump --format=custom "$DATABASE_URL" > backup.dump');
        break;
      }
      const dir = path.resolve(arg('dir') ?? 'backups');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `quartet-${nowIso().replace(/[:.]/g, '-')}.db`);
      const { default: Database } = await import('better-sqlite3');
      const db = new Database(ctx.sqlitePath, { readonly: true });
      await db.backup(file);
      db.close();
      console.log(`Backup written to ${file}`);
      break;
    }
    default:
      console.log('Commands: migrate | editor-password [--password …] | token [--name …] | demo-load | demo-remove | backup [--dir …]');
  }
} finally {
  await close();
}
