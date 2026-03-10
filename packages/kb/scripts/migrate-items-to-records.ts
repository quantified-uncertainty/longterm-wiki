/**
 * migrate-items-to-records.ts
 *
 * Converts all `items:` sections in KB entity YAML files to `records:` format.
 *
 * Changes per entity:
 * 1. `items:` → `records:`
 * 2. Removes `type:` and `entries:` wrapper (collection name maps to schema via depluralization)
 * 3. Replaces opaque keys (i_XXX) with readable slugs derived from name/person/key fields
 * 4. Converts `!ref stableId:slug` → plain `slug`
 * 5. Renames `amount` → `raised` in funding-round collections
 * 6. Quotes date values that aren't already quoted
 *
 * Usage: npx tsx packages/kb/scripts/migrate-items-to-records.ts [--dry-run] [--entity=openai]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { globSync } from "node:fs";

const DATA_DIR = join(import.meta.dirname, "../data/things");
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const entityFilter = args.find(a => a.startsWith("--entity="))?.split("=")[1];

// Slug generation: lowercase, replace spaces/special chars with hyphens
function toSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// Convert !ref stableId:slug → slug
function stripRef(value: string): string {
  // Match !ref <stableId>:<slug> pattern
  const refMatch = value.match(/^!ref\s+\w+:(.+)$/);
  if (refMatch) return refMatch[1];
  return value;
}

interface ItemEntry {
  [key: string]: unknown;
}

interface ItemCollection {
  type?: string;
  entries?: Record<string, ItemEntry>;
}

function deriveKey(entry: ItemEntry, collectionName: string): string {
  // Try to derive a readable key from the entry fields
  const name = entry.name as string | undefined;
  const person = entry.person as string | undefined;
  const member = entry.member as string | undefined;
  const partner = entry.partner as string | undefined;
  const investor = entry.investor as string | undefined;
  const pledger = entry.pledger as string | undefined;
  const holder = entry.holder as string | undefined;

  // For person-referencing collections, use the person slug
  if (person) {
    const slug = stripRef(String(person));
    return slug;
  }
  if (member) return stripRef(String(member));
  if (partner) return stripRef(String(partner));
  if (investor) return stripRef(String(investor));
  if (pledger) return stripRef(String(pledger));
  if (holder) return stripRef(String(holder));

  // For named entries, slugify the name
  if (name) return toSlug(String(name));

  // Fallback to collection-based key
  return `entry-${Math.random().toString(36).slice(2, 8)}`;
}

// Collection name renames (items name → records name)
const COLLECTION_RENAMES: Record<string, string> = {
  "key-people": "key-persons",
  "board-members": "board-seats",
  "equity-holders": "equity-positions",
  "round-investments": "investments",
  "notable-publications": "notable-publications", // same
};

// Field renaming rules per collection type (keyed by OLD collection name)
const FIELD_RENAMES: Record<string, Record<string, string>> = {
  "funding-rounds": { amount: "raised" },
};

function processFile(filePath: string): { changed: boolean; entityId: string } {
  const entityId = basename(filePath, ".yaml");
  const content = readFileSync(filePath, "utf-8");

  // Check if file has items section
  if (!content.match(/^items:/m)) {
    return { changed: false, entityId };
  }

  // Already has records? Skip if so (anthropic was already migrated)
  if (content.match(/^records:/m)) {
    console.log(`  ${entityId}: SKIP (already has records section)`);
    return { changed: false, entityId };
  }

  const lines = content.split("\n");
  const itemsLineIdx = lines.findIndex(l => l === "items:");
  if (itemsLineIdx === -1) {
    return { changed: false, entityId };
  }

  // Parse the YAML structure manually to understand the items
  // We'll do a line-by-line transformation
  const beforeItems = lines.slice(0, itemsLineIdx);
  const itemsSection = lines.slice(itemsLineIdx);

  // Transform the items section to records format
  const recordLines: string[] = ["records:"];
  let currentCollection = "";
  let currentEntryKey = "";
  let inEntries = false;
  let indent = 0;
  const renames = new Map<string, Record<string, string>>();

  for (let i = 1; i < itemsSection.length; i++) {
    const line = itemsSection[i];
    const trimmed = line.trimStart();
    const lineIndent = line.length - trimmed.length;

    // Skip empty lines
    if (trimmed === "") {
      recordLines.push("");
      continue;
    }

    // Skip comments
    if (trimmed.startsWith("#")) {
      recordLines.push(line);
      continue;
    }

    // Collection name (2-space indent under items:)
    if (lineIndent === 2 && trimmed.match(/^[a-z][\w-]*:$/)) {
      const oldName = trimmed.replace(":", "");
      currentCollection = oldName;
      const newName = COLLECTION_RENAMES[oldName] || oldName;
      recordLines.push(`  ${newName}:`);
      inEntries = false;
      continue;
    }

    // type: line (4-space indent) — skip it
    if (lineIndent === 4 && trimmed.startsWith("type:")) {
      continue;
    }

    // entries: line (4-space indent) — skip it, next level becomes direct children
    if (lineIndent === 4 && trimmed === "entries:") {
      inEntries = true;
      continue;
    }

    // Entry key (6-space indent under entries:, or 4-space if no entries wrapper)
    if (inEntries && lineIndent === 6 && trimmed.match(/^[\w-]+:$/)) {
      const oldKey = trimmed.replace(":", "");
      // We'll need to read ahead to derive the key
      // For now, store the old key and we'll derive later
      currentEntryKey = oldKey;

      // Look ahead to find name/person field for key derivation
      let newKey = oldKey;
      for (let j = i + 1; j < itemsSection.length; j++) {
        const nextLine = itemsSection[j].trimStart();
        const nextIndent = itemsSection[j].length - nextLine.length;
        if (nextIndent <= 6 && nextLine !== "") break; // Left the entry

        if (nextLine.startsWith("person:")) {
          const val = nextLine.replace("person:", "").trim();
          newKey = stripRef(val);
          break;
        }
        if (nextLine.startsWith("member:")) {
          const val = nextLine.replace("member:", "").trim();
          newKey = stripRef(val);
          break;
        }
        if (nextLine.startsWith("name:")) {
          const val = nextLine.replace("name:", "").trim().replace(/^["']|["']$/g, "");
          newKey = toSlug(val);
          break;
        }
      }

      // Write the entry key at 4-space indent (de-indented from 6)
      recordLines.push(`    ${newKey}:`);
      continue;
    }

    // Entry fields (8-space indent under entry key)
    if (inEntries && lineIndent === 8) {
      // Process field: strip !ref, rename fields, quote dates
      let processedLine = line;

      // De-indent from 8 to 6
      processedLine = "      " + trimmed;

      // Strip !ref tags
      processedLine = processedLine.replace(/!ref\s+\w+:(\S+)/g, "$1");

      // Rename fields for specific collections
      const fieldRenames = FIELD_RENAMES[currentCollection];
      if (fieldRenames) {
        for (const [from, to] of Object.entries(fieldRenames)) {
          const pattern = new RegExp(`^(\\s+)${from}:`);
          processedLine = processedLine.replace(pattern, `$1${to}:`);
        }
      }

      // Quote bare date values (YYYY-MM or YYYY-MM-DD without quotes)
      processedLine = processedLine.replace(
        /^(\s+(?:date|start|end|appointed|launched|released|started|founded):)\s+(\d{4}-\d{2}(?:-\d{2})?)$/,
        '$1 "$2"'
      );

      recordLines.push(processedLine);
      continue;
    }

    // Continuation lines at deeper indent (10+) — de-indent by 2
    if (inEntries && lineIndent >= 10) {
      const deindented = "  ".repeat(lineIndent / 2 - 1) + trimmed;
      recordLines.push(deindented);
      continue;
    }

    // Anything else at indent 4 that's not type/entries — pass through
    if (lineIndent === 4 && !inEntries) {
      recordLines.push(line);
      continue;
    }

    // Default: pass through
    recordLines.push(line);
  }

  const newContent = [...beforeItems, ...recordLines].join("\n");

  if (dryRun) {
    console.log(`  ${entityId}: would migrate (${itemsSection.length} lines)`);
  } else {
    writeFileSync(filePath, newContent);
    console.log(`  ${entityId}: migrated (${itemsSection.length} lines)`);
  }

  return { changed: true, entityId };
}

// Main
console.log(`\nMigrating items → records${dryRun ? " (DRY RUN)" : ""}...\n`);

const files = globSync(join(DATA_DIR, "*.yaml")).sort();
let migrated = 0;

for (const file of files) {
  const entityId = basename(file, ".yaml");
  if (entityFilter && entityId !== entityFilter) continue;

  const result = processFile(file);
  if (result.changed) migrated++;
}

console.log(`\nDone: ${migrated} entities ${dryRun ? "would be " : ""}migrated.\n`);
