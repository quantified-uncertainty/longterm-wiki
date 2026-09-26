/**
 * API key authentication middleware.
 *
 * Uses a single key (`LONGTERMWIKI_SERVER_API_KEY`) for all API access.
 *
 * Modes (see `resolveAuthMode`):
 *   - "key"          — key configured: a valid Bearer token is required.
 *   - "open-dev"     — no key, NODE_ENV !== "production": everything passes
 *                      (local dev, vitest).
 *   - "prod-no-key"  — no key but NODE_ENV === "production" (the Dockerfile
 *                      sets it): a misconfiguration. Reads keep working so
 *                      a missing secret can never take the site down, but
 *                      writes are refused with 503 and the condition is
 *                      logged loudly, instead of silently letting anyone on
 *                      the internet write to the production database.
 */

import { timingSafeEqual } from "node:crypto";
import type { Context, Next, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "./logger.js";

export type AuthMode = "key" | "open-dev" | "prod-no-key";

export function resolveAuthMode(env: NodeJS.ProcessEnv = process.env): AuthMode {
  if (env.LONGTERMWIKI_SERVER_API_KEY) return "key";
  return env.NODE_ENV === "production" ? "prod-no-key" : "open-dev";
}

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Constant-time token comparison to prevent timing side-channel attacks. */
export function verifyToken(token: string, expectedKey: string): boolean {
  const tokenBuf = Buffer.from(token);
  const keyBuf = Buffer.from(expectedKey);
  return tokenBuf.length === keyBuf.length && timingSafeEqual(tokenBuf, keyBuf);
}

/** Extract Bearer token from Authorization header. */
function extractBearerToken(c: Context): string | null {
  const authHeader = c.req.header("Authorization");
  if (!authHeader?.startsWith("Bearer ")) return null;
  return authHeader.slice(7);
}

/**
 * Middleware that validates the API key. Behaviour per `AuthMode` above.
 */
export function validateApiKey(): MiddlewareHandler {
  if (resolveAuthMode() === "prod-no-key") {
    logger.error(
      "LONGTERMWIKI_SERVER_API_KEY is not set while NODE_ENV=production — " +
        "/api writes will be refused (503) until it is set; reads stay open."
    );
  }

  return async (c: Context, next: Next) => {
    const mode = resolveAuthMode();

    if (mode === "open-dev") {
      await next();
      return;
    }

    if (mode === "prod-no-key") {
      if (READ_METHODS.has(c.req.method)) {
        await next();
        return;
      }
      logger.error(
        { method: c.req.method, path: c.req.path },
        "Refusing write: LONGTERMWIKI_SERVER_API_KEY is not configured in production"
      );
      throw new HTTPException(503, {
        message: "Server auth not configured; writes are disabled",
      });
    }

    const expectedKey = process.env.LONGTERMWIKI_SERVER_API_KEY as string;
    const token = extractBearerToken(c);
    if (!token) {
      throw new HTTPException(401, { message: "Bearer token required" });
    }

    if (!verifyToken(token, expectedKey)) {
      throw new HTTPException(401, { message: "Invalid API key" });
    }

    await next();
  };
}
