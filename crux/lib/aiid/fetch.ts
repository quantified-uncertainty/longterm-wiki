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
import { escapeRegex } from "../claim-text-utils.ts";
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
  const re = new RegExp(`${escapeRegex(AIID_R2_BASE)}/backup-(\\d{14})\\.tar\\.bz2`, "g");
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
 *
 * Hardening: the redirect mode is `error` so a redirect to an unexpected
 * origin is rejected — the caller has already pinned `url` to the AIID R2
 * bucket and we don't want a redirect (intentional or hostile) to widen
 * that trust.
 */
export async function downloadSnapshot(
  url: string,
  targetPath?: string,
): Promise<string> {
  const out =
    targetPath ??
    join(mkdtempSync(join(tmpdir(), "aiid-snapshot-")), "backup.tar.bz2");

  const res = await fetch(url, { redirect: "error" });
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

/** A tar entry as produced by `listTarEntries()`. */
export interface TarEntry {
  /** Path of the entry within the archive. */
  name: string;
  /** Entry type: `-` regular, `d` directory, `l` symlink, `h` hardlink, etc. */
  type: string;
  /** Symlink/hardlink target if this is a link entry, otherwise undefined. */
  linkTarget?: string;
}

/**
 * Verbose tar listing — `-tvjf` includes the permission string (whose first
 * char is the entry type) and, for link entries, ` -> target` or ` link to
 * target`. We parse those out so `assertSafeTarEntries()` can reject any
 * link entries before extraction. AIID archives come from a third-party R2
 * bucket; checking entry-name text alone is not enough — a crafted archive
 * could contain a symlink whose target escapes the extraction root.
 */
export function listTarEntries(archivePath: string): TarEntry[] {
  const out = execFileSync("tar", ["-tvjf", archivePath], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024, // AIID dump has ~30k entries; 64 MB string is plenty
  });

  const entries: TarEntry[] = [];
  for (const rawLine of out.split("\n")) {
    const line = rawLine.replace(/\r$/, "");
    if (!line.trim()) continue;

    // Verbose format: `<perms> <owner> <size> <date> <time> <name>[ -> target | link to target]`
    // The permission string (first whitespace-separated token) starts with the
    // type char; anything we don't recognize as a regular file or directory is
    // treated as a link/special and rejected by assertSafeTarEntries.
    const m = line.match(/^(\S+)\s+\S+\s+\d+\s+\S+\s+\S+\s+(.+)$/);
    if (!m) {
      // Unparseable line — be conservative and reject by giving it an unknown type.
      entries.push({ name: line.trim(), type: "?" });
      continue;
    }
    const type = m[1][0] ?? "?";
    let rest = m[2];
    let linkTarget: string | undefined;
    // bsdtar / GNU tar format symlinks as " -> target" and hardlinks as " link to target".
    const linkMatch = rest.match(/^(.+?)\s+(?:->|link to)\s+(.+)$/);
    if (linkMatch) {
      rest = linkMatch[1];
      linkTarget = linkMatch[2];
    }
    entries.push({ name: rest, type, linkTarget });
  }
  return entries;
}

/**
 * Throws if any entry is unsafe. Consumers must call this before extraction.
 * Pure: no I/O.
 *
 * Rejected entry shapes:
 *   - Absolute paths (`/foo`)
 *   - Paths containing `..` segments
 *   - Symlinks and hardlinks (any link entry, regardless of target — link
 *     targets to absolute paths or `..` are obviously dangerous, but even
 *     in-archive links can be combined with a later traversal walk to escape
 *     the extraction root, so we reject all link entries unconditionally).
 *   - Unknown / special entry types (devices, fifos, etc.)
 */
export function assertSafeTarEntries(entries: TarEntry[]): void {
  for (const entry of entries) {
    if (entry.name.startsWith("/")) {
      throw new Error(`Refusing to extract absolute path from archive: ${entry.name}`);
    }
    const segments = entry.name.split("/");
    if (segments.some((s) => s === "..")) {
      throw new Error(`Refusing to extract traversal path from archive: ${entry.name}`);
    }
    if (entry.type === "l" || entry.type === "h") {
      throw new Error(
        `Refusing to extract link entry from archive: ${entry.name} -> ${entry.linkTarget ?? "(unknown)"}`,
      );
    }
    if (entry.type !== "-" && entry.type !== "d") {
      throw new Error(
        `Refusing to extract unsupported entry type '${entry.type}' from archive: ${entry.name}`,
      );
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
