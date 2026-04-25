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
import { assertSafeTarEntries, type TarEntry } from "./fetch.ts";

/** Helper: build a regular-file TarEntry from just a path. */
const f = (name: string): TarEntry => ({ name, type: "-" });
/** Helper: build a directory TarEntry. */
const d = (name: string): TarEntry => ({ name, type: "d" });
/** Helper: build a symlink TarEntry pointing somewhere. */
const sym = (name: string, target: string): TarEntry => ({
  name,
  type: "l",
  linkTarget: target,
});
/** Helper: build a hardlink TarEntry. */
const hard = (name: string, target: string): TarEntry => ({
  name,
  type: "h",
  linkTarget: target,
});

describe("assertSafeTarEntries", () => {
  it("accepts a normal nested layout", () => {
    expect(() =>
      assertSafeTarEntries([
        d("backup-20260420103651/"),
        d("backup-20260420103651/aiidprod/"),
        f("backup-20260420103651/aiidprod/incidents.json"),
        f("backup-20260420103651/aiidprod/reports.json"),
        f("backup-20260420103651/aiidprod/entities.json"),
      ]),
    ).not.toThrow();
  });

  it("rejects absolute paths", () => {
    expect(() => assertSafeTarEntries([f("/etc/passwd")])).toThrow(/absolute path/);
    expect(() => assertSafeTarEntries([f("/foo/bar")])).toThrow(/absolute path/);
  });

  it("rejects parent-directory traversal", () => {
    expect(() => assertSafeTarEntries([f("foo/../../bar")])).toThrow(/traversal/);
    expect(() => assertSafeTarEntries([f("../sibling")])).toThrow(/traversal/);
  });

  it("rejects bare '..' entry", () => {
    expect(() => assertSafeTarEntries([f("..")])).toThrow(/traversal/);
  });

  it("rejects mixed safe + unsafe entries (fails fast on first)", () => {
    expect(() =>
      assertSafeTarEntries([
        f("safe/file.json"),
        f("../escape.txt"),
        f("another/safe/file.json"),
      ]),
    ).toThrow(/traversal/);
  });

  it("treats '.' as a normal current-dir reference (allowed)", () => {
    // Tar dumps sometimes contain a literal `./` or `.` entry for the root.
    expect(() => assertSafeTarEntries([f("."), f("./foo")])).not.toThrow();
  });

  it("accepts an empty list (no entries to validate)", () => {
    expect(() => assertSafeTarEntries([])).not.toThrow();
  });

  it("rejects entries that look benign but contain '..' as a segment", () => {
    // `foo..bar` (no slash) is fine — it's just an unusual filename.
    expect(() => assertSafeTarEntries([f("foo..bar")])).not.toThrow();
    // But `foo/../bar` is traversal.
    expect(() => assertSafeTarEntries([f("foo/../bar")])).toThrow(/traversal/);
  });

  it("rejects symlink entries unconditionally (even with safe targets)", () => {
    expect(() =>
      assertSafeTarEntries([sym("backup/link", "incidents.json")]),
    ).toThrow(/link entry/);
    expect(() =>
      assertSafeTarEntries([sym("backup/escape", "/etc/passwd")]),
    ).toThrow(/link entry/);
    expect(() =>
      assertSafeTarEntries([sym("backup/up", "../../etc/passwd")]),
    ).toThrow(/link entry/);
  });

  it("rejects hardlink entries unconditionally", () => {
    expect(() =>
      assertSafeTarEntries([hard("backup/hl", "incidents.json")]),
    ).toThrow(/link entry/);
  });

  it("rejects unsupported entry types (devices, fifos, etc.)", () => {
    expect(() =>
      assertSafeTarEntries([{ name: "backup/dev", type: "c" }]),
    ).toThrow(/unsupported entry type/);
    expect(() =>
      assertSafeTarEntries([{ name: "backup/fifo", type: "p" }]),
    ).toThrow(/unsupported entry type/);
    expect(() =>
      assertSafeTarEntries([{ name: "backup/?", type: "?" }]),
    ).toThrow(/unsupported entry type/);
  });
});
