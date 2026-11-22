import type { Config } from './config';
import type { DB, Dialect } from './db';

export interface AppContext {
  db: DB;
  dialect: Dialect;
  config: Config;
  /** Injectable clock (tests use a fixed time). */
  now: () => Date;
  sqlitePath?: string;
}
