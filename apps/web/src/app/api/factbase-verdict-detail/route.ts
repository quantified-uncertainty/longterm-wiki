import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/factbase-verdict-detail?factId=...
 *
 * Proxies KB verdict detail requests to the wiki-server's
 * /api/kb-verifications/verdicts/:factId endpoint.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const factId = searchParams.get("factId");

  if (!factId) {
    return NextResponse.json(
      { error: "factId is required" },
      { status: 400 },
    );
  }

  // Validate factId length to prevent abuse
  if (factId.length > 100) {
    return NextResponse.json(
      { error: "factId too long" },
      { status: 400 },
    );
  }

  // Validate factId contains only safe characters (alphanumeric, hyphens, underscores, dots, colons)
  if (!/^[\w.\-:]+$/.test(factId)) {
    return NextResponse.json(
      { error: "factId contains invalid characters" },
      { status: 400 },
    );
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

    const url = `${serverUrl}/api/kb-verifications/verdicts/${encodeURIComponent(factId)}`;
    const res = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      if (res.status === 404) {
        return NextResponse.json(
          { error: "Verdict not found" },
          { status: 404 },
        );
      }
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
