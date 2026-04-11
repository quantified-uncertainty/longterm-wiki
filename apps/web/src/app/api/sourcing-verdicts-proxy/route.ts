import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/sourcing-verdicts-proxy?entity_id=...&record_type=...&limit=...
 *
 * Proxies sourcing verdict requests to the wiki-server.
 * entity_id is optional — omit it to fetch all verdicts.
 */
export async function GET(request: NextRequest) {
  const entityId = request.nextUrl.searchParams.get("entity_id");

  if (entityId && (entityId.length > 200 || !/^[\w.\-:*]+$/.test(entityId))) {
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
    // Forward validated query params to the sourcing verdicts endpoint
    const params = new URLSearchParams();
    if (entityId && entityId.trim() && entityId !== "*") {
      params.set("entity_id", entityId.trim());
    }
    const rawLimit = parseInt(request.nextUrl.searchParams.get("limit") ?? "500", 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 5000) : 500;
    params.set("limit", String(limit));
    const rawOffset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10);
    if (Number.isFinite(rawOffset) && rawOffset > 0) {
      params.set("offset", String(rawOffset));
    }
    const recordType = request.nextUrl.searchParams.get("record_type");
    if (recordType && recordType.length <= 50) params.set("record_type", recordType);
    const verdict = request.nextUrl.searchParams.get("verdict");
    if (verdict && verdict.length <= 50) params.set("verdict", verdict);

    const url = `${config.serverUrl}/api/sourcing/verdicts?${params.toString()}`;
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
