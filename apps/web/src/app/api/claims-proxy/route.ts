import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/claims-proxy
 *
 * Proxies claims requests to the wiki-server.
 * Supports two modes via the `type` query param:
 * - type=stats: returns aggregate metrics from /api/claims/stats
 * - (default): returns paginated claims list from /api/claims/all
 */
export async function GET(request: NextRequest) {
  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "not_configured", message: "Wiki server not configured" },
      { status: 503 },
    );
  }

  try {
    const type = request.nextUrl.searchParams.get("type");

    let url: string;
    if (type === "stats") {
      url = `${config.serverUrl}/api/claims/stats`;
    } else {
      const params = new URLSearchParams();
      const rawLimit = parseInt(request.nextUrl.searchParams.get("limit") ?? "100", 10);
      const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 500) : 100;
      params.set("limit", String(limit));

      const rawOffset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10);
      if (Number.isFinite(rawOffset) && rawOffset > 0) {
        params.set("offset", String(rawOffset));
      }

      const status = request.nextUrl.searchParams.get("status");
      if (status && status.length <= 50) params.set("status", status);

      const targetTable = request.nextUrl.searchParams.get("target_table");
      if (targetTable && targetTable.length <= 100) params.set("target_table", targetTable);

      const entityId = request.nextUrl.searchParams.get("entity_id");
      if (entityId && entityId.length <= 200) params.set("entity_id", entityId);

      url = `${config.serverUrl}/api/claims/all?${params.toString()}`;
    }

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
