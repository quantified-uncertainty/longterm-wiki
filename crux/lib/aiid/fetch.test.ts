/**
 * Tests for path-traversal hardening on AIID tar extraction.
 *
 * The full fetch + extract pipeline is integration-only (it shells out
 * to `tar`), so we can't unit-test it without a real archive. But the
 * pure validator that gates extraction is critical and easy to test —
 * any bypass of `assertSafeTarEntries` could let a hostile archive
 * write outside the temp dir (Zip-Slip class of attack).
 */

import { describe, it, expect } from "vitest";
import { assertSafeTarEntries } from "./fetch.ts";

describe("assertSafeTarEntries", () => {
  it("accepts a normal nested layout", () => {
    expect(() =>
      assertSafeTarEntries([
        "backup-20260420103651/",
        "backup-20260420103651/aiidprod/",
        "backup-20260420103651/aiidprod/incidents.json",
        "backup-20260420103651/aiidprod/reports.json",
        "backup-20260420103651/aiidprod/entities.json",
      ]),
    ).not.toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => assertSafeTarEntries(["/etc/passwd"])).toThrow(/absolute path/);
    expect(() => assertSafeTarEntries(["/foo/bar"])).toThrow(/absolute path/);
  });

  it("rejects parent-directory traversal", () => {
    expect(() => assertSafeTarEntries(["foo/../../bar"])).toThrow(/traversal/);
    expect(() => assertSafeTarEntries(["../sibling"])).toThrow(/traversal/);
  });

  it("rejects bare '..' entry", () => {
    expect(() => assertSafeTarEntries([".."])).toThrow(/traversal/);
  });

  it("rejects mixed safe + unsafe entries (fails fast on first)", () => {
    expect(() =>
      assertSafeTarEntries([
        "safe/file.json",
        "../escape.txt",
        "another/safe/file.json",
      ]),
    ).toThrow(/traversal/);
  });

  it("treats '.' as a normal current-dir reference (allowed)", () => {
    // Tar dumps sometimes contain a literal `./` or `.` entry for the root.
    expect(() => assertSafeTarEntries([".", "./foo"])).not.toThrow();
  });

  it("accepts an empty list (no entries to validate)", () => {
    expect(() => assertSafeTarEntries([])).not.toThrow();
  });

  it("rejects entries that look benign but contain '..' as a segment", () => {
    // `foo..bar` (no slash) is fine — it's just an unusual filename.
    expect(() => assertSafeTarEntries(["foo..bar"])).not.toThrow();
    // But `foo/../bar` is traversal.
    expect(() => assertSafeTarEntries(["foo/../bar"])).toThrow(/traversal/);
  });
});
