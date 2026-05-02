/**
 * Scorecard → FactBase mirror (QUA-865).
 *
 * Reads "overall" grades from the latest snapshot of each scorecard source
 * (PG `scorecard_grades` via the wiki-server API) and writes them as
 * FactBase facts under each rated organization's existing single-file
 * `packages/factbase/data/fb-entities/<slug>.yaml`.
 *
 * The five scorecard predicates (`fli-index-grade`, `saferai-grade`, ...)
 * form the set of "managed" facts: on every sync, every existing fact
 * whose property is in that set is removed from the entity yaml, and the
 * fresh set is appended. Hand-curated facts on other predicates are
 * preserved by use of `parseDocument()`/`Document.toString()` from the
 * `yaml` library, which round-trips comments, formatting, and field
 * order.
 *
 * Determinism: fact IDs come from `generateContentFactId(subject,
 * predicate, value, asOf)`, so re-running the sync with unchanged source
 * data produces byte-identical yaml output (stable sort + deterministic
 * IDs + atomic tmp+rename writes).
 *
 * Why we don't use per-entity directories: even though the factbase
 * loader supports them, several flat-readdir callers (career-import,
 * validate-factbase-fact-unit-field, entity-matrix scanner) only see
 * top-level `<slug>.yaml` files and would silently lose data for any
 * entity migrated to directory form. Inline embedding avoids that whole
 * compatibility surface — the cost is one yaml-document round-trip per
 * rated entity per sync.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseDocument, isSeq, isMap, type Document, type YAMLMap } from 'yaml';
import {
  getAllScorecardGrades,
  type ScorecardGradesAllResult,
} from '../wiki-server/scorecard-grades.ts';
import type { ApiResult } from '../wiki-server/client.ts';
import { generateContentFactId } from '../../../packages/factbase/src/ids.ts';
import { CUSTOM_TAGS } from '../../../packages/factbase/src/loader.ts';
import { loadAllEntities, type EntityWithType } from '../research/entity-loader.ts';

// ── Types ──────────────────────────────────────────────────────────────

/** Single grade row returned by the wiki-server API. */
export type ApiGrade = ScorecardGradesAllResult['items'][number];

/** A single fact ready to be serialized into yaml. */
export interface MirrorFact {
  id: string;
  property: string;
  value: string;
  asOf: string;
  source: string;
  notes: string;
}

/** Map from entity stableId → facts for that entity, sorted deterministically. */
export type FactsByEntity = Map<string, MirrorFact[]>;

/**
 * Map from `scorecardSource` (PG enum) → factbase predicate id.
 * Predicates are registered in `packages/factbase/data/properties.yaml`
 * under the `scorecards` category.
 */
export const SCORECARD_PREDICATE_BY_SOURCE: Record<string, string> = {
  fli_index: 'fli-index-grade',
  saferai: 'saferai-grade',
  ailabwatch: 'ailabwatch-grade',
  fmti: 'fmti-grade',
  seoul_tracker: 'seoul-tracker-grade',
};

/**
 * The complete set of managed predicate ids — every fact whose `property`
 * is in this set is fully owned by this sync and gets rewritten on each
 * run. Used to identify pre-existing managed facts for removal before
 * appending the fresh set.
 */
export const MANAGED_PREDICATES: ReadonlySet<string> = new Set(
  Object.values(SCORECARD_PREDICATE_BY_SOURCE),
);

const SOURCE_NOTES_LABEL: Record<string, string> = {
  fli_index: 'FLI AI Safety Index',
  saferai: 'SaferAI Ratings',
  ailabwatch: 'AI Lab Watch',
  fmti: 'Stanford FMTI',
  seoul_tracker: 'Seoul Commitment Tracker',
};

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

// ── Pure transforms ────────────────────────────────────────────────────

/**
 * Convert one API grade row into a MirrorFact, or return null if the row
 * cannot be mirrored (unknown source, missing source url, etc.).
 *
 * Pure — no I/O. Used by buildFactsByEntity() and tested in isolation.
 */
