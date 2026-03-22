import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/entity-verifications-proxy?entity_id=...&record_type=...&limit=...
 *
 * Proxies verification verdict + evidence requests to the wiki-server.
 */
export async function GET(request: NextRequest) {
  const entityId = request.nextUrl.searchParams.get("entity_id");
  if (!entityId || !entityId.trim()) {
    return NextResponse.json(
      { error: "validation_error", message: "entity_id parameter is required" },
      { status: 400 }
    );
  }

  if (entityId.length > 200 || !/^[\w.\-:]+$/.test(entityId)) {
    return NextResponse.json(
      { error: "validation_error", message: "Invalid entity_id" },
      { status: 400 }
    );
  }

  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "not_configured", message: "Wiki server not configured" },
      { status: 503 }
    );
  }

  try {
    // Forward all query params to the unified verifications endpoint
    const params = new URLSearchParams();
    params.set("entity_id", entityId.trim());
    params.set("limit", request.nextUrl.searchParams.get("limit") ?? "200");
    const recordType = request.nextUrl.searchParams.get("record_type");
    if (recordType) params.set("record_type", recordType);
    const verdict = request.nextUrl.searchParams.get("verdict");
    if (verdict) params.set("verdict", verdict);

    const url = `${config.serverUrl}/api/verifications/verdicts?${params.toString()}`;
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
      { status: 502 }
    );
  }
}
