#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Triage raw [^N]: footnotes across content/docs.
 *
 * Classifies each file with raw numeric footnotes into two buckets:
 *   - url-bearing: every [^N]: definition contains a retrievable URL
 *   - mixed/placeholder: at least one [^N]: definition has no URL (a placeholder)
 *
 * Modes:
 *   --report       (default) list stats and per-file classification; no writes
 *   --convert      run convertNewFootnotes on url-bearing files; writes files + DB
 *   --strip        strip URL-less (placeholder) footnotes from all files that have any
 *   --strip --only-mixed
 *                  strip placeholders ONLY in files that also have url-bearing
 *                  footnotes (so a follow-up --convert can finish the job cleanly)
 *
 * Does NOT run LLM research. For placeholder footnotes that need real sourcing,
 * use `crux w improve --tier=deep --apply` (without --engine=v2).
 *
 * Usage:
 *   pnpm tsx crux/scripts/triage-footnotes.ts --report
 *   WIKI_SERVER_ENV=prod pnpm tsx crux/scripts/triage-footnotes.ts --convert
 *   pnpm tsx crux/scripts/triage-footnotes.ts --strip
 */

import fs from 'fs';
import path from 'path';
import matter from 'gray-matter';
import { parseFootnotes, type ParsedFootnote } from '../lib/footnote-parser.ts';
import {
  convertNewFootnotes,
  createDbEntriesForRcFootnotes,
} from '../lib/convert-new-footnotes.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTENT_DIR = path.join(ROOT, 'content/docs');

function walkMdxFiles(dir: string): string[] {
  const results: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkMdxFiles(fullPath));
    } else if (entry.name.endsWith('.mdx')) {
      results.push(fullPath);
    }
  }
  return results;
}

interface FileTriage {
  relPath: string;
  pageId: string;
  entitySlug: string | null;
  raw: ParsedFootnote[];
  urlBearing: ParsedFootnote[];
  placeholders: ParsedFootnote[];
  allUrlBearing: boolean;
}

function scanFile(filePath: string): FileTriage | null {
  const content = fs.readFileSync(filePath, 'utf-8');
  const parsed = matter(content);
  const raw = parseFootnotes(parsed.content);
  if (raw.length === 0) return null;

  const urlBearing = raw.filter((f) => f.url);
  const placeholders = raw.filter((f) => !f.url);

  const fm = parsed.data as { wikiId?: string; id?: string };
  const pageId =
    fm.wikiId || fm.id || path.basename(filePath, '.mdx');
  const entitySlug = fm.id ?? path.basename(filePath, '.mdx');

  return {
    relPath: path.relative(process.cwd(), filePath),
    pageId,
    entitySlug,
    raw,
    urlBearing,
    placeholders,
    allUrlBearing: placeholders.length === 0,
  };
}

function stripPlaceholderFootnotes(content: string, numbers: number[]): string {
  let modified = content;
  const sorted = [...numbers].sort((a, b) => b - a);
  for (const n of sorted) {
    // Strip inline refs: [^N] (but not definition lines)
    const inline = new RegExp(`\\[\\^${n}\\](?!:)`, 'g');
    modified = modified.replace(inline, '');
    // Strip definition line (and any trailing blank line it owns)
    const def = new RegExp(`^\\[\\^${n}\\]:[^\\n]*\\n?`, 'gm');
    modified = modified.replace(def, '');
  }
  return modified;
}

function formatReport(triages: FileTriage[]): void {
  const urlOnly = triages.filter((t) => t.allUrlBearing);
  const mixed = triages.filter((t) => !t.allUrlBearing && t.urlBearing.length > 0);
  const placeholderOnly = triages.filter((t) => t.urlBearing.length === 0);

  const totalRaw = triages.reduce((s, t) => s + t.raw.length, 0);
  const totalUrlBearing = triages.reduce((s, t) => s + t.urlBearing.length, 0);
  const totalPlaceholders = triages.reduce((s, t) => s + t.placeholders.length, 0);

  console.log(`\n=== Raw footnote triage ===\n`);
  console.log(`Files with raw [^N]: footnotes:  ${triages.length}`);
  console.log(`Total raw footnotes:             ${totalRaw}`);
  console.log(`  url-bearing (auto-convertible): ${totalUrlBearing}`);
  console.log(`  placeholders (need LLM/strip):  ${totalPlaceholders}`);
  console.log();
  console.log(`Files fully url-bearing (safe to auto-convert): ${urlOnly.length}`);
  console.log(`Files with mixed URL+placeholder footnotes:    ${mixed.length}`);
  console.log(`Files with only placeholders:                  ${placeholderOnly.length}`);

  if (urlOnly.length > 0) {
    console.log(`\n--- Fully url-bearing files (first 20) ---`);
    for (const t of urlOnly.slice(0, 20)) {
      console.log(`  ${t.relPath}  (${t.raw.length} footnotes)`);
    }
    if (urlOnly.length > 20) console.log(`  … and ${urlOnly.length - 20} more`);
  }

  if (placeholderOnly.length > 0) {
    console.log(`\n--- Placeholder-only files (first 20) ---`);
    for (const t of placeholderOnly.slice(0, 20)) {
      console.log(`  ${t.relPath}  (${t.raw.length} placeholders)`);
    }
    if (placeholderOnly.length > 20) console.log(`  … and ${placeholderOnly.length - 20} more`);
  }

  if (mixed.length > 0) {
    console.log(`\n--- Mixed files (first 10) ---`);
    for (const t of mixed.slice(0, 10)) {
      console.log(
        `  ${t.relPath}  (${t.urlBearing.length} url / ${t.placeholders.length} placeholder)`,
      );
    }
    if (mixed.length > 10) console.log(`  … and ${mixed.length - 10} more`);
  }
}

