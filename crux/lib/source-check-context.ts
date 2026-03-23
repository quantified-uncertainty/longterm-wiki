/**
 * Source-Check Verdict Context for Improve Pipeline
 *
 * Fetches source-check verdicts for an entity from the wiki-server and formats
 * them as concise LLM context. Only includes actionable verdicts (contradicted,
 * outdated) so the improve LLM knows which claims need correction.
 *
 * Best-effort: if the wiki-server is unavailable, returns null and the improve
 * pipeline proceeds without this context.
 */

import { apiRequest } from './wiki-server/client.ts';
import { loadDatabase } from './content-types.ts';

/** Shape of a single verdict from the wiki-server API. */
interface SourceCheckVerdict {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number | null;
  needsRecheck: boolean;
  nextCheckDue: string | null;
  lastComputedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

/** Response shape from GET /api/source-checks/verdicts. */
interface VerdictsResponse {
  verdicts: SourceCheckVerdict[];
  total: number;
}

/** Verdicts that are actionable for the improve pipeline. */
const ACTIONABLE_VERDICTS = ['contradicted', 'outdated'] as const;

/**
 * Resolve a page ID (slug like "anthropic") to its stableId for API queries.
 *
 * Returns the slug itself if no stableId is found (the verdict API also stores
 * entity_id as a slug in some cases).
 */
function resolveStableId(pageId: string): string[] {
  try {
    const db = loadDatabase();
    const entities = db.typedEntities ?? db.entities ?? [];
    const entity = entities.find(
      (e) =>
        e.id === pageId ||
        e.wikiId === pageId,
    );
    if (!entity) return [pageId];

    // database.json entities have runtime fields (stableId) not present in
    // the static Entity interface. Use runtime property access.
    const rec = entity as { id: string; wikiId?: string; stableId?: string };
    const ids = new Set<string>();
    ids.add(pageId);
    if (rec.stableId) ids.add(rec.stableId);
    if (rec.wikiId) ids.add(rec.wikiId);
    return Array.from(ids);
  } catch {
    return [pageId];
  }
}

/**
 * Fetch actionable source-check verdicts for a page's entity.
 *
 * Queries the wiki-server for contradicted and outdated verdicts associated
 * with the entity. Returns null if no actionable verdicts are found or if
 * the server is unavailable.
 */
async function fetchActionableVerdicts(
  pageId: string,
): Promise<SourceCheckVerdict[] | null> {
  const entityIds = resolveStableId(pageId);
  const allVerdicts: SourceCheckVerdict[] = [];

  for (const entityId of entityIds) {
    for (const verdict of ACTIONABLE_VERDICTS) {
      const result = await apiRequest<VerdictsResponse>(
        'GET',
        `/api/source-checks/verdicts?entity_id=${encodeURIComponent(entityId)}&verdict=${verdict}&limit=50`,
      );
      if (result.ok) {
        allVerdicts.push(...result.data.verdicts);
      }
    }
  }

  if (allVerdicts.length === 0) return null;

  // Deduplicate by (recordType, recordId, fieldName) in case multiple entity IDs matched
  const seen = new Set<string>();
  const deduped: SourceCheckVerdict[] = [];
  for (const v of allVerdicts) {
    const key = `${v.recordType}:${v.recordId}:${v.fieldName ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(v);
    }
  }

  return deduped.length > 0 ? deduped : null;
}

/**
 * Format a single verdict as a concise bullet point for the LLM.
 */
function formatVerdict(v: SourceCheckVerdict): string {
  const confidence = v.confidence != null ? ` (confidence: ${(v.confidence * 100).toFixed(0)}%)` : '';
  const field = v.fieldName ? ` [field: ${v.fieldName}]` : '';
  const reasoning = v.reasoning
    ? ` — ${v.reasoning.slice(0, 300)}`
    : '';
  return `- [${v.verdict}]${field}${confidence} ${v.recordType}/${v.recordId}${reasoning}`;
}

/**
 * Build source-check verdict context for a wiki page.
 *
 * Fetches contradicted and outdated verdicts from the wiki-server and formats
 * them as a compact block for injection into the improve LLM prompt.
 *
 * Returns null if:
 * - The wiki-server is unavailable
 * - No actionable verdicts exist for this entity
 * - An error occurs (best-effort, never throws)
 *
 * @param pageId - The wiki page slug (e.g. "anthropic")
 */
export async function buildSourceCheckContext(
  pageId: string,
): Promise<string | null> {
  try {
    const verdicts = await fetchActionableVerdicts(pageId);
    if (!verdicts || verdicts.length === 0) return null;

    const lines: string[] = [];
    lines.push(`Source-check warnings for this entity (${verdicts.length} issue${verdicts.length === 1 ? '' : 's'}):`);
    lines.push('');

    const contradicted = verdicts.filter(v => v.verdict === 'contradicted');
    const outdated = verdicts.filter(v => v.verdict === 'outdated');

    if (contradicted.length > 0) {
      lines.push(`CONTRADICTED (${contradicted.length}):`);
      for (const v of contradicted) {
        lines.push(formatVerdict(v));
      }
      lines.push('');
    }

    if (outdated.length > 0) {
      lines.push(`OUTDATED (${outdated.length}):`);
      for (const v of outdated) {
        lines.push(formatVerdict(v));
      }
      lines.push('');
    }

    return lines.join('\n');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[source-check-context] Failed to fetch verdicts for "${pageId}": ${msg} — skipping`);
    return null;
  }
}
