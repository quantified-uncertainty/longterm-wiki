/**
 * Org-name resolution for scorecard ingesters (QUA-698).
 *
 * Wraps `entity-matcher.ts` from grant-import (which already loads
 * database.json titles + aliases) and layers the scorecard-specific
 * `data/scorecards/org-aliases.yaml` on top.
 *
 * Resolution order (per QUA-698 — never silently drop):
 *   1. exact case-insensitive match in `org-aliases.yaml`
 *   2. exact entity title/alias match (via grant-import matcher)
 *   3. normalized match (Inc./Ltd./Corp./AI/Labs suffix stripped)
 *   4. throw — caller decides whether to print + skip or hard-fail
 */

import { readFileSync } from "fs";
import { resolve } from "path";
import { parse as parseYaml } from "yaml";
import {
  buildEntityMatcher,
  normalizeGranteeName,
} from "../grant-import/entity-matcher.ts";
import type { EntityMatcher } from "../grant-import/types.ts";

const ALIASES_PATH = resolve("data/scorecards/org-aliases.yaml");

/** Loaded once at process start. */
function loadOverrides(): Record<string, string> {
  const raw = readFileSync(ALIASES_PATH, "utf8");
  const parsed = parseYaml(raw) as { overrides: Record<string, string> };
  if (!parsed?.overrides || typeof parsed.overrides !== "object") {
    throw new Error(
      `data/scorecards/org-aliases.yaml: missing or invalid 'overrides' map`,
    );
  }
  // Normalize keys to lowercase for case-insensitive lookup.
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.overrides)) {
    out[key.toLowerCase().trim()] = value;
  }
  return out;
}

export interface OrgResolver {
  /** entities.stable_id (sid_…) of the resolved org. */
  entityId: string;
  /** Canonical title from database.json. */
  canonicalName: string;
  /** Slug used to derive the override (for debugging). */
  slug: string;
}

export interface OrgResolverContext {
  matcher: EntityMatcher;
  overrides: Record<string, string>;
}

/**
 * Build the resolver context once per CLI invocation. Exposed so that
 * ingesters can share a single matcher (loads database.json — non-trivial)
 * across many `resolveOrg` calls.
 */
export function buildOrgResolver(): OrgResolverContext {
  const matcher = buildEntityMatcher();
  const overrides = loadOverrides();
  return { matcher, overrides };
}

/**
 * Lookup by-slug helper. The grant-import matcher exposes
 * `match(name)` which already accepts slugs as a key. We re-use that
 * but expose a cleaner name + return shape.
 */
function matchBySlug(
  ctx: OrgResolverContext,
  slug: string,
): OrgResolver | null {
  const m = ctx.matcher.match(slug);
  if (!m) return null;
  return { entityId: m.stableId, canonicalName: m.name, slug: m.slug };
}

/**
 * Resolve an org name from a scorecard source to a wiki entity.
 *
 * Returns `null` when nothing matches — the caller decides whether to
 * collect unresolved names for batch reporting (analyze) or to throw
 * (sync). Per QUA-698, sync MUST hard-fail on unresolved orgs.
 */
export function resolveOrg(
  ctx: OrgResolverContext,
  rawName: string,
): OrgResolver | null {
  const trimmed = rawName.trim();
  if (!trimmed) return null;
  const lower = trimmed.toLowerCase();

  // 1. Override map.
  const overrideSlug = ctx.overrides[lower];
  if (overrideSlug) {
    const m = matchBySlug(ctx, overrideSlug);
    if (m) return m;
    // Override pointed to a slug that doesn't resolve — that's a data
    // bug in the YAML, surface loudly.
    throw new Error(
      `org-aliases.yaml: override "${rawName}" → "${overrideSlug}" but no entity with that slug exists in database.json. Run \`pnpm build-data:content\` or fix the override.`,
    );
  }

  // 2. Direct match against title / alias / slug.
  const direct = ctx.matcher.match(trimmed);
  if (direct)
    return {
      entityId: direct.stableId,
      canonicalName: direct.name,
      slug: direct.slug,
    };

  // 3. Normalized match (strip Inc., Ltd., AI suffix etc.). Reuse the
  // grant-import normalization — it already handles a long list.
  const normalized = normalizeGranteeName(trimmed);
  if (normalized !== trimmed) {
    const norm = ctx.matcher.match(normalized);
    if (norm)
      return {
        entityId: norm.stableId,
        canonicalName: norm.name,
        slug: norm.slug,
      };
  }

  return null;
}
