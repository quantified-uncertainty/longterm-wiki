import { describe, it, expect } from "vitest";
import { SID_PREFIX, generateSid } from "../src/index.js";

const ALPHANUMERIC =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const ALPHANUMERIC_SET = new Set(ALPHANUMERIC.split(""));

describe("generateSid shape over many iterations", () => {
  it("always returns sid_ + 10 chars all within the ALPHANUMERIC set", () => {
    for (let n = 0; n < 5000; n++) {
      const id = generateSid();
      expect(typeof id).toBe("string");
      expect(id.startsWith(SID_PREFIX)).toBe(true);
      expect(id.length).toBe(SID_PREFIX.length + 10);

      const suffix = id.slice(SID_PREFIX.length);
      expect(suffix.length).toBe(10);
      for (const ch of suffix) {
        expect(ALPHANUMERIC_SET.has(ch)).toBe(true);
      }
    }
  });

  it("eventually emits characters from across the alphabet (not stuck)", () => {
    const seen = new Set<string>();
    for (let n = 0; n < 5000; n++) {
      for (const ch of generateSid().slice(SID_PREFIX.length)) {
        seen.add(ch);
      }
    }
    // With 62 possible chars and 50k draws, we expect broad coverage.
    expect(seen.size).toBeGreaterThan(50);
  });
});
