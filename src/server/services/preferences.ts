import { DEFAULT_PREFERENCES, preferencesSchema, type Preferences } from '../../shared/preferences';
import { categoryGroup, genreLineage, ELECTRONIC_GENRES } from '../../shared/taxonomy';
import type { AppContext } from '../context';
import { nowIso, parseJson } from '../util';

export async function getPreferences(ctx: AppContext, userId: string): Promise<{ data: Preferences; version: number }> {
  const row = await ctx.db.selectFrom('user_preferences').selectAll().where('user_id', '=', userId).executeTakeFirst();
  if (!row) return { data: DEFAULT_PREFERENCES, version: 0 };
  // Parsing through the schema fills in defaults for settings added after the row was saved.
  const parsed = preferencesSchema.safeParse(parseJson(row.data, {}));
  return { data: parsed.success ? parsed.data : DEFAULT_PREFERENCES, version: row.version };
}

export async function savePreferences(ctx: AppContext, userId: string, data: Preferences): Promise<{ data: Preferences; version: number }> {
  const existing = await ctx.db.selectFrom('user_preferences').select(['version']).where('user_id', '=', userId).executeTakeFirst();
  const version = (existing?.version ?? 0) + 1;
  const row = { user_id: userId, data: JSON.stringify(data), version, updated_at: nowIso() };
  if (existing) await ctx.db.updateTable('user_preferences').set(row).where('user_id', '=', userId).execute();
  else await ctx.db.insertInto('user_preferences').values(row).execute();
  return { data, version };
}

export interface PersonalContext {
  userId: string;
  prefs: Preferences;
  /** artist id -> watchlist status */
  watch: Map<string, 'active' | 'paused'>;
  /** Net feedback per category / genre slug (negative = fewer like this). */
  feedbackCategories: Map<string, number>;
  feedbackGenres: Map<string, number>;
}

/** Central scoring context: interests and the followed-artist list (shared by every device). */
export async function loadPersonalContext(ctx: AppContext, userId: string): Promise<PersonalContext> {
  const [{ data: prefs }, watch] = await Promise.all([
    getPreferences(ctx, userId),
    ctx.db.selectFrom('watchlist').select(['artist_id', 'status']).where('user_id', '=', userId).execute(),
  ]);
  // "Fewer like this" feedback is kept on each device and applied in the browser.
  return {
    userId,
    prefs,
    watch: new Map(watch.map((w) => [w.artist_id, w.status as 'active' | 'paused'])),
    feedbackCategories: new Map(),
    feedbackGenres: new Map(),
  };
}

export interface Scorable {
  status: string;
  prominence: number;
  highlight: boolean;
  categories: string[];
  genres: string[];
  artists: { artist_id: string; name: string; billing: string }[];
  languages: string[] | null;
  language_importance: string | null;
  kind: string;
}

export interface ScoreResult {
  score: number;
  highlight: boolean;
  reasons: string[];
  followedArtists: string[];
}

const LABEL_CACHE = new Map<string, string>();
import { CATEGORY_BY_SLUG, GENRE_BY_SLUG } from '../../shared/taxonomy';
function label(slug: string) {
  if (!LABEL_CACHE.has(slug)) LABEL_CACHE.set(slug, GENRE_BY_SLUG.get(slug)?.label ?? CATEGORY_BY_SLUG.get(slug)?.label ?? slug);
  return LABEL_CACHE.get(slug)!;
}

/**
 * Highlight scoring. Combines research-provided prominence and highlight flags
 * with explicit interests, followed artists and "fewer like this" feedback.
 */
export function scoreEvent(e: Scorable, p: PersonalContext): ScoreResult {
  const reasons: string[] = [];
  let score = Math.min(100, Math.max(0, e.prominence)) * 0.45;
  if (e.highlight) {
    score += 25;
  }

  const followed = e.artists.filter((a) => p.watch.get(a.artist_id) === 'active');
  if (followed.length) {
    score += 45;
    const names = [...new Set(followed.map((a) => a.name))];
    reasons.push(`${names.slice(0, 2).join(' and ')}${names.length > 2 ? ` and ${names.length - 2} more` : ''} ${names.length > 1 ? 'are' : 'is'} on your watchlist`);
  }

  // Strongest interest among categories (incl. their group) and genres (incl. parents).
  let bestCat: [string, number] | null = null;
  for (const c of e.categories) {
    for (const slug of [c, categoryGroup(c)].filter(Boolean) as string[]) {
      const w = p.prefs.categoryWeights[slug];
      if (w !== undefined && (!bestCat || w > bestCat[1])) bestCat = [slug, w];
    }
  }
  let bestGenre: [string, number] | null = null;
  for (const g of e.genres) {
    for (const slug of genreLineage(g)) {
      const w = p.prefs.genreWeights[slug];
      if (w !== undefined && (!bestGenre || w > bestGenre[1])) bestGenre = [slug, w];
    }
  }
  const wMax = Math.max(bestCat?.[1] ?? 0, bestGenre?.[1] ?? 0);
  const wMin = Math.min(bestCat?.[1] ?? 0, bestGenre?.[1] ?? 0);
  if (wMax > 0) {
    score += wMax * 8 + (bestCat && bestGenre && bestCat[1] > 0 && bestGenre[1] > 0 ? 4 : 0);
    const which = bestGenre && bestGenre[1] === wMax ? bestGenre[0] : bestCat![0];
    reasons.push(wMax >= 3 ? `${label(which)} is one of your top interests` : `Matches your interest in ${label(which).toLowerCase()}`);
  } else if (wMin < 0) {
    score += wMin * 10;
  }

  let fb = 0;
  for (const c of e.categories) fb += p.feedbackCategories.get(c) ?? 0;
  for (const g of e.genres) fb += p.feedbackGenres.get(g) ?? 0;
  score += Math.max(-30, Math.min(10, fb * 8));
  if (fb < 0) reasons.push('Shown less because you asked for fewer like this');

  const langs = e.languages ?? [];
  if (e.language_importance === 'essential' && langs.length && !langs.some((l) => p.prefs.spokenLanguages.includes(l))) {
    if (p.prefs.preferEnglishFriendly) score -= 25;
  } else if (langs.includes('en') && e.language_importance === 'essential') {
    reasons.push('In English');
  }

  if (e.prominence >= 75) reasons.push(e.categories.includes('music-festival') || e.kind === 'festival' ? 'Major festival' : 'Big-name or major event');
  if (e.highlight && !reasons.length) reasons.push('Picked out as a notable event');

  if (e.genres.some((g) => ELECTRONIC_GENRES.has(g))) score += 3; // electronic gets gentle extra prominence

  if (e.status === 'cancelled') score -= 100;
  score = Math.round(Math.max(-100, Math.min(150, score)));
  const highlight = e.status !== 'cancelled' && (followed.length > 0 || score >= p.prefs.highlightThreshold);
  return { score, highlight, reasons, followedArtists: followed.map((a) => a.artist_id) };
}
