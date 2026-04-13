/**
 * Maps a sourcing `recordType` (e.g. "funding-round") to the wiki-server
 * record-lookup source table name (e.g. "funding_rounds").
 *
 * Centralized here so callers don't guess the table name via regex
 * (QUA-420 — `recordType.replace(/-/g, "_") + "s"` generated garbage like
 * `entity_s`, `fact_s`, `race_s`).
 *
 * Keep in sync with `VALID_RECORD_TYPES` in `apps/wiki-server/src/api-types.ts`
 * and `VALID_SOURCE_TABLES` in `apps/wiki-server/src/routes/tablebase/record-lookup.ts`.
 */

export const RECORD_TYPE_TO_TABLE = {
  grant: "grants",
  personnel: "personnel",
  division: "divisions",
  "funding-program": "funding_programs",
  "funding-round": "funding_rounds",
  investment: "investments",
  "equity-position": "equity_positions",
  "policy-stakeholder": "policy_stakeholders",
  publication: "publications",
  "benchmark-result": "benchmark_results",
  "entity-event": "entity_events",
  "entity-assessment": "entity_assessments",
  citation: "citation_quotes",
  "wiki-page": "wiki_pages",
  fact: "facts",
} as const satisfies Record<string, string>;

export type KnownRecordType = keyof typeof RECORD_TYPE_TO_TABLE;

/** Returns the source table name for a known recordType, or null otherwise. */
export function recordTypeToTable(recordType: string): string | null {
  return (RECORD_TYPE_TO_TABLE as Record<string, string>)[recordType] ?? null;
}
