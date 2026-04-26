/**
 * Tunable knobs for the backfill-sources command.
 */

/** Per-record research budget cap (USD). */
export const PER_RECORD_BUDGET = 0.10;

/** Default cumulative cost ceiling (USD) when --max-cost isn't passed. */
export const DEFAULT_MAX_COST = 5.0;

/** Default page-content cap to skip too-short scrapes (chars). */
export const MIN_CONTENT_LENGTH = 50;

/** Default search-query truncation length. */
export const SEARCH_QUERY_MAX_LENGTH = 200;

/**
 * Domains we consider "self" — sourcing a longtermwiki fact against
 * longtermwiki content is circular and useless. Includes the two deprecated
 * domains flagged in CLAUDE.md so we don't self-source via an old redirect.
 * Extend this list if staging/mirror domains need to be excluded too.
 */
export const SELF_DOMAINS = [
  'longtermwiki.com',
  'longtermwiki.org',
  'longterm.wiki',
  'longterm-wiki.vercel.app',
  'ea-crux-project.vercel.app',
];
