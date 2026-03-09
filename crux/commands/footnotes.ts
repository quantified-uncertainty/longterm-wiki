/**
 * Footnotes Command Handlers
 *
 * Migration tools for claim reference footnote markers in MDX files.
 *
 * Usage:
 *   crux footnotes migrate-cr                Dry-run: show what would change
 *   crux footnotes migrate-cr --apply        Apply changes to MDX files
 *   crux footnotes migrate-cr --page=<id>    Process a single page
 */

import { basename } from 'path';
import { readFileSync, writeFileSync } from 'fs';
import { CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { batchedRequest, isServerAvailable } from '../lib/wiki-server/client.ts';
import { normalizeUrlForDedup } from '../lib/footnote-parser.ts';
import { buildKBFactSourceMap, type KBFactMatch } from '../lib/kb-fact-lookup.ts';
import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';

// ── Types ─────────────────────────────────────────────────────────────

interface FootnotesCommandOptions extends BaseOptions {
  apply?: boolean;
  page?: string;
  ci?: boolean;
  dryRun?: boolean;
  'dry-run'?: boolean;
}

interface ClaimReference {
  claimId: number;
  claimText: string;
  verdict: string | null;
  referenceId: string | null;
}

interface PageCitation {
  referenceId: string;
  title: string | null;
  url: string | null;
  note: string | null;
  resourceId: string | null;
}

interface ReferencesAllResponse {
  pages: Record<string, {
    claimReferences: ClaimReference[];
    citations: PageCitation[];
  }>;
  totalPages: number;
  totalClaimRefs: number;
  totalCitations: number;
}

interface MigrationAction {
  /** Original cr- reference ID (e.g., "cr-abc1") */
  originalRef: string;
  /** New reference ID (e.g., "kb-f_abc123" or "rc-abc1") */
  newRef: string;
  /** Whether this was matched to a KB fact */
  matched: boolean;
  /** Description for display */
  description: string;
}

interface PageMigrationResult {
  slug: string;
  filePath: string;
  crRefCount: number;
  actions: MigrationAction[];
  written: boolean;
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Extract the page slug from an MDX file path.
 * e.g., content/docs/knowledge-base/organizations/anthropic.mdx → "anthropic"
 */
function getSlugFromPath(filePath: string): string {
  const ext = filePath.endsWith('.mdx') ? '.mdx' : '.md';
  return basename(filePath, ext);
}

/**
 * Find all [^cr-XXXX] inline references in MDX content.
 * Returns unique reference IDs (without the [^ ] wrapper).
 *
 * Matches [^cr-XXXX] but NOT [^cr-XXXX]: (definition lines).
 */
function findCrRefs(content: string): string[] {
  // Match [^cr-XXXX] that is NOT followed by a colon (definition)
  const re = /\[\^(cr-[a-f0-9]+)\](?!:)/g;
  const refs = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    refs.add(match[1]);
  }
  return [...refs];
}

/**
 * Find all existing [^rc-XXXX] reference IDs in content.
 * Matches hex chars plus any trailing 'x' disambiguators.
 * Used to prevent collisions when converting cr- to rc- refs.
 */
function findExistingRcRefs(content: string): Set<string> {
  const re = /\[\^(rc-[a-z0-9]+)\]/gi;
  const refs = new Set<string>();
  let match: RegExpExecArray | null;
  while ((match = re.exec(content)) !== null) {
    refs.add(match[1]);
  }
  return refs;
}

/**
 * Try to match a specific claim reference to a KB fact.
 *
 * Strategy: look up the claim's associated citation (same referenceId) to get
 * a source URL, then match that URL against KB fact sources. This ensures each
 * cr- ref is matched only to the KB fact for its own citation, not any
 * arbitrary citation on the page.
 *
 * Uses the shared buildKBFactSourceMap from kb-fact-lookup.ts (same normalization
 * and first-match semantics as the improve pipeline).
 */
function matchClaimToKBFact(
  claimRef: ClaimReference,
  citations: PageCitation[],
  kbSourceMap: Map<string, KBFactMatch>,
): string | null {
  if (kbSourceMap.size === 0) return null;

  // Find the citation with the same referenceId as this claim ref.
  // The claims API returns a referenceId that links to the citation in the same
  // footnote. Match that specific citation's URL against KB facts.
  if (claimRef.referenceId) {
    const associatedCitation = citations.find(c => c.referenceId === claimRef.referenceId);
    if (associatedCitation?.url) {
      const normalized = normalizeUrlForDedup(associatedCitation.url);
      const match = kbSourceMap.get(normalized);
      if (match) return match.factId;
    }
  }

  // No direct citation association — no match.
  // We intentionally do NOT fall back to matching any citation on the page,
  // as that would produce false positives (different claims mapped to the
  // same unrelated KB fact).
  return null;
}

/**
 * Apply migration actions to MDX content.
 * Replaces [^cr-XXXX] with the new reference in the content body.
 */
function applyMigrations(content: string, actions: MigrationAction[]): string {
  let result = content;
  for (const action of actions) {
    // Replace all inline occurrences of [^cr-XXXX] (not definition lines)
    // Use a regex that matches the full [^cr-XXXX] pattern but not [^cr-XXXX]:
    const escaped = action.originalRef.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`\\[\\^${escaped}\\](?!:)`, 'g');
    result = result.replace(re, `[^${action.newRef}]`);
  }
  return result;
}

