import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/source-check-detail?recordType=...&recordId=...
 *
 * Proxies source-check evidence requests to the wiki-server's
 * /api/source-checks/evidence/:recordType/:recordId endpoint.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const recordType = searchParams.get("recordType");
  const recordId = searchParams.get("recordId");

  if (!recordType || !recordId) {
    return NextResponse.json(
      { error: "recordType and recordId are required" },
      { status: 400 },
    );
  }

  if (recordId.length > 500 || recordType.length > 50) {
    return NextResponse.json(
      { error: "Parameter too long" },
      { status: 400 },
    );
  }

  // Validate IDs contain only safe characters
  if (!/^[\w.\-:]+$/.test(recordId) || !/^[\w.\-]+$/.test(recordType)) {
    return NextResponse.json(
      { error: "Parameters contain invalid characters" },
      { status: 400 },
    );
  }

  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "Wiki server not configured" },
      { status: 503 },
    );
  }

  try {
    const url = `${config.serverUrl}/api/source-checks/evidence/${encodeURIComponent(recordType)}/${encodeURIComponent(recordId)}`;
    const res = await fetch(url, {
      headers: config.headers,
      signal: AbortSignal.timeout(10000),
    });

    if (!res.ok) {
      if (res.status === 404) {
        return NextResponse.json(
          { error: "Evidence not found" },
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
