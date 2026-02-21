import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/search?q=...&limit=20
 *
 * Proxies search requests to the wiki-server's PostgreSQL full-text search.
 * Returns 503 when the wiki-server is unavailable so the client can fall back
 * to MiniSearch.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const q = searchParams.get("q");
  const limit = searchParams.get("limit") ?? "20";

  if (!q || !q.trim()) {
    return NextResponse.json({ results: [], query: "", total: 0 });
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

    const url = `${serverUrl}/api/pages/search?q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`;
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
