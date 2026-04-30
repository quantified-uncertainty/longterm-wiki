/**
 * The benchmark-quarantine source-URL cell only renders DB-sourced URLs as
 * <a href> when they pass `isSafeUrl`. This test confirms the canonical
 * helper still rejects the schemes that motivated this guard (javascript:,
 * data:, file:) — tied to the cell at benchmark-quarantine-table.tsx.
 */
import { describe, it, expect } from "vitest";
import { isSafeUrl } from "@/lib/url-utils";

describe("isSafeUrl — XSS guard for benchmark-quarantine source URLs", () => {
  it("accepts http and https", () => {
    expect(isSafeUrl("https://example.com/foo")).toBe(true);
    expect(isSafeUrl("http://example.com")).toBe(true);
  });

  it("rejects javascript:", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("JAVASCRIPT:alert(1)")).toBe(false);
  });

  it("rejects data:", () => {
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
  });

  it("rejects file: and other non-web schemes", () => {
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
    expect(isSafeUrl("ftp://example.com")).toBe(false);
    expect(isSafeUrl("vbscript:msgbox")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isSafeUrl("not a url")).toBe(false);
    expect(isSafeUrl("")).toBe(false);
  });
});
