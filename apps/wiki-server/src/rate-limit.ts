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
 *
 * SECURITY NOTE — X-Forwarded-For Trust
 * ======================================
 * This middleware extracts the client IP from X-Forwarded-For / X-Real-IP /
 * CF-Connecting-IP headers. These headers are trivially spoofable by end users.
 *
 * **This server MUST be deployed behind a trusted reverse proxy** (e.g., Fly.io,
 * Cloudflare, nginx) that overwrites X-Forwarded-For with the real client IP
 * before forwarding. If the server is exposed directly to the internet without
 * a trusted proxy, an attacker can rotate the X-Forwarded-For value on every
 * request to bypass rate limiting entirely.
 *
 * As a defense-in-depth measure, the RateLimiter enforces a `maxKeys` cap
 * (default 10,000). When the number of tracked keys exceeds this threshold,
 * new keys are denied immediately — preventing unbounded memory growth from
 * key-flooding attacks even if header spoofing occurs.
 */

import type { Context, MiddlewareHandler } from "hono";
import { logger } from "./logger.js";

// ---------------------------------------------------------------------------
// IPv6 normalization
// ---------------------------------------------------------------------------

/**
 * Normalize an IPv6 address to its /64 prefix for rate limiting.
 *
 * IPv6 allocates /64 prefixes to end sites, so different addresses within
 * the same /64 likely belong to the same user. Normalizing to /64 prevents
 * an attacker from rotating through addresses within their allocation.
 *
 * IPv4 addresses (and IPv4-mapped IPv6 like ::ffff:1.2.3.4) are returned
 * unchanged.
 */
export function normalizeIPv6(ip: string): string {
  // IPv4 — return as-is
  if (!ip.includes(":")) {
    return ip;
  }

  // IPv4-mapped IPv6 (::ffff:1.2.3.4) — return the IPv4 portion
  const v4MappedMatch = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
  if (v4MappedMatch) {
    return v4MappedMatch[1];
  }

  // Full IPv6 — normalize to /64 prefix (first 4 groups)
  const expanded = expandIPv6(ip);
  if (!expanded) {
    // If we can't parse it, return as-is rather than silently misclassifying
    return ip;
  }

  // Take the first 4 groups (64 bits) and zero out the rest
  const groups = expanded.split(":");
  const prefix = groups.slice(0, 4).join(":") + "::/64";
  return prefix;
}

/**
 * Expand an IPv6 address to its full 8-group representation.
 * Returns null if the address doesn't look like valid IPv6.
 */
function expandIPv6(ip: string): string | null {
  let parts: string[];

  if (ip.includes("::")) {
    const [left, right] = ip.split("::");
    const leftParts = left ? left.split(":") : [];
    const rightParts = right ? right.split(":") : [];
    const missing = 8 - leftParts.length - rightParts.length;

    if (missing < 0) return null;

    parts = [
      ...leftParts,
      ...(Array(missing).fill("0000") as string[]),
      ...rightParts,
    ];
  } else {
    parts = ip.split(":");
  }

  if (parts.length !== 8) return null;

  return parts.map((p) => p.padStart(4, "0")).join(":");
}

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
 *
 * The `maxKeys` parameter caps the number of distinct keys tracked. Once
 * the cap is reached, requests from unknown keys are denied. This prevents
 * memory exhaustion from key-flooding attacks (e.g., spoofed X-Forwarded-For).
 */
export class RateLimiter {
  private windows = new Map<string, WindowEntry>();
  private cleanupInterval: ReturnType<typeof setInterval> | null = null;
  readonly config: RateLimitConfig;
  readonly maxKeys: number;

  constructor(config: RateLimitConfig, maxKeys = 10_000) {
    this.config = config;
    this.maxKeys = maxKeys;
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

    // If this is a new key and we've hit the maxKeys cap, deny immediately.
    // This prevents unbounded memory growth from key-flooding attacks.
    if (!entry && this.windows.size >= this.maxKeys) {
      logger.warn(
        { key, maxKeys: this.maxKeys, currentKeys: this.windows.size },
        "Rate limiter maxKeys cap reached — denying new key"
      );
      return {
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.ceil(this.config.windowMs / 2),
        resetMs: Math.ceil(this.config.windowMs / 2),
      };
    }

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
  //
  // IMPORTANT: These headers are only trustworthy when the server sits behind
  // a reverse proxy that overwrites them. See the module-level security note.
  const forwarded =
    c.req.header("x-forwarded-for") ||
    c.req.header("x-real-ip") ||
    c.req.header("cf-connecting-ip");

  if (forwarded) {
    // x-forwarded-for may contain "client, proxy1, proxy2" — use the first
    const clientIp = forwarded.split(",")[0].trim();
    return normalizeIPv6(clientIp);
  }

  // No proxy headers available. This typically means the server is running
  // locally or is directly exposed without a reverse proxy. Log a warning
  // because all requests will share the same rate-limit bucket, which both
  // degrades service for legitimate users and makes rate limiting ineffective.
  logger.warn(
    { path: c.req.path, method: c.req.method },
    "Rate limiter: no proxy headers found — falling back to shared 'no-proxy-ip' key. " +
      "Ensure the server is behind a trusted reverse proxy in production."
  );

  return "no-proxy-ip";
}

export interface RateLimitMiddlewareOptions {
  /** Rate limiter for GET requests. */
  readLimiter: RateLimiter;
  /** Rate limiter for non-GET (write) requests. */
  writeLimiter: RateLimiter;
  /** Methods treated as "read". Defaults to ["GET", "HEAD", "OPTIONS"]. */
  readMethods?: string[];
  /** Paths to skip rate limiting entirely (exact match, not prefix). */
  skipPaths?: string[];
  /** Skip rate limiting for requests with a valid Bearer token. */
  skipAuthenticated?: boolean;
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
  const skipPaths = new Set(options.skipPaths ?? []);

  return async (c, next) => {
    // Check if this path should skip rate limiting (exact match only).
    // Using exact match prevents bypass via path traversal tricks like
    // "/health/../../api/secret" that would match a prefix check.
    if (skipPaths.has(c.req.path)) {
      await next();
      return;
    }

    // Skip rate limiting for authenticated requests — they're already
    // gated by bearer auth and represent trusted internal traffic
    // (CI sync, Next.js ISR, crux CLI). Rate limiting is for
    // protecting against unauthenticated abuse.
    if (options.skipAuthenticated) {
      const authHeader = c.req.header("Authorization");
      if (authHeader?.startsWith("Bearer ")) {
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

/** Default maximum number of distinct IP keys tracked per limiter. */
export const DEFAULT_MAX_KEYS = 10_000;

/**
 * Create preconfigured rate limiters with default settings.
 * Override individual limits via the options parameter.
 */
export function createDefaultRateLimiters(overrides?: {
  read?: Partial<RateLimitConfig>;
  write?: Partial<RateLimitConfig>;
  maxKeys?: number;
}) {
  const maxKeys = overrides?.maxKeys ?? DEFAULT_MAX_KEYS;
  const readLimiter = new RateLimiter(
    {
      ...DEFAULT_READ_LIMIT,
      ...overrides?.read,
    },
    maxKeys
  );
  const writeLimiter = new RateLimiter(
    {
      ...DEFAULT_WRITE_LIMIT,
      ...overrides?.write,
    },
    maxKeys
  );

  return { readLimiter, writeLimiter };
}
