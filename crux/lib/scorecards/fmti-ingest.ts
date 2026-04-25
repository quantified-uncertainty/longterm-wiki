/**
 * Stanford FMTI Ingester — fetch + parse + sync orchestration.
 *
 * Public surface:
 *   ingestFmtiWaves(opts) — fetch all configured waves and POST records to
 *                            the wiki-server scorecard endpoints.
 *
 * Pure transforms live in `./fmti.ts`. This module only handles I/O.
 */

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { parse as parseYaml } from "yaml";
import { getServerUrl } from "../wiki-server/client.ts";
import {
  syncScorecardSnapshots,
} from "../wiki-server/scorecard-snapshots.ts";
import { syncScorecardGrades } from "../wiki-server/scorecard-grades.ts";
import { buildEntityMatcher, normalizeGranteeName } from "../grant-import/entity-matcher.ts";
import { generateId } from "../grant-import/id.ts";
import {
  FMTI_WAVES,
  buildFmtiRecords,
  fmtiRawUrl,
  parseFmtiFlatScores,
  parseFmtiIndicators,
  parseFmtiOct2023Scores,
  type FmtiIndicator,
  type FmtiScoreRow,
  type FmtiWave,
  type ScorecardGradeRecord,
  type ScorecardSnapshotRecord,
} from "./fmti.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const FETCH_TIMEOUT_MS = 30_000;
const GRADES_BATCH_SIZE = 500;

const ORG_OVERRIDES_PATH = "data/scorecards/fmti-org-overrides.yaml";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface IngestOptions {
  /** Restrict to one wave (`fmti-dec-2025` etc.). Defaults to all. */
  waveId?: string;
  /** Don't POST anything — just fetch + parse + report counts. */
  dryRun?: boolean;
  /**
   * When unmatched org names are encountered, create lightweight stub
   * `entities` rows so the FK validation passes. Defaults to false; off by
   * default makes the ingester safe to run as a coverage check without
   * mutating the entity registry.
   */
  ensureStubEntities?: boolean;
  /** Override fetch (used in tests). */
  fetchImpl?: typeof fetch;
}

export interface WaveIngestResult {
  waveId: string;
  snapshot: ScorecardSnapshotRecord;
  gradeCount: number;
  resolvedOrgs: number;
  unresolvedOrgs: string[];
  warnings: string[];
  /** Set when --dry-run; null otherwise. */
  dryRun: boolean;
  /** Wiki-server upsert result, or null on dry-run / sync skipped. */
  syncResult: { snapshots: number; grades: number; errors: string[] } | null;
}

export interface IngestResult {
  waves: WaveIngestResult[];
  errors: string[];
}

