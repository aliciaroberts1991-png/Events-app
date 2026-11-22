import crypto from 'node:crypto';
import pg from 'pg';
import { buildApp, type BuiltApp } from '../../src/server/app';
import { createApiToken, createUser } from '../../src/server/auth';
import { seedWatchlist } from '../../src/server/services/seed';

/** Fixed "now": Sunday 22 November 2026, 10:00 in Bratislava. */
export const FIXED_NOW = new Date('2026-11-22T09:00:00Z');

export interface TestEnv extends BuiltApp {
  clock: { now: Date };
  cookie: string;
  token: string;
  userId: string;
  dbUrl: string;
  api: (method: string, url: string, body?: unknown, opts?: { cookie?: string | null; csrf?: boolean }) => Promise<{ status: number; body: any; headers: Record<string, unknown> }>;
  research: (method: string, url: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; body: any }>;
  login: () => Promise<string>;
}

export async function freshDatabaseUrl(): Promise<string> {
  if (process.env.TEST_DATABASE === 'postgres') {
    const admin = process.env.TEST_PG_ADMIN_URL ?? 'postgres://postgres@127.0.0.1:5432/postgres';
    const name = `quartet_test_${crypto.randomBytes(4).toString('hex')}`;
    const c = new pg.Client({ connectionString: admin });
    await c.connect();
    await c.query(`create database ${name}`);
    await c.end();
    return admin.replace(/\/[^/]*$/, `/${name}`);
  }
  return 'sqlite::memory:';
}

