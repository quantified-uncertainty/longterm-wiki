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
import { assertSafeTarEntries, parseTarVerboseLine, type TarEntry } from "./fetch.ts";

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

/**
 * Parser tests for the two `tar -tvjf` output dialects we encounter in
 * the wild. Regression: bsdtar (macOS) puts the group name at the third
 * token, but the previous regex required a digit there and silently
 * fell through to a `type: "?"` entry — which `assertSafeTarEntries`
 * then rejected, breaking ingest entirely (QUA-733).
 */
describe("parseTarVerboseLine", () => {
  it("parses bsdtar directory entries (the QUA-733 regression case)", () => {
    const entry = parseTarVerboseLine(
      "drwxr-xr-x  0 runner runner      0 Apr 20 03:37 mongodump_full_snapshot/",
    );
    expect(entry).toEqual({
      name: "mongodump_full_snapshot/",
      type: "d",
      linkTarget: undefined,
    });
  });

  it("parses bsdtar regular file entries", () => {
    const entry = parseTarVerboseLine(
      "-rw-r--r--  0 runner runner   1234 Apr 20 03:37 mongodump_full_snapshot/aiidprod/incidents.json",
    );
    expect(entry).toEqual({
      name: "mongodump_full_snapshot/aiidprod/incidents.json",
      type: "-",
      linkTarget: undefined,
    });
  });

  it("parses bsdtar symlink entries with ` -> target`", () => {
    const entry = parseTarVerboseLine(
      "lrwxr-xr-x  0 runner runner      0 Apr 20 03:37 sample/link -> file.txt",
    );
    expect(entry).toEqual({
      name: "sample/link",
      type: "l",
      linkTarget: "file.txt",
    });
  });

  it("parses GNU tar directory entries (`owner/group` token)", () => {
    const entry = parseTarVerboseLine(
      "drwxr-xr-x runner/runner    0 2024-04-20 03:37 mongodump_full_snapshot/",
    );
    expect(entry).toEqual({
      name: "mongodump_full_snapshot/",
      type: "d",
      linkTarget: undefined,
    });
  });

  it("parses GNU tar regular file entries", () => {
    const entry = parseTarVerboseLine(
      "-rw-r--r-- runner/runner 1234 2024-04-20 03:37 mongodump_full_snapshot/aiidprod/incidents.json",
    );
    expect(entry).toEqual({
      name: "mongodump_full_snapshot/aiidprod/incidents.json",
      type: "-",
      linkTarget: undefined,
    });
  });

  it("parses GNU tar hardlink entries with ` link to target`", () => {
    const entry = parseTarVerboseLine(
      "hrw-r--r-- runner/runner 0 2024-04-20 03:37 sample/hardlink link to sample/file.txt",
    );
    expect(entry).toEqual({
      name: "sample/hardlink",
      type: "h",
      linkTarget: "sample/file.txt",
    });
  });

  it("returns null for blank lines (skipped by listTarEntries)", () => {
    expect(parseTarVerboseLine("")).toBeNull();
    expect(parseTarVerboseLine("   ")).toBeNull();
    expect(parseTarVerboseLine("\r")).toBeNull();
  });

  it("returns a sentinel `?` entry for unparseable lines (rejected by validator)", () => {
    // Defensive: anything we can't parse becomes a `?` entry which
    // assertSafeTarEntries then rejects.
    const entry = parseTarVerboseLine("garbage with no time");
    expect(entry).toEqual({ name: "garbage with no time", type: "?" });
    // The validator must reject any `?` we emit.
    expect(() => assertSafeTarEntries([entry!])).toThrow(/unsupported entry type/);
  });

  it("strips a trailing CR (handles archives produced on Windows hosts)", () => {
    const entry = parseTarVerboseLine(
      "drwxr-xr-x  0 runner runner      0 Apr 20 03:37 dir/\r",
    );
    expect(entry).toEqual({ name: "dir/", type: "d", linkTarget: undefined });
  });

  it("does not misparse filenames that contain HH:MM-looking substrings", () => {
    // Greedy `.*` finds the rightmost-but-still-valid HH:MM that lets
    // the rest of the line match. The timestamp is `03:37`; the literal
    // `01:23` in the filename must not be treated as the timestamp.
    const entry = parseTarVerboseLine(
      "-rw-r--r--  0 runner runner   1234 Apr 20 03:37 backup/data_01:23.json",
    );
    expect(entry).toEqual({
      name: "backup/data_01:23.json",
      type: "-",
      linkTarget: undefined,
    });
  });
});