export function gradeToFact(grade: ApiGrade): MirrorFact | null {
  // The API typing models scorecardSource as joinable nullable (the row
  // is left-joined to scorecard_snapshots), but in practice every grade
  // has a snapshot. Treat null defensively.
  const source_ = grade.scorecardSource;
  if (!source_) return null;
  const predicate = SCORECARD_PREDICATE_BY_SOURCE[source_];
  if (!predicate) return null;

  // Use scoreRaw because it preserves the exact source representation
  // (letters, percents, FMTI's "X / 100") — that's what humans want to
  // see embedded with <FBF>.
  const value = grade.scoreRaw;
  if (!value) return null;

  // Source: prefer the per-grade deep-link; fall back to the snapshot's
  // top-level source URL. Most grades inherit (sourceUrl is null) so the
  // fallback is the common case.
  const source = grade.sourceUrl ?? grade.snapshotSourceUrl;
  if (!source) return null;

  const asOf = grade.publishedAt;
  if (!asOf) return null;

  const sourceLabel = SOURCE_NOTES_LABEL[source_] ?? source_;
  const wave = formatWaveLabel(asOf);
  const notes = `${sourceLabel} — ${wave}`;

  // Deterministic ID — same (subject, predicate, value, asOf) always
  // yields the same fact id, so re-runs with unchanged data produce
  // byte-identical yaml.
  const id = generateContentFactId(grade.entityId, predicate, value, asOf);

  return {
    id,
    property: predicate,
    value,
    asOf,
    source,
    notes,
  };
}

/**
 * Group API grades by entity stableId, dropping rows that can't be
 * mirrored. Within each entity, facts are sorted by (predicate, asOf) so
 * yaml output is stable.
 */
export function buildFactsByEntity(grades: ApiGrade[]): FactsByEntity {
  const out: FactsByEntity = new Map();
  for (const g of grades) {
    const f = gradeToFact(g);
    if (!f) continue;
    const arr = out.get(g.entityId) ?? [];
    arr.push(f);
    out.set(g.entityId, arr);
  }
  // Stable sort within each entity for deterministic diffs.
  for (const [, arr] of out) {
    arr.sort((a, b) => {
      if (a.property !== b.property) return a.property.localeCompare(b.property);
      return a.asOf.localeCompare(b.asOf);
    });
  }
  return out;
}

/**
 * Build a stableId → fb-entity slug map by reading `data/entities/*.yaml`.
 * The slug is the entity's `id` field (which is also the fb-entity yaml
 * filename stem). Entities without a stableId are skipped.
 */
export function buildSlugByStableId(entities: EntityWithType[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of entities) {
    if (typeof e.stableId !== 'string') continue;
    out.set(e.stableId, e.id);
  }
  return out;
}

/**
 * Render a human label for the snapshot date, used in the `notes:` field
 * of each generated fact. Falls back to the raw `asOf` string when the
 * date isn't in a recognized form.
 *   2025-12-02  → "December 2025"
 *   2025-10-01  → "October 2025"
 *   2024-06     → "June 2024"
 *   2025        → "2025"
 *   "garbage"   → "garbage" (fall-through; do not throw)
 */
export function formatWaveLabel(asOf: string): string {
  const m = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/.exec(asOf);
  if (!m) return asOf;
  const [, yearStr, monthStr] = m;
  const year = Number(yearStr);
  if (!monthStr) return String(year);
  const month = Number(monthStr);
  if (month >= 1 && month <= 12) return `${MONTH_NAMES[month - 1]} ${year}`;
  return asOf;
}

// ── YAML document operations ───────────────────────────────────────────

/**
 * Pure-ish transform: take an existing yaml Document for an entity file
 * and replace its managed scorecard facts with `freshFacts`. Returns
 * `{ doc, removed, appended }` for telemetry. The doc is mutated in
 * place; the returned reference is the same one passed in.
 *
 * Algorithm:
 *   1. Walk the `facts:` sequence and remove every fact whose `property`
 *      is in MANAGED_PREDICATES.
 *   2. Append every fact from `freshFacts` to the end of the sequence.
 *
 * Because parseDocument preserves comments and field order, hand-curated
 * facts and the entity header (`entity:`) and `_sources:` map are
 * untouched.
 */
export function applyManagedFacts(
  doc: Document,
  freshFacts: MirrorFact[],
): { removed: number; appended: number } {
  const root = doc.contents;
  if (!isMap(root)) {
    throw new Error('[scorecard-mirror] entity yaml root is not a mapping');
  }

  // Get or create the `facts` sequence.
  let factsNode = root.get('facts', true);
  if (!factsNode) {
    const created = doc.createNode([]);
    root.set('facts', created);
    factsNode = root.get('facts', true);
  }
  if (!isSeq(factsNode)) {
    throw new Error('[scorecard-mirror] `facts` node is not a sequence');
  }

  // Remove existing managed facts.
  let removed = 0;
  for (let i = factsNode.items.length - 1; i >= 0; i--) {
    const item = factsNode.items[i];
    if (!isMap(item)) continue;
    const prop = (item as YAMLMap).get('property');
    if (typeof prop === 'string' && MANAGED_PREDICATES.has(prop)) {
      factsNode.items.splice(i, 1);
      removed++;
    }
  }

  // Append fresh facts in order.
  for (const fact of freshFacts) {
    const node = doc.createNode({
      id: fact.id,
      property: fact.property,
      value: fact.value,
      asOf: fact.asOf,
      source: fact.source,
      notes: fact.notes,
    });
    factsNode.items.push(node);
  }

  return { removed, appended: freshFacts.length };
}

