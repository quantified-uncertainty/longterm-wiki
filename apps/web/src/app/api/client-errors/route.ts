import { NextRequest, NextResponse } from "next/server";

/**
 * POST /api/client-errors
 *
 * Receives client-side errors from the browser and forwards them to
 * wiki-server's /api/operational/monitoring/incidents endpoint.
 *
 * The client uses navigator.sendBeacon (fire-and-forget), so this
 * endpoint should be fast and never fail loudly.
 */
export async function POST(request: NextRequest) {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  if (!serverUrl) {
    return NextResponse.json({ ok: true }); // Silently accept when no server
  }

  try {
    const body = await request.json();

    const incident = {
      service: "vercel-frontend",
      severity: "warning",
      title: `Client error: ${String(body.message ?? "unknown").slice(0, 200)}`,
      detail: body.stack?.slice(0, 3000),
      checkSource: body.source ?? "client-error-reporter",
      metadata: {
        url: body.url,
        userAgent: body.userAgent,
        clientTimestamp: body.timestamp,
      },
    };

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }

    // Fire-and-forget — don't await, just let it go
    fetch(`${serverUrl}/api/operational/monitoring/incidents`, {
      method: "POST",
      headers,
      body: JSON.stringify(incident),
      signal: AbortSignal.timeout(5000),
    }).catch(() => {
      // Intentionally silent — wiki-server may be down
    });

    return NextResponse.json({ ok: true });
  } catch {
    // Malformed body or other error — accept silently
    return NextResponse.json({ ok: true });
  }
}
