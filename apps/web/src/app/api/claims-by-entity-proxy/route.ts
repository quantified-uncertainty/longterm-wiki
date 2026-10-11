import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/claims-by-entity-proxy?entity_id=...
 *
 * Proxies per-entity claims requests to wiki-server /api/claims/by-entity/:entityId.
 */
export async function GET(request: NextRequest) {
  const entityId = request.nextUrl.searchParams.get("entity_id");
  if (!entityId || entityId.length > 200) {
    return NextResponse.json(
      { error: "validation_error", message: "Missing or invalid entity_id" },
      { status: 400 },
    );
  }

  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "not_configured", message: "Wiki server not configured" },
      { status: 503 },
    );
  }

  try {
    const params = new URLSearchParams();
    const rawLimit = parseInt(request.nextUrl.searchParams.get("limit") ?? "50", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
    params.set("limit", String(limit));

    const rawOffset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10);
    if (Number.isFinite(rawOffset) && rawOffset > 0) {
      params.set("offset", String(rawOffset));
    }

    const url = `${config.serverUrl}/api/claims/by-entity/${encodeURIComponent(entityId)}?${params.toString()}`;
    const res = await fetch(url, {
      headers: config.headers,
      signal: AbortSignal.timeout(15_000),
    });

    return new NextResponse(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "connection_error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