/**
 * Read an entity yaml file as a Document (preserves comments + format).
 * Uses the factbase loader's CUSTOM_TAGS so `!ref`, `!date`, `!src` round-trip.
 */
export function readEntityDocument(filepath: string): Document {
  const raw = readFileSync(filepath, 'utf-8');
  return parseDocument(raw, { customTags: CUSTOM_TAGS });
}

/**
 * Atomic write: serialize `doc`, write to `<path>.tmp`, then rename.
 */
export function writeEntityDocument(filepath: string, doc: Document): void {
  const content = doc.toString();
  const tmpPath = filepath + '.tmp';
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filepath);
}

/**
 * Path of the single-file entity yaml for `slug`, or null if it doesn't
 * exist. Per-entity directory layouts are intentionally NOT supported
 * here — see file header for rationale.
 */
export function findEntityFile(slug: string, fbEntitiesDir: string): string | null {
  const filePath = join(fbEntitiesDir, `${slug}.yaml`);
  return existsSync(filePath) ? filePath : null;
}

/**
 * Apply the freshFacts set to `<slug>.yaml`, removing any pre-existing
 * managed facts and appending the new set. Returns the path written
 * (the existing single-file path) or null when the entity has no
 * fb-entity yaml.
 */
export function writeManagedFactsToEntity(
  slug: string,
  freshFacts: MirrorFact[],
  fbEntitiesDir: string,
): { path: string; removed: number; appended: number } | null {
  const path = findEntityFile(slug, fbEntitiesDir);
  if (!path) return null;
  const doc = readEntityDocument(path);
  const counts = applyManagedFacts(doc, freshFacts);
  writeEntityDocument(path, doc);
  return { path, ...counts };
}

// ── High-level orchestrator ────────────────────────────────────────────

export interface SyncSummary {
  apiGrades: number;
  entitiesWithGrades: number;
  /** Entities written to (resolved + had slug + had existing fb-entity yaml). */
  entitiesWritten: number;
  /** Entities skipped — slug found but no fb-entity yaml on disk. */
  entitiesSkippedNoFbYaml: number;
  /** Entities skipped — stableId not present in `data/entities/*.yaml`. */
  entitiesSkippedNoSlug: number;
  /**
   * Pre-existing managed facts removed from yaml files because they
   * belong to entities that no longer have any current grades (e.g.
   * dropped from latest wave). Counted in fact-count, not entity-count.
   */
  staleFactsRemoved: number;
  details: Array<{
    slug: string | null;
    stableId: string | null;
    factCount: number;
    status: 'written' | 'skipped-no-fb-yaml' | 'skipped-no-slug' | 'stale-cleanup';
    path: string | null;
  }>;
}

export interface SyncOptions {
  fbEntitiesDir?: string;
  entities?: EntityWithType[];
  grades?: ApiGrade[];
  dryRun?: boolean;
}

const DEFAULT_FB_ENTITIES_DIR = join(
  import.meta.dirname!,
  '../../../packages/factbase/data/fb-entities',
);

/**
 * End-to-end sync: fetch grades, group, write managed facts inline into
 * each rated entity's single-file yaml, and clean up managed facts in
 * any entity yaml that is no longer rated. Idempotent.
 */
