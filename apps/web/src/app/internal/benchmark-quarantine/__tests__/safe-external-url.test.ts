import { describe, it, expect } from "vitest";
import { safeExternalUrl } from "../benchmark-quarantine-table";

describe("safeExternalUrl", () => {
  it("accepts http and https URLs", () => {
    expect(safeExternalUrl("https://example.com/foo")).toBe(
      "https://example.com/foo",
    );
    expect(safeExternalUrl("http://example.com")).toBe("http://example.com");
  });

  it("rejects javascript: URLs (XSS guard)", () => {
    expect(safeExternalUrl("javascript:alert(1)")).toBeNull();
    expect(safeExternalUrl("JAVASCRIPT:alert(1)")).toBeNull();
  });

  it("rejects data: URLs", () => {
    expect(safeExternalUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("rejects file: and other non-web schemes", () => {
    expect(safeExternalUrl("file:///etc/passwd")).toBeNull();
    expect(safeExternalUrl("ftp://example.com")).toBeNull();
    expect(safeExternalUrl("vbscript:msgbox")).toBeNull();
  });

  it("returns null for null/empty input", () => {
    expect(safeExternalUrl(null)).toBeNull();
    expect(safeExternalUrl("")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(safeExternalUrl("not a url")).toBeNull();
    expect(safeExternalUrl("https://")).toBeNull();
  });
});