// ── Main command ──────────────────────────────────────────────────────

async function migrateCrCommand(
  args: string[],
  options: FootnotesCommandOptions,
): Promise<CommandResult> {
  const apply = options.apply === true;
  const pageFilter = options.page as string | undefined;

  // 1. Check wiki-server availability
  const available = await isServerAvailable();
  if (!available) {
    return {
      exitCode: 1,
      output: 'Error: Wiki server is not reachable. Cannot fetch claim reference data.\n' +
        '  Set LONGTERMWIKI_SERVER_URL in your .env file.',
    };
  }

  // 2. Fetch all claim references from the wiki-server
  const refResult = await batchedRequest<ReferencesAllResponse>(
    'GET',
    '/api/references/all',
    undefined,
    30_000,
  );
  if (!refResult.ok) {
    return {
      exitCode: 1,
      output: `Error fetching references: ${refResult.message}`,
    };
  }
  const allRefs = refResult.data;

  // 3. Find all MDX files with [^cr-XXXX] markers
  const allMdxFiles = findMdxFiles(CONTENT_DIR_ABS);
  const filesWithCr: Array<{ filePath: string; slug: string; content: string; crRefs: string[] }> = [];

  for (const filePath of allMdxFiles) {
    const slug = getSlugFromPath(filePath);
    if (pageFilter && slug !== pageFilter) continue;

    const content = readFileSync(filePath, 'utf-8');
    const crRefs = findCrRefs(content);
    if (crRefs.length > 0) {
      filesWithCr.push({ filePath, slug, content, crRefs });
    }
  }

  if (filesWithCr.length === 0) {
    if (options.ci) {
      return {
        exitCode: 0,
        output: JSON.stringify({
          pages: [],
          summary: { totalCrRefs: 0, totalKbMatches: 0, totalRcConversions: 0, totalPages: 0 },
        }),
      };
    }
    const msg = pageFilter
      ? `No [^cr-] references found in page: ${pageFilter}`
      : 'No [^cr-] references found in any MDX files.';
    return { exitCode: 0, output: msg };
  }

  // 4. Process each file
  const results: PageMigrationResult[] = [];
  let totalCrRefs = 0;
  let totalKbMatches = 0;
  let totalRcConversions = 0;

  for (const { filePath, slug, content, crRefs } of filesWithCr) {
    // Get page's entity ID from the slug
    const entityId = slug;

    // Load KB fact source map for this entity (reuses shared kb-fact-lookup.ts)
    const kbSourceMap = await buildKBFactSourceMap(entityId);

    // Get claim references from the API for this page
    const pageData = allRefs.pages[slug];
    const claimRefs = pageData?.claimReferences ?? [];
    const citations = pageData?.citations ?? [];

    // Build referenceId → ClaimReference map
    const refIdToClaimRef = new Map<string, ClaimReference>();
    for (const cr of claimRefs) {
      if (cr.referenceId) {
        refIdToClaimRef.set(cr.referenceId, cr);
      }
    }

    // Collect existing rc- refs in the file to prevent collisions
    const existingRcRefs = findExistingRcRefs(content);
    // Also track new rc- refs we assign during this file
    const usedKbFactIds = new Set<string>();

    // Determine migration actions for each cr- ref
    const actions: MigrationAction[] = [];

    for (const crRef of crRefs) {
      const claimRef = refIdToClaimRef.get(crRef);

      // Try to match to a KB fact
      let kbFactId: string | null = null;
      if (claimRef && kbSourceMap.size > 0) {
        kbFactId = matchClaimToKBFact(claimRef, citations, kbSourceMap);
        // Prevent multiple cr- refs mapping to the same KB fact
        if (kbFactId && usedKbFactIds.has(kbFactId)) {
          kbFactId = null;
        }
      }

      if (kbFactId) {
        usedKbFactIds.add(kbFactId);
        actions.push({
          originalRef: crRef,
          newRef: `kb-${kbFactId}`,
          matched: true,
          description: claimRef
            ? `${claimRef.claimText.slice(0, 60)}...`
            : 'KB fact match',
        });
        totalKbMatches++;
      } else {
        // No match — convert cr- to rc-, checking for collisions
        const suffix = crRef.replace('cr-', '');
        let newRef = `rc-${suffix}`;
        while (existingRcRefs.has(newRef)) {
          newRef = `${newRef}x`;
        }
        existingRcRefs.add(newRef);
        actions.push({
          originalRef: crRef,
          newRef,
          matched: false,
          description: claimRef
            ? `${claimRef.claimText.slice(0, 60)}...`
            : 'no claim data in API',
        });
        totalRcConversions++;
      }
    }

    totalCrRefs += crRefs.length;

    // Apply changes if --apply
    let written = false;
    if (apply && actions.length > 0) {
      const newContent = applyMigrations(content, actions);
      if (newContent !== content) {
        writeFileSync(filePath, newContent, 'utf-8');
        written = true;
      }
    }

    results.push({
      slug,
      filePath,
      crRefCount: crRefs.length,
      actions,
      written,
    });
  }

  // 5. Format output
  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        pages: results.map(r => ({
          slug: r.slug,
          crRefCount: r.crRefCount,
          kbMatches: r.actions.filter(a => a.matched).length,
          rcConversions: r.actions.filter(a => !a.matched).length,
          written: r.written,
        })),
        summary: {
          totalCrRefs,
          totalKbMatches,
          totalRcConversions,
          totalPages: results.length,
        },
      }),
    };
  }

  const lines: string[] = [];

  for (const result of results) {
    const countLabel = `${result.crRefCount} cr-ref${result.crRefCount === 1 ? '' : 's'}`;
    const writeStatus = result.written ? ' \x1b[32m(written)\x1b[0m' : '';
    lines.push(`\x1b[1mPage: ${result.slug}\x1b[0m (${countLabel})${writeStatus}`);

    for (const action of result.actions) {
      const arrow = `[^${action.originalRef}] \u2192 [^${action.newRef}]`;
      const tag = action.matched
        ? '\x1b[32mKB\x1b[0m'
        : '\x1b[33mrc\x1b[0m';
      // Truncate description to fit on one line
      const desc = action.description.length > 50
        ? action.description.slice(0, 50) + '...'
        : action.description;
      lines.push(`  ${arrow}  (${tag}: ${desc})`);
    }
    lines.push('');
  }

  // Summary
  lines.push('\x1b[1mSummary:\x1b[0m');
  lines.push(`  ${totalCrRefs} cr-refs across ${results.length} page${results.length === 1 ? '' : 's'}`);
  lines.push(`  \x1b[32m\u2192 ${totalKbMatches} can migrate to [^kb-factId]\x1b[0m`);
  lines.push(`  \x1b[33m\u2192 ${totalRcConversions} will become [^rc-XXXX]\x1b[0m`);

  if (!apply) {
    lines.push('');
    lines.push('\x1b[2mDry run — no files modified. Use --apply to write changes.\x1b[0m');
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Exports ───────────────────────────────────────────────────────────

export const commands = {
  'migrate-cr': migrateCrCommand,
  default: migrateCrCommand,
};

export function getHelp(): string {
  return `
Footnotes Domain — Migration tools for claim reference footnote markers

Commands:
  migrate-cr     Migrate [^cr-XXXX] markers to [^kb-factId] or [^rc-XXXX]

Options:
  --apply         Write changes to MDX files (default: dry-run)
  --page=<id>     Only process a specific page (by slug)
  --ci            JSON output

How it works:
  1. Scans all MDX files for [^cr-XXXX] inline references
  2. Fetches claim reference data from the wiki-server (/api/references/all)
  3. For each page, loads KB facts from packages/kb/data/things/{entityId}.yaml
  4. Tries to match claims to KB facts by source URL
  5. If KB match found: converts [^cr-XXXX] to [^kb-{factId}]
  6. If no match: converts [^cr-XXXX] to [^rc-XXXX] (plain citation ref)

The command is idempotent — running it twice won't double-convert.

Examples:
  crux footnotes migrate-cr                  Preview all changes (dry run)
  crux footnotes migrate-cr --page=anthropic Preview changes for one page
  crux footnotes migrate-cr --apply          Apply changes to all files
  crux footnotes migrate-cr --ci             JSON output for scripting
`;
}
