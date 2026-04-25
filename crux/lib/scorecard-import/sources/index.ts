/**
 * Scorecard source registry. Each source ships an adapter; the dispatcher
 * looks them up here by their PG enum value (`ScorecardSourceKey`).
 *
 * FMTI is intentionally absent — it has its own ingester (QUA-697) which
 * reads CSV from a CC-BY-4.0 GitHub repo and is unrelated to the
 * scrape/extract pattern these four share.
 */

import { fliAdapter } from "./fli.ts";
import { saferaiAdapter } from "./saferai.ts";
import { aiLabWatchAdapter } from "./ailabwatch.ts";
import { seoulAdapter } from "./seoul.ts";
import type {
  ScorecardSourceAdapter,
  ScorecardSourceKey,
} from "../types.ts";

export const ALL_SOURCES: readonly ScorecardSourceAdapter[] = [
  fliAdapter,
  saferaiAdapter,
  aiLabWatchAdapter,
  seoulAdapter,
] as const;

const BY_KEY = new Map<ScorecardSourceKey, ScorecardSourceAdapter>(
  ALL_SOURCES.map((a) => [a.source, a]),
);

export function getAdapter(
  source: ScorecardSourceKey,
): ScorecardSourceAdapter {
  const a = BY_KEY.get(source);
  if (!a) {
    throw new Error(
      `Unknown scorecard source "${source}". Available: ${[...BY_KEY.keys()].join(", ")}`,
    );
  }
  return a;
}

export function listSourceKeys(): ScorecardSourceKey[] {
  return [...BY_KEY.keys()];
}
