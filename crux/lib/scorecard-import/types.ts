/**
 * Types for the scorecard-import pipeline (QUA-698).
 *
 * Each source ships a `ScorecardSourceAdapter` that knows how to:
 *   1. Enumerate its waves (snapshots).
 *   2. Parse cached raw input (HTML, PDF text, JSON) into RawGrades.
 *   3. Optionally fetch fresh raw input into `data/scorecards/raw/<source>/`.
 *
 * The shared engine (`sync.ts`) then resolves entity refs via the alias map,
 * builds the API payloads, and POSTs them to wiki-server.
 */

import type { ScorecardSourceKey } from "../../../apps/web/src/app/scorecards/scorecards-constants.ts";

export type { ScorecardSourceKey };

/**
 * One snapshot row (a wave of a scorecard). Maps 1:1 to
 * `scorecard_snapshots` / the `/api/scorecard-snapshots/sync` payload.
 *
 * `id` is the deterministic snapshot ID — must round-trip across reruns so
 * the upsert is idempotent. Convention: `<source>-<wave-slug>` e.g.
 * `fli_index-summer-2025`, `saferai-2026-04`.
 */
export interface RawSnapshot {
  id: string;
  scorecardSource: ScorecardSourceKey;
  waveLabel: string | null;
  publishedAt: string; // ISO YYYY-MM-DD
  sourceUrl: string;
  methodologyUrl?: string | null;
  license?: string | null;
  notes?: string | null;
  isLatest: boolean;
  sourceActive: boolean;
}

/**
 * One grade row (a cell in a scorecard). The engine resolves `orgName` to
 * an entity stableId via `org-aliases.yaml` before sync; unresolved names
 * cause the sync to hard-fail rather than silently drop.
 *
 * `dimensionSlug = "overall"` denotes the per-org rollup; the directory
 * matrix queries with `?overall=true` and ignores everything else.
 */
export interface RawGrade {
  /** Snapshot this grade belongs to (matches `RawSnapshot.id`). */
  snapshotId: string;
  /** Display name from the source. Used for entity lookup + audit. */
  orgName: string;
  /** Aliases the source publishes for this org (helps fuzzy lookup). */
  orgAliases?: string[];
  /** Dimension slug (kebab-case). `overall` for the rollup. */
  dimensionSlug: string;
  /** Human label from the source. */
  dimensionLabel: string;
  /** 0-1 weight of this dimension (only when source publishes weights). */
  dimensionWeight?: number | null;
  /** For nested dimensions (FMTI subdomains, FLI sub-axes). */
  dimensionParentSlug?: string | null;
  /** Numeric score if the source publishes one (percent, point total, etc.). */
  scoreNumeric?: number | null;
  /** Letter grade if the source publishes one (A, B+, F, "Partial"). */
  scoreLetter?: string | null;
  /** Verbatim score string (audit fidelity, always present). */
  scoreRaw: string;
  notes?: string | null;
  /** Per-cell URL when the source links to a justification page. */
  sourceUrl?: string | null;
}

/**
 * A source adapter — one per scorecard publisher. Implementations live in
 * `crux/lib/scorecard-import/sources/<key>.ts` and are wired into the
 * dispatcher via `sources/index.ts::ALL_SOURCES`.
 */
export interface ScorecardSourceAdapter {
  /** PG enum value — must match `ScorecardSourceKey`. */
  source: ScorecardSourceKey;
  /** Display name for CLI output. */
  name: string;
  /**
   * Build all snapshots this adapter knows about (including historical
   * waves). Reads from `data/scorecards/raw/<source>/` — does NOT fetch
   * from the network. `fetch()` is the separate subcommand for that.
   */
  listSnapshots(): RawSnapshot[];
  /**
   * Parse all grade rows for the given snapshot from cached raw input.
   * Each row is expected to be already-typed by the adapter; the shared
   * engine handles entity resolution and API payload construction.
   *
   * Throws if raw input is missing — the caller should run `fetch` first.
   */
  parseGrades(snapshot: RawSnapshot): RawGrade[];
  /**
   * Optional: fetch the source's raw HTML/PDF/JSON into
   * `data/scorecards/raw/<source>/<wave>/`. When unimplemented, the
   * adapter is "manual-only" — raw inputs are committed by hand. Most
   * adapters provide this for convenience but it is not required.
   */
  fetch?(snapshot: RawSnapshot): Promise<void>;
}

/**
 * Result of resolving a `RawGrade.orgName` against the alias map +
 * `database.json` entity index.
 */
export interface ResolvedGrade {
  raw: RawGrade;
  /** entities.stable_id (sid_…). */
  entityId: string;
  /** Canonical title from database.json — used as `entityDisplayName`. */
  canonicalName: string;
}

/** Counters returned by `analyzeSource()` — used by the CLI summary. */
export interface SourceAnalysis {
  source: ScorecardSourceKey;
  snapshots: number;
  grades: number;
  uniqueOrgs: number;
  resolved: number;
  unresolved: string[];
}
