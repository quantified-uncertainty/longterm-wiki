import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/verification-names-proxy?record_type=...&record_ids=id1,id2,...
 *
 * Proxies verification name resolution requests to the wiki-server's
 * /api/verifications/resolve-names endpoint.
 * Returns { names: Record<string, string> } mapping record IDs to human-readable names.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = request.nextUrl;
  const recordType = searchParams.get("record_type");
  const recordIds = searchParams.get("record_ids");

  if (!recordType || !recordIds) {
    return NextResponse.json(
      { error: "record_type and record_ids are required" },
      { status: 400 },
    );
  }

  if (recordType.length > 50 || recordIds.length > 10_000) {
    return NextResponse.json(
      { error: "Parameter too long" },
      { status: 400 },
    );
  }

  // Validate recordType contains only safe characters
  if (!/^[\w.\-]+$/.test(recordType)) {
    return NextResponse.json(
      { error: "record_type contains invalid characters" },
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
    const params = new URLSearchParams({
      record_type: recordType,
      record_ids: recordIds,
    });
    const url = `${config.serverUrl}/api/verifications/resolve-names?${params.toString()}`;
    const res = await fetch(url, {
      headers: config.headers,
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      return NextResponse.json(
        { error: "Wiki server error", names: {} },
        { status: res.status },
      );
    }

    const data = await res.json();
    return NextResponse.json(data);
  } catch (err) {
    console.warn(
      `[verification-names-proxy] Failed to resolve names: ${err instanceof Error ? err.message : String(err)}`
    );
    return NextResponse.json(
      { error: "Wiki server unreachable", names: {} },
      { status: 502 },
    );
  }
}
