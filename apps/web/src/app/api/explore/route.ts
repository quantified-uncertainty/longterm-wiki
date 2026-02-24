import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/explore?limit=50&offset=0&search=...&entityType=...&category=...&cluster=...&sort=...
 *
 * Proxies explore requests to the wiki-server's /api/explore endpoint.
 * Returns 503 when the wiki-server is unavailable so the client can fall back
 * to local data.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;

  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    return NextResponse.json(
      { error: "Wiki server not configured" },
      { status: 503 },
    );
  }

  try {
    const headers: Record<string, string> = {};
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    // Forward all query params to the wiki-server
    const url = `${serverUrl}/api/explore?${searchParams.toString()}`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(5000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Wiki server error" },
        { status: 503 },
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
