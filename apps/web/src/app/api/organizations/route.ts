import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/organizations?limit=50&offset=0&q=...&sort=...
 *
 * Proxies paginated organization requests to the wiki-server's
 * /api/entities/organizations endpoint. Supports search, sort, and pagination.
 */
export async function GET(request: NextRequest) {
  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "Wiki server not configured" },
      { status: 503 },
    );
  }

  try {
    // Forward all query params to the wiki-server
    const { searchParams } = request.nextUrl;
    const url = `${config.serverUrl}/api/entities/organizations?${searchParams.toString()}`;
    const res = await fetch(url, {
      headers: config.headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      // Forward client errors (400, 404) so the UI can distinguish
      // "bad request" from "server down"
      const status = res.status >= 400 && res.status < 500 ? res.status : 503;
      return NextResponse.json(
        { error: `Wiki server error: ${res.status}` },
        { status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch {
    return NextResponse.json(
      { error: "Wiki server unreachable" },
      { status: 503 },
    );
  }
}
