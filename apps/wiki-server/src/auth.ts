/**
 * Scoped API key authentication middleware.
 *
 * Supports three key types:
 *   - Legacy superkey (`LONGTERMWIKI_SERVER_API_KEY`) — grants all scopes
 *   - Project key (`LONGTERMWIKI_PROJECT_KEY`) — append-only coordination
 *     (IDs, sessions, edit logs, jobs, agent sessions, auto-update tracking)
 *   - Content key (`LONGTERMWIKI_CONTENT_KEY`) — destructive content sync
 *     (pages, entities, facts, claims, citations, resources, links, summaries,
 *      hallucination risk, artifacts)
 *
 * Read requests (GET) are allowed by any valid key.
 * Write requests require the appropriate scope.
 */

import type { Context, Next, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export type ApiScope = "project" | "content";

interface KeyConfig {
  legacyKey?: string;
  projectKey?: string;
  contentKey?: string;
}

/** Read key config from environment variables. */
export function getKeyConfig(): KeyConfig {
  return {
    legacyKey: process.env.LONGTERMWIKI_SERVER_API_KEY,
    projectKey: process.env.LONGTERMWIKI_PROJECT_KEY,
    contentKey: process.env.LONGTERMWIKI_CONTENT_KEY,
  };
}

/** Determine which scopes a bearer token grants. Returns empty array if invalid. */
export function resolveScopes(
  token: string,
  config: KeyConfig
): ApiScope[] {
  // Legacy superkey grants all scopes
  if (config.legacyKey && token === config.legacyKey) {
    return ["project", "content"];
  }

  // Scoped keys grant their specific scope only
  const scopes: ApiScope[] = [];
  if (config.projectKey && token === config.projectKey) {
    scopes.push("project");
  }
  if (config.contentKey && token === config.contentKey) {
    scopes.push("content");
  }

  return scopes;
}

/** Extract Bearer token from Authorization header. */
function extractBearerToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/**
 * Middleware that validates any API key and sets resolved scopes on the context.
 *
 * If no keys are configured at all, all requests pass through (dev mode).
 * If keys are configured, a valid Bearer token is required.
 */
export function validateApiKey(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const config = getKeyConfig();

    // If no keys are configured at all, skip auth (dev mode)
    if (!config.legacyKey && !config.projectKey && !config.contentKey) {
      c.set("apiScopes", ["project", "content"]);
      await next();
      return;
    }

    const token = extractBearerToken(c);
    if (!token) {
      throw new HTTPException(401, { message: "Bearer token required" });
    }

    const scopes = resolveScopes(token, config);
    if (scopes.length === 0) {
      throw new HTTPException(401, { message: "Invalid API key" });
    }

    c.set("apiScopes", scopes);
    await next();
  };
}

/**
 * Middleware that restricts write operations (non-GET) to keys with the given scope.
 *
 * GET requests pass through regardless of scope (reads are allowed for all keys).
 * Non-GET requests require the specified scope.
 */
export function requireWriteScope(scope: ApiScope): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    // GET requests are always allowed (read access)
    if (c.req.method === "GET") {
      await next();
      return;
    }

    const scopes: ApiScope[] = c.get("apiScopes") ?? [];
    if (!scopes.includes(scope)) {
      throw new HTTPException(403, {
        message: `This endpoint requires '${scope}' scope for ${c.req.method} requests`,
      });
    }

    await next();
  };
}
