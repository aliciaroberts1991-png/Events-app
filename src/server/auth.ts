// Access model (revised requirements)
// - Browsing is open: no sign-in is needed to read listings, artists or status.
// - Central data (followed artists, interests, places, schedule, notifications, imports,
//   tokens, shared listings) is owned by one "site" record and can only be changed after
//   unlocking editing with the editor passphrase. Unlocking creates a long-lived,
//   server-side editor session for that device (httpOnly cookie).
// - Research executors use bearer tokens.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from './context';
import { HttpError, newId, nowIso, sha256 } from './util';
import { setSetting } from './services/import';

const scrypt = promisify(crypto.scrypt) as (pw: string, salt: Buffer, len: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const SCRYPT = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${SCRYPT.N}$${SCRYPT.r}$${SCRYPT.p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !hash) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(expected, actual);
}

export const SESSION_COOKIE = 'quartet_editor';

let siteIdCache: { db: unknown; id: string } | null = null;

/** The single record that owns central settings and the followed-artist list. */
export async function siteId(ctx: AppContext): Promise<string> {
  if (siteIdCache && siteIdCache.db === ctx.db) return siteIdCache.id;
  let row = await ctx.db.selectFrom('users').select('id').orderBy('created_at').executeTakeFirst();
  if (!row) {
    const t = nowIso();
    const id = newId('usr');
    await ctx.db
      .insertInto('users')
      .values({ id, email: (ctx.config.ownerEmail ?? 'editor@local').toLowerCase(), display_name: 'Site', password_hash: '', created_at: t, updated_at: t })
      .onConflict((oc) => oc.column('email').doNothing())
      .execute();
    row = await ctx.db.selectFrom('users').select('id').orderBy('created_at').executeTakeFirstOrThrow();
  }
  siteIdCache = { db: ctx.db, id: row.id };
  return row.id;
}

/** EDITOR_PASSWORD (when set) is the source of truth for the editor passphrase. */
export async function applyEditorPasswordFromEnv(ctx: AppContext) {
  const id = await siteId(ctx);
  const pw = ctx.config.editorPassword;
  if (!pw) return;
  const row = await ctx.db.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirstOrThrow();
  if (row.password_hash && (await verifyPassword(pw, row.password_hash))) return;
  await setEditorPassword(ctx, pw);
}

export async function setEditorPassword(ctx: AppContext, password: string) {
  if (password.length < 10) throw new HttpError(400, 'Use a passphrase of at least 10 characters');
  const id = await siteId(ctx);
  await ctx.db.updateTable('users').set({ password_hash: await hashPassword(password), updated_at: nowIso() }).where('id', '=', id).execute();
}

export async function editingConfigured(ctx: AppContext) {
  const id = await siteId(ctx);
  const row = await ctx.db.selectFrom('users').select('password_hash').where('id', '=', id).executeTakeFirst();
  return !!row?.password_hash;
}

export async function createSession(ctx: AppContext, userId: string, userAgent: string | undefined) {
  const token = crypto.randomBytes(32).toString('base64url');
  const t = ctx.now();
  const expires = new Date(t.getTime() + ctx.config.sessionDays * 86400_000);
  await ctx.db
    .insertInto('sessions')
    .values({ id: sha256(token), user_id: userId, created_at: t.toISOString(), last_seen_at: t.toISOString(), expires_at: expires.toISOString(), user_agent: userAgent?.slice(0, 300) ?? null })
    .execute();
  return { token, expires };
}

export function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string, expires: Date) {
  reply.setCookie(SESSION_COOKIE, token, { httpOnly: true, secure: ctx.config.cookieSecure, sameSite: 'lax', path: '/', expires });
}

export interface EditorSession {
  site_id: string;
  session_id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    editor?: EditorSession;
    researchToken?: { id: string; name: string };
  }
}

/** Returns the editor session for this request, if editing is unlocked on this device. Sliding expiry. */
export async function authenticateEditor(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): Promise<EditorSession | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const sid = sha256(token);
  const row = await ctx.db.selectFrom('sessions').select(['id', 'user_id', 'expires_at', 'last_seen_at']).where('id', '=', sid).executeTakeFirst();
  const now = ctx.now();
  if (!row || row.expires_at < now.toISOString()) return null;
  if (now.getTime() - Date.parse(row.last_seen_at) > 3600_000) {
    const expires = new Date(now.getTime() + ctx.config.sessionDays * 86400_000);
    await ctx.db.updateTable('sessions').set({ last_seen_at: now.toISOString(), expires_at: expires.toISOString() }).where('id', '=', sid).execute();
    setSessionCookie(ctx, reply, token, expires);
  }
  return { site_id: row.user_id, session_id: sid };
}

// ---- Unlock throttling (in memory; enough for a single-site app)
const attempts = new Map<string, { count: number; until: number }>();
export function checkLoginThrottle(key: string) {
  const a = attempts.get(key);
  if (a && a.until > Date.now() && a.count >= 5) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
}
export function recordLoginFailure(key: string) {
  const a = attempts.get(key);
  const until = Date.now() + 10 * 60_000;
  attempts.set(key, { count: a && a.until > Date.now() ? a.count + 1 : 1, until });
}
export function clearLoginFailures(key: string) {
  attempts.delete(key);
}

// ---- Research API tokens
export async function createApiToken(ctx: AppContext, name: string, userId: string | null) {
  const secret = `qrt_${crypto.randomBytes(24).toString('base64url')}`;
  const id = newId('tok');
  await ctx.db
    .insertInto('api_tokens')
    .values({ id, name, token_hash: sha256(secret), token_prefix: secret.slice(0, 8), scopes: 'research', created_at: nowIso(), created_by_user_id: userId, last_used_at: null, revoked_at: null })
    .execute();
  return { id, token: secret };
}

export async function authenticateToken(ctx: AppContext, req: FastifyRequest) {
  const h = req.headers.authorization;
  const alt = req.headers['x-api-key'];
  const raw = h?.startsWith('Bearer ') ? h.slice(7).trim() : typeof alt === 'string' ? alt.trim() : null;
  if (!raw) throw new HttpError(401, 'Missing bearer token');
  const row = await ctx.db.selectFrom('api_tokens').selectAll().where('token_hash', '=', sha256(raw)).executeTakeFirst();
  if (!row || row.revoked_at) throw new HttpError(401, 'Invalid or revoked token');
  const t = nowIso();
  await ctx.db.updateTable('api_tokens').set({ last_used_at: t }).where('id', '=', row.id).execute();
  await setSetting(ctx, 'executor_last_seen_at', t);
  return { id: row.id, name: row.name };
}
