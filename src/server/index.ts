import { buildApp } from './app';
import { startScheduler } from './services/runs';

const { app, ctx, close } = await buildApp({}, { logger: process.env.NODE_ENV === 'production' });
const stopScheduler = startScheduler(ctx);
await app.listen({ port: ctx.config.port, host: ctx.config.host });
const owner = await ctx.db.selectFrom('users').select('email').executeTakeFirst();
console.log(`${ctx.config.appName} listening on http://${ctx.config.host}:${ctx.config.port} (database: ${ctx.dialect})`);
if (!owner) console.log('No owner account yet. Set OWNER_EMAIL and OWNER_PASSWORD, or run `npm run owner:create -- --email you@example.com`.');

const shutdown = async () => {
  stopScheduler();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
