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

const R2_PUBLIC_BASE = "https://pub-72b2b2fc36ec423189843747af98f80e.r2.dev";
const SNAPSHOTS_PAGE_URL = "https://incidentdatabase.ai/research/snapshots";

/**
 * Scrape the documented snapshots page for the latest backup URL.
 * The page links each snapshot by filename, e.g.
 *   <a href="https://pub-...r2.dev/backup-20260420103651.tar.bz2">
 */
export async function discoverLatestSnapshotUrl(): Promise<string> {
  const res = await fetch(SNAPSHOTS_PAGE_URL);
  if (!res.ok) {
    throw new Error(
      `Failed to fetch AIID snapshots page: ${res.status} ${res.statusText}`,
    );
  }
  const html = await res.text();
  // Anchor href with the R2 base and `backup-<digits>.tar.bz2`
  const re =
    /https:\/\/pub-[0-9a-f]+\.r2\.dev\/backup-(\d{14})\.tar\.bz2/g;
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
 */
export function extractSnapshot(archivePath: string): string {
  const dir = mkdtempSync(join(tmpdir(), "aiid-extract-"));
  // `tar` is in coreutils on Darwin + Linux. Use execFileSync for argv
  // safety (no shell interpretation of archivePath).
  execFileSync("tar", ["-xjf", archivePath, "-C", dir], {
    stdio: ["ignore", "pipe", "pipe"],
  });
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

export const AIID_R2_BASE = R2_PUBLIC_BASE;
export const AIID_SNAPSHOTS_PAGE = SNAPSHOTS_PAGE_URL;
