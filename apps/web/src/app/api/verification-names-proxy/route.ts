import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";
import { getTypedEntityByStableId, getIdRegistry } from "@/data/tablebase";
import { getKBFactById, getKBProperty, getKBEntity } from "@/data/factbase";

/**
 * GET /api/verification-names-proxy?record_type=...&record_ids=id1,id2,...
 *
 * Resolves record IDs to human-readable names.
 *
 * For `record_type=entity`: resolves locally from database.json (no wiki-server needed).
 * Returns { names: Record<string, string>, hrefs: Record<string, string> }.
 *
 * For all other types: proxies to the wiki-server's /api/verifications/resolve-names endpoint.
 * Returns { names: Record<string, string> }.
 */
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

  if (recordType.length > 50 || recordIds.length > 10_000) {
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

  // Fact resolution: use local FactBase data (fast, no wiki-server dependency)
  if (recordType === "fact") {
    const ids = recordIds.split(",").filter(Boolean);
    const names: Record<string, string> = {};

    for (const factId of ids) {
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
    const ids = recordIds.split(",").filter(Boolean);
    const names: Record<string, string> = {};
    const hrefs: Record<string, string> = {};
    const registry = getIdRegistry();

    for (const stableId of ids) {
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

  // All other types: proxy to wiki-server
  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "Wiki server not configured" },
      { status: 503 },
    );
  }

  try {
    const params = new URLSearchParams({
      record_type: recordType,
      record_ids: recordIds,
    });
    const url = `${config.serverUrl}/api/verifications/resolve-names?${params.toString()}`;
    const res = await fetch(url, {
      headers: config.headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Wiki server error", names: {} },
        { status: res.status },
      );
    }

    const data = await res.json();
    // Strip "new:" prefix from resolved names at API boundary
    if (data.names) {
      for (const key of Object.keys(data.names)) {
        if (typeof data.names[key] === "string" && data.names[key].startsWith("new:")) {
          data.names[key] = data.names[key].slice(4).trim();
        }
      }
    }
    return NextResponse.json(data);
  } catch (err) {
    console.warn(
      `[verification-names-proxy] Failed to resolve names: ${err instanceof Error ? err.message : String(err)}`
    );
    return NextResponse.json(
      { error: "Wiki server unreachable", names: {} },
      { status: 502 },
    );
  }
}
