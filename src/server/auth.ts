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
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return crypto.timingSafeEqual(expected, actual);
}

export const SESSION_COOKIE = 'quartet_session';

export async function createUser(ctx: AppContext, email: string, password: string, displayName?: string) {
  if (password.length < 10) throw new HttpError(400, 'Use a password of at least 10 characters');
  const t = nowIso();
  const id = newId('usr');
  await ctx.db.insertInto('users').values({ id, email: email.toLowerCase().trim(), display_name: displayName ?? null, password_hash: await hashPassword(password), created_at: t, updated_at: t }).execute();
  return id;
}

/** Creates the owner from OWNER_EMAIL / OWNER_PASSWORD when no account exists yet. */
export async function ensureOwnerFromEnv(ctx: AppContext) {
  const count = await ctx.db.selectFrom('users').select(ctx.db.fn.countAll<number>().as('n')).executeTakeFirst();
  if (Number(count?.n ?? 0) > 0) return null;
  if (!ctx.config.ownerEmail || !ctx.config.ownerPassword) return null;
  return createUser(ctx, ctx.config.ownerEmail, ctx.config.ownerPassword, 'Owner');
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

export interface AuthedUser {
  id: string;
  email: string;
  display_name: string | null;
  session_id: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthedUser;
    researchToken?: { id: string; name: string };
  }
}

/** Sliding expiry: active sessions are extended, so phone and laptop stay signed in. */
export async function authenticateSession(ctx: AppContext, req: FastifyRequest, reply: FastifyReply): Promise<AuthedUser | null> {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  const sid = sha256(token);
  const row = await ctx.db
    .selectFrom('sessions as s')
    .innerJoin('users as u', 'u.id', 's.user_id')
    .select(['s.id', 's.expires_at', 's.last_seen_at', 'u.id as user_id', 'u.email', 'u.display_name'])
    .where('s.id', '=', sid)
    .executeTakeFirst();
  const now = ctx.now();
  if (!row || row.expires_at < now.toISOString()) return null;
  if (now.getTime() - Date.parse(row.last_seen_at) > 3600_000) {
    const expires = new Date(now.getTime() + ctx.config.sessionDays * 86400_000);
    await ctx.db.updateTable('sessions').set({ last_seen_at: now.toISOString(), expires_at: expires.toISOString() }).where('id', '=', sid).execute();
    setSessionCookie(ctx, reply, token, expires);
  }
  return { id: row.user_id, email: row.email, display_name: row.display_name, session_id: sid };
}

// ---- Login throttling (in memory; enough for a single-owner app)
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
