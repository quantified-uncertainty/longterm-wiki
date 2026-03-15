#!/usr/bin/env -S node --import tsx/esm
/**
 * Migrate KB entity references in MDX files from slugs to stableIds.
 *
 * Converts:
 *   - <KBF entity="anthropic" ...>         → <KBF entity="mK9pX3rQ7n" ...>
 *   - <KBFactTable entity="anthropic" ...> → <KBFactTable entity="mK9pX3rQ7n" ...>
 *   - <KBRecordTable entity="anthropic" ...> → <KBRecordTable entity="mK9pX3rQ7n" ...>
 *   - <Calc expr="{anthropic.revenue} / {anthropic.valuation}" ...>
 *       → <Calc expr="{mK9pX3rQ7n.revenue} / {mK9pX3rQ7n.valuation}" ...>
 *
 * Skips references inside backtick-delimited code spans/blocks (documentation examples).
 * Idempotent: already-migrated stableIds are left unchanged.
 *
 * Usage:
 *   pnpm tsx crux/scripts/migrate-kb-slugs-to-stableids.ts           # Dry run
 *   pnpm tsx crux/scripts/migrate-kb-slugs-to-stableids.ts --apply   # Write changes
 *   pnpm tsx crux/scripts/migrate-kb-slugs-to-stableids.ts --verbose # Show all replacements
 */

import fs from "fs";
import path from "path";

const ROOT = path.resolve(import.meta.dirname, "../..");
const CONTENT_DIR = path.join(ROOT, "content/docs");
const KB_THINGS_DIR = path.join(ROOT, "packages/factbase/data/things");

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const VERBOSE = args.includes("--verbose");

// ── Step 1: Build slug → stableId mapping from KB YAML files ─────────

function buildSlugMap(): { slugToId: Map<string, string>; stableIds: Set<string> } {
  const slugToId = new Map<string, string>();
  const stableIds = new Set<string>();
  const files = fs.readdirSync(KB_THINGS_DIR).filter((f) => f.endsWith(".yaml"));

  for (const file of files) {
    const content = fs.readFileSync(path.join(KB_THINGS_DIR, file), "utf-8");
    // Parse just the thing header to get id and stableId
    // The YAML may have custom tags like !ref, so we use a lenient approach
    const idMatch = content.match(/^\s*id:\s*(\S+)/m);
    const stableIdMatch = content.match(/^\s*stableId:\s*(\S+)/m);

    if (idMatch && stableIdMatch) {
      const slug = idMatch[1];
      const stableId = stableIdMatch[1];
      slugToId.set(slug, stableId);
      stableIds.add(stableId);
    }
  }

  return { slugToId, stableIds };
}

// ── Step 2: Find MDX files containing KB component references ────────

function findMdxFiles(): string[] {
  const results: string[] = [];

  function walk(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith(".mdx")) {
        results.push(fullPath);
      }
    }
  }

  walk(CONTENT_DIR);
  return results;
}

// ── Step 3: Migrate entity references in a single file ───────────────

interface Replacement {
  original: string;
  replaced: string;
  line: number;
  type: "entity-attr" | "calc-ref";
}

/**
 * Split content into code-protected segments.
 * Returns alternating [non-code, code, non-code, code, ...] segments.
 * We only modify non-code segments.
 */
