#!/usr/bin/env node
/**
 * migrate-session-logs.mjs
 *
 * Converts .claude/sessions/*.md session log files to the new YAML format.
 *
 * Usage:
 *   node scripts/migrate-session-logs.mjs            # Preview (dry run)
 *   node scripts/migrate-session-logs.mjs --apply    # Write .yaml and delete .md files
 *   node scripts/migrate-session-logs.mjs --apply --keep-md  # Write .yaml but keep .md files
 */

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'fs';
import { join, basename } from 'path';
import { fileURLToPath } from 'url';
import { stringify as yamlStringify } from 'yaml';

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const KEEP_MD = args.includes('--keep-md');
const DRY_RUN = !APPLY;

const SESSIONS_DIR = join(fileURLToPath(import.meta.url), '../../.claude/sessions');

const HEADING_RE = /^## (\d{4}-\d{2}-\d{2}) \| ([^\|]+?) \| (.+)$/;
const PAGE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Extract a markdown bold field value from the session body.
 * e.g. **What was done:** Some text...
 */
function extractField(body, fieldName) {
  const escaped = fieldName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`\\*\\*${escaped}:\\*\\*\\s*(.+?)(?=\\n\\*\\*|\\n---\\s*$|$)`, 's');
  const match = body.match(re);
  return match ? match[1].trim() : null;
}

/**
 * Extract bullet list items from a field value like:
 *   - Item 1
 *   - Item 2
 * Returns an array of strings (without the leading "- ").
 */
function extractBulletList(text) {
  if (!text) return [];
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('- '))
    .map(line => line.slice(2).trim())
    .filter(line => line.length > 0 && line.toLowerCase() !== 'none');
}

/**
 * Parse a single markdown session log file into structured data.
 */
function parseMdFile(content) {
  const lines = content.split('\n');
  const headingLine = lines[0];
  const headingMatch = headingLine?.match(HEADING_RE);

  if (!headingMatch) {
    return null; // Not a valid session log
  }

  const date = headingMatch[1];
  const branch = headingMatch[2].trim();
  const title = headingMatch[3].trim();
  const body = lines.slice(1).join('\n');

  // Summary
  const summary = extractField(body, 'What was done') ?? '';

  // Pages — convert to array of valid slugs
  const pagesRaw = extractField(body, 'Pages');
  let pages = [];
  if (pagesRaw && !/^\(.*\)$/.test(pagesRaw) && pagesRaw.toLowerCase() !== 'none') {
    pages = pagesRaw
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0 && PAGE_ID_RE.test(id));
  }

  // PR — extract number
  const prRaw = extractField(body, 'PR');
  let pr;
  if (prRaw) {
    const numMatch = prRaw.match(/^#(\d+)$/) || prRaw.match(/\/pull\/(\d+)/);
    if (numMatch) pr = parseInt(numMatch[1], 10);
  }

  // Optional metadata
  const model = extractField(body, 'Model') ?? undefined;
  const duration = extractField(body, 'Duration') ?? undefined;
  const cost = extractField(body, 'Cost') ?? undefined;

  // Issues encountered, Learnings/notes, Recommendations
  const issuesRaw = extractField(body, 'Issues encountered');
  const issues = extractBulletList(issuesRaw);

  const learningsRaw = extractField(body, 'Learnings/notes');
  const learnings = extractBulletList(learningsRaw);

  const recommendationsRaw = extractField(body, 'Recommendations');
  const recommendations = extractBulletList(recommendationsRaw);

  // Build structured object — preserve field order
  const entry = {
    date,
    branch,
    title,
    model,
    duration,
    ...(cost !== undefined && { cost }),
    pages,
    summary,
    ...(pr !== undefined && { pr }),
    ...(issues.length > 0 && { issues }),
    ...(learnings.length > 0 && { learnings }),
    ...(recommendations.length > 0 && { recommendations }),
  };

  // Remove undefined keys
  for (const key of Object.keys(entry)) {
    if (entry[key] === undefined) delete entry[key];
  }

  return entry;
}

/**
 * Convert parsed entry to YAML string.
 */
function toYaml(entry) {
  return yamlStringify(entry, {
    lineWidth: 0, // Don't auto-wrap long lines
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  });
}

function main() {
  if (!existsSync(SESSIONS_DIR)) {
    console.error(`Sessions directory not found: ${SESSIONS_DIR}`);
    process.exit(1);
  }

  const files = readdirSync(SESSIONS_DIR)
    .filter(f => f.endsWith('.md'))
    .sort();

  if (files.length === 0) {
    console.log('No .md session files found to migrate.');
    return;
  }

  console.log(`Found ${files.length} .md session files`);
  if (DRY_RUN) console.log('(Dry run — use --apply to write files)\n');

  let converted = 0;
  let skipped = 0;
  let failed = 0;

  for (const file of files) {
    const mdPath = join(SESSIONS_DIR, file);
    const yamlFile = file.replace(/\.md$/, '.yaml');
    const yamlPath = join(SESSIONS_DIR, yamlFile);

    const content = readFileSync(mdPath, 'utf-8');
    const entry = parseMdFile(content);

    if (!entry) {
      console.log(`  SKIP  ${file} — no valid heading found`);
      skipped++;
      continue;
    }

    const yamlContent = toYaml(entry);

    if (DRY_RUN) {
      console.log(`  WOULD CONVERT  ${file} → ${yamlFile}`);
      console.log(`    pages: [${entry.pages?.join(', ') || ''}]`);
      converted++;
    } else {
      if (existsSync(yamlPath)) {
        console.log(`  SKIP  ${file} — ${yamlFile} already exists`);
        skipped++;
        continue;
      }
      try {
        writeFileSync(yamlPath, yamlContent, 'utf-8');
        if (!KEEP_MD) {
          unlinkSync(mdPath);
          console.log(`  ✓  ${file} → ${yamlFile} (md deleted)`);
        } else {
          console.log(`  ✓  ${file} → ${yamlFile} (md kept)`);
        }
        converted++;
      } catch (err) {
        console.error(`  ERROR  ${file}: ${err.message}`);
        failed++;
      }
    }
  }

  console.log(`\nDone: ${converted} converted, ${skipped} skipped, ${failed} failed`);
  if (DRY_RUN && converted > 0) {
    console.log('\nRun with --apply to perform the migration.');
  }
}

main();
