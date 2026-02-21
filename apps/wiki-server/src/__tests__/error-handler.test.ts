import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createApp } from "../app.js";

/**
 * Tests for the global error handler in app.ts.
 *
 * The error handler has two behaviors:
 * 1. For /api/* routes (authenticated): return the real error message
 * 2. For other routes: return a generic "An unexpected error occurred"
 *
 * HTTPExceptions are always re-thrown so Hono returns the proper status code.
 */
describe("Global error handler", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createTestApp() {
    const app = createApp();

    // Register routes that throw specific errors for testing
    app.get("/api/test-error", () => {
      throw new Error("specific SQL bug: column X does not exist");
    });

    app.get("/public-error", () => {
      throw new Error("should not be exposed");
    });

    app.get("/api/test-http-exception", () => {
      throw new HTTPException(403, { message: "Forbidden" });
    });

    return app;
  }

  it("returns real error message for /api/* routes", async () => {
    const app = createTestApp();
    const res = await app.request("/api/test-error");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("specific SQL bug: column X does not exist");
  });

  it("returns generic message for non-/api/ routes", async () => {
    const app = createTestApp();
    const res = await app.request("/public-error");

    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe("internal_error");
    expect(body.message).toBe("An unexpected error occurred");
  });

  it("re-throws HTTPExceptions with their original status code", async () => {
    const app = createTestApp();
    const res = await app.request("/api/test-http-exception");

    expect(res.status).toBe(403);
  });

  it("logs unhandled errors to console.error", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const app = createTestApp();
    await app.request("/api/test-error");

    expect(consoleSpy).toHaveBeenCalledWith(
      "Unhandled error:",
      expect.any(Error)
    );
  });
});
