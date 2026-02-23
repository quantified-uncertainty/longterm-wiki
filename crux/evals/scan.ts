/**
 * Batch Scanner — Run hunting agents across many pages
 *
 * Scans wiki pages with adversarial agents and produces a structured
 * manifest of findings, suitable for feeding into the improve pipeline
 * as targeted directions.
 *
 * Usage:
 *   import { scanPages } from './scan.ts';
 *   const result = await scanPages({ agents: ['reference-sniffer'], pages: 'high-risk' });
 *
 * CLI: pnpm crux evals scan [options]
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { AdversarialFinding } from './types.ts';
import { extractClaims, sniffPage } from './agents/reference-sniffer.ts';
import { auditPageDescriptions } from './agents/description-auditor.ts';
import { checkCrossReferences } from './agents/cross-reference-checker.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { parseFrontmatter } from '../lib/mdx-utils.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AgentName = 'reference-sniffer' | 'description-auditor' | 'cross-ref';
export type PageFilter = 'all' | 'high-risk' | 'zero-citations' | string[];

export interface ScanOptions {
  agents: AgentName[];
  pages: PageFilter;
  useLlm?: boolean;
  limit?: number;
  /** Output path for manifest JSON (default: .claude/temp/scan-manifest.json) */
  output?: string;
  verbose?: boolean;
}

export interface PageScanResult {
  pageId: string;
  entityType?: string;
  wordCount: number;
  citationCount: number;
  claimCount: number;
  uncitedClaimCount: number;
  findings: AdversarialFinding[];
  /** Per-agent summary counts */
  agentSummary: Record<string, { total: number; critical: number; warning: number }>;
}

export interface ScanManifest {
  /** When this scan was run */
  scannedAt: string;
  /** Which agents were used */
  agents: AgentName[];
  /** Whether LLM was used */
  usedLlm: boolean;
  /** Total pages scanned */
  pagesScanned: number;
  /** Total findings across all pages */
  totalFindings: number;
  /** Per-page results, sorted by uncited claim count (descending) */
  pages: PageScanResult[];
  /** Cross-reference contradictions (from cross-ref agent) */
  crossRefContradictions: AdversarialFinding[];
  /** Duration in ms */
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Page loading
// ---------------------------------------------------------------------------

interface LoadedPage {
  id: string;
  content: string;
  entityType?: string;
  quality?: number;
  citationCount: number;
}

async function loadContentPages(filter: PageFilter, limit?: number): Promise<LoadedPage[]> {
  const contentDir = join(process.cwd(), 'content/docs/knowledge-base');
  const pages: LoadedPage[] = [];

  async function scanDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (limit && pages.length >= limit) return;

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.name.endsWith('.mdx')) {
          const id = basename(entry.name, '.mdx');
          const content = await readFile(fullPath, 'utf-8');
          const fm = parseFrontmatter(content);

          const footnoteRefs = content.match(/\[\^\d+\]/g) || [];
          const citationCount = new Set(footnoteRefs.map(r => r)).size;

          pages.push({
            id,
            content,
            entityType: fm.entityType as string | undefined,
            quality: fm.quality as number | undefined,
            citationCount,
          });
        }
      }
    } catch {
      // Skip unreadable directories
    }
  }

  await scanDir(contentDir);

  // Apply filter
  if (Array.isArray(filter)) {
    const idSet = new Set(filter);
    return pages.filter(p => idSet.has(p.id));
  }

  if (filter === 'high-risk') {
    // High-risk heuristic: zero citations + biographical types + >300 words
    return pages.filter(p => {
      const wordCount = p.content.split(/\s+/).length;
      const isBiographical = ['person', 'organization', 'funder'].includes(p.entityType || '');
      const zeroCitations = p.citationCount === 0;
      const lowQuality = (p.quality ?? 100) < 50;
      return (zeroCitations && wordCount > 300) || (isBiographical && zeroCitations) || lowQuality;
    });
  }

  if (filter === 'zero-citations') {
    return pages.filter(p => p.citationCount === 0 && p.content.split(/\s+/).length > 300);
  }

  return pages; // 'all'
}

// ---------------------------------------------------------------------------
// Core scan logic
// ---------------------------------------------------------------------------