export async function ingestFmtiWaves(
  opts: IngestOptions = {},
): Promise<IngestResult> {
  const dryRun = !!opts.dryRun;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // Pick which waves to run.
  const waves = opts.waveId
    ? FMTI_WAVES.filter((w) => w.snapshotId === opts.waveId)
    : [...FMTI_WAVES];
  if (waves.length === 0) {
    return {
      waves: [],
      errors: [
        `Unknown FMTI wave "${opts.waveId}". Known waves: ${FMTI_WAVES.map((w) => w.snapshotId).join(", ")}`,
      ],
    };
  }

  // Build the entity matcher once.
  const matcher = buildEntityMatcher();
  const overrides = loadOrgOverrides();

  // First pass: fetch + parse all waves so we can gather the union of org
  // names, ensure-entities once, and then build records.
  type ParsedWave = {
    wave: FmtiWave;
    indicators: FmtiIndicator[];
    scores: FmtiScoreRow[];
    orgs: string[];
    warnings: string[];
  };
  const parsed: ParsedWave[] = [];
  const errors: string[] = [];

  for (const wave of waves) {
    try {
      const p = await parseWave(wave, fetchImpl);
      parsed.push(p);
    } catch (err) {
      errors.push(`${wave.snapshotId}: ${formatErr(err)}`);
    }
  }

  if (parsed.length === 0) {
    return { waves: [], errors };
  }

  // Cross-wave: enrich May 2024 indicators with metadata from Oct 2023 / Dec
  // 2025 if available, since May2024_scores.csv has no inline domain info.
  // (Best-effort; a record without indicator metadata still rolls up at the
  // overall level but skips subdomain/domain rollups.)
  enrichMissingIndicators(parsed);

  // Resolve all orgs across all waves in one pass so we hit the entity
  // matcher / ensure-entities at most once per name.
  const allOrgs = new Set<string>();
  for (const p of parsed) for (const o of p.orgs) allOrgs.add(o);

  const orgIndex = await resolveOrgs(
    [...allOrgs],
    {
      matcher,
      overrides,
      ensureStubEntities: !!opts.ensureStubEntities,
      dryRun,
    },
  );

  // Tag latest = the most-recently-published wave we're shipping.
  // (If you only ingest historical waves, none gets tagged latest — that's
  // intentional: don't downgrade an already-latest snapshot.)
  const latestId = pickLatestWaveId(parsed.map((p) => p.wave));

  const results: WaveIngestResult[] = [];

  for (const p of parsed) {
    const built = buildFmtiRecords({
      wave: p.wave,
      isLatest: p.wave.snapshotId === latestId,
      indicators: p.indicators,
      scores: p.scores,
      orgs: p.orgs,
      resolveOrg: (name) => orgIndex.get(name) ?? null,
    });

    const result: WaveIngestResult = {
      waveId: p.wave.snapshotId,
      snapshot: built.snapshot,
      gradeCount: built.grades.length,
      resolvedOrgs: built.snapshot.orgCount,
      unresolvedOrgs: built.unresolvedOrgs,
      warnings: p.warnings,
      dryRun,
      syncResult: null,
    };

    if (!dryRun) {
      result.syncResult = await syncWaveToServer(built.snapshot, built.grades);
    }
    results.push(result);
  }

  return { waves: results, errors };
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function parseWave(
  wave: FmtiWave,
  fetchImpl: typeof fetch,
): Promise<{
  wave: FmtiWave;
  indicators: FmtiIndicator[];
  scores: FmtiScoreRow[];
  orgs: string[];
  warnings: string[];
}> {
  const warnings: string[] = [];

  if (wave.scoresHasDomain) {
    // Oct 2023 — integrated scores file with Domain/Subdomain inline.
    const text = await fetchText(fmtiRawUrl(wave, wave.scoresFile), fetchImpl);
    const { orgs, rows } = parseFmtiOct2023Scores(text);
    const indicators: FmtiIndicator[] = rows.map((r) => ({
      domain: r.domain,
      subdomain: r.subdomain,
      name: r.indicator,
    }));
    const scores: FmtiScoreRow[] = rows.map((r) => ({
      indicator: r.indicator,
      scores: r.scores,
    }));
    return { wave, indicators, scores, orgs, warnings };
  }

  // Flat scores file (Dec 2025 / May 2024). Fetch indicators if available.
  const scoresText = await fetchText(
    fmtiRawUrl(wave, wave.scoresFile),
    fetchImpl,
  );
  const { orgs, rows: scores } = parseFmtiFlatScores(scoresText);

  let indicators: FmtiIndicator[] = [];
  if (wave.indicatorsFile) {
    const indText = await fetchText(
      fmtiRawUrl(wave, wave.indicatorsFile),
      fetchImpl,
    );
    indicators = parseFmtiIndicators(indText);
  } else {
    warnings.push(
      "No indicators-definitions file for this wave — domain/subdomain rollups will be inferred from sibling waves where possible.",
    );
  }
  return { wave, indicators, scores, orgs, warnings };
}

async function fetchText(url: string, fetchImpl: typeof fetch): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "longterm-wiki-fmti-ingest/1.0",
        Accept: "text/csv, text/plain;q=0.9, */*;q=0.5",
      },
      redirect: "follow",
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} for ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * For waves with no indicators-definitions file (e.g. May 2024), borrow the
 * domain/subdomain mapping from sibling waves whose indicator names overlap.
 * Best-effort — names that still don't match remain unmapped.
 */
function enrichMissingIndicators(
  parsed: Array<{
    wave: FmtiWave;
    indicators: FmtiIndicator[];
    scores: FmtiScoreRow[];
  }>,
): void {
  const ref = new Map<string, FmtiIndicator>();
  for (const p of parsed) {
    for (const i of p.indicators) {
      if (i.domain && i.subdomain) ref.set(i.name, i);
    }
  }
  for (const p of parsed) {
    if (p.indicators.length > 0) continue;
    const enriched: FmtiIndicator[] = [];
    for (const sr of p.scores) {
      const known = ref.get(sr.indicator);
      // Skip entries with no domain/subdomain match — buildFmtiRecords
      // treats unknown indicators as parent="overall" with no rollup, which
      // is the right shape for "wave has no indicators-defs and we couldn't
      // find a sibling match".
      if (known) enriched.push(known);
    }
    p.indicators = enriched;
  }
}

function pickLatestWaveId(waves: FmtiWave[]): string | null {
  if (waves.length === 0) return null;
  return [...waves].sort((a, b) =>
    b.publishedAt.localeCompare(a.publishedAt),
  )[0].snapshotId;
}

// ---------------------------------------------------------------------------
// Org resolution
// ---------------------------------------------------------------------------

interface ResolveOptions {
  matcher: ReturnType<typeof buildEntityMatcher>;
  overrides: Record<string, string>;
  ensureStubEntities: boolean;
  dryRun: boolean;
}

/**
 * Resolve all org names to entity stableIds. Returns a name → stableId map
 * (missing names are simply absent from the map — caller decides how to
 * report them).
 *
 * When `ensureStubEntities` is true and the resolver reaches an unmatched
 * name, it creates a lightweight `organization` entity (stub: true) using
 * the same `generateId(...)` pattern as `tb ensure-entities`.
 */
