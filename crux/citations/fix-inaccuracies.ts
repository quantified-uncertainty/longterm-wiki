/**
 * Citation Inaccuracy Auto-Fixer
 *
 * Reads flagged citations from the dashboard YAML (for discovery), then
 * enriches each with full source text from SQLite before generating fixes.
 *
 * Usage:
 *   pnpm crux citations fix-inaccuracies                        # Dry run all
 *   pnpm crux citations fix-inaccuracies --apply                 # Apply all
 *   pnpm crux citations fix-inaccuracies compute-governance      # One page
 *   pnpm crux citations fix-inaccuracies --verdict=inaccurate    # Filter by verdict
 *   pnpm crux citations fix-inaccuracies --max-score=0.5         # Only worst
 *
 * Requires: OPENROUTER_API_KEY
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import yaml from 'js-yaml';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { findPageFile } from '../lib/file-utils.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { callOpenRouter, stripCodeFences, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { createClient, callClaude, MODELS } from '../lib/anthropic.ts';
import { appendEditLog } from '../lib/edit-log.ts';
import { citationQuotes, citationContent } from '../lib/knowledge-db.ts';
import { checkAccuracyForPage } from './check-accuracy.ts';
import { extractQuotesForPage } from './extract-quotes.ts';
import { exportDashboardData, ACCURACY_DIR, ACCURACY_PAGES_DIR } from './export-dashboard.ts';
import type { FlaggedCitation } from './export-dashboard.ts';
import { logBatchProgress } from './shared.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FixProposal {
  footnote: number;
  original: string;
  replacement: string;
  explanation: string;
  fixType: string;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
  content: string | null;
  details: Array<{
    footnote: number;
    status: 'applied' | 'not_found';
    explanation: string;
  }>;
}

export interface SectionRewrite {
  heading: string;
  originalSection: string;
  rewrittenSection: string;
  startLine: number;
  endLine: number;
}

export interface ExtractedSection {
  heading: string;
  text: string;
  startLine: number;
  endLine: number;
}

// ---------------------------------------------------------------------------
// Section extraction for escalation
// ---------------------------------------------------------------------------

/**
 * Extract the heading-bounded section containing a footnote reference.
 * Uses ## or ### headings as boundaries. Stops at footnote definitions block.
 * Works on frontmatter-stripped body text.
 */
export function extractSection(body: string, footnoteNum: number): ExtractedSection | null {
  // Use regex to match exact footnote number (avoid [^1] matching inside [^10])
  const markerRe = new RegExp(`\\[\\^${footnoteNum}\\](?!\\d)`);
  if (!markerRe.test(body)) return null;

  const lines = body.split('\n');

  // Find the line containing the footnote reference (not a definition line)
  let targetLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip footnote definition lines like [^1]: ...
    if (/^\[\^\d+\]:/.test(line.trimStart())) continue;
    if (markerRe.test(line)) {
      targetLine = i;
      break;
    }
  }
  if (targetLine === -1) return null;

  // Search backward for the nearest heading (## or ###)
  let startLine = 0;
  let heading = '';
  for (let i = targetLine; i >= 0; i--) {
    if (/^#{2,3}\s/.test(lines[i])) {
      startLine = i;
      heading = lines[i];
      break;
    }
  }

  // Search forward for the next heading or footnote definitions block
  let endLine = lines.length - 1;
  for (let i = targetLine + 1; i < lines.length; i++) {
    // Stop at next heading of same or higher level
    if (/^#{2,3}\s/.test(lines[i])) {
      endLine = i - 1;
      break;
    }
    // Stop at footnote definitions block (consecutive [^N]: lines)
    if (/^\[\^\d+\]:/.test(lines[i].trimStart())) {
      endLine = i - 1;
      break;
    }
  }

  // Trim trailing blank lines
  while (endLine > startLine && lines[endLine].trim() === '') {
    endLine--;
  }

  const text = lines.slice(startLine, endLine + 1).join('\n');
  return { heading, text, startLine, endLine };
}

/**
 * Group flagged citations by the section they appear in.
 * Returns a Map keyed by section start line.
 */
export function groupFlaggedBySection(
  body: string,
  flagged: FlaggedCitation[],
): Map<number, { section: ExtractedSection; citations: FlaggedCitation[] }> {
  const groups = new Map<number, { section: ExtractedSection; citations: FlaggedCitation[] }>();

  for (const f of flagged) {
    const section = extractSection(body, f.footnote);
    if (!section) continue;

    const existing = groups.get(section.startLine);
    if (existing) {
      existing.citations.push(f);
    } else {
      groups.set(section.startLine, { section, citations: [f] });
    }
  }

  return groups;
}

/**
 * Find all footnote references [^N] in a section of text.
 * Returns unique footnote numbers found (not definition lines).
 */
