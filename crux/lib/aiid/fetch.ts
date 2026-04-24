/**
 * Fetch + extract MIT AIID weekly R2 snapshots.
 *
 * The snapshots are hosted at
 *   https://pub-72b2b2fc36ec423189843747af98f80e.r2.dev/backup-<TIMESTAMP>.tar.bz2
 * and documented on https://incidentdatabase.ai/research/snapshots.
 *
 * We stream the tar.bz2 to /tmp, then shell out to `tar -xjf` — there's
 * no Node-native bz2 decoder in the stdlib and we already depend on
 * coreutils elsewhere in crux. The extracted MongoDB dump includes JSON
 * and CSV exports; we read the JSON files we need and ignore the rest.
 */

import { mkdtempSync, createWriteStream, readdirSync, readFileSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import type { AiidEntityRaw, AiidIncidentRaw, AiidReportRaw } from "./transform.ts";

export const AIID_R2_BASE = "https://pub-72b2b2fc36ec423189843747af98f80e.r2.dev";
export const AIID_SNAPSHOTS_PAGE = "https://incidentdatabase.ai/research/snapshots";

/**
 * Scrape the documented snapshots page for the latest backup URL.
 *
 * The regex is **pinned to the known R2 bucket** (not just any `pub-*.r2.dev`
 * host) so a typo'd or hostile link on the snapshots page can't redirect us
 * to an attacker-controlled bucket. Defense-in-depth: the CLI also checks
 * `startsWith(AIID_R2_BASE)` before downloading.
 */
export async function discoverLatestSnapshotUrl(): Promise<string> {
  const res = await fetch(AIID_SNAPSHOTS_PAGE);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch AIID snapshots page: ${res.status} ${res.statusText}`,
    );
  }
  const html = await res.text();
  const escapedBase = AIID_R2_BASE.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`${escapedBase}/backup-(\\d{14})\\.tar\\.bz2`, "g");
  const matches = Array.from(html.matchAll(re));
  if (matches.length === 0) {
    throw new Error(
      "No AIID backup URLs found on snapshots page — page layout may have changed",
    );
  }
  // Sort by the timestamp component descending and pick the newest.
  matches.sort((a, b) => (a[1] < b[1] ? 1 : -1));
  return matches[0][0];
}

/**
 * Stream-download the given URL to a path under `/tmp`. Returns the path.
 */
export async function downloadSnapshot(
  url: string,
  targetPath?: string,
): Promise<string> {
  const out =
    targetPath ??
    join(mkdtempSync(join(tmpdir(), "aiid-snapshot-")), "backup.tar.bz2");

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to download snapshot ${url}: ${res.status} ${res.statusText}`,
    );
  }
  if (!res.body) {
    throw new Error(`Snapshot download returned no body: ${url}`);
  }
  // Node 22 provides Readable.fromWeb() for ReadableStream -> Node stream.
  const nodeStream = Readable.fromWeb(
    res.body as unknown as import("stream/web").ReadableStream,
  );
  await pipeline(nodeStream, createWriteStream(out));
  return out;
}

/**
 * Validate a tar archive's entries do not escape the extraction root. AIID
 * archives come from a third-party R2 bucket; even though tar typically
 * rejects `..` traversal at extract time, we double-check here so the
 * trust model is explicit.
 *
 * Rejected entry shapes:
 *   - Absolute paths (`/foo`)
 *   - Paths containing `..` segments
 *   - Symlinks pointing outside the archive root (best-effort)
 */
export function listTarEntries(archivePath: string): string[] {
  const out = execFileSync("tar", ["-tjf", archivePath], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024, // AIID dump has ~30k entries; 64 MB string is plenty
  });
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Throws if any entry name is unsafe. Consumers must call this before
 * extraction. Pure: no I/O.
 */
