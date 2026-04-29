/**
 * Mirrored constants from the canonical aggregation
 * (`apps/wiki-server/src/routes/sourcing/sourcing-aggregation.ts`).
 *
 * The wiki-server cannot import from apps/web and vice versa, so these
 * literals are duplicated. Keep in sync with the wiki-server module. The
 * aggregation function itself runs on the server; apps/web only needs
 * `DEFAULT_MIN_RELEVANCE` to render the explainer's qualitative
 * "high-relevance / low-relevance" tag the same way the rule classifies it.
 */

/** See `DEFAULT_MIN_RELEVANCE` in wiki-server's sourcing-aggregation.ts. */
export const DEFAULT_MIN_RELEVANCE = 0.3;
