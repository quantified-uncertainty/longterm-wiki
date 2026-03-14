import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/grants/by-entity/:entityId?limit=50&offset=0&q=...&sort=...&status=...
 *
 * Proxies paginated grant requests to the wiki-server's
 * /api/grants/by-entity/:entityId endpoint. Supports search, sort, and filters.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ entityId: string }> },
) {
  const { entityId } = await params;

  // Validate entityId: alphanumeric + hyphens, max 200 chars
  if (!entityId || entityId.length > 200 || !/^[\w-]+$/.test(entityId)) {
    return NextResponse.json({ error: "Invalid entityId" }, { status: 400 });
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

    // Forward all query params to the wiki-server
    const { searchParams } = request.nextUrl;
    const url = `${serverUrl}/api/grants/by-entity/${encodeURIComponent(entityId)}?${searchParams.toString()}`;
    const res = await fetch(url, {
      headers,
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