async function runConvert(triages: FileTriage[]): Promise<void> {
  const convertible = triages.filter((t) => t.allUrlBearing);
  console.log(`\nConverting ${convertible.length} files (url-bearing only)...\n`);

  let filesChanged = 0;
  let footnotesConverted = 0;
  let dbCreates = 0;
  let failures = 0;

  for (const t of convertible) {
    try {
      const abs = path.resolve(t.relPath);
      const content = fs.readFileSync(abs, 'utf-8');
      const result = await convertNewFootnotes(content, t.pageId, {
        createDbEntries: true,
        entityId: t.entitySlug ?? undefined,
      });
      if (result.convertedCount > 0 && result.content !== content) {
        fs.writeFileSync(abs, result.content);
        filesChanged++;
        footnotesConverted += result.convertedCount;
        if (result.dbEntriesCreated) dbCreates++;
        console.log(
          `  ✓ ${t.relPath}  (${result.convertedCount} → ${result.kbMatchCount} kb, ${result.convertedCount - result.kbMatchCount} rc)`,
        );
      } else {
        console.log(`  – ${t.relPath}  (no change)`);
      }
    } catch (err: unknown) {
      failures++;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ✗ ${t.relPath}  failed: ${msg}`);
    }
  }

  console.log(`\nFiles changed:        ${filesChanged}`);
  console.log(`Footnotes converted:  ${footnotesConverted}`);
  console.log(`DB create batches OK: ${dbCreates}`);
  if (failures > 0) console.log(`Failures:             ${failures}`);
}

function runStrip(triages: FileTriage[], onlyMixed: boolean): void {
  // Mixed = file has BOTH url-bearing and placeholder footnotes. Stripping the
  // placeholders leaves the url-bearing ones intact, so a follow-up --convert
  // can promote the file to fully-sourced [^rc-XXXX] form.
  const stripTargets = triages.filter((t) =>
    onlyMixed
      ? t.placeholders.length > 0 && t.urlBearing.length > 0
      : t.placeholders.length > 0,
  );
  const label = onlyMixed ? 'mixed files' : 'all files with placeholders';
  console.log(`\nStripping placeholders in ${stripTargets.length} ${label}...\n`);

  let filesChanged = 0;
  let footnotesStripped = 0;

  for (const t of stripTargets) {
    const abs = path.resolve(t.relPath);
    const content = fs.readFileSync(abs, 'utf-8');
    const phNumbers = t.placeholders.map((p) => p.number);
    const modified = stripPlaceholderFootnotes(content, phNumbers);
    if (modified !== content) {
      fs.writeFileSync(abs, modified);
      filesChanged++;
      footnotesStripped += phNumbers.length;
      console.log(`  ✓ ${t.relPath}  (stripped ${phNumbers.length})`);
    }
  }

  console.log(`\nFiles changed:        ${filesChanged}`);
  console.log(`Footnotes stripped:   ${footnotesStripped}`);
}

async function runDbBackfill(): Promise<void> {
  const files = walkMdxFiles(CONTENT_DIR);
  let filesProcessed = 0;
  let totalCreated = 0;
  for (const f of files) {
    const content = fs.readFileSync(f, 'utf-8');
    if (!/\[\^rc-/.test(content)) continue;
    const parsed = matter(content);
    const fm = parsed.data as { wikiId?: string; id?: string };
    const pageId = fm.wikiId || fm.id || path.basename(f, '.mdx');
    const created = await createDbEntriesForRcFootnotes(content, pageId);
    if (created > 0) {
      filesProcessed++;
      totalCreated += created;
      console.log(`  ✓ ${path.relative(process.cwd(), f)}: ${created} citations`);
    }
  }
  console.log(`\nDB backfill: ${totalCreated} citations across ${filesProcessed} files`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode: 'report' | 'convert' | 'strip' | 'db-backfill' = args.includes('--convert')
    ? 'convert'
    : args.includes('--strip')
      ? 'strip'
      : args.includes('--db-backfill')
        ? 'db-backfill'
        : 'report';

  if (mode === 'db-backfill') {
    await runDbBackfill();
    return;
  }

  const files = walkMdxFiles(CONTENT_DIR);
  const triages: FileTriage[] = [];
  for (const f of files) {
    const t = scanFile(f);
    if (t) triages.push(t);
  }

  formatReport(triages);

  if (mode === 'convert') {
    await runConvert(triages);
  } else if (mode === 'strip') {
    runStrip(triages, args.includes('--only-mixed'));
  } else {
    console.log(`\n(report mode — no files written. Use --convert or --strip to apply.)`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
