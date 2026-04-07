import { NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/source-check-coverage-proxy
 *
 * Proxies source-check coverage requests to the wiki-server's
 * /api/source-checks/coverage endpoint.
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
    const url = `${config.serverUrl}/api/source-checks/coverage`;
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
      `[source-check-coverage-proxy] Failed to fetch coverage: ${err instanceof Error ? err.message : String(err)}`
    );
    return NextResponse.json(
      { error: "Wiki server unreachable", coverage: [] },
      { status: 502 },
    );
  }
}
