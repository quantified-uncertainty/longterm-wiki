/**
 * API key authentication middleware.
 *
 * Uses a single key (`LONGTERMWIKI_SERVER_API_KEY`) for all API access.
 * If no key is configured, all requests pass through (dev mode).
 */

import { timingSafeEqual } from "node:crypto";
import type { Context, Next, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

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
 * Middleware that validates the API key.
 *
 * If no key is configured, all requests pass through (dev mode).
 * If a key is configured, a valid Bearer token is required.
 */
export function validateApiKey(): MiddlewareHandler {
  return async (c: Context, next: Next) => {
    const expectedKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

    // If no key is configured, skip auth (dev mode)
    if (!expectedKey) {
      await next();
      return;
    }

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