async function resolveOrgs(
  names: string[],
  opts: ResolveOptions,
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  // Stubs are deduplicated by canonical slug so that aliased display names
  // (e.g. "Stability" / "Stability AI" → `stability-ai`) collapse to one
  // stub entity instead of two.
  const stubsBySlug = new Map<
    string,
    { slug: string; displayName: string; stableId: string; aliases: Set<string> }
  >();

  for (const name of names) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    // 1. Exact override → canonical slug.
    const overrideSlug = opts.overrides[trimmed];
    if (overrideSlug) {
      const m = opts.matcher.match(overrideSlug);
      if (m) {
        out.set(trimmed, m.stableId);
        continue;
      }
      if (opts.ensureStubEntities) {
        registerStub(stubsBySlug, overrideSlug, trimmed);
        out.set(trimmed, stubsBySlug.get(overrideSlug)!.stableId);
      }
      continue;
    }

    // 2. Direct entity matcher (title or alias).
    const direct = opts.matcher.match(trimmed);
    if (direct) {
      out.set(trimmed, direct.stableId);
      continue;
    }

    // 3. Normalize (strip Inc., Labs, etc.).
    const normalized = normalizeGranteeName(trimmed);
    if (normalized !== trimmed) {
      const normMatch = opts.matcher.match(normalized);
      if (normMatch) {
        out.set(trimmed, normMatch.stableId);
        continue;
      }
    }

    // 4. Ensure-entities (creates stub keyed by derived slug).
    if (opts.ensureStubEntities) {
      const slug = toSlug(trimmed);
      registerStub(stubsBySlug, slug, trimmed);
      out.set(trimmed, stubsBySlug.get(slug)!.stableId);
    }
    // Else: leave unresolved.
  }

  if (stubsBySlug.size > 0 && !opts.dryRun) {
    const { syncEntities } = await import("../wiki-server/entities.ts");
    const stubArr = [...stubsBySlug.values()];
    const result = await syncEntities(
      stubArr.map((s) => ({
        id: s.slug,
        stableId: s.stableId,
        entityType: "organization",
        title: s.displayName,
        metadata: {
          stub: true,
          source: "fmti-ingest",
          // Capture observed display-name aliases on the metadata blob so
          // future runs (or a follow-up that promotes these to wiki pages)
          // can recover the variants. The entities schema has no native
          // aliases column — those live in YAML.
          fmtiAliases: [...s.aliases],
        },
      })),
    );
    if (!result.ok) {
      // Don't fail hard — strip the un-synced stubs from the resolution map
      // so the grade sync's FK validation rejects them instead of silently
      // shipping orphan refs.
      for (const s of stubArr) {
        for (const alias of s.aliases) out.delete(alias);
      }
    }
  }

  return out;
}

function registerStub(
  bySlug: Map<
    string,
    { slug: string; displayName: string; stableId: string; aliases: Set<string> }
  >,
  slug: string,
  displayName: string,
): void {
  const existing = bySlug.get(slug);
  if (existing) {
    existing.aliases.add(displayName);
    return;
  }
  bySlug.set(slug, {
    slug,
    displayName,
    stableId: generateId(`organization:${slug}`),
    aliases: new Set([displayName]),
  });
}

function toSlug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function loadOrgOverrides(): Record<string, string> {
  try {
    const text = readFileSync(resolvePath(ORG_OVERRIDES_PATH), "utf-8");
    const parsed = parseYaml(text) as { overrides?: Record<string, string> };
    return parsed.overrides ?? {};
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Wiki-server sync
// ---------------------------------------------------------------------------

async function syncWaveToServer(
  snapshot: ScorecardSnapshotRecord,
  grades: ScorecardGradeRecord[],
): Promise<{ snapshots: number; grades: number; errors: string[] }> {
  const serverUrl = getServerUrl();
  const errors: string[] = [];
  if (!serverUrl) {
    return {
      snapshots: 0,
      grades: 0,
      errors: ["LONGTERMWIKI_SERVER_URL not configured — cannot sync"],
    };
  }

  // The typed sync clients accept `Array<Record<string, unknown>>` (the
  // server-side validates against a Zod schema, so the runtime check is
  // authoritative). Our records are stricter than that — assignable but not
  // structurally identical, hence the cast.
  const snapResult = await syncScorecardSnapshots([
    { ...snapshot } as unknown as Record<string, unknown>,
  ]);
  if (!snapResult.ok) {
    errors.push(`Snapshot sync failed: ${snapResult.message}`);
    return { snapshots: 0, grades: 0, errors };
  }
  const snapshotsUpserted = snapResult.data.upserted;

  let gradesUpserted = 0;
  for (let i = 0; i < grades.length; i += GRADES_BATCH_SIZE) {
    const batch = grades.slice(i, i + GRADES_BATCH_SIZE);
    const r = await syncScorecardGrades(
      batch.map((g) => ({ ...g })) as Array<Record<string, unknown>>,
    );
    if (!r.ok) {
      errors.push(
        `Grades batch ${Math.floor(i / GRADES_BATCH_SIZE) + 1} (${batch.length} items) failed: ${r.message}`,
      );
      continue;
    }
    gradesUpserted += r.data.upserted;
  }

  return { snapshots: snapshotsUpserted, grades: gradesUpserted, errors };
}

function formatErr(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