function splitCodeSegments(content: string): { text: string; isCode: boolean }[] {
  const segments: { text: string; isCode: boolean }[] = [];
  // Match fenced code blocks (```...```) and inline code (`...`)
  // Process fenced blocks first (greedy), then inline
  const codePattern = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = codePattern.exec(content)) !== null) {
    if (match.index > lastIndex) {
      segments.push({ text: content.slice(lastIndex, match.index), isCode: false });
    }
    segments.push({ text: match[0], isCode: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < content.length) {
    segments.push({ text: content.slice(lastIndex), isCode: false });
  }

  return segments;
}

function migrateFile(
  filePath: string,
  slugToId: Map<string, string>,
  stableIds: Set<string>,
): { newContent: string; replacements: Replacement[] } {
  const content = fs.readFileSync(filePath, "utf-8");
  const replacements: Replacement[] = [];

  const segments = splitCodeSegments(content);
  const newSegments = segments.map((seg) => {
    if (seg.isCode) return seg.text;

    let text = seg.text;

    // 1. Migrate entity="slug" attributes in KB components
    // Matches: <KBF entity="...", <KBFactTable entity="...", <KBRecordTable entity="...", etc.
    text = text.replace(
      /(<(?:KBF|KBFactTable|KBRecordTable|KBFactValue|KBRecordCollection)\s[^>]*entity=")([^"]+)(")/g,
      (full, prefix, entityVal, suffix) => {
        // Skip if already a stableId (exists in the known stableId set)
        if (stableIds.has(entityVal)) return full;
        // Skip generic/placeholder values used in documentation examples
        if (["entity", "slug", "x", "y"].includes(entityVal)) return full;

        const stableId = slugToId.get(entityVal);
        if (!stableId) return full; // Unknown slug, leave as-is

        // Find line number for this match
        const beforeMatch = content.indexOf(full);
        const lineNum = beforeMatch >= 0
          ? content.slice(0, beforeMatch).split("\n").length
          : 0;

        replacements.push({
          original: `entity="${entityVal}"`,
          replaced: `entity="${stableId}"`,
          line: lineNum,
          type: "entity-attr",
        });

        return `${prefix}${stableId}${suffix}`;
      },
    );

    // 2. Migrate {slug.property} references in Calc expr attributes
    text = text.replace(
      /(<Calc\s[^>]*expr=")([^"]+)(")/g,
      (full, prefix, exprVal, suffix) => {
        let newExpr = exprVal;
        let changed = false;

        // Replace {slug.property} patterns
        newExpr = newExpr.replace(
          /\{([a-zA-Z][a-zA-Z0-9-]*)\./g,
          (refFull, ref) => {
            // Skip if already a stableId
            if (stableIds.has(ref)) return refFull;

            const stableId = slugToId.get(ref);
            if (!stableId) return refFull;

            changed = true;
            return `{${stableId}.`;
          },
        );

        if (changed) {
          const beforeMatch = content.indexOf(full);
          const lineNum = beforeMatch >= 0
            ? content.slice(0, beforeMatch).split("\n").length
            : 0;

          replacements.push({
            original: `expr="${exprVal}"`,
            replaced: `expr="${newExpr}"`,
            line: lineNum,
            type: "calc-ref",
          });

          return `${prefix}${newExpr}${suffix}`;
        }

        return full;
      },
    );

    return text;
  });

  return { newContent: newSegments.join(""), replacements };
}

// ── Main ─────────────────────────────────────────────────────────────

function main() {
  console.log("KB Slug → StableId Migration");
  console.log("=".repeat(50));
  console.log(APPLY ? "MODE: APPLY (writing changes)" : "MODE: DRY RUN (no changes)");
  console.log();

  // Build mapping
  const { slugToId, stableIds } = buildSlugMap();
  console.log(`Loaded ${slugToId.size} slug → stableId mappings from KB YAML`);

  if (VERBOSE) {
    console.log("\nSlug mappings:");
    for (const [slug, stableId] of slugToId) {
      console.log(`  ${slug} → ${stableId}`);
    }
  }
  console.log();

  // Find and process MDX files
  const mdxFiles = findMdxFiles();
  console.log(`Found ${mdxFiles.length} MDX files to scan`);
  console.log();

  let totalReplacements = 0;
  let filesModified = 0;

  for (const filePath of mdxFiles) {
    const { newContent, replacements } = migrateFile(filePath, slugToId, stableIds);

    if (replacements.length > 0) {
      filesModified++;
      totalReplacements += replacements.length;

      const relPath = path.relative(ROOT, filePath);
      console.log(`  ${relPath}: ${replacements.length} replacement(s)`);

      if (VERBOSE) {
        for (const r of replacements) {
          console.log(`    L${r.line} [${r.type}] ${r.original} → ${r.replaced}`);
        }
      }

      if (APPLY) {
        fs.writeFileSync(filePath, newContent, "utf-8");
      }
    }
  }

  console.log();
  console.log("─".repeat(50));
  console.log(`Total: ${totalReplacements} replacements in ${filesModified} files`);

  if (!APPLY && totalReplacements > 0) {
    console.log("\nRun with --apply to write changes.");
  }
  if (APPLY) {
    console.log("\nChanges written successfully.");
  }
}

main();
