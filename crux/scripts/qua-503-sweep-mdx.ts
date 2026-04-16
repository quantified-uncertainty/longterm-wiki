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

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTENT_DIR_ABS, PROJECT_ROOT } from "../lib/content-types.ts";
import { findMdxFiles } from "../lib/file-utils.ts";

const MAPPING_PATH = join(
  PROJECT_ROOT,
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

// Permissive sweep regex: tolerates extra whitespace, single quotes, the `id`
// attribute appearing first or after other props on the same opening tag, and
// self-closing forms. Keeps the 10-char alphanumeric capture so the audit can
// distinguish bare10 from sid_ ids.
const SWEEP_RE = /<R\b([^>]*?)\bid\s*=\s*(["'])([A-Za-z0-9]{10})\2/g;

// Post-sweep audit: any bare10 id remaining inside any <R ...> opening tag
// means the sweep regex missed an authoring variant. Run against the
// post-rewrite content so dry-run still validates correctness.
const AUDIT_RE = /<R\b[^>]*\bid\s*=\s*["']([A-Za-z0-9]{10})["'][^>]*>/g;

function main(): void {
  const mapping = JSON.parse(readFileSync(MAPPING_PATH, "utf-8")) as MappingRow[];
  const map = new Map<string, string>();
  for (const row of mapping) map.set(row.old, row.new);

  const files = findMdxFiles(CONTENT_DIR_ABS);
  const unknownIds = new Map<string, number>();
  const stragglers: { file: string; id: string }[] = [];

  let totalRewrites = 0;
  let filesTouched = 0;

  for (const file of files) {
    const src = readFileSync(file, "utf-8");
    let rewrites = 0;
    const next = src.replace(SWEEP_RE, (full, before: string, q: string, id: string) => {
      const fresh = map.get(id);
      if (!fresh) {
        unknownIds.set(id, (unknownIds.get(id) ?? 0) + 1);
        return full;
      }
      rewrites++;
      return `<R${before}id=${q}${fresh}${q}`;
    });

    for (const m of next.matchAll(AUDIT_RE)) {
      stragglers.push({ file, id: m[1] });
    }

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

  if (stragglers.length > 0) {
    console.error(
      `\nERROR: post-sweep audit found ${stragglers.length} <R> tag(s) still using a bare10 id:`,
    );
    for (const s of stragglers.slice(0, 20)) {
      console.error(`  ${s.file}: ${s.id}`);
    }
    if (stragglers.length > 20) {
      console.error(`  ...and ${stragglers.length - 20} more`);
    }
    process.exit(1);
  }
}

main();