export function findAllFootnotesInSection(sectionText: string): number[] {
  const seen = new Set<number>();
  const re = /\[\^(\d+)\]/g;
  let match: RegExpExecArray | null;
  const lines = sectionText.split('\n');

  for (const line of lines) {
    // Skip footnote definition lines
    if (/^\[\^\d+\]:/.test(line.trimStart())) continue;
    re.lastIndex = 0;
    while ((match = re.exec(line)) !== null) {
      seen.add(parseInt(match[1], 10));
    }
  }

  return [...seen].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Claude escalation — section-level rewrite
// ---------------------------------------------------------------------------

const ESCALATION_SYSTEM_PROMPT = `You are a wiki editor fixing citation inaccuracies. You receive a full section of a wiki page where some citations have been flagged as inaccurate or unsupported.

Your job: rewrite the section so all claims accurately reflect their cited sources. You have evidence for ALL citations in the section (not just flagged ones).

Rules:
1. Use SOURCE EVIDENCE to determine correct values. Replace wrong facts with values from the source.
2. You may restructure paragraphs, split sentences, and move claims between citations as needed.
3. For unsupported claims (source doesn't address the topic): remove the claim, or remove just the footnote reference if the claim is likely true from general knowledge.
4. For overclaims: tone down language to match what the source supports.
5. PRESERVE the section heading exactly as-is (first line starting with ## or ###).
6. PRESERVE all footnote references [^N] — do not renumber or remove them unless the verdict is "unsupported" and you're removing the claim.
7. PRESERVE all MDX components like <EntityLink id="..."> exactly as written.
8. PRESERVE the overall tone and style of the wiki.
9. Keep the section roughly the same length — don't add speculation or new claims.
10. Return ONLY the corrected section text. No explanations, no JSON, no code fences.`;

/** Max source text chars to include per citation in escalation prompt. */
const MAX_SOURCE_PER_ESCALATION = 6_000;

/**
 * Look up source evidence for a non-flagged footnote directly from SQLite.
 * Used in escalation to provide context for neighboring citations.
 */
function lookupFootnoteEvidence(pageId: string, footnote: number): string | null {
  try {
    const row = citationQuotes.get(pageId, footnote);
    if (!row) return null;

    const parts: string[] = [];

    // Supporting quotes (best evidence)
    if (row.accuracy_supporting_quotes) {
      parts.push('Key passages from source:');
      parts.push(row.accuracy_supporting_quotes);
    }

    // Extracted quote
    if (row.source_quote && !row.accuracy_supporting_quotes?.includes(row.source_quote.slice(0, 50))) {
      parts.push('Extracted quote:');
      parts.push(row.source_quote);
    }

    if (parts.length > 0) return parts.join('\n');

    // Fall back to cached full text
    if (row.url) {
      const cached = citationContent.getByUrl(row.url);
      if (cached?.full_text) {
        const truncated = cached.full_text.length > MAX_SOURCE_PER_ESCALATION
          ? cached.full_text.slice(0, MAX_SOURCE_PER_ESCALATION) + '\n[... truncated ...]'
          : cached.full_text;
        return `Full source text:\n${truncated}`;
      }
    }

    return null;
  } catch {
    return null; // SQLite unavailable
  }
}

/**
 * Escalate to Claude Sonnet with section-level rewrites when Gemini Flash
 * returns 0 proposals for flagged citations.
 */
export async function escalateWithClaude(
  pageId: string,
  body: string,
  flaggedCitations: FlaggedCitation[],
  allEnriched: EnrichedFlaggedCitation[],
  opts?: { verbose?: boolean },
): Promise<SectionRewrite[]> {
  const client = createClient();
  if (!client) {
    throw new Error('ANTHROPIC_API_KEY required for Claude escalation');
  }

  const groups = groupFlaggedBySection(body, flaggedCitations);
  if (groups.size === 0) return [];

  const rewrites: SectionRewrite[] = [];

  for (const [, { section, citations }] of groups) {
    // Find ALL footnotes in the section (not just flagged)
    const allFootnotes = findAllFootnotesInSection(section.text);

    // Build evidence for all footnotes in the section
    const evidenceParts: string[] = [];
    for (const fn of allFootnotes) {
      const enriched = allEnriched.find(
        (e) => e.pageId === pageId && e.footnote === fn,
      );
      const flaggedItem = citations.find((c) => c.footnote === fn);

      evidenceParts.push(`--- Citation [^${fn}] ${flaggedItem ? '(FLAGGED)' : '(context)'} ---`);

      if (flaggedItem) {
        evidenceParts.push(`Verdict: ${flaggedItem.verdict}`);
        evidenceParts.push(`Score: ${flaggedItem.score}`);
        if (flaggedItem.issues) {
          evidenceParts.push(`Issues: ${flaggedItem.issues}`);
        }
      }

      if (enriched) {
        const evidence = buildSourceEvidence(enriched);
        if (evidence) {
          evidenceParts.push(`Source evidence:\n${evidence.slice(0, MAX_SOURCE_PER_ESCALATION)}`);
        }
      } else {
        // For non-flagged footnotes, look up evidence directly from SQLite
        const evidence = lookupFootnoteEvidence(pageId, fn);
        if (evidence) {
          evidenceParts.push(`Source evidence:\n${evidence.slice(0, MAX_SOURCE_PER_ESCALATION)}`);
        }
      }

      evidenceParts.push('');
    }

    // Compute which footnotes must be preserved vs. are removable
    const removableFns = new Set(
      citations
        .filter((c) => c.verdict === 'unsupported' || c.verdict === 'inaccurate')
        .map((c) => c.footnote),
    );
    const mustPreserve = allFootnotes.filter((fn) => !removableFns.has(fn));

    const preserveNote = mustPreserve.length > 0
      ? `\nIMPORTANT: These footnotes MUST appear in your output: ${mustPreserve.map((fn) => `[^${fn}]`).join(', ')}. Do not remove or renumber them.\n`
      : '';

    const userPrompt = [
      `Page: ${pageId}`,
      `Section to rewrite:`,
      '',
      section.text,
      '',
      `Evidence for citations in this section:`,
      '',
      ...evidenceParts,
      preserveNote,
    ].join('\n');

    if (opts?.verbose) {
      process.stdout.write(`  Escalating section "${section.heading.replace(/^#+\s*/, '')}" to Claude... `);
    }

    try {
      const result = await callClaude(client, {
        model: MODELS.sonnet,
        systemPrompt: ESCALATION_SYSTEM_PROMPT,
        userPrompt,
        maxTokens: 4000,
        temperature: 0,
      });

      const rewritten = result.text.trim();

      // Safety checks
      const origLen = section.text.length;
      const newLen = rewritten.length;

      if (newLen < origLen * 0.3) {
        if (opts?.verbose) console.log('rejected (too short)');
        continue;
      }
      if (newLen > origLen * 3.0) {
        if (opts?.verbose) console.log('rejected (too long)');
        continue;
      }

      // Check footnote preservation
      const origFootnotes = findAllFootnotesInSection(section.text);
      const newFootnotes = findAllFootnotesInSection(rewritten);
      const missingFootnotes = origFootnotes.filter((fn) => !newFootnotes.includes(fn));

      // Allow removal for unsupported/inaccurate verdicts (claims we know are wrong)
      const removableFootnotes = new Set(
        citations
          .filter((c) => c.verdict === 'unsupported' || c.verdict === 'inaccurate')
          .map((c) => c.footnote),
      );
      const badlyMissing = missingFootnotes.filter((fn) => !removableFootnotes.has(fn));
      if (badlyMissing.length > 0) {
        if (opts?.verbose) {
          console.log(`rejected (missing footnotes: ${badlyMissing.join(', ')})`);
        }
        continue;
      }

      // Check EntityLink preservation
      const origLinks = (section.text.match(/<EntityLink[^>]*>/g) ?? []).sort();
      const newLinks = (rewritten.match(/<EntityLink[^>]*>/g) ?? []).sort();
      if (origLinks.join() !== newLinks.join()) {
        if (opts?.verbose) console.log('rejected (EntityLink mismatch)');
        continue;
      }

      if (opts?.verbose) {
        console.log(`done (${origLen} → ${newLen} chars)`);
      }

      rewrites.push({
        heading: section.heading,
        originalSection: section.text,
        rewrittenSection: rewritten,
        startLine: section.startLine,
        endLine: section.endLine,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts?.verbose) {
        console.log(`error: ${msg.slice(0, 80)}`);
      }
    }
  }

  return rewrites;
}

/**
 * Apply section-level rewrites to page content.
 * Processes bottom-to-top to preserve line offsets.
 */
export function applySectionRewrites(
  content: string,
  rewrites: SectionRewrite[],
): { content: string; applied: number; skipped: number } {
  let modified = content;
  let applied = 0;
  let skipped = 0;

  // Sort by startLine descending (bottom-to-top) for safe replacement
  const sorted = [...rewrites].sort((a, b) => b.startLine - a.startLine);

  for (const rw of sorted) {
    const idx = modified.indexOf(rw.originalSection);
    if (idx === -1) {
      skipped++;
      continue;
    }

    modified =
      modified.slice(0, idx) +
      rw.rewrittenSection +
      modified.slice(idx + rw.originalSection.length);
    applied++;
  }

  return { content: modified, applied, skipped };
}

// ---------------------------------------------------------------------------
// Dashboard YAML reader
// ---------------------------------------------------------------------------

/** Read flagged citations from per-page YAML files (with fallback to old monolithic format). */
export function loadFlaggedCitations(opts: {
  pageId?: string;
  verdict?: string;
  maxScore?: number;
}): FlaggedCitation[] {
  let flagged: FlaggedCitation[] = [];

  // New split format: pages/<pageId>.yaml
  if (existsSync(ACCURACY_PAGES_DIR)) {
    const files = readdirSync(ACCURACY_PAGES_DIR).filter((f) => f.endsWith('.yaml'));

    // If filtering to one page, only read that file
    if (opts.pageId) {
      const pageFile = join(ACCURACY_PAGES_DIR, `${opts.pageId}.yaml`);
      if (existsSync(pageFile)) {
        const raw = readFileSync(pageFile, 'utf-8');
        const parsed = yaml.load(raw);
        if (Array.isArray(parsed)) {
          flagged = parsed as FlaggedCitation[];
        }
      }
    } else {
      for (const f of files) {
        try {
          const raw = readFileSync(join(ACCURACY_PAGES_DIR, f), 'utf-8');
          const parsed = yaml.load(raw);
          if (Array.isArray(parsed)) {
            flagged.push(...(parsed as FlaggedCitation[]));
          }
        } catch { /* skip malformed files */ }
      }
    }
  } else {
    // Fallback: old monolithic dashboard.yaml
    const oldPath = join(ACCURACY_DIR, 'dashboard.yaml');
    if (!existsSync(oldPath)) {
      throw new Error(
        `No citation accuracy data found. Run: pnpm crux citations export-dashboard`,
      );
    }
    const raw = readFileSync(oldPath, 'utf-8');
    const data = yaml.load(raw) as { flaggedCitations?: FlaggedCitation[] };
    flagged = data.flaggedCitations ?? [];

    if (opts.pageId) {
      flagged = flagged.filter((c) => c.pageId === opts.pageId);
    }
  }

  if (opts.verdict) {
    flagged = flagged.filter((c) => c.verdict === opts.verdict);
  }
  if (opts.maxScore !== undefined) {
    flagged = flagged.filter((c) => (c.score ?? 1) <= opts.maxScore!);
  }

  return flagged;
}

// ---------------------------------------------------------------------------
// SQLite enrichment — pull full source text for better fix generation
// ---------------------------------------------------------------------------

export interface EnrichedFlaggedCitation extends FlaggedCitation {
  fullClaimText: string | null;
  sourceQuote: string | null;
  supportingQuotes: string | null;
  sourceFullText: string | null;
}

/**
 * Enrich flagged citations with full data from SQLite.
 * Falls back gracefully if SQLite is unavailable (e.g., on Vercel).
 */
export function enrichFromSqlite(flagged: FlaggedCitation[]): EnrichedFlaggedCitation[] {
  try {
    return flagged.map((f) => {
      const row = citationQuotes.get(f.pageId, f.footnote);
      let sourceFullText: string | null = null;
      if (f.url) {
        const cached = citationContent.getByUrl(f.url);
        if (cached?.full_text) {
          sourceFullText = cached.full_text;
        }
      }
      return {
        ...f,
        fullClaimText: row?.claim_text ?? null,
        sourceQuote: row?.source_quote ?? null,
        supportingQuotes: row?.accuracy_supporting_quotes ?? null,
        sourceFullText,
      };
    });
  } catch {
    // SQLite unavailable — return with null enrichments
    return flagged.map((f) => ({
      ...f,
      fullClaimText: null,
      sourceQuote: null,
      supportingQuotes: null,
      sourceFullText: null,
    }));
  }
}

// ---------------------------------------------------------------------------
// Section context extraction
// ---------------------------------------------------------------------------

/**
 * Extract the section around a footnote reference for LLM context.
 * Returns ~20 lines centered around the first `[^N]` occurrence.
 */
export function extractSectionContext(body: string, footnoteNum: number): string {
  // Use regex to match exact footnote number (avoid [^1] matching inside [^10])
  const markerRe = new RegExp(`\\[\\^${footnoteNum}\\](?!\\d)`);
  const match = markerRe.exec(body);
  if (!match) return '';
  const idx = match.index;

  const lines = body.split('\n');
  let lineIdx = 0;
  let charCount = 0;
  for (let i = 0; i < lines.length; i++) {
    charCount += lines[i].length + 1; // +1 for newline
    if (charCount > idx) {
      lineIdx = i;
      break;
    }
  }

  const start = Math.max(0, lineIdx - 10);
  const end = Math.min(lines.length, lineIdx + 11);
  return lines.slice(start, end).join('\n');
}

// ---------------------------------------------------------------------------
// LLM interaction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are a wiki editor fixing citation inaccuracies. You receive flagged citations where the wiki text misrepresents or is unsupported by the cited source.

You are given:
- The wiki section context around each flagged citation
- The issue description explaining what's wrong
- Source evidence: passages from the cited source showing what it actually says

Generate fixes that make the wiki text accurately reflect the cited source. Rules:

1. Use the SOURCE EVIDENCE to determine what's correct. Replace wrong facts, names, numbers, and dates with the correct values from the source. Do NOT guess — use the exact values the source provides.
2. If the source says something substantially different from the wiki, rewrite the claim to match the source. Larger rewrites are fine when the original is substantially wrong.
3. For unsupported claims (source doesn't address the topic at all): either remove the footnote reference [^N] if the claim might still be true from other sources, or remove/rewrite the claim if it appears fabricated.
4. For overclaims: tone down the language to match what the source actually supports.
5. Keep accurate parts of claims intact — only change what's wrong.
6. NEVER change footnote definitions (lines starting with [^N]:)
7. NEVER add new footnotes or alter MDX components like <EntityLink>
8. The "original" text must be an EXACT substring of the page content
9. Keep "original" as short as possible while being unique in the page

Return a JSON array of fix objects. If no fix is needed (e.g., the issue is with the source, not the wiki), return an empty array.

JSON format:
[
  {
    "footnote": 5,
    "original": "exact text from the page",
    "replacement": "fixed text",
    "explanation": "brief reason for the change",
    "fix_type": "rewrite|correct|soften|remove_ref|remove_detail"
  }
]

Return ONLY valid JSON, no markdown fences.`;

/** Max source text chars to include in the fixer prompt per citation. */
const MAX_SOURCE_PER_CITATION = 8_000;

function buildUserPrompt(
  pageId: string,
  flagged: EnrichedFlaggedCitation[],
  pageContent: string,
): string {
  const body = stripFrontmatter(pageContent);
  const parts: string[] = [`Page: ${pageId}\n`];

  for (const c of flagged) {
    const context = extractSectionContext(body, c.footnote);
    parts.push(`--- Citation [^${c.footnote}] ---`);
    parts.push(`Verdict: ${c.verdict}`);
    parts.push(`Score: ${c.score}`);
    if (c.issues) {
      parts.push(`Issues: ${c.issues}`);
    }
    parts.push(`Source: ${c.sourceTitle ?? 'unknown'}`);

    // Use full claim text from SQLite when available (YAML version is truncated)
    const claimText = c.fullClaimText || c.claimText;
    parts.push(`\nClaim text: ${claimText}`);

    if (context) {
      parts.push(`\nSection context:\n${context}`);
    }

    // Include source evidence so the LLM can determine the correct values
    const sourceEvidence = buildSourceEvidence(c);
    if (sourceEvidence) {
      parts.push(`\nSource evidence (use this to determine correct values):\n${sourceEvidence}`);
    }

    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Build source evidence string from enriched citation data.
 * Prioritizes: supporting quotes > extracted quote > truncated full text.
 */
function buildSourceEvidence(c: EnrichedFlaggedCitation): string | null {
  const parts: string[] = [];

  // Supporting quotes from accuracy check (most targeted)
  if (c.supportingQuotes) {
    parts.push('Key passages from source:');
    parts.push(c.supportingQuotes);
  }

  // Extracted quote from the source
  if (c.sourceQuote && !c.supportingQuotes?.includes(c.sourceQuote.slice(0, 50))) {
    parts.push('Extracted quote:');
    parts.push(c.sourceQuote);
  }

  // If we have supporting quotes, that's usually enough
  if (parts.length > 0) return parts.join('\n');

  // Fall back to truncated full source text
  if (c.sourceFullText) {
    const truncated = c.sourceFullText.length > MAX_SOURCE_PER_CITATION
      ? c.sourceFullText.slice(0, MAX_SOURCE_PER_CITATION) + '\n[... truncated ...]'
      : c.sourceFullText;
    parts.push('Full source text:');
    parts.push(truncated);
  }

  return parts.length > 0 ? parts.join('\n') : null;
}

/** Parse LLM response into fix proposals. */
export function parseLLMFixResponse(content: string): FixProposal[] {
  const cleaned = stripCodeFences(content);
  try {
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter(
        (p: Record<string, unknown>) =>
          typeof p.original === 'string' &&
          typeof p.replacement === 'string' &&
          p.original.length > 0 &&
          p.original !== p.replacement,
      )
      .map((p: Record<string, unknown>) => ({
        footnote: typeof p.footnote === 'number' ? p.footnote : 0,
        original: p.original as string,
        replacement: p.replacement as string,
        explanation: typeof p.explanation === 'string' ? p.explanation : '',
        fixType: typeof p.fix_type === 'string' ? p.fix_type : 'unknown',
      }));
  } catch {
    return [];
  }
}

/** Generate fixes for all flagged citations on one page (single LLM call). */
export async function generateFixesForPage(
  pageId: string,
  flagged: FlaggedCitation[] | EnrichedFlaggedCitation[],
  pageContent: string,
  opts?: { model?: string },
): Promise<FixProposal[]> {
  // Enrich if not already enriched
  const enriched: EnrichedFlaggedCitation[] = 'fullClaimText' in (flagged[0] ?? {})
    ? (flagged as EnrichedFlaggedCitation[])
    : enrichFromSqlite(flagged);

  const userPrompt = buildUserPrompt(pageId, enriched, pageContent);

  const response = await callOpenRouter(SYSTEM_PROMPT, userPrompt, {
    model: opts?.model,
    maxTokens: 4000,
    title: 'LongtermWiki Fix Inaccuracies',
  });

  return parseLLMFixResponse(response);
}

// ---------------------------------------------------------------------------
// Source replacement search
// ---------------------------------------------------------------------------

export interface SourceReplacement {
  footnote: number;
  oldUrl: string;
  newUrl: string;
  newTitle: string;
  confidence: string; // 'high' | 'medium' | 'low'
  reason: string;
}

/**
 * Search for a better source URL for unsupported citations.
 * Uses the Exa API to find pages that actually contain the claimed information.
 * Falls back to LLM-based search query generation + Exa search.
 */
export async function findReplacementSources(
  flaggedCitations: EnrichedFlaggedCitation[],
  opts?: { verbose?: boolean },
): Promise<SourceReplacement[]> {
  const exaApiKey = process.env.EXA_API_KEY;
  if (!exaApiKey) {
    if (opts?.verbose) {
      console.log('  (EXA_API_KEY not set — skipping source replacement search)');
    }
    return [];
  }

  // Only consider unsupported citations with score=0 (source genuinely doesn't have the info)
  const candidates = flaggedCitations.filter(
    (c) => c.verdict === 'unsupported' && (c.score ?? 1) <= 0.2,
  );

  if (candidates.length === 0) return [];

  const replacements: SourceReplacement[] = [];

  for (const cit of candidates) {
    const claimText = cit.fullClaimText || cit.claimText;
    if (!claimText || claimText.length < 20) continue;

    // Build a targeted search query from the claim
    const searchQuery = buildSearchQuery(claimText, cit.sourceTitle);

    try {
      const results = await searchExa(exaApiKey, searchQuery);
      if (results.length === 0) continue;

      // Filter out the same domain as the current source
      const currentDomain = cit.url ? extractDomainFromUrl(cit.url) : null;
      const filteredResults = results.filter(
        (r) => !currentDomain || extractDomainFromUrl(r.url) !== currentDomain,
      );

      if (filteredResults.length === 0) continue;

      // Pick the best result (first one — Exa ranks by relevance)
      const best = filteredResults[0];

      replacements.push({
        footnote: cit.footnote,
        oldUrl: cit.url || '',
        newUrl: best.url,
        newTitle: best.title,
        confidence: best.text && best.text.length > 200 ? 'medium' : 'low',
        reason: `Current source doesn't support the claim. Found potentially relevant: "${best.title}"`,
      });

      if (opts?.verbose) {
        console.log(`  [^${cit.footnote}] Found replacement: ${best.title.slice(0, 60)}...`);
      }

      // Rate limit between searches
      await new Promise((r) => setTimeout(r, 500));
    } catch (err: unknown) {
      // Swallow search errors — source replacement is best-effort
      if (opts?.verbose) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`  [^${cit.footnote}] Search error: ${msg.slice(0, 60)}`);
      }
    }
  }

  return replacements;
}

