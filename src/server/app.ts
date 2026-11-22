import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import fs from 'node:fs';
import path from 'node:path';
import { ZodError } from 'zod';
import { loadConfig, type Config } from './config';
import type { AppContext } from './context';
import { migrateToLatest, openDatabase, pingDatabase } from './db';
import { applyEditorPasswordFromEnv, siteId } from './auth';
import { apiRoutes } from './routes/api';
import { researchRoutes } from './routes/research';
import { seedWatchlist, loadDemo, demoStatus } from './services/seed';
import { HttpError } from './util';

export interface BuiltApp {
  app: FastifyInstance;
  ctx: AppContext;
  close: () => Promise<void>;
}

export async function buildApp(overrides: Partial<Config> = {}, opts: { now?: () => Date; logger?: boolean } = {}): Promise<BuiltApp> {
  const config = loadConfig(overrides);
  const handle = await openDatabase(config.databaseUrl);
  await migrateToLatest(handle.db);
  const ctx: AppContext = { db: handle.db, dialect: handle.dialect, config, now: opts.now ?? (() => new Date()), sqlitePath: handle.sqlitePath };

  // One central "site" record owns the followed-artist list and shared settings.
  const site = await siteId(ctx);
  await applyEditorPasswordFromEnv(ctx);
  await seedWatchlist(ctx, site);
  if (config.seedDemo && !(await demoStatus(ctx)).loaded) await loadDemo(ctx);

  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: config.trustProxy,
    bodyLimit: 5 * 1024 * 1024,
  });
  await app.register(fastifyCookie);
  // Accept empty JSON bodies (many automation tools send "content-type: application/json" with no body).
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    const text = typeof body === 'string' ? body : body.toString();
    if (!text.trim()) return done(null, {});
    try {
      done(null, JSON.parse(text));
    } catch {
      done(new HttpError(400, 'Request body is not valid JSON'), undefined);
    }
  });

  app.addHook('onSend', async (_req, reply) => {
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'same-origin');
    reply.header('x-frame-options', 'DENY');
    reply.header(
      'content-security-policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self' data:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
    );
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.statusCode).send({ error: err.message, details: err.details });
    if (err instanceof ZodError) return reply.code(422).send({ error: 'Validation failed', details: err.issues });
    const e = err as { statusCode?: number; message?: string; code?: string };
    if (e.statusCode && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message ?? 'Bad request' });
    req.log.error(err);
    console.error(err);
    return reply.code(500).send({ error: 'Something went wrong on the server' });
  });

  app.get('/api/health', async () => {
    await pingDatabase(ctx.db);
    return { ok: true, database: ctx.dialect, time: new Date().toISOString() };
  });

  await apiRoutes(app, ctx);
  await researchRoutes(app, ctx);

  const clientDir = path.resolve(process.cwd(), 'dist/client');
  if (fs.existsSync(path.join(clientDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: clientDir, wildcard: true, maxAge: '1h', index: false });
    app.get('/', (_req, reply) => reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html'));
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      return reply.type('text/html').header('cache-control', 'no-cache').sendFile('index.html');
    });
  } else {
    app.setNotFoundHandler((req, reply) => reply.code(404).send({ error: req.url.startsWith('/api/') ? 'Not found' : 'Client not built. Run `npm run build` or use `npm run dev`.' }));
  }

  return { app, ctx, close: async () => { await app.close(); await handle.close(); } };
}
