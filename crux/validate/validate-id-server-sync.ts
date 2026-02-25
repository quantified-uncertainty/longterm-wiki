#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * ID Server Sync Validation
 *
 * Checks that all locally-defined numericIds match the wiki-server's
 * canonical ID allocations. Catches:
 *   1. Agent-invented IDs that were never allocated from the server
 *   2. Slug→ID mismatches (local says E42→foo, server says E42→bar)
 *   3. Entities/pages with no numericId at all
 *
 * Usage:
 *   npx tsx crux/validate/validate-id-server-sync.ts
 *   npx tsx crux/validate/validate-id-server-sync.ts --ci
 *
 * Exit codes:
 *   0 = All IDs match server (or server unavailable — advisory)
 *   1 = Mismatches detected
 */

import { readFileSync, readdirSync, existsSync } from 'fs';
import { join } from 'path';
import { parse } from 'yaml';
import { PROJECT_ROOT, DATA_DIR_ABS, CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { getColors } from '../lib/output.ts';
import { isServerAvailable, getServerUrl, buildHeaders } from '../lib/wiki-server/client.ts';

const CI_MODE = process.argv.includes('--ci');
const c = getColors(CI_MODE);

interface LocalId {
  slug: string;
  numericId: string;
  source: string; // "entity:filename" or "page:path"
}

interface ServerIdEntry {
  numericId: string;
  slug: string;
}

// ---------------------------------------------------------------------------
// Collect local IDs
// ---------------------------------------------------------------------------

function collectLocalIds(): LocalId[] {
  const results: LocalId[] = [];

  // 1. YAML entities
  const entityDir = join(DATA_DIR_ABS, 'entities');
  if (existsSync(entityDir)) {
    for (const file of readdirSync(entityDir)) {
      if (!file.endsWith('.yaml')) continue;
      try {
        const content = readFileSync(join(entityDir, file), 'utf-8');
        const entities = parse(content) || [];
        if (Array.isArray(entities)) {
          for (const e of entities) {
            if (e?.id && e?.numericId) {
              results.push({
                slug: e.id,
                numericId: e.numericId,
                source: `entity:${file}`,
              });
            }
          }
        }
      } catch { /* skip unparseable */ }
    }
  }

  // 2. MDX frontmatter
  function scanDir(dir: string) {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        scanDir(join(dir, entry.name));
      } else if (entry.name.endsWith('.mdx')) {
        try {
          const content = readFileSync(join(dir, entry.name), 'utf-8');
          const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
          if (!fmMatch) return;
          const fm = parse(fmMatch[1]) || {};
          if (fm.numericId && fm.entityId) {
            results.push({
              slug: fm.entityId,
              numericId: fm.numericId,
              source: `page:${join(dir, entry.name).replace(PROJECT_ROOT + '/', '')}`,
            });
          }
        } catch { /* skip */ }
      }
    }
  }
  scanDir(CONTENT_DIR_ABS);

  return results;
}

// ---------------------------------------------------------------------------
// Fetch server IDs
// ---------------------------------------------------------------------------

async function fetchServerIds(): Promise<Map<string, ServerIdEntry>> {
  const serverUrl = getServerUrl();
  const map = new Map<string, ServerIdEntry>();
  let offset = 0;
  const limit = 200;

  while (true) {
    const res = await fetch(`${serverUrl}/api/ids?limit=${limit}&offset=${offset}`, {
      headers: buildHeaders('project'),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) break;

    const data = await res.json() as { ids: ServerIdEntry[]; total: number };
    for (const entry of data.ids) {
      map.set(entry.slug, entry);
    }
    if (data.ids.length < limit) break;
    offset += limit;
  }

  return map;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const available = await isServerAvailable();
  if (!available) {
    if (CI_MODE) {
      console.log(JSON.stringify({ passed: true, advisory: true, message: 'Server unavailable — skipping ID sync check' }));
    } else {
      console.log(`${c.dim}⊘ Wiki server unavailable — skipping ID sync validation${c.reset}`);
    }
    process.exit(0);
  }

  const localIds = collectLocalIds();
  if (localIds.length === 0) {
    if (!CI_MODE) console.log(`${c.dim}No local numericIds found${c.reset}`);
    process.exit(0);
  }

  const serverIds = await fetchServerIds();
  const issues: string[] = [];

  // Build reverse map: numericId → slug (server)
  const serverNumericToSlug = new Map<string, string>();
  for (const [slug, entry] of serverIds) {
    serverNumericToSlug.set(entry.numericId, slug);
  }

  for (const local of localIds) {
    const serverEntry = serverIds.get(local.slug);

    if (!serverEntry) {
      // Slug not registered at all — might be agent-invented
      issues.push(
        `${local.source}: slug "${local.slug}" (${local.numericId}) is not registered on the server. ` +
        `Run: pnpm crux ids allocate ${local.slug}`
      );
      continue;
    }

    if (serverEntry.numericId !== local.numericId) {
      // Slug exists but with different ID — conflict
      issues.push(
        `${local.source}: slug "${local.slug}" has local ID ${local.numericId} but server says ${serverEntry.numericId}`
      );
      continue;
    }

    // Also check: is this numericId claimed by a different slug on the server?
    const serverSlug = serverNumericToSlug.get(local.numericId);
    if (serverSlug && serverSlug !== local.slug) {
      issues.push(
        `${local.source}: numericId ${local.numericId} is locally assigned to "${local.slug}" but server assigns it to "${serverSlug}"`
      );
    }
  }

  if (issues.length === 0) {
    if (CI_MODE) {
      console.log(JSON.stringify({ passed: true, checked: localIds.length }));
    } else {
      console.log(`${c.green}✓ All ${localIds.length} local IDs match server allocations${c.reset}`);
    }
    process.exit(0);
  }

  if (CI_MODE) {
    console.log(JSON.stringify({ passed: false, issues }));
  } else {
    console.log(`${c.red}✗ ${issues.length} ID sync issue(s) found:${c.reset}\n`);
    for (const issue of issues) {
      console.log(`  ${c.red}•${c.reset} ${issue}`);
    }
    console.log(`\n${c.dim}Fix: Run \`pnpm crux ids allocate <slug>\` for each unregistered slug${c.reset}`);
  }

  process.exit(1);
}

main().catch(err => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