/** Build a concise search query from a claim text. */
function buildSearchQuery(claimText: string, sourceTitle: string | null): string {
  // Strip MDX components and footnote markers
  let clean = claimText
    .replace(/<[^>]+>/g, '')
    .replace(/\[\^\d+\]/g, '')
    .replace(/\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  // Truncate to reasonable search length
  if (clean.length > 200) {
    clean = clean.slice(0, 200);
  }

  return clean;
}

/** Extract domain from a URL. */
function extractDomainFromUrl(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

interface ExaSearchResult {
  title: string;
  url: string;
  text?: string;
}

/** Search via Exa API. */
async function searchExa(apiKey: string, query: string): Promise<ExaSearchResult[]> {
  const response = await fetch('https://api.exa.ai/search', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      type: 'auto',
      numResults: 5,
      contents: { text: { maxCharacters: 500 } },
    }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Exa API error ${response.status}: ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as { results: ExaSearchResult[] };
  return data.results || [];
}

/**
 * Apply source replacements to page content by updating footnote definition URLs.
 * Only replaces the URL inside [^N]: [Title](URL) definitions.
 */
export function applySourceReplacements(
  content: string,
  replacements: SourceReplacement[],
): { content: string; applied: number; skipped: number } {
  let modified = content;
  let applied = 0;
  let skipped = 0;

  for (const rep of replacements) {
    // Match footnote definition pattern: [^N]: [Title](URL) or [^N]: URL
    const defRegex = new RegExp(
      `(\\[\\^${rep.footnote}\\]:\\s*)(?:\\[([^\\]]*?)\\]\\((${escapeRegex(rep.oldUrl)})\\)|(${escapeRegex(rep.oldUrl)}))`,
    );

    const match = defRegex.exec(modified);
    if (!match) {
      skipped++;
      continue;
    }

    const prefix = match[1]; // "[^N]: "
    const newDef = `${prefix}[${rep.newTitle}](${rep.newUrl})`;
    modified = modified.slice(0, match.index) + newDef + modified.slice(match.index + match[0].length);
    applied++;
  }

  return { content: modified, applied, skipped };
}

/** Escape special regex characters in a string. */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Orphaned footnote cleanup
// ---------------------------------------------------------------------------

/**
 * Remove footnote definition lines ([^N]: ...) where no corresponding
 * inline reference [^N] exists in the body text.
 *
 * This prevents dangling definitions after section rewrites remove
 * inline footnote references.
 */
export function cleanupOrphanedFootnotes(content: string): { content: string; removed: number[] } {
  const lines = content.split('\n');

  // Find all inline footnote references (not in definition lines)
  const inlineRefs = new Set<number>();
  const defLineIndices: Array<{ lineIdx: number; footnote: number }> = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Check if this is a footnote definition line
    const defMatch = trimmed.match(/^\[\^(\d+)\]:/);
    if (defMatch) {
      defLineIndices.push({ lineIdx: i, footnote: parseInt(defMatch[1], 10) });
      continue;
    }

    // Otherwise, collect all inline [^N] references on this line
    const refRe = /\[\^(\d+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = refRe.exec(line)) !== null) {
      inlineRefs.add(parseInt(m[1], 10));
    }
  }

  // Find orphaned definitions (no matching inline reference)
  const orphanedLineIndices = new Set<number>();
  const removed: number[] = [];
  for (const def of defLineIndices) {
    if (!inlineRefs.has(def.footnote)) {
      orphanedLineIndices.add(def.lineIdx);
      removed.push(def.footnote);
    }
  }

  if (removed.length === 0) {
    return { content, removed: [] };
  }

  // Remove orphaned lines (and trailing blank line if it creates a double-blank)
  const filtered = lines.filter((_, i) => !orphanedLineIndices.has(i));

  // Clean up double-blank lines that might result from removal
  const cleaned: string[] = [];
  for (let i = 0; i < filtered.length; i++) {
    if (i > 0 && filtered[i].trim() === '' && filtered[i - 1].trim() === '') {
      // Skip consecutive blank lines (keep only one)
      if (cleaned.length > 0 && cleaned[cleaned.length - 1].trim() === '') {
        continue;
      }
    }
    cleaned.push(filtered[i]);
  }

  return { content: cleaned.join('\n'), removed: removed.sort((a, b) => a - b) };
}

// ---------------------------------------------------------------------------
// Fix application
// ---------------------------------------------------------------------------

/**
 * Apply fix proposals to page content via string replacement.
 * Processes in reverse offset order to preserve positions.
 */
export function applyFixes(content: string, proposals: FixProposal[]): ApplyResult {
  const result: ApplyResult = { applied: 0, skipped: 0, content: null, details: [] };

  // Find offsets and sort descending
  const withOffsets = proposals.map((p) => ({
    ...p,
    offset: content.indexOf(p.original),
  }));

  // Sort by offset descending (bottom-to-top)
  withOffsets.sort((a, b) => b.offset - a.offset);

  let modified = content;

  for (const fix of withOffsets) {
    if (fix.offset === -1) {
      result.skipped++;
      result.details.push({
        footnote: fix.footnote,
        status: 'not_found',
        explanation: `Original text not found in page`,
      });
      continue;
    }

    // Verify the text at the expected offset still matches
    const atOffset = modified.slice(fix.offset, fix.offset + fix.original.length);
    if (atOffset !== fix.original) {
      result.skipped++;
      result.details.push({
        footnote: fix.footnote,
        status: 'not_found',
        explanation: `Text at offset ${fix.offset} no longer matches`,
      });
      continue;
    }

    modified =
      modified.slice(0, fix.offset) +
      fix.replacement +
      modified.slice(fix.offset + fix.original.length);
    result.applied++;
    result.details.push({
      footnote: fix.footnote,
      status: 'applied',
      explanation: fix.explanation,
    });
  }

  if (result.applied > 0) {
    result.content = modified;
  }

  return result;
}

// ---------------------------------------------------------------------------
// CLI main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const apply = args.apply === true;
  const json = args.json === true;
  const escalate = args.escalate !== false; // enabled by default, --no-escalate disables
  const model = typeof args.model === 'string' ? args.model : undefined;
  const verdictFilter = typeof args.verdict === 'string' ? args.verdict : undefined;
  const maxScore = typeof args['max-score'] === 'string'
    ? parseFloat(args['max-score'])
    : undefined;

  const positional = args._positional as string[];
  const pageIdFilter = positional[0];

  const c = getColors(json);

  // Load flagged citations from YAML, then enrich with SQLite source data
  let enriched: EnrichedFlaggedCitation[];
  try {
    const flagged = loadFlaggedCitations({
      pageId: pageIdFilter,
      verdict: verdictFilter,
      maxScore,
    });
    enriched = enrichFromSqlite(flagged);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}Error: ${msg}${c.reset}`);
    process.exit(1);
  }

  if (enriched.length === 0) {
    if (json) {
      console.log(JSON.stringify({ fixesProposed: 0, fixesApplied: 0, pages: [] }));
    } else {
      console.log(`${c.green}No flagged citations found matching filters.${c.reset}`);
    }
    process.exit(0);
  }

  // Count how many have source evidence
  const withSource = enriched.filter(
    (e) => e.supportingQuotes || e.sourceQuote || e.sourceFullText,
  ).length;

  // Group by page
  const byPage = new Map<string, EnrichedFlaggedCitation[]>();
  for (const f of enriched) {
    if (!byPage.has(f.pageId)) byPage.set(f.pageId, []);
    byPage.get(f.pageId)!.push(f);
  }

  if (!json) {
    console.log(
      `\n${c.bold}${c.blue}Citation Inaccuracy Fixer${c.reset}${apply ? ` ${c.red}(APPLY MODE)${c.reset}` : ` ${c.dim}(dry run)${c.reset}`}\n`,
    );
    console.log(
      `  ${enriched.length} flagged citation${enriched.length === 1 ? '' : 's'} across ${byPage.size} page${byPage.size === 1 ? '' : 's'}`,
    );
    console.log(`  Source evidence: ${withSource}/${enriched.length} citations have source text`);
    console.log(`  Model: ${model || DEFAULT_CITATION_MODEL}\n`);
  }

  const concurrency = Math.max(1, parseInt((args.concurrency as string) || '1', 10));
  if (!json && concurrency > 1) {
    console.log(`  Concurrency: ${concurrency}\n`);
  }

  interface PageResult {
    pageId: string;
    proposals: FixProposal[];
    applyResult?: ApplyResult;
  }

  const allResults: PageResult[] = [];
  const pageEntries = [...byPage.entries()];
  const verbose = !json && concurrency === 1;
  const runStart = Date.now();

  for (let i = 0; i < pageEntries.length; i += concurrency) {
    const batch = pageEntries.slice(i, i + concurrency);
    const batchStart = Date.now();

    const batchResults = await Promise.all(
      batch.map(async ([pageId, pageFlagged], batchIdx): Promise<PageResult | null> => {
        const globalIdx = i + batchIdx;

        if (!json) {
          console.log(
            `${c.dim}[${globalIdx + 1}/${pageEntries.length}]${c.reset} ${c.bold}${pageId}${c.reset} (${pageFlagged.length} flagged)`,
          );
        }

        // Find the page file
        const filePath = findPageFile(pageId);
        if (!filePath) {
          if (!json) {
            console.log(`  ${c.red}${pageId}: Page file not found — skipping${c.reset}`);
          }
          return null;
        }

        const pageContent = readFileSync(filePath, 'utf-8');

        // Generate fixes via LLM
        let proposals: FixProposal[];
        try {
          proposals = await generateFixesForPage(pageId, pageFlagged, pageContent, { model });
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!json) {
            console.log(`  ${c.red}${pageId}: LLM error — ${msg.slice(0, 100)}${c.reset}`);
          }
          return null;
        }

        if (proposals.length === 0 && escalate) {
          // Escalate to Claude Sonnet with section-level rewrites
          if (!json) {
            console.log(`  ${c.dim}No string-replacement fixes proposed — escalating to Claude...${c.reset}`);
          }

          try {
            const body = stripFrontmatter(pageContent);
            const sectionRewrites = await escalateWithClaude(
              pageId, body, pageFlagged, enriched,
              { verbose: !json },
            );

            if (sectionRewrites.length > 0 && apply) {
              const rwResult = applySectionRewrites(pageContent, sectionRewrites);
              if (rwResult.applied > 0) {
                // Clean up orphaned footnote definitions
                const orphanResult = cleanupOrphanedFootnotes(rwResult.content);
                writeFileSync(filePath, orphanResult.content, 'utf-8');
                appendEditLog(pageId, {
                  tool: 'crux-fix-escalated',
                  agency: 'automated',
                  note: `Escalated to Claude: rewrote ${rwResult.applied} section(s) to fix citation inaccuracies`,
                });
                if (!json && orphanResult.removed.length > 0) {
                  console.log(`  ${c.dim}Cleaned up ${orphanResult.removed.length} orphaned footnote(s): ${orphanResult.removed.map(n => `[^${n}]`).join(', ')}${c.reset}`);
                }
              }

              if (!json) {
                console.log(`  ${c.green}${pageId}: ${rwResult.applied} section(s) rewritten${c.reset}${rwResult.skipped > 0 ? ` ${c.yellow}(${rwResult.skipped} skipped)${c.reset}` : ''}`);
              }

              // Create a synthetic ApplyResult for the summary
              const syntheticApply: ApplyResult = {
                applied: rwResult.applied,
                skipped: rwResult.skipped,
                content: rwResult.content,
                details: sectionRewrites.map((rw) => ({
                  footnote: 0,
                  status: 'applied' as const,
                  explanation: `Section rewrite: ${rw.heading}`,
                })),
              };
              return { pageId, proposals: [], applyResult: syntheticApply };
            } else if (sectionRewrites.length > 0 && !apply) {
              if (!json) {
                for (const rw of sectionRewrites) {
                  console.log(`  ${c.yellow}Section: ${rw.heading.replace(/^#+\s*/, '')}${c.reset}`);
                  console.log(`    ${c.dim}${rw.originalSection.length} chars → ${rw.rewrittenSection.length} chars${c.reset}`);
                }
              }
              return { pageId, proposals: [] };
            } else {
              if (verbose) {
                console.log(`  ${c.dim}Escalation produced no rewrites${c.reset}`);
              }
              return { pageId, proposals: [] };
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            if (!json) {
              console.log(`  ${c.yellow}Escalation failed: ${msg.slice(0, 80)}${c.reset}`);
            }
            return { pageId, proposals: [] };
          }
        } else if (proposals.length === 0) {
          if (verbose) {
            console.log(`  ${c.dim}No fixes proposed${c.reset}`);
          } else if (!json) {
            console.log(`  ${c.dim}${pageId}: no fixes proposed${c.reset}`);
          }
          return { pageId, proposals: [] };
        }

        // Display proposals
        if (verbose) {
          for (const p of proposals) {
            console.log(`  ${c.yellow}[^${p.footnote}]${c.reset} ${p.fixType}: ${p.explanation}`);
            console.log(`    ${c.red}- ${truncate(p.original, 100)}${c.reset}`);
            console.log(`    ${c.green}+ ${truncate(p.replacement, 100)}${c.reset}`);
          }
        }

        // Apply if requested
        if (apply) {
          const applyResult = applyFixes(pageContent, proposals);
          const modifiedContent = applyResult.content;

          if (applyResult.applied > 0 && modifiedContent) {
            writeFileSync(filePath, modifiedContent, 'utf-8');
            appendEditLog(pageId, {
              tool: 'crux-fix',
              agency: 'automated',
              note: `Fixed ${applyResult.applied} flagged citation inaccuracies`,
            });
          }

          if (!json) {
            const appliedStr = applyResult.applied > 0
              ? `${c.green}${applyResult.applied} applied${c.reset}`
              : `${c.dim}0 applied${c.reset}`;
            const skippedStr = applyResult.skipped > 0
              ? ` ${c.yellow}(${applyResult.skipped} skipped)${c.reset}`
              : '';
            console.log(`  ${pageId}: ${proposals.length} proposed, ${appliedStr}${skippedStr}`);
          }

          return { pageId, proposals, applyResult };
        }

        if (!verbose && !json) {
          console.log(`  ${c.green}${pageId}:${c.reset} ${proposals.length} fixes proposed`);
        }

        return { pageId, proposals };
      }),
    );

    for (const r of batchResults) {
      if (r) allResults.push(r);
    }

    if (!json && pageEntries.length > concurrency) {
      logBatchProgress(c, {
        batchIndex: i, concurrency, totalPages: pageEntries.length,
        runStartMs: runStart, batchStartMs: batchStart,
      });
    } else {
      console.log('');
    }
  }

  // Summary
  const totalProposed = allResults.reduce((s, r) => s + r.proposals.length, 0);
  const totalApplied = allResults.reduce((s, r) => s + (r.applyResult?.applied ?? 0), 0);

  // Re-verify fixed pages to confirm improvements
  const pagesWithAppliedFixes = allResults
    .filter((r) => r.applyResult && r.applyResult.applied > 0)
    .map((r) => r.pageId);

  interface ReVerifyResult {
    pageId: string;
    before: { inaccurate: number; unsupported: number };
    after: { inaccurate: number; unsupported: number; accurate: number };
  }
  const reVerifyResults: ReVerifyResult[] = [];

  if (apply && pagesWithAppliedFixes.length > 0) {
    if (!json) {
      console.log(`${c.bold}${c.blue}Re-verifying fixed pages...${c.reset}\n`);
    }

    for (const pageId of pagesWithAppliedFixes) {
      const pageFlagged = byPage.get(pageId) || [];
      const beforeInaccurate = pageFlagged.filter((f) => f.verdict === 'inaccurate').length;
      const beforeUnsupported = pageFlagged.filter((f) => f.verdict === 'unsupported').length;

      try {
        if (!json) {
          process.stdout.write(`  ${pageId}: re-extracting claims... `);
        }

        // Re-extract claims from the updated page to update claim_text in SQLite
        const filePath = findPageFile(pageId);
        if (filePath) {
          const updatedRaw = readFileSync(filePath, 'utf-8');
          const updatedBody = stripFrontmatter(updatedRaw);
          await extractQuotesForPage(pageId, updatedBody, { verbose: false, recheck: true });
        }

        if (!json) {
          process.stdout.write(`re-checking... `);
        }
        const result = await checkAccuracyForPage(pageId, {
          verbose: false,
          recheck: true,
        });
        reVerifyResults.push({
          pageId,
          before: { inaccurate: beforeInaccurate, unsupported: beforeUnsupported },
          after: {
            inaccurate: result.inaccurate,
            unsupported: result.unsupported,
            accurate: result.accurate,
          },
        });

        if (!json) {
          const beforeTotal = beforeInaccurate + beforeUnsupported;
          const afterTotal = result.inaccurate + result.unsupported;
          const improved = beforeTotal - afterTotal;
          if (improved > 0) {
            console.log(`${c.green}${improved} fixed${c.reset} (${beforeTotal} → ${afterTotal} flagged)`);
          } else if (improved === 0) {
            console.log(`${c.yellow}unchanged${c.reset} (${afterTotal} flagged)`);
          } else {
            console.log(`${c.red}regression${c.reset} (${beforeTotal} → ${afterTotal} flagged)`);
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!json) {
          console.log(`${c.red}error: ${msg.slice(0, 80)}${c.reset}`);
        }
      }
    }

    // Re-export dashboard data with updated verdicts
    exportDashboardData();

    if (!json) console.log('');
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          fixesProposed: totalProposed,
          fixesApplied: totalApplied,
          reVerification: reVerifyResults,
          pages: allResults.map((r) => ({
            pageId: r.pageId,
            proposed: r.proposals.length,
            applied: r.applyResult?.applied ?? 0,
            skipped: r.applyResult?.skipped ?? 0,
            fixes: r.proposals.map((p) => ({
              footnote: p.footnote,
              fixType: p.fixType,
              explanation: p.explanation,
            })),
          })),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`${c.bold}Summary${c.reset}`);
    console.log(`  Proposed: ${totalProposed}`);
    if (apply) {
      console.log(`  Applied:  ${totalApplied}`);
    }

    if (reVerifyResults.length > 0) {
      const totalBefore = reVerifyResults.reduce(
        (s, r) => s + r.before.inaccurate + r.before.unsupported, 0,
      );
      const totalAfter = reVerifyResults.reduce(
        (s, r) => s + r.after.inaccurate + r.after.unsupported, 0,
      );
      const improved = totalBefore - totalAfter;
      console.log(
        `  Re-verified: ${improved > 0 ? c.green : c.yellow}${improved} citations improved${c.reset} (${totalBefore} → ${totalAfter} flagged)`,
      );
    }

    if (!apply && totalProposed > 0) {
      console.log(`\n${c.dim}Run with --apply to write changes and auto-re-verify.${c.reset}`);
    }
    console.log('');
  }

  process.exit(0);
}

function truncate(s: string, maxLen: number): string {
  const oneLine = s.replace(/\n/g, ' ');
  return oneLine.length > maxLen ? oneLine.slice(0, maxLen) + '...' : oneLine;
}

// Only run when executed directly
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: Error) => {
    console.error('Error:', err.message);
    process.exit(1);
  });
}
