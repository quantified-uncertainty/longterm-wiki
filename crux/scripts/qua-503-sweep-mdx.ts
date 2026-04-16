/**
 * QUA-503: Rewrite every `<R id="<bare10>">` in `content/docs/` to use the new
 * `sid_<10>` id produced by `qua-503-generate-mapping.ts`.
 *
 * Reads the committed mapping at
 * `apps/wiki-server/scripts/qua-503-bare10-mapping.json` and applies it to every
 * `.mdx`/`.md` file under `content/docs/`. The match is intentionally strict —
 * `<R id="..."` with a bare 10-char alphanumeric — to avoid touching anything
 * else.
 *
 * Idempotent: re-running after the sweep is a no-op because the regex only
 * matches bare10 ids.
 *
 * Usage:
 *   pnpm tsx crux/scripts/qua-503-sweep-mdx.ts          # write
 *   pnpm tsx crux/scripts/qua-503-sweep-mdx.ts --dry    # report, no writes
 */

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const CONTENT_ROOT = join(REPO_ROOT, "content", "docs");
const MAPPING_PATH = join(
  REPO_ROOT,
  "apps",
  "wiki-server",
  "scripts",
  "qua-503-bare10-mapping.json",
);

const DRY_RUN = process.argv.includes("--dry");

interface MappingRow {
  old: string;
  new: string;
  resourceId: string;
}

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      walk(full, out);
    } else if (name.endsWith(".mdx") || name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function main(): void {
  const mapping = JSON.parse(readFileSync(MAPPING_PATH, "utf-8")) as MappingRow[];
  const map = new Map<string, string>();
  for (const row of mapping) map.set(row.old, row.new);

  const files = walk(CONTENT_ROOT);
  const unknownIds = new Map<string, number>();
  let totalRewrites = 0;
  let filesTouched = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    let rewrites = 0;
    const next = src.replace(
      /<R id="([A-Za-z0-9]{10})"/g,
      (full, id: string) => {
        const fresh = map.get(id);
        if (!fresh) {
          unknownIds.set(id, (unknownIds.get(id) ?? 0) + 1);
          return full;
        }
        rewrites++;
        return `<R id="${fresh}"`;
      },
    );
    if (rewrites > 0) {
      totalRewrites += rewrites;
      filesTouched++;
      if (!DRY_RUN) {
        writeFileSync(file, next);
      }
    }
  }

  console.log(
    `${DRY_RUN ? "[dry-run] " : ""}Rewrote ${totalRewrites} <R> references across ${filesTouched} files`,
  );

  if (unknownIds.size > 0) {
    console.error(
      `\nERROR: ${unknownIds.size} unknown bare10 ids were found but NOT in the mapping:`,
    );
    const samples = [...unknownIds.entries()].slice(0, 20);
    for (const [id, count] of samples) {
      console.error(`  ${id} (${count} occurrence${count === 1 ? "" : "s"})`);
    }
    if (unknownIds.size > samples.length) {
      console.error(`  ...and ${unknownIds.size - samples.length} more`);
    }
    process.exit(1);
  }
}

main();
