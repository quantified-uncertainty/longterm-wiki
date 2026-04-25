import { NextRequest, NextResponse } from "next/server";
import { getWikiServerConfig } from "@lib/wiki-server";

/**
 * Proxy for /api/framework-review/* (QUA-710 / Phase 4-C).
 *
 * The browser doesn't have wiki-server credentials, so the dashboard's
 * client components POST through this Next.js route, which forwards to
 * the upstream framework-review endpoints with the server-side API key.
 *
 * The `path` query param picks the upstream endpoint. We allow:
 *
 *   - GET path=stats|pending-versions|unreviewed-diffs
 *   - GET path=version/<id> | diff/<id>          (id constrained to a safe set)
 *   - POST path=threshold/<id>
 *   - POST path=version/<id>/publish
 *   - POST path=diff/<id>
 *
 * Unknown paths return 400 — the allowlist is the security boundary
 * (no path-traversal, no hitting other wiki-server routes).
 */

const ID_RE = /^[A-Za-z0-9_-]{1,200}$/;

type AllowedPath =
  | { method: "GET"; pattern: "stats" | "pending-versions" | "unreviewed-diffs" }
  | { method: "GET"; pattern: "version/:id" | "diff/:id"; id: string }
  | { method: "POST"; pattern: "threshold/:id" | "version/:id/publish" | "diff/:id"; id: string };

function resolvePath(method: "GET" | "POST", raw: string | null): AllowedPath | null {
  if (!raw) return null;

  if (method === "GET") {
    if (raw === "stats" || raw === "pending-versions" || raw === "unreviewed-diffs") {
      return { method: "GET", pattern: raw };
    }
    const versionMatch = raw.match(/^version\/([^/]+)$/);
    if (versionMatch && ID_RE.test(versionMatch[1])) {
      return { method: "GET", pattern: "version/:id", id: versionMatch[1] };
    }
    const diffMatch = raw.match(/^diff\/([^/]+)$/);
    if (diffMatch && ID_RE.test(diffMatch[1])) {
      return { method: "GET", pattern: "diff/:id", id: diffMatch[1] };
    }
    return null;
  }

  // POST
  const thresholdMatch = raw.match(/^threshold\/([^/]+)$/);
  if (thresholdMatch && ID_RE.test(thresholdMatch[1])) {
    return { method: "POST", pattern: "threshold/:id", id: thresholdMatch[1] };
  }
  const publishMatch = raw.match(/^version\/([^/]+)\/publish$/);
  if (publishMatch && ID_RE.test(publishMatch[1])) {
    return { method: "POST", pattern: "version/:id/publish", id: publishMatch[1] };
  }
  const diffMatch = raw.match(/^diff\/([^/]+)$/);
  if (diffMatch && ID_RE.test(diffMatch[1])) {
    return { method: "POST", pattern: "diff/:id", id: diffMatch[1] };
  }
  return null;
}

function buildUpstreamPath(p: AllowedPath): string {
  switch (p.pattern) {
    case "stats":
    case "pending-versions":
    case "unreviewed-diffs":
      return `/api/framework-review/${p.pattern}`;
    case "version/:id":
      return `/api/framework-review/version/${encodeURIComponent(p.id)}`;
    case "diff/:id":
      return `/api/framework-review/diff/${encodeURIComponent(p.id)}`;
    case "threshold/:id":
      return `/api/framework-review/threshold/${encodeURIComponent(p.id)}`;
    case "version/:id/publish":
      return `/api/framework-review/version/${encodeURIComponent(p.id)}/publish`;
  }
}

export async function GET(request: NextRequest) {
  return forward(request, "GET");
}

export async function POST(request: NextRequest) {
  return forward(request, "POST");
}

async function forward(request: NextRequest, method: "GET" | "POST") {
  const config = getWikiServerConfig();
  if (!config) {
    return NextResponse.json(
      { error: "not_configured", message: "Wiki server not configured" },
      { status: 503 },
    );
  }

  const allowed = resolvePath(method, request.nextUrl.searchParams.get("path"));
  if (!allowed) {
    return NextResponse.json(
      { error: "validation_error", message: "Invalid or missing path" },
      { status: 400 },
    );
  }

  try {
    const url = `${config.serverUrl}${buildUpstreamPath(allowed)}`;
    const init: RequestInit = {
      method,
      headers: {
        ...config.headers,
        ...(method === "POST" ? { "content-type": "application/json" } : {}),
      },
      signal: AbortSignal.timeout(15_000),
    };
    if (method === "POST") {
      const body = await request.text();
      init.body = body;
    }
    const res = await fetch(url, init);
    return new NextResponse(res.body, {
      status: res.status,
      headers: { "content-type": res.headers.get("content-type") ?? "application/json" },
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: "connection_error",
        message: err instanceof Error ? err.message : String(err),
      },
      { status: 502 },
    );
  }
}
