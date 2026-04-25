/**
 * Tests for path-traversal hardening on AIID tar extraction.
 *
 * The full fetch + extract pipeline is integration-only (it shells out
 * to `tar`), so we can't unit-test it without a real archive. But the
 * pure validator that gates extraction is critical and easy to test —
 * any bypass of `assertSafeTarEntries` could let a hostile archive
 * write outside the temp dir (Zip-Slip class of attack).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { execFileSync } from "child_process";
import { tmpdir } from "os";
import { join } from "path";
import { assertSafeTarEntries, listTarEntries, type TarEntry } from "./fetch.ts";

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
 * Integration tests for `listTarEntries`. We synthesize tiny tar.bz2
 * archives with the local `tar` (bsdtar on macOS, GNU tar on Linux CI) so
 * the test exercises the same parser path that AIID ingest uses, including
 * the cross-pass `-tjf` / `-tvjf` reconciliation.
 *
 * The QUA-733 regression and the QUA-733 review-finding security
 * regressions both live here: the parser must not silently bypass
 * `assertSafeTarEntries()` for hostile filenames containing `..`,
 * timestamp-shaped substrings, or arrow-shaped substrings.
 */
describe("listTarEntries (integration)", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "fetch-tar-test-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  /**
   * Tar archive fixture spec — used by `makeArchive()` to synthesize tiny
   * bz2 archives via Python's tarfile module, the only path that lets us
   * inject filenames the local filesystem would otherwise refuse (`..`-
   * prefixed, `\n`-embedded, etc.).
   */
  type FixtureItem =
    | string
    | {
        name: string;
        kind?: "file" | "symlink";
        linkname?: string;
        mtime?: number;
      };

  function makeArchive(items: FixtureItem[]): string {
    const archivePath = join(scratch, "test.tar.bz2");
    const normalized = items.map((it) => (typeof it === "string" ? { name: it } : it));
    const py = `
import tarfile, io
buf = io.BytesIO()
items = ${JSON.stringify(normalized)}
with tarfile.open(fileobj=buf, mode='w:bz2') as tf:
    for it in items:
        info = tarfile.TarInfo(name=it['name'])
        info.size = 0
        if it.get('kind') == 'symlink':
            info.type = tarfile.SYMTYPE
            info.linkname = it['linkname']
            tf.addfile(info)
        else:
            if 'mtime' in it:
                info.mtime = it['mtime']
            tf.addfile(info, io.BytesIO(b''))
open(${JSON.stringify(archivePath)}, 'wb').write(buf.getvalue())
`;
    execFileSync("python3", ["-c", py], { stdio: ["ignore", "pipe", "pipe"] });
    return archivePath;
  }

  it("parses a benign archive — name is taken verbatim from `tar -tjf`", () => {
    const archive = makeArchive([
      "backup/aiidprod/incidents.json",
      "backup/aiidprod/reports.json",
    ]);
    const entries = listTarEntries(archive);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      name: "backup/aiidprod/incidents.json",
      type: "-",
    });
    expect(entries[1]).toMatchObject({
      name: "backup/aiidprod/reports.json",
      type: "-",
    });
  });

  /**
   * Security regression — the QUA-733 review finding. The previous regex
   * approach would parse this filename as `harmless.json` because the
   * greedy `.*` anchored on `01:23` (inside the filename) instead of
   * `03:37` (the real timestamp), and the year-only mtime form had no
   * `HH:MM` at all. The two-pass implementation reads names from `tar
   * -tjf` directly, so the entry name is the literal filename and
   * `assertSafeTarEntries` sees the `..` segment and rejects.
   */
  it("preserves a `..`-prefixed filename containing time-like substrings (security)", () => {
    const archive = makeArchive(["../escape 01:23 harmless.json"]);
    const entries = listTarEntries(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0].name).toBe("../escape 01:23 harmless.json");
    expect(entries[0].type).toBe("-");
    expect(() => assertSafeTarEntries(entries)).toThrow(/traversal/);
  });

  it("preserves a regular filename containing ` -> ` (no false-positive link split)", () => {
    const archive = makeArchive(["notes -> draft.txt"]);
    const entries = listTarEntries(archive);
    expect(entries[0].name).toBe("notes -> draft.txt");
    expect(entries[0].type).toBe("-");
    expect(entries[0].linkTarget).toBeUndefined();
  });

  it("preserves a regular filename containing ` link to ` (no false-positive hardlink split)", () => {
    const archive = makeArchive(["my link to file.txt"]);
    const entries = listTarEntries(archive);
    expect(entries[0].name).toBe("my link to file.txt");
    expect(entries[0].type).toBe("-");
    expect(entries[0].linkTarget).toBeUndefined();
  });

  it("rejects an actual symlink (regardless of how the local tar formats the line)", () => {
    const archive = makeArchive([
      { name: "evil", kind: "symlink", linkname: "../../etc/passwd" },
    ]);
    const entries = listTarEntries(archive);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("l");
    expect(entries[0].linkTarget).toBe("../../etc/passwd");
    expect(() => assertSafeTarEntries(entries)).toThrow(/link entry/);
  });

  it("preserves filenames with bsdtar's year fallback (mtime older than ~6 months)", () => {
    // mtime 0 = 1970-01-01, well past bsdtar's 6-month HH:MM cutoff →
    // verbose listing degrades to `Mon DD  YYYY` format. The previous
    // regex implementation had no `HH:MM` to anchor on and broke entirely.
    const archive = makeArchive([{ name: "backup/old.json", mtime: 0 }]);
    const entries = listTarEntries(archive);
    expect(entries[0].name).toBe("backup/old.json");
    expect(entries[0].type).toBe("-");
  });
});
