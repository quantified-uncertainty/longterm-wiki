/**
 * Migrate !ref tags in KB YAML files from `!ref stableId:slug` to `!ref stableId`.
 *
 * Part of the KB data migration backlog (discussion #2023).
 * Removes the `:slug` suffix from !ref YAML tags, since slugs are being
 * phased out in favor of bare stableIds.
 *
 * Usage:
 *   pnpm tsx crux/scripts/migrate-ref-slugs.ts --dry-run   # preview changes (default)
 *   pnpm tsx crux/scripts/migrate-ref-slugs.ts --apply      # apply changes
 */

import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, extname } from "node:path";

const THINGS_DIR = join(
  import.meta.dirname,
  "../../packages/factbase/data/things"
);

// Matches `!ref <stableId>:<slug>` and captures the stableId and slug portions.
// stableId is a 10-char alphanumeric string; slug is a kebab-case identifier.
const REF_WITH_SLUG_RE = /!ref ([A-Za-z0-9]{10}):([a-z0-9-]+)/g;

async function main() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const dryRun = !apply;

  if (dryRun) {
    console.log("DRY RUN — pass --apply to write changes\n");
  }

  const entries = await readdir(THINGS_DIR);
  const yamlFiles = entries.filter(
    (e) => extname(e) === ".yaml" || extname(e) === ".yml"
  );

  let totalReplacements = 0;
  let filesChanged = 0;

  for (const filename of yamlFiles.sort()) {
    const filepath = join(THINGS_DIR, filename);
    const content = await readFile(filepath, "utf-8");

    // Count matches first
    const matches = [...content.matchAll(REF_WITH_SLUG_RE)];
    if (matches.length === 0) continue;

    // Replace all `!ref stableId:slug` with `!ref stableId`
    const updated = content.replace(
      REF_WITH_SLUG_RE,
      (_match, stableId: string, _slug: string) => `!ref ${stableId}`
    );

    if (updated === content) continue; // idempotent: no changes needed

    filesChanged++;
    totalReplacements += matches.length;

    for (const match of matches) {
      const [full, stableId, slug] = match;
      console.log(
        `  ${filename}: ${full} -> !ref ${stableId}  (removed :${slug})`
      );
    }

    if (apply) {
      await writeFile(filepath, updated, "utf-8");
    }
  }

  console.log(
    `\n${dryRun ? "Would change" : "Changed"} ${totalReplacements} !ref tags across ${filesChanged} files.`
  );

  if (dryRun && totalReplacements > 0) {
    console.log("\nRun with --apply to write changes.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
