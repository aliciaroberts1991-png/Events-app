import { buildApp } from './app';
import { startScheduler } from './services/runs';

const { app, ctx, close } = await buildApp({}, { logger: process.env.NODE_ENV === 'production' });
const stopScheduler = startScheduler(ctx);
await app.listen({ port: ctx.config.port, host: ctx.config.host });
console.log(`${ctx.config.appName} listening on http://${ctx.config.host}:${ctx.config.port} (database: ${ctx.dialect})`);
const { editingConfigured } = await import('./auth');
if (!(await editingConfigured(ctx))) console.log('Editing is locked: set EDITOR_PASSWORD (or run `npm run editor:password`) to enable changes to the artist list and settings. Browsing works without it.');

const shutdown = async () => {
  stopScheduler();
  await close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
