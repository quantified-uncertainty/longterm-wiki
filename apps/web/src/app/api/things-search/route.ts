import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/things-search?q=...&thing_type=...&limit=20
 *
 * Proxies search requests to the wiki-server's things full-text search.
 * Returns 503 when the wiki-server is unavailable.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q");
  const thingType = searchParams.get("thing_type");
  const rawLimit = parseInt(searchParams.get("limit") ?? "20", 10);
  const limit = Math.min(Math.max(isNaN(rawLimit) ? 20 : rawLimit, 1), 100);

  if (!q || !q.trim()) {
    return NextResponse.json({ results: [], query: "", total: 0, searchMethod: "none" });
  }

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

    const params = new URLSearchParams({ q, limit: String(limit) });
    if (thingType) params.set("thing_type", thingType);

    const url = `${serverUrl}/api/things/search?${params}`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(3000),
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
