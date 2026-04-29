/**
 * QUA-329: schema validation for the new optional `contentHash` field on
 * UpdateResourceFetchStatusSchema. The PATCH /:id/fetch-status endpoint
 * persists this hash to `resources.content_hash` so subsequent re-ingest
 * jobs can detect content drift via `previousContentHash`. Bad input here
 * silently corrupts the temporal-fix chain, so validate at the boundary.
 */
import { describe, it, expect } from "vitest";
import { UpdateResourceFetchStatusSchema } from "../api-types.js";

describe("UpdateResourceFetchStatusSchema — contentHash", () => {
  const baseValid = {
    fetchStatus: "ok" as const,
    lastFetchedAt: new Date().toISOString(),
  };

  it("accepts a 16-char lowercase hex hash (production format)", () => {
    const r = UpdateResourceFetchStatusSchema.safeParse({
      ...baseValid,
      contentHash: "abc123def4567890",
    });
    expect(r.success).toBe(true);
  });

  it("accepts a full 64-char lowercase hex SHA-256 (future-compat)", () => {
    const r = UpdateResourceFetchStatusSchema.safeParse({
      ...baseValid,
      contentHash: "0".repeat(64),
    });
    expect(r.success).toBe(true);
  });

  it("accepts the patch with contentHash omitted entirely", () => {
    const r = UpdateResourceFetchStatusSchema.safeParse(baseValid);
    expect(r.success).toBe(true);
  });

  it("rejects an empty contentHash", () => {
    const r = UpdateResourceFetchStatusSchema.safeParse({
      ...baseValid,
      contentHash: "",
    });
    expect(r.success).toBe(false);
  });

  it("rejects a contentHash longer than 64 chars", () => {
    const r = UpdateResourceFetchStatusSchema.safeParse({
      ...baseValid,
      contentHash: "a".repeat(65),
    });
    expect(r.success).toBe(false);
  });

  it("rejects uppercase hex (must be lowercase)", () => {
    const r = UpdateResourceFetchStatusSchema.safeParse({
      ...baseValid,
      contentHash: "ABC123DEF4567890",
    });
    expect(r.success).toBe(false);
  });

  it("rejects non-hex characters", () => {
    const r = UpdateResourceFetchStatusSchema.safeParse({
      ...baseValid,
      contentHash: "g".repeat(16),
    });
    expect(r.success).toBe(false);
  });

  it("rejects shell-injection attempts in contentHash", () => {
    const r = UpdateResourceFetchStatusSchema.safeParse({
      ...baseValid,
      contentHash: "abc; DROP TABLE",
    });
    expect(r.success).toBe(false);
  });
});
