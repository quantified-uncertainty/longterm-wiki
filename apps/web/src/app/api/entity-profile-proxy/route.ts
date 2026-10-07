import { NextRequest, NextResponse } from "next/server";
import { isHiddenPerson } from "@/lib/hidden-people";
import { scrubbedProxyResponse } from "@/lib/scrubbed-proxy-response";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * GET /api/entity-profile-proxy?entity=...
 *
 * Proxies entity profile requests to the wiki-server so that the client-side
 * viewer can fetch data without exposing wiki-server credentials.
 * Hidden people (see hidden-people.ts) are scrubbed from the response.
 */
export async function GET(request: NextRequest) {
  const entity = request.nextUrl.searchParams.get("entity");
  if (!entity || !entity.trim()) {
    return NextResponse.json(
      { error: "validation_error", message: "entity parameter is required" },
      { status: 400 }
    );
  }

  if (isHiddenPerson(entity.trim())) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "not_configured", message: "Wiki server not configured" },
      { status: 503 }
    );
  }

  try {
    const url = `${config.serverUrl}/api/entity-profile/${encodeURIComponent(entity.trim())}`;
    const res = await fetch(url, {
      headers: config.headers,
      signal: AbortSignal.timeout(15_000),
    });

    return await scrubbedProxyResponse(res);
  } catch (err) {
    return NextResponse.json(
      {
        error: "connection_error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 }
    );
  }
}
