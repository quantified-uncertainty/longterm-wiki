/**
 * Tests for KB records migration — DEPRECATED.
 *
 * The YAML → PG record migration is complete. Record-handling code has been
 * removed from the FactBase package. These tests are no longer applicable.
 */

import { describe, it, expect } from 'vitest';
import { run } from './factbase-migrate-records.ts';

describe("factbase-migrate-records (deprecated)", () => {
  it("returns deprecation message", async () => {
    const result = await run([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("DEPRECATED");
  });
});
