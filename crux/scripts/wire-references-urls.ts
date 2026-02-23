#!/usr/bin/env -S node --import tsx/esm
/**
 * Wire References via URL matching (Phase 3).
 *
 * Runs the enrichReferences module (with URL matching) to update existing
 * References blocks and add new ones where footnote/markdown URLs match
 * the resource catalog.
 *
 * Usage:
 *   npx tsx crux/scripts/wire-references-urls.ts                # Dry run
 *   npx tsx crux/scripts/wire-references-urls.ts --apply        # Write changes
 */

import fs from 'fs';
import path from 'path';
import { enrichReferences } from '../enrich/enrich-references.ts';

const ROOT = path.resolve(import.meta.dirname, '../..');
const CONTENT_DIR = path.join(ROOT, 'content/docs');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const VERBOSE = args.includes('--verbose');

function getAllMdxFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...getAllMdxFiles(fullPath));
    } else if (entry.name.endsWith('.mdx')) {
      results.push(fullPath);
    }
  }
  return results;
}

function main() {
  console.log(APPLY ? '🔧 APPLY mode — writing changes' : '📋 DRY RUN — no files will be modified');
  console.log();

  const mdxFiles = getAllMdxFiles(CONTENT_DIR);
  console.log(`Scanning ${mdxFiles.length} MDX files...`);
  console.log();

  let addedCount = 0;
  let updatedCount = 0;
  let unchangedCount = 0;
  let noneCount = 0;
  let totalNewUrlMatches = 0;
  const newlyWired: { slug: string; refCount: number; urlMatches: number }[] = [];
  const updatedPages: { slug: string; refCount: number; newUrlMatches: number }[] = [];

  for (const filePath of mdxFiles) {
    const content = fs.readFileSync(filePath, 'utf-8');
    const relPath = path.relative(CONTENT_DIR, filePath).replace(/\.mdx$/, '');
    const parts = relPath.split('/');
    const slug = parts[parts.length - 1];

    const result = enrichReferences(content, { pageId: slug, root: ROOT });

    switch (result.action) {
      case 'none':
        noneCount++;
        break;
      case 'unchanged':
        unchangedCount++;
        break;
      case 'added': {
        addedCount++;
        const urlMatches = result.sources?.urlMatch ?? 0;
        totalNewUrlMatches += urlMatches;
        newlyWired.push({ slug, refCount: result.refCount, urlMatches });
        if (VERBOSE) {
          console.log(`  ADD: ${slug} (${result.refCount} refs, ${urlMatches} from URL matching)`);
        }
        if (APPLY) {
          fs.writeFileSync(filePath, result.content);
        }
        break;
      }
      case 'updated': {
        updatedCount++;
        const newUrlMatches = result.sources?.urlMatch ?? 0;
        totalNewUrlMatches += newUrlMatches;
        updatedPages.push({ slug, refCount: result.refCount, newUrlMatches });
        if (VERBOSE) {
          console.log(`  UPD: ${slug} (${result.refCount} refs, +${newUrlMatches} from URL matching)`);
        }
        if (APPLY) {
          fs.writeFileSync(filePath, result.content);
        }
        break;
      }
    }
  }

  // Summary
  console.log('─'.repeat(60));
  console.log('Results:');
  console.log(`  Newly wired:        ${addedCount} pages`);
  console.log(`  Updated:            ${updatedCount} pages`);
  console.log(`  Unchanged:          ${unchangedCount} pages`);
  console.log(`  No resources:       ${noneCount} pages`);
  console.log(`  New URL matches:    ${totalNewUrlMatches} resources total`);
  console.log();

  if (newlyWired.length > 0) {
    console.log('Newly wired pages (from URL matching):');
    const withUrls = newlyWired.filter(p => p.urlMatches > 0).sort((a, b) => b.urlMatches - a.urlMatches);
    for (const p of withUrls.slice(0, 15)) {
      console.log(`  ${p.urlMatches.toString().padStart(3)} URL matches  ${p.slug} (${p.refCount} total)`);
    }
    if (withUrls.length > 15) console.log(`  ... and ${withUrls.length - 15} more`);
    console.log();
  }

  if (updatedPages.length > 0 && updatedPages.some(p => p.newUrlMatches > 0)) {
    console.log('Pages with new URL-matched resources (updating existing References):');
    const withNew = updatedPages.filter(p => p.newUrlMatches > 0).sort((a, b) => b.newUrlMatches - a.newUrlMatches);
    for (const p of withNew.slice(0, 15)) {
      console.log(`  +${p.newUrlMatches.toString().padStart(2)} refs  ${p.slug} (${p.refCount} total)`);
    }
    if (withNew.length > 15) console.log(`  ... and ${withNew.length - 15} more`);
  }

  if (!APPLY && (addedCount + updatedCount) > 0) {
    console.log();
    console.log(`Run with --apply to write changes.`);
  }
}

main();
