import { NextRequest, NextResponse } from "next/server";

/**
 * GET /api/agent-session-events?agentId=N&limit=100
 *
 * Proxies agent session events requests to the wiki-server's
 * /api/agent-session-events/by-agent/:agentId endpoint.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const agentId = searchParams.get("agentId");
  const limit = searchParams.get("limit") || "100";

  if (!agentId) {
    return NextResponse.json(
      { error: "agentId is required" },
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
    const apiKey =
      process.env.LONGTERMWIKI_PROJECT_KEY ||
      process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    const url = `${serverUrl}/api/agent-session-events/by-agent/${agentId}?limit=${limit}`;
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
