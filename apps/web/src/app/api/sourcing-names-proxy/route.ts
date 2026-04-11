import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";
import { getTypedEntityByStableId, getIdRegistry } from "@/data/tablebase";
import { getKBFactById, getKBProperty, getKBEntity } from "@/data/factbase";

/**
 * GET /api/sourcing-names-proxy?record_type=...&record_ids=id1,id2,...
 *
 * Resolves record IDs to human-readable names.
 *
 * For `record_type=entity`: resolves locally from database.json (no wiki-server needed).
 * Returns { names: Record<string, string>, hrefs: Record<string, string> }.
 *
 * For all other types: proxies to the wiki-server's /api/sourcing/resolve-names endpoint.
 * Batches requests to stay within wiki-server's 10,000-char query string limit.
 * Returns { names: Record<string, string> }.
 */

/**
 * Maximum character length for the record_ids query parameter per batch.
 * The wiki-server's Zod schema enforces max(10000), and long URLs can cause
 * issues with HTTP servers. Use a conservative limit to leave room for
 * URL encoding overhead and other query parameters.
 */
const MAX_IDS_CHARS_PER_BATCH = 6000;

/**
 * Validate and sanitize a record ID.
 * Returns the trimmed ID if valid, or null if it should be filtered out.
 */
function sanitizeRecordId(id: string): string | null {
  const trimmed = id.trim();
  if (!trimmed) return null;
  // Record IDs should be reasonable length (varchar(10) IDs, stableIds, or
  // citation format like "page:<slug>:fn<N>"). Reject anything suspiciously long.
  if (trimmed.length > 200) return null;
  return trimmed;
}

/**
 * Split an array of IDs into batches where each batch's comma-joined string
 * stays within the character limit.
 */
function batchIds(ids: string[], maxChars: number): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const id of ids) {
    // +1 for the comma separator (except for the first item)
    const addedLen = current.length === 0 ? id.length : id.length + 1;
    if (currentLen + addedLen > maxChars && current.length > 0) {
      batches.push(current);
      current = [id];
      currentLen = id.length;
    } else {
      current.push(id);
      currentLen += addedLen;
    }
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}

export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const recordType = searchParams.get("record_type");
  const recordIds = searchParams.get("record_ids");

  if (!recordType || !recordIds) {
    return NextResponse.json(
      { error: "record_type and record_ids are required" },
      { status: 400 },
    );
  }

  if (recordType.length > 50 || recordIds.length > 60_000) {
    return NextResponse.json(
      { error: "Parameter too long" },
      { status: 400 },
    );
  }

  // Validate recordType contains only safe characters
  if (!/^[\w.\-]+$/.test(recordType)) {
    return NextResponse.json(
      { error: "record_type contains invalid characters" },
      { status: 400 },
    );
  }

  const allIds = recordIds
    .split(",")
    .map(sanitizeRecordId)
    .filter((id): id is string => id !== null);

  if (allIds.length === 0) {
    return NextResponse.json({ names: {} });
  }

  // Fact resolution: use local FactBase data (fast, no wiki-server dependency)
  if (recordType === "fact") {
    const names: Record<string, string> = {};

    for (const factId of allIds) {
      const fact = getKBFactById(factId);
      if (fact) {
        const entity = getKBEntity(fact.subjectId);
        const property = getKBProperty(fact.propertyId);
        const entityName = entity?.name ?? fact.subjectId;
        const propertyName = property?.name ?? fact.propertyId;
        names[factId] = `${entityName} — ${propertyName}`;
      }
    }

    return NextResponse.json({ names });
  }

  // Entity resolution: use local database.json (fast, no wiki-server dependency)
  if (recordType === "entity") {
    const names: Record<string, string> = {};
    const hrefs: Record<string, string> = {};
    const registry = getIdRegistry();

    for (const stableId of allIds) {
      const entity = getTypedEntityByStableId(stableId);
      if (entity) {
        names[stableId] = entity.title;
        const wikiId = registry.bySlug[entity.id];
        if (wikiId) {
          hrefs[stableId] = `/wiki/${wikiId}`;
        }
      }
    }

    return NextResponse.json({ names, hrefs });
  }

  // All other types: proxy to wiki-server in batches
  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "Wiki server not configured" },
      { status: 503 },
    );
  }

  const batches = batchIds(allIds, MAX_IDS_CHARS_PER_BATCH);

  // Cap outbound fan-out to prevent amplification attacks
  if (batches.length > 10) {
    return NextResponse.json(
      { error: "Too many record IDs — reduce the request size" },
      { status: 400 },
    );
  }

  const names: Record<string, string> = {};

  try {
    const batchResults = await Promise.allSettled(
      batches.map(async (ids) => {
        const idsStr = ids.join(",");
        const params = new URLSearchParams({
          record_type: recordType,
          record_ids: idsStr,
        });
        const url = `${config.serverUrl}/api/sourcing/resolve-names?${params.toString()}`;
        const res = await fetch(url, {
          headers: config.headers,
          signal: AbortSignal.timeout(10_000),
        });

        if (!res.ok) {
          const body = await res.text().catch(() => "");
          console.warn(
            `[sourcing-names-proxy] Wiki server returned ${res.status} for ${recordType} ` +
            `(${ids.length} IDs, ${idsStr.length} chars): ${body.slice(0, 500)}`
          );
          return null;
        }

        return await res.json();
      })
    );

    for (const result of batchResults) {
      if (result.status === "fulfilled" && result.value?.names) {
        for (const [id, name] of Object.entries(result.value.names as Record<string, string>)) {
          if (typeof name === "string" && name.startsWith("new:")) {
            names[id] = name.slice(4).trim();
          } else if (typeof name === "string") {
            names[id] = name;
          }
        }
      } else if (result.status === "rejected") {
        console.warn(
          `[sourcing-names-proxy] Batch request failed for ${recordType}: ` +
          `${result.reason instanceof Error ? result.reason.message : String(result.reason)}`
        );
      }
    }

    const hadError = batchResults.some(
      r => r.status === "rejected" || (r.status === "fulfilled" && r.value === null)
    );
    return NextResponse.json({
      names,
      ...(hadError ? { partial: true } : {}),
    });
  } catch (err) {
    console.warn(
      `[sourcing-names-proxy] Failed to resolve names for ${recordType}: ${err instanceof Error ? err.message : String(err)}`
    );
    return NextResponse.json(
      { error: "Wiki server unreachable", names: {} },
      { status: 502 },
    );
  }
}
