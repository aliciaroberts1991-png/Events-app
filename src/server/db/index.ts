import { Kysely, PostgresDialect, SqliteDialect, sql } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import fs from 'node:fs';
import path from 'node:path';
import type { Database } from './types';
import * as m0001 from './migrations/0001_initial';

export type DB = Kysely<Database>;
export type Dialect = 'sqlite' | 'postgres';

/** Migrations are bundled statically so they ship inside the server build. */
const MIGRATIONS: Record<string, Migration> = {
  '0001_initial': m0001,
};

class StaticProvider implements MigrationProvider {
  async getMigrations() {
    return MIGRATIONS;
  }
}

export interface DbHandle {
  db: DB;
  dialect: Dialect;
  close: () => Promise<void>;
  sqlitePath?: string;
}

/**
 * DATABASE_URL forms:
 *   sqlite:/absolute/path/quartet.db   (default: ./data/quartet.db)
 *   sqlite::memory:
 *   postgres://user:pass@host:5432/dbname
 */
export async function openDatabase(url: string): Promise<DbHandle> {
  if (url.startsWith('postgres://') || url.startsWith('postgresql://')) {
    const pg = await import('pg');
    // Keep NUMERIC/float columns as JS numbers.
    pg.default.types.setTypeParser(701, (v: string) => parseFloat(v));
    pg.default.types.setTypeParser(1700, (v: string) => parseFloat(v));
    pg.default.types.setTypeParser(20, (v: string) => parseInt(v, 10));
    const pool = new pg.default.Pool({ connectionString: url, max: 10 });
    const db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) });
    return { db, dialect: 'postgres', close: () => db.destroy() };
  }
  const file = url.replace(/^sqlite:/, '') || ':memory:';
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const { default: Database } = await import('better-sqlite3');
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('synchronous = NORMAL');
  const db = new Kysely<Database>({ dialect: new SqliteDialect({ database: sqlite }) });
  return { db, dialect: 'sqlite', close: () => db.destroy(), sqlitePath: file === ':memory:' ? undefined : file };
}

export async function migrateToLatest(db: DB): Promise<string[]> {
  const migrator = new Migrator({ db, provider: new StaticProvider() });
  const { error, results } = await migrator.migrateToLatest();
  if (error) throw error;
  return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
}

export async function pingDatabase(db: DB): Promise<boolean> {
  await sql`select 1`.execute(db);
  return true;
}