export async function scanPages(options: ScanOptions): Promise<ScanManifest> {
  const startTime = Date.now();
  const useLlm = options.useLlm ?? false;
  const verbose = options.verbose ?? false;

  if (verbose) console.log(`[scan] Loading pages (filter: ${Array.isArray(options.pages) ? `${options.pages.length} specific` : options.pages})...`);

  const loadedPages = await loadContentPages(options.pages, options.limit);
  if (verbose) console.log(`[scan] Loaded ${loadedPages.length} pages`);

  const results: PageScanResult[] = [];
  let allCrossRefFindings: AdversarialFinding[] = [];

  // Run per-page agents
  const perPageAgents = options.agents.filter(a => a !== 'cross-ref');

  for (let i = 0; i < loadedPages.length; i++) {
    const page = loadedPages[i];
    if (verbose) console.log(`[scan] [${i + 1}/${loadedPages.length}] ${page.id}`);

    const findings: AdversarialFinding[] = [];
    const agentSummary: Record<string, { total: number; critical: number; warning: number }> = {};

    // Extract claims (always — it's free and gives us the uncited count)
    const claims = extractClaims(page.content);
    const uncitedClaims = claims.filter(c =>
      !c.hasAnyCitation &&
      (/\b\d{4}\b/.test(c.claim) || /\$[\d,.]+/.test(c.claim) || /\d+%/.test(c.claim))
    );

    for (const agent of perPageAgents) {
      try {
        let agentFindings: AdversarialFinding[] = [];

        if (agent === 'reference-sniffer') {
          agentFindings = await sniffPage(page.id, page.content, { useLlm });
        } else if (agent === 'description-auditor') {
          agentFindings = await auditPageDescriptions(page.id, page.content, { useLlm });
        }

        findings.push(...agentFindings);
        agentSummary[agent] = {
          total: agentFindings.length,
          critical: agentFindings.filter(f => f.severity === 'critical').length,
          warning: agentFindings.filter(f => f.severity === 'warning').length,
        };
      } catch (err) {
        if (verbose) console.warn(`[scan] Agent ${agent} failed on ${page.id}: ${(err as Error).message}`);
        agentSummary[agent] = { total: 0, critical: 0, warning: 0 };
      }
    }

    const wordCount = stripFrontmatter(page.content).split(/\s+/).length;

    results.push({
      pageId: page.id,
      entityType: page.entityType,
      wordCount,
      citationCount: page.citationCount,
      claimCount: claims.length,
      uncitedClaimCount: uncitedClaims.length,
      findings,
      agentSummary,
    });
  }

  // Run cross-ref agent (needs all pages together)
  if (options.agents.includes('cross-ref')) {
    if (verbose) console.log(`[scan] Running cross-reference checker across ${loadedPages.length} pages...`);
    try {
      const pagesForCrossRef = loadedPages.map(p => ({ id: p.id, content: p.content }));
      allCrossRefFindings = await checkCrossReferences(pagesForCrossRef);
      if (verbose) console.log(`[scan] Found ${allCrossRefFindings.length} cross-reference contradictions`);
    } catch (err) {
      if (verbose) console.warn(`[scan] Cross-ref failed: ${(err as Error).message}`);
    }
  }

  // Sort by uncited claim count (worst first)
  results.sort((a, b) => b.uncitedClaimCount - a.uncitedClaimCount);

  const totalFindings = results.reduce((sum, r) => sum + r.findings.length, 0) + allCrossRefFindings.length;

  const manifest: ScanManifest = {
    scannedAt: new Date().toISOString(),
    agents: options.agents,
    usedLlm: useLlm,
    pagesScanned: results.length,
    totalFindings,
    pages: results,
    crossRefContradictions: allCrossRefFindings,
    durationMs: Date.now() - startTime,
  };

  // Write manifest to disk
  const outputPath = options.output || join(process.cwd(), '.claude/temp/scan-manifest.json');
  const outputDir = join(outputPath, '..');
  await mkdir(outputDir, { recursive: true });
  await writeFile(outputPath, JSON.stringify(manifest, null, 2));

  return manifest;
}

// ---------------------------------------------------------------------------
// Direction generation from scan results
// ---------------------------------------------------------------------------

/**
 * Generate targeted improvement directions from a page's scan results.
 * This is the key bridge between scanning and improving — it converts
 * findings into actionable instructions for the improve pipeline.
 */
export function generateDirections(page: PageScanResult): string {
  const parts: string[] = [];

  // Lead with the most impactful direction
  if (page.uncitedClaimCount > 0) {
    parts.push(
      `This page has ${page.uncitedClaimCount} specific factual claims (dates, numbers, percentages) without citations. ` +
      `Add footnoted citations for each. Prioritize primary sources (official websites, papers, reputable news). ` +
      `If a claim cannot be verified, either remove it or add a hedge ("reportedly", "according to some sources").`
    );
  }

  if (page.citationCount === 0) {
    parts.push(
      `This page has ZERO citations. Every substantive factual claim needs a source. ` +
      `Do not leave any specific dates, funding amounts, employee counts, or biographical claims unsourced.`
    );
  }

  // Add agent-specific directions
  const snifferFindings = page.findings.filter(f => f.agent === 'reference-sniffer');
  const auditorFindings = page.findings.filter(f => f.agent === 'description-auditor');

  if (snifferFindings.some(f => f.category === 'confabulation-pattern')) {
    parts.push(
      `Remove confabulation patterns: phrases like "reportedly", "widely regarded as", "one of the most important" ` +
      `that are asserted without evidence. Either cite a source or use more measured language.`
    );
  }

  if (snifferFindings.some(f => f.category === 'internal-contradiction')) {
    parts.push(
      `Fix internal contradictions: claims on this page that disagree with each other. ` +
      `Verify the correct information and ensure consistency throughout.`
    );
  }

  if (auditorFindings.some(f => f.category === 'inconsistency')) {
    parts.push(
      `Fix description inconsistencies: the YAML entity description, frontmatter, and overview section ` +
      `contain conflicting information. Verify and align all descriptions.`
    );
  }

  if (auditorFindings.some(f => f.category === 'uncited-specific')) {
    parts.push(
      `The overview section contains specific claims (dates, roles, achievements) without citations. ` +
      `These are high-visibility and need sources.`
    );
  }

  // Entity-type-specific directions
  if (page.entityType === 'person') {
    parts.push(
      `For this person page: verify all biographical dates, roles, affiliations, and achievements ` +
      `against cited sources. Do not include uncited biographical claims.`
    );
  } else if (page.entityType === 'organization') {
    parts.push(
      `For this organization page: verify founding date, funding amounts, employee counts, ` +
      `key personnel, and mission statements against cited sources.`
    );
  }

  // Never fabricate citations
  parts.push(
    `CRITICAL: Never fabricate citations. If you cannot find a reliable source for a claim, ` +
    `remove the claim rather than inventing a source.`
  );

  return parts.join('\n\n');
}