export async function setup(opts: { dbUrl?: string; seedOwner?: boolean } = {}): Promise<TestEnv> {
  const clock = { now: new Date(FIXED_NOW) };
  const dbUrl = opts.dbUrl ?? (await freshDatabaseUrl());
  const built = await buildApp(
    { databaseUrl: dbUrl, schedulerEnabled: true, cookieSecure: false, ownerEmail: null, ownerPassword: null, seedDemo: false, researchWebhookUrl: null, smtpUrl: null, emailFrom: null, publicUrl: 'https://quartet.example' },
    { now: () => clock.now },
  );
  let userId = (await built.ctx.db.selectFrom('users').select('id').executeTakeFirst())?.id;
  if (!userId && opts.seedOwner !== false) {
    userId = await createUser(built.ctx, 'owner@example.com', 'correct horse battery', 'Owner');
    await seedWatchlist(built.ctx, userId);
  }
  const { token } = await createApiToken(built.ctx, 'test executor', userId ?? null);

  const env = { ...built, clock, cookie: '', token, userId: userId!, dbUrl } as TestEnv;
  env.api = async (method, url, body, o = {}) => {
    const headers: Record<string, string> = {};
    const cookie = o.cookie === undefined ? env.cookie : o.cookie;
    if (cookie) headers.cookie = cookie;
    if (o.csrf !== false) headers['x-quartet-csrf'] = '1';
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await built.app.inject({ method: method as never, url, headers, payload: body === undefined ? undefined : JSON.stringify(body) });
    let parsed: unknown = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* text */
    }
    return { status: res.statusCode, body: parsed, headers: res.headers };
  };
  env.research = async (method, url, body, headers = {}) => {
    const res = await built.app.inject({
      method: method as never,
      url: `/api/research/v1${url}`,
      headers: { authorization: `Bearer ${env.token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      payload: body === undefined ? undefined : JSON.stringify(body),
    });
    let parsed: unknown = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* empty */
    }
    return { status: res.statusCode, body: parsed };
  };
  env.login = async () => {
    const res = await built.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: JSON.stringify({ email: 'owner@example.com', password: 'correct horse battery' }) });
    if (res.statusCode !== 200) throw new Error(`login failed ${res.statusCode} ${res.body}`);
    const c = res.cookies.find((x) => x.name === 'quartet_session')!;
    return `quartet_session=${c.value}`;
  };
  if (userId) env.cookie = await env.login();
  return env;
}

/** A small, realistic research payload used across tests (fictional venues/artists). */
export function samplePayload() {
  return {
    events: [
      {
        ref: 'dnb-bratislava',
        source_keys: ['test:evt:dnb-1'],
        title: 'Roller Night',
        start: '2026-11-28T22:00',
        end: '05:00',
        timezone: 'Europe/Bratislava',
        venue: { key: 'test:venue:club', name: 'Test Club', city: 'Bratislava', country: 'SK', lat: 48.145, lng: 17.11 },
        categories: ['dnb'],
        genres: ['liquid-dnb'],
        lineup: [{ name: 'Chase & Status', billing: 'headliner', format: 'dj_set' }],
        tickets: { url: 'https://tickets.example/roller', price_min: 20, currency: 'EUR', status: 'available', presale_at: '2026-11-25T10:00', sale_timezone: 'Europe/Bratislava' },
        prominence: 50,
        sources: [{ url: 'https://venue.example/roller', type: 'venue', name: 'Test Club' }],
        verified_at: '2026-11-21T12:00:00Z',
      },
      {
        ref: 'vienna-wine',
        source_keys: ['test:evt:wine-1'],
        title: 'Vienna Wine Weekend',
        start: '2026-11-28',
        end: '2026-11-29',
        timezone: 'Europe/Vienna',
        venue: { name: 'Wine Hall', city: 'Vienna', country: 'AT', lat: 48.2, lng: 16.37 },
        categories: ['wine'],
        prominence: 40,
        languages: ['de'],
        language_importance: 'helpful',
      },
      {
        ref: 'prague-comedy',
        source_keys: ['test:evt:comedy-1'],
        title: 'English Comedy Night',
        start: '2026-11-27T20:00',
        end: '22:00',
        timezone: 'Europe/Prague',
        venue: { name: 'Laugh Bar', city: 'Prague', country: 'CZ', lat: 50.08, lng: 14.42 },
        categories: ['stand-up', 'english-comedy'],
        languages: ['en'],
        language_importance: 'essential',
        prominence: 35,
      },
      {
        ref: 'small-house',
        source_keys: ['test:evt:house-small'],
        title: 'Tiny House Session',
        start: '2026-11-27T21:00',
        timezone: 'Europe/Bratislava',
        venue: { name: 'Back Room', city: 'Bratislava', country: 'SK', lat: 48.14, lng: 17.1 },
        categories: ['house'],
        genres: ['deep-house'],
        prominence: 5,
      },
      {
        ref: 'hainburg-hike',
        title: 'Ridge Hike',
        start: '2026-11-29T09:00',
        end: '2026-11-29T13:00',
        timezone: 'Europe/Vienna',
        venue: { name: 'Trailhead', city: 'Hainburg an der Donau', country: 'AT', lat: 48.1468, lng: 16.9419 },
        categories: ['hike'],
        participation: 'participant',
      },
      {
        ref: 'festival',
        kind: 'festival',
        source_keys: ['test:evt:fest-1'],
        title: 'Summer Bass Festival 2027',
        festival: { name: 'Summer Bass Festival', edition: '2027', series_key: 'test:fes:summer-bass' },
        start: '2027-07-09',
        end: '2027-07-11',
        timezone: 'Europe/Bratislava',
        venue: { name: 'Festival Island', city: 'Šamorín', country: 'SK', lat: 48.03, lng: 17.31 },
        categories: ['music-festival', 'dnb'],
        lineup: [
          { name: 'Chase & Status', billing: 'headliner', format: 'live', date: '2027-07-10' },
          { name: 'Bicep', billing: 'headliner', format: 'dj_set', date: '2027-07-11' },
        ],
        camping: { available: true },
      },
      {
        ref: 'euro-festival',
        kind: 'festival',
        title: 'Coastline Sounds 2027',
        festival: { name: 'Coastline Sounds', edition: '2027' },
        start: '2027-06-18',
        end: '2027-06-20',
        timezone: 'Europe/Lisbon',
        venue: { name: 'Coast Park', city: 'Lisbon', country: 'PT', lat: 38.72, lng: -9.14 },
        categories: ['music-festival'],
        lineup: [{ name: 'Maribou State', billing: 'headliner', format: 'live', date: '2027-06-19' }],
      },
    ],
  };
}
