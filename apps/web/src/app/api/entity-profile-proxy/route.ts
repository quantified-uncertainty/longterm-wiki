import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/entity-profile-proxy?entity=...
 *
 * Proxies entity profile requests to the wiki-server so that the client-side
 * viewer can fetch data without exposing wiki-server credentials.
 * Streams the response body through without parsing/re-serializing.
 */
export async function GET(request: NextRequest) {
  const entity = request.nextUrl.searchParams.get("entity");
  if (!entity || !entity.trim()) {
    return NextResponse.json(
      { error: "validation_error", message: "entity parameter is required" },
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
    const url = `${config.serverUrl}/api/entity-profile/${encodeURIComponent(entity.trim())}`;
    const res = await fetch(url, {
      headers: config.headers,
      signal: AbortSignal.timeout(15_000),
    });

    // Stream response body through without parse+reserialize
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