export async function syncScorecardFactsToYaml(
  opts: SyncOptions = {},
): Promise<SyncSummary> {
  const fbEntitiesDir = opts.fbEntitiesDir ?? DEFAULT_FB_ENTITIES_DIR;

  const grades = opts.grades ?? (await fetchAllOverallGrades());
  const factsByEntity = buildFactsByEntity(grades);

  const entities = opts.entities ?? loadAllEntities();
  const slugByStableId = buildSlugByStableId(entities);

  const summary: SyncSummary = {
    apiGrades: grades.length,
    entitiesWithGrades: factsByEntity.size,
    entitiesWritten: 0,
    entitiesSkippedNoFbYaml: 0,
    entitiesSkippedNoSlug: 0,
    staleFactsRemoved: 0,
    details: [],
  };

  // Track which entity files we wrote, so the stale-cleanup pass can skip
  // them — they're already in the desired state.
  const writtenSlugs = new Set<string>();

  for (const [stableId, facts] of factsByEntity) {
    const slug = slugByStableId.get(stableId);
    if (!slug) {
      summary.entitiesSkippedNoSlug++;
      summary.details.push({
        slug: null,
        stableId,
        factCount: facts.length,
        status: 'skipped-no-slug',
        path: null,
      });
      continue;
    }

    const path = findEntityFile(slug, fbEntitiesDir);
    if (!path) {
      summary.entitiesSkippedNoFbYaml++;
      summary.details.push({
        slug,
        stableId,
        factCount: facts.length,
        status: 'skipped-no-fb-yaml',
        path: null,
      });
      continue;
    }

    if (!opts.dryRun) {
      writeManagedFactsToEntity(slug, facts, fbEntitiesDir);
    }
    summary.entitiesWritten++;
    summary.details.push({
      slug,
      stableId,
      factCount: facts.length,
      status: 'written',
      path,
    });
    writtenSlugs.add(slug);
  }

  // Stale cleanup: any entity yaml that has managed facts but is no
  // longer rated this run loses its managed facts. We scan every
  // top-level `<slug>.yaml` in fb-entities and check for managed
  // properties; if found, we re-run applyManagedFacts with [] to strip
  // them. Skip files we just wrote (already correct).
  for (const slug of findEntitiesWithManagedFacts(fbEntitiesDir)) {
    if (writtenSlugs.has(slug)) continue;
    const path = join(fbEntitiesDir, `${slug}.yaml`);
    if (!opts.dryRun) {
      const doc = readEntityDocument(path);
      const counts = applyManagedFacts(doc, []);
      if (counts.removed > 0) {
        writeEntityDocument(path, doc);
        summary.staleFactsRemoved += counts.removed;
        summary.details.push({
          slug,
          stableId: null,
          factCount: counts.removed,
          status: 'stale-cleanup',
          path,
        });
      }
    } else {
      // In dry-run, count would-be removals by parsing without writing.
      const doc = readEntityDocument(path);
      const counts = applyManagedFacts(doc, []);
      if (counts.removed > 0) {
        summary.staleFactsRemoved += counts.removed;
        summary.details.push({
          slug,
          stableId: null,
          factCount: counts.removed,
          status: 'stale-cleanup',
          path,
        });
      }
    }
  }

  return summary;
}

/**
 * Walk top-level `<slug>.yaml` files looking for any with a managed
 * scorecard predicate in `facts:`. Returns the slugs (filename stems).
 *
 * Cheap text-scan first to avoid parsing every file in the repo —
 * a file without any managed-predicate substring can't have a managed
 * fact, so we skip its yaml parse entirely.
 */
export function findEntitiesWithManagedFacts(fbEntitiesDir: string): string[] {
  if (!existsSync(fbEntitiesDir)) return [];
  const out: string[] = [];
  const entries = readdirSync(fbEntitiesDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.yaml')) continue;
    const path = join(fbEntitiesDir, entry.name);
    const raw = readFileSync(path, 'utf-8');
    if (!hasManagedPredicateSubstring(raw)) continue;
    out.push(entry.name.replace(/\.yaml$/, ''));
  }
  return out;
}

/** True if any managed predicate name appears in the file content. */
function hasManagedPredicateSubstring(content: string): boolean {
  for (const pred of MANAGED_PREDICATES) {
    if (content.includes(pred)) return true;
  }
  return false;
}

// ── Post-sync orchestration helper ─────────────────────────────────────

export interface PostSyncMirrorResult {
  written: number;
  skipped: number;
  staleFactsRemoved: number;
}

/**
 * Run the FactBase mirror as a post-step of a scorecard ingest. Returns
 * `{summary, error}` — never throws. Failures are reported as warnings on
 * the console and surfaced in `error` so the caller can include them in
 * its CI output without conflating mirror failures with PG-sync failures.
 */
export async function runMirrorAfterSync(
  dryRun: boolean,
): Promise<{ summary: PostSyncMirrorResult | null; error: string | null }> {
  try {
    const summary = await syncScorecardFactsToYaml({ dryRun });
    return {
      summary: {
        written: summary.entitiesWritten,
        skipped: summary.entitiesSkippedNoFbYaml + summary.entitiesSkippedNoSlug,
        staleFactsRemoved: summary.staleFactsRemoved,
      },
      error: null,
    };
  } catch (err) {
    return {
      summary: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

/** Fetch every overall+latest grade in pages of 200. */
async function fetchAllOverallGrades(): Promise<ApiGrade[]> {
  const PAGE_SIZE = 200;
  const all: ApiGrade[] = [];
  let offset = 0;
  const HARD_CAP = 5000;
  while (all.length < HARD_CAP) {
    const res: ApiResult<ScorecardGradesAllResult> = await getAllScorecardGrades({
      limit: PAGE_SIZE,
      offset,
      latest: true,
      overall: true,
    });
    if (!res.ok) {
      throw new Error(
        `[scorecard-mirror] failed to fetch grades (offset=${offset}): ${res.error} ${res.message}`,
      );
    }
    all.push(...res.data.items);
    if (res.data.items.length < PAGE_SIZE) break;
    offset += PAGE_SIZE;
  }
  return all;
}
