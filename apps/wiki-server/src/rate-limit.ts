/**
 * In-memory sliding-window rate limiter middleware for Hono.
 *
 * Provides per-IP rate limiting with configurable limits by endpoint category.
 * Uses a simple sliding window algorithm with automatic cleanup of expired entries.
 *
 * Categories:
 *   - "read"  (GET requests): generous limits (default 100 req/min)
 *   - "write" (POST/PUT/DELETE/PATCH): stricter limits (default 20 req/min)
 *
 * Returns 429 Too Many Requests with a Retry-After header when limits are exceeded.
 */

import type { Context, MiddlewareHandler } from "hono";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// Rate limiter core
// ---------------------------------------------------------------------------

export interface RateLimitConfig {
  /** Maximum number of requests allowed in the window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

interface WindowEntry {
  /** Timestamps of requests within the current window. */
  timestamps: number[];
}

/**
 * Sliding-window rate limiter. Tracks request timestamps per key and checks
 * whether the key has exceeded its allowed request count within the window.
 */
export class RateLimiter {
  private windows = new Map<string, WindowEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  readonly config: RateLimitConfig;

  constructor(config: RateLimitConfig) {
    this.config = config;
  }

  /**
   * Start periodic cleanup of expired window entries.
   * Call this once when the server starts. Not required for tests.
   */
  startCleanup(intervalMs = 60_000): void {
    this.cleanupInterval = setInterval(() => this.cleanup(), intervalMs);
    // Don't block process exit
    if (this.cleanupInterval.unref) {
      this.cleanupInterval.unref();
    }
  }

  /** Stop periodic cleanup. */
  stopCleanup(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
  }

  /**
   * Check whether a request from `key` should be allowed.
   *
   * @returns `{ allowed: true, remaining, resetMs }` if under limit,
   *          `{ allowed: false, remaining: 0, retryAfterMs }` if over limit.
   */
  check(key: string, now = Date.now()): RateLimitResult {
    const windowStart = now - this.config.windowMs;

    let entry = this.windows.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.windows.set(key, entry);
    }

    // Slide window: discard timestamps outside the current window
    entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

    if (entry.timestamps.length >= this.config.maxRequests) {
      // Over limit — calculate how long until the oldest request in the window
      // falls out, making room for a new one.
      const oldestInWindow = entry.timestamps[0];
      const retryAfterMs = oldestInWindow + this.config.windowMs - now;
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(retryAfterMs, 1),
        resetMs: oldestInWindow + this.config.windowMs - now,
      };
    }

    // Under limit — record this request
    entry.timestamps.push(now);
    const remaining = this.config.maxRequests - entry.timestamps.length;
    const resetMs =
      entry.timestamps.length > 0
        ? entry.timestamps[0] + this.config.windowMs - now
        : this.config.windowMs;

    return { allowed: true, remaining, resetMs };
  }

  /** Remove all expired entries to prevent memory growth. */
  cleanup(now = Date.now()): number {
    const windowStart = now - this.config.windowMs;
    let removed = 0;
    for (const [key, entry] of this.windows) {
      entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
      if (entry.timestamps.length === 0) {
        this.windows.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Reset all tracked state. Useful for testing. */
  reset(): void {
    this.windows.clear();
  }

  /** Number of tracked keys. Useful for monitoring. */
  get size(): number {
    return this.windows.size;
  }
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterMs?: number;
  resetMs: number;
}

// ---------------------------------------------------------------------------
// Hono middleware factory
// ---------------------------------------------------------------------------

/** Extract a client identifier from the request for rate limiting. */
function getClientKey(c: Context): string {
  // Check standard proxy headers first (Fly.io, Cloudflare, nginx, etc.)
  const forwarded =
    c.req.header("x-forwarded-for") ||
    c.req.header("x-real-ip") ||
    c.req.header("cf-connecting-ip");

  if (forwarded) {
    // x-forwarded-for may contain "client, proxy1, proxy2" — use the first
    return forwarded.split(",")[0].trim();
  }

  // Fallback: not ideal in production but fine for dev/local
  return "unknown";
}

export interface RateLimitMiddlewareOptions {
  /** Rate limiter for GET requests. */
  readLimiter: RateLimiter;
  /** Rate limiter for non-GET (write) requests. */
  writeLimiter: RateLimiter;
  /** Methods treated as "read". Defaults to ["GET", "HEAD", "OPTIONS"]. */
  readMethods?: string[];
  /** Paths to skip rate limiting entirely (exact prefix match). */
  skipPaths?: string[];
}

/**
 * Create a Hono middleware that applies per-IP rate limiting.
 *
 * Uses separate limiters for read vs. write requests, allowing generous
 * GET limits while restricting mutating operations more tightly.
 */
export function rateLimitMiddleware(
  options: RateLimitMiddlewareOptions
): MiddlewareHandler {
  const readMethods = new Set(
    options.readMethods ?? ["GET", "HEAD", "OPTIONS"]
  );
  const skipPaths = options.skipPaths ?? [];

  return async (c, next) => {
    // Check if this path should skip rate limiting
    for (const prefix of skipPaths) {
      if (c.req.path.startsWith(prefix)) {
        await next();
        return;
      }
    }

    const clientKey = getClientKey(c);
    const isRead = readMethods.has(c.req.method);
    const limiter = isRead ? options.readLimiter : options.writeLimiter;
    const category = isRead ? "read" : "write";

    const result = limiter.check(clientKey);

    // Always set informational headers
    c.header("X-RateLimit-Limit", String(limiter.config.maxRequests));
    c.header("X-RateLimit-Remaining", String(result.remaining));
    c.header(
      "X-RateLimit-Reset",
      String(Math.ceil((Date.now() + result.resetMs) / 1000))
    );
    c.header("X-RateLimit-Category", category);

    if (!result.allowed) {
      const retryAfterSec = Math.ceil((result.retryAfterMs ?? 1000) / 1000);
      c.header("Retry-After", String(retryAfterSec));

      logger.warn(
        { clientKey, category, path: c.req.path },
        "Rate limit exceeded"
      );

      return c.json(
        {
          error: "rate_limit_exceeded",
          message: `Too many ${category} requests. Retry after ${retryAfterSec} seconds.`,
          retryAfter: retryAfterSec,
        },
        429
      );
    }

    await next();
  };
}

// ---------------------------------------------------------------------------
// Default configuration
// ---------------------------------------------------------------------------

/** Default rate limit: 100 GET requests per minute per IP. */
export const DEFAULT_READ_LIMIT: RateLimitConfig = {
  maxRequests: 100,
  windowMs: 60_000,
};

/** Default rate limit: 20 write requests per minute per IP. */
export const DEFAULT_WRITE_LIMIT: RateLimitConfig = {
  maxRequests: 20,
  windowMs: 60_000,
};

/**
 * Create preconfigured rate limiters with default settings.
 * Override individual limits via the options parameter.
 */
export function createDefaultRateLimiters(overrides?: {
  read?: Partial<RateLimitConfig>;
  write?: Partial<RateLimitConfig>;
}) {
  const readLimiter = new RateLimiter({
    ...DEFAULT_READ_LIMIT,
    ...overrides?.read,
  });
  const writeLimiter = new RateLimiter({
    ...DEFAULT_WRITE_LIMIT,
    ...overrides?.write,
  });

  return { readLimiter, writeLimiter };
}
