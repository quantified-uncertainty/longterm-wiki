import { NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/sourcing-coverage-proxy
 *
 * Proxies sourcing coverage requests to the wiki-server's
 * /api/sourcing/coverage endpoint.
 * Returns { coverage: Array<{ recordType, total, verified, percentage }> }
 */
export async function GET() {
  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "not_configured", message: "Wiki server not configured" },
      { status: 503 },
    );
  }

  try {
    const url = `${config.serverUrl}/api/sourcing/coverage`;
    const res = await fetch(url, {
      headers: config.headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Wiki server error" },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.warn(
      `[sourcing-coverage-proxy] Failed to fetch coverage: ${err instanceof Error ? err.message : String(err)}`
    );
    return NextResponse.json(
      { error: "Wiki server unreachable", coverage: [] },
      { status: 502 },
    );
  }
}