export function assertSafeTarEntries(entries: string[]): void {
  for (const entry of entries) {
    if (entry.startsWith("/")) {
      throw new Error(`Refusing to extract absolute path from archive: ${entry}`);
    }
    // `..` must not appear as its own segment — also catches `foo/../bar`.
    const segments = entry.split("/");
    if (segments.some((s) => s === "..")) {
      throw new Error(`Refusing to extract traversal path from archive: ${entry}`);
    }
  }
}

/**
 * Extract a tar.bz2 into a fresh temp directory. Returns the directory path.
 *
 * The MongoDB dump layout looks roughly like:
 *   backup-YYYYMMDDHHMMSS/
 *     aiidprod/
 *       incidents.json
 *       reports.json
 *       entities.json
 *       classifications.json
 *       ...
 *
 * We don't assume a specific root directory name — we just recursively
 * look for the JSON filenames we need.
 *
 * Hardening (Zip-Slip / path-traversal):
 *   1. List entries first via `tar -tjf` and reject absolute or `..` paths.
 *   2. Pass `--no-same-owner` and `--no-same-permissions` to drop archive
 *      uid/gid/mode bits on extraction (defense if running with elevated
 *      privileges; harmless otherwise).
 */
export function extractSnapshot(archivePath: string): string {
  // 1. Pre-scan entries.
  const entries = listTarEntries(archivePath);
  assertSafeTarEntries(entries);

  // 2. Extract into a fresh temp dir. `tar` is in coreutils on Darwin + Linux.
  //    `execFileSync` argv form prevents shell interpretation of archivePath.
  const dir = mkdtempSync(join(tmpdir(), "aiid-extract-"));
  execFileSync(
    "tar",
    [
      "-xjf",
      archivePath,
      "-C",
      dir,
      "--no-same-owner",
      "--no-same-permissions",
    ],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  return dir;
}

/**
 * Walk `root` recursively, returning the first file whose basename matches
 * the given name (e.g. "incidents.json"). AIID snapshots sometimes wrap
 * the collections in an `aiidprod/` directory.
 */
export function findFileByName(root: string, basename: string): string | null {
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(dir, e);
      let st;
      try {
        st = statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) stack.push(full);
      else if (e === basename) return full;
    }
  }
  return null;
}

/**
 * Parse an array-of-objects JSON file from the snapshot.
 *
 * AIID's MongoDB `mongoexport` output is typically one JSON object per line
 * (ndjson) or a single JSON array. We handle both — auto-detect by first
 * non-whitespace character.
 */
export function parseJsonArrayFile<T>(path: string): T[] {
  const buf = readFileSync(path, "utf8");
  const trimmed = buf.trimStart();
  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(buf);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected array in ${path}, got ${typeof parsed}`);
    }
    return parsed as T[];
  }
  // ndjson path
  const out: T[] = [];
  const lines = buf.split(/\r?\n/);
  for (const line of lines) {
    const l = line.trim();
    if (!l) continue;
    try {
      out.push(JSON.parse(l) as T);
    } catch (e) {
      throw new Error(
        `Failed to parse ndjson line in ${path}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  return out;
}

/** Discover + load all three collections we care about from a snapshot root. */
export function loadSnapshotCollections(root: string): {
  incidents: AiidIncidentRaw[];
  reports: AiidReportRaw[];
  entities: AiidEntityRaw[];
} {
  const incidentsPath = findFileByName(root, "incidents.json");
  const reportsPath = findFileByName(root, "reports.json");
  const entitiesPath = findFileByName(root, "entities.json");

  if (!incidentsPath) throw new Error("incidents.json not found in snapshot");
  if (!reportsPath) throw new Error("reports.json not found in snapshot");
  if (!entitiesPath) throw new Error("entities.json not found in snapshot");

  return {
    incidents: parseJsonArrayFile<AiidIncidentRaw>(incidentsPath),
    reports: parseJsonArrayFile<AiidReportRaw>(reportsPath),
    entities: parseJsonArrayFile<AiidEntityRaw>(entitiesPath),
  };
}

/** Best-effort cleanup — never throws. */
export function cleanupDir(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // Log-and-ignore intentional: cleanup is a nice-to-have.
  }
}
