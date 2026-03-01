import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import {
  RateLimiter,
  rateLimitMiddleware,
  createDefaultRateLimiters,
  normalizeIPv6,
  type RateLimitConfig,
} from "../rate-limit.js";

// ---------------------------------------------------------------------------
// normalizeIPv6 unit tests
// ---------------------------------------------------------------------------

describe("normalizeIPv6", () => {
  it("returns IPv4 addresses unchanged", () => {
    expect(normalizeIPv6("1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIPv6("192.168.1.1")).toBe("192.168.1.1");
    expect(normalizeIPv6("10.0.0.1")).toBe("10.0.0.1");
  });

  it("extracts IPv4 from IPv4-mapped IPv6", () => {
    expect(normalizeIPv6("::ffff:1.2.3.4")).toBe("1.2.3.4");
    expect(normalizeIPv6("::FFFF:192.168.1.1")).toBe("192.168.1.1");
  });

  it("normalizes full IPv6 addresses to /64 prefix", () => {
    const result = normalizeIPv6("2001:0db8:85a3:0000:0000:8a2e:0370:7334");
    expect(result).toBe("2001:0db8:85a3:0000::/64");
  });

  it("normalizes abbreviated IPv6 addresses to /64 prefix", () => {
    const result = normalizeIPv6("2001:db8:85a3::8a2e:370:7334");
    expect(result).toBe("2001:0db8:85a3:0000::/64");
  });

  it("groups addresses in the same /64 to the same key", () => {
    const addr1 = normalizeIPv6("2001:db8:85a3:0:1111:2222:3333:4444");
    const addr2 = normalizeIPv6("2001:db8:85a3:0:aaaa:bbbb:cccc:dddd");
    expect(addr1).toBe(addr2);
  });

  it("distinguishes addresses in different /64 prefixes", () => {
    const addr1 = normalizeIPv6("2001:db8:85a3:0001::");
    const addr2 = normalizeIPv6("2001:db8:85a3:0002::");
    expect(addr1).not.toBe(addr2);
  });

  it("handles loopback (::1)", () => {
    const result = normalizeIPv6("::1");
    expect(result).toBe("0000:0000:0000:0000::/64");
  });

  it("returns unparseable strings as-is", () => {
    expect(normalizeIPv6("not-an-ip")).toBe("not-an-ip");
    expect(normalizeIPv6("1:2:3:4:5:6:7:8:9")).toBe("1:2:3:4:5:6:7:8:9");
  });
});

// ---------------------------------------------------------------------------
// RateLimiter core unit tests
// ---------------------------------------------------------------------------

describe("RateLimiter", () => {
  it("allows requests under the limit", () => {
    const limiter = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
    const r1 = limiter.check("ip-1");
    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(2);

    const r2 = limiter.check("ip-1");
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(1);

    const r3 = limiter.check("ip-1");
    expect(r3.allowed).toBe(true);
    expect(r3.remaining).toBe(0);
  });

  it("blocks requests over the limit", () => {
    const limiter = new RateLimiter({ maxRequests: 2, windowMs: 60_000 });
    limiter.check("ip-1");
    limiter.check("ip-1");

    const r3 = limiter.check("ip-1");
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
    expect(r3.retryAfterMs).toBeGreaterThan(0);
  });

  it("tracks different keys independently", () => {
    const limiter = new RateLimiter({ maxRequests: 1, windowMs: 60_000 });
    const r1 = limiter.check("ip-1");
    expect(r1.allowed).toBe(true);

    const r2 = limiter.check("ip-2");
    expect(r2.allowed).toBe(true);

    // ip-1 is now over limit
    const r3 = limiter.check("ip-1");
    expect(r3.allowed).toBe(false);

    // ip-2 is also over limit
    const r4 = limiter.check("ip-2");
    expect(r4.allowed).toBe(false);
  });

  it("allows requests again after the window expires", () => {
    const windowMs = 1000;
    const limiter = new RateLimiter({ maxRequests: 1, windowMs });

    const now = Date.now();
    const r1 = limiter.check("ip-1", now);
    expect(r1.allowed).toBe(true);

    // Still within window
    const r2 = limiter.check("ip-1", now + 500);
    expect(r2.allowed).toBe(false);

    // After window expires
    const r3 = limiter.check("ip-1", now + windowMs + 1);
    expect(r3.allowed).toBe(true);
  });

  it("provides correct retryAfterMs", () => {
    const windowMs = 10_000;
    const limiter = new RateLimiter({ maxRequests: 1, windowMs });

    const now = 1000000;
    limiter.check("ip-1", now);

    const result = limiter.check("ip-1", now + 3000);
    expect(result.allowed).toBe(false);
    // The oldest request was at `now`, so it expires at `now + windowMs`.
    // retryAfterMs = (now + windowMs) - (now + 3000) = windowMs - 3000 = 7000
    expect(result.retryAfterMs).toBe(7000);
  });

  it("cleanup removes expired entries", () => {
    const windowMs = 1000;
    const limiter = new RateLimiter({ maxRequests: 10, windowMs });

    const now = Date.now();
    limiter.check("ip-1", now);
    limiter.check("ip-2", now);
    expect(limiter.size).toBe(2);

    // After window expires, cleanup should remove both
    const removed = limiter.cleanup(now + windowMs + 1);
    expect(removed).toBe(2);
    expect(limiter.size).toBe(0);
  });

  it("cleanup keeps entries with recent timestamps", () => {
    const windowMs = 10_000;
    const limiter = new RateLimiter({ maxRequests: 10, windowMs });

    const now = Date.now();
    limiter.check("ip-1", now);
    limiter.check("ip-2", now - 5000);

    // Cleanup at `now` — both are within window
    const removed = limiter.cleanup(now);
    expect(removed).toBe(0);
    expect(limiter.size).toBe(2);
  });

  it("reset clears all state", () => {
    const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
    limiter.check("ip-1");
    limiter.check("ip-2");
    expect(limiter.size).toBe(2);

    limiter.reset();
    expect(limiter.size).toBe(0);
  });

  // -------------------------------------------------------------------------
  // maxKeys cap
  // -------------------------------------------------------------------------

  describe("maxKeys cap", () => {
    it("denies new keys when maxKeys is reached", () => {
      const limiter = new RateLimiter(
        { maxRequests: 10, windowMs: 60_000 },
        3 // maxKeys = 3
      );

      expect(limiter.check("ip-1").allowed).toBe(true);
      expect(limiter.check("ip-2").allowed).toBe(true);
      expect(limiter.check("ip-3").allowed).toBe(true);
      expect(limiter.size).toBe(3);

      const result = limiter.check("ip-4");
      expect(result.allowed).toBe(false);
      expect(result.remaining).toBe(0);
      expect(result.retryAfterMs).toBeGreaterThan(0);
    });

    it("still allows existing keys when maxKeys is reached", () => {
      const limiter = new RateLimiter(
        { maxRequests: 10, windowMs: 60_000 },
        2 // maxKeys = 2
      );

      limiter.check("ip-1");
      limiter.check("ip-2");

      const r1 = limiter.check("ip-1");
      expect(r1.allowed).toBe(true);

      const r2 = limiter.check("ip-2");
      expect(r2.allowed).toBe(true);
    });

    it("allows new keys again after cleanup frees slots", () => {
      const windowMs = 1000;
      const limiter = new RateLimiter(
        { maxRequests: 10, windowMs },
        2 // maxKeys = 2
      );

      const now = Date.now();
      limiter.check("ip-1", now);
      limiter.check("ip-2", now);

      expect(limiter.check("ip-3", now + 100).allowed).toBe(false);

      limiter.cleanup(now + windowMs + 1);
      expect(limiter.size).toBe(0);

      expect(limiter.check("ip-3", now + windowMs + 2).allowed).toBe(true);
    });

    it("exposes maxKeys on the instance", () => {
      const limiter = new RateLimiter(
        { maxRequests: 10, windowMs: 60_000 },
        5000
      );
      expect(limiter.maxKeys).toBe(5000);
    });

    it("defaults maxKeys to 10000", () => {
      const limiter = new RateLimiter({ maxRequests: 10, windowMs: 60_000 });
      expect(limiter.maxKeys).toBe(10_000);
    });
  });
});

// ---------------------------------------------------------------------------
// Middleware integration tests
// ---------------------------------------------------------------------------

describe("rateLimitMiddleware", () => {
  function buildApp(
    readConfig: RateLimitConfig,
    writeConfig: RateLimitConfig
  ) {
    const readLimiter = new RateLimiter(readConfig);
    const writeLimiter = new RateLimiter(writeConfig);

    const app = new Hono();

    app.use(
      "*",
      rateLimitMiddleware({
        readLimiter,
        writeLimiter,
        skipPaths: ["/health"],
      })
    );

    app.get("/api/pages", (c) => c.json({ ok: true }));
    app.post("/api/pages", (c) => c.json({ ok: true }));
    app.put("/api/pages/1", (c) => c.json({ ok: true }));
    app.delete("/api/pages/1", (c) => c.json({ ok: true }));
    app.get("/health", (c) => c.json({ status: "ok" }));
    app.get("/health/extra", (c) => c.json({ status: "ok" }));

    return { app, readLimiter, writeLimiter };
  }

  it("allows GET requests under the read limit", async () => {
    const { app } = buildApp(
      { maxRequests: 3, windowMs: 60_000 },
      { maxRequests: 1, windowMs: 60_000 }
    );

    for (let i = 0; i < 3; i++) {
      const res = await app.request("/api/pages");
      expect(res.status).toBe(200);
    }
  });

  it("returns 429 for GET requests over the read limit", async () => {
    const { app } = buildApp(
      { maxRequests: 2, windowMs: 60_000 },
      { maxRequests: 10, windowMs: 60_000 }
    );

    await app.request("/api/pages");
    await app.request("/api/pages");

    const res = await app.request("/api/pages");
    expect(res.status).toBe(429);

    const body = await res.json();
    expect(body.error).toBe("rate_limit_exceeded");
    expect(body.retryAfter).toBeGreaterThan(0);
  });

  it("returns 429 for POST requests over the write limit", async () => {
    const { app } = buildApp(
      { maxRequests: 100, windowMs: 60_000 },
      { maxRequests: 1, windowMs: 60_000 }
    );

    // First POST succeeds
    const res1 = await app.request("/api/pages", { method: "POST" });
    expect(res1.status).toBe(200);

    // Second POST is rate limited
    const res2 = await app.request("/api/pages", { method: "POST" });
    expect(res2.status).toBe(429);
  });

  it("applies different limits for read vs. write", async () => {
    const { app } = buildApp(
      { maxRequests: 5, windowMs: 60_000 },
      { maxRequests: 2, windowMs: 60_000 }
    );

    // Use up write limit
    await app.request("/api/pages", { method: "POST" });
    await app.request("/api/pages", { method: "POST" });

    // Write is blocked
    const writeRes = await app.request("/api/pages", { method: "POST" });
    expect(writeRes.status).toBe(429);

    // But read still works (different limiter)
    const readRes = await app.request("/api/pages");
    expect(readRes.status).toBe(200);
  });

  it("includes Retry-After header on 429 responses", async () => {
    const { app } = buildApp(
      { maxRequests: 1, windowMs: 60_000 },
      { maxRequests: 10, windowMs: 60_000 }
    );

    await app.request("/api/pages");
    const res = await app.request("/api/pages");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("includes X-RateLimit-* headers on successful responses", async () => {
    const { app } = buildApp(
      { maxRequests: 10, windowMs: 60_000 },
      { maxRequests: 10, windowMs: 60_000 }
    );

    const res = await app.request("/api/pages");
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Limit")).toBe("10");
    expect(res.headers.get("X-RateLimit-Remaining")).toBe("9");
    expect(res.headers.get("X-RateLimit-Reset")).toBeTruthy();
    expect(res.headers.get("X-RateLimit-Category")).toBe("read");
  });

  it("sets category to 'write' for POST requests", async () => {
    const { app } = buildApp(
      { maxRequests: 10, windowMs: 60_000 },
      { maxRequests: 10, windowMs: 60_000 }
    );

    const res = await app.request("/api/pages", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.get("X-RateLimit-Category")).toBe("write");
  });

  it("treats PUT and DELETE as write requests", async () => {
    const { app } = buildApp(
      { maxRequests: 100, windowMs: 60_000 },
      { maxRequests: 1, windowMs: 60_000 }
    );

    // First write request (PUT) succeeds
    const res1 = await app.request("/api/pages/1", { method: "PUT" });
    expect(res1.status).toBe(200);
    expect(res1.headers.get("X-RateLimit-Category")).toBe("write");

    // Second write request (DELETE) is rate limited
    const res2 = await app.request("/api/pages/1", { method: "DELETE" });
    expect(res2.status).toBe(429);
  });

  // -------------------------------------------------------------------------
  // skipPaths: exact match (not prefix)
  // -------------------------------------------------------------------------

  it("skips rate limiting for exact skipPaths match", async () => {
    const { app } = buildApp(
      { maxRequests: 1, windowMs: 60_000 },
      { maxRequests: 1, windowMs: 60_000 }
    );

    // /health should always work, even after limit is reached
    for (let i = 0; i < 5; i++) {
      const res = await app.request("/health");
      expect(res.status).toBe(200);
    }
  });

  it("does NOT skip rate limiting for paths that start with a skip path", async () => {
    const { app } = buildApp(
      { maxRequests: 1, windowMs: 60_000 },
      { maxRequests: 1, windowMs: 60_000 }
    );

    // /health/extra is NOT in skipPaths — it should be rate limited
    const res1 = await app.request("/health/extra");
    expect(res1.status).toBe(200);

    // Second request should be rate limited
    const res2 = await app.request("/health/extra");
    expect(res2.status).toBe(429);
  });

  // -------------------------------------------------------------------------
  // X-Forwarded-For and IPv6 normalization in middleware
  // -------------------------------------------------------------------------

  it("uses X-Forwarded-For header for client identification", async () => {
    const { app } = buildApp(
      { maxRequests: 1, windowMs: 60_000 },
      { maxRequests: 10, windowMs: 60_000 }
    );

    // First request from IP-A succeeds
    const res1 = await app.request("/api/pages", {
      headers: { "X-Forwarded-For": "1.2.3.4" },
    });
    expect(res1.status).toBe(200);

    // Second request from IP-A is rate limited
    const res2 = await app.request("/api/pages", {
      headers: { "X-Forwarded-For": "1.2.3.4" },
    });
    expect(res2.status).toBe(429);

    // Request from IP-B still succeeds
    const res3 = await app.request("/api/pages", {
      headers: { "X-Forwarded-For": "5.6.7.8" },
    });
    expect(res3.status).toBe(200);
  });

  it("uses first IP from X-Forwarded-For chain", async () => {
    const { app } = buildApp(
      { maxRequests: 1, windowMs: 60_000 },
      { maxRequests: 10, windowMs: 60_000 }
    );

    // Request with proxy chain — should use 1.2.3.4 as the key
    const res1 = await app.request("/api/pages", {
      headers: { "X-Forwarded-For": "1.2.3.4, 10.0.0.1, 10.0.0.2" },
    });
    expect(res1.status).toBe(200);

    // Same client IP through different proxy chain — should be rate limited
    const res2 = await app.request("/api/pages", {
      headers: { "X-Forwarded-For": "1.2.3.4, 10.0.0.99" },
    });
    expect(res2.status).toBe(429);
  });

  it("normalizes IPv6 addresses from X-Forwarded-For to /64 prefix", async () => {
    const { app } = buildApp(
      { maxRequests: 1, windowMs: 60_000 },
      { maxRequests: 10, windowMs: 60_000 }
    );

    // First request with one IPv6 address
    const res1 = await app.request("/api/pages", {
      headers: {
        "X-Forwarded-For": "2001:db8:85a3:0:1111:2222:3333:4444",
      },
    });
    expect(res1.status).toBe(200);

    // Second request with a different address in the same /64 — should be
    // rate limited because both normalize to the same /64 prefix
    const res2 = await app.request("/api/pages", {
      headers: {
        "X-Forwarded-For": "2001:db8:85a3:0:aaaa:bbbb:cccc:dddd",
      },
    });
    expect(res2.status).toBe(429);
  });

  it("does not share bucket between no-proxy fallback and real IPs", async () => {
    const { app } = buildApp(
      { maxRequests: 1, windowMs: 60_000 },
      { maxRequests: 10, windowMs: 60_000 }
    );

    // Request without proxy headers — uses fallback key
    const res1 = await app.request("/api/pages");
    expect(res1.status).toBe(200);

    // Request with a real IP should still succeed (different bucket)
    const res2 = await app.request("/api/pages", {
      headers: { "X-Forwarded-For": "1.2.3.4" },
    });
    expect(res2.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// createDefaultRateLimiters
// ---------------------------------------------------------------------------

describe("createDefaultRateLimiters", () => {
  it("creates limiters with default config", () => {
    const { readLimiter, writeLimiter } = createDefaultRateLimiters();
    expect(readLimiter.config.maxRequests).toBe(100);
    expect(readLimiter.config.windowMs).toBe(60_000);
    expect(writeLimiter.config.maxRequests).toBe(20);
    expect(writeLimiter.config.windowMs).toBe(60_000);
  });

  it("allows overriding individual limits", () => {
    const { readLimiter, writeLimiter } = createDefaultRateLimiters({
      read: { maxRequests: 50 },
      write: { windowMs: 30_000 },
    });
    expect(readLimiter.config.maxRequests).toBe(50);
    expect(readLimiter.config.windowMs).toBe(60_000); // default preserved
    expect(writeLimiter.config.maxRequests).toBe(20); // default preserved
    expect(writeLimiter.config.windowMs).toBe(30_000);
  });

  it("passes maxKeys to both limiters", () => {
    const { readLimiter, writeLimiter } = createDefaultRateLimiters({
      maxKeys: 500,
    });
    expect(readLimiter.maxKeys).toBe(500);
    expect(writeLimiter.maxKeys).toBe(500);
  });

  it("defaults maxKeys to 10000", () => {
    const { readLimiter, writeLimiter } = createDefaultRateLimiters();
    expect(readLimiter.maxKeys).toBe(10_000);
    expect(writeLimiter.maxKeys).toBe(10_000);
  });
});
