/**
 * Lightweight Citation-Adding Pass
 *
 * Surgical footnote insertion: finds uncited factual claims in wiki page
 * prose, searches the web for source URLs, and inserts footnote references
 * + definitions. Does NOT rewrite prose — only adds [^rc-XXXX] markers.
 *
 * Usage:
 *   crux verify page <id> --fix              Add citations to uncited claims
 *   crux verify page <id> --fix --limit=10   Limit to 10 claims
 *   crux verify page <id> --fix --dry-run    Show what would be added without writing
 */

import fs from 'fs';
import { createHash } from 'crypto';
import type { CommandResult } from '../lib/command-types.ts';
import { findPageById } from '../lib/page-resolution.ts';
import { extractClaims } from '../lib/semantic-diff/claim-extractor.ts';
import type { ExtractedClaim } from '../lib/semantic-diff/types.ts';
import { createLlmClient, callLlm, runLlmAgent, MODELS } from '../lib/llm.ts';
import { fetchSourceContent as fetchCachedContent } from '../lib/sourcing/source-fetcher.ts';
import { parseJsonFromLlm } from '../lib/json-parsing.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import { withPipelineRun } from '../lib/pipeline-runs/lifecycle.ts';

// Reuse from verify-page.ts
import { extractFootnotedSentences, claimHasCitation, isCheckWorthy } from './verify-page-utils.ts';

// ── Types ────────────────────────────────────────────────────────────

interface FoundSource {
  url: string;
  title: string;
  snippet: string;
}

interface CitationToAdd {
  claim: ExtractedClaim;
  source: FoundSource;
  refId: string;
  insertionLine: number;      // line number in the MDX where the footnote ref goes
  insertionColumn: number;    // character position after which to insert
}

// ── Source finding ───────────────────────────────────────────────────

const FIND_SOURCE_PROMPT = `You find authoritative web sources for factual claims. Search the web and return the single best source URL that directly supports the claim.

Output JSON:
{
  "url": "https://...",
  "title": "Page title",
  "snippet": "The specific text from the page that supports the claim"
}

If no good source is found, return:
{
  "url": "",
  "title": "",
  "snippet": ""
}

Rules:
- Prefer primary sources (official announcements, research papers, government docs)
- Prefer recent sources over old ones
- The source must DIRECTLY support the specific claim, not just be about the topic
- Never return URLs you aren't confident are real
- NEVER cite longtermwiki.com, longterm.wiki, or any mirror of this wiki — that would be circular
- Prefer stable URLs: Wikipedia, arxiv, official company pages, major news outlets
- Avoid URLs with database record IDs (e.g., /rec12345) that may break`;

interface FindSourceResult {
  url: string;
  title: string;
  snippet: string;
}

async function findSourceForClaim(
  claim: ExtractedClaim,
  client: ReturnType<typeof createLlmClient>,
  costTracker: CostTracker,
  avoidDomains: string[] = [],
): Promise<FoundSource | null> {
  const avoidClause = avoidDomains.length > 0
    ? `\n\nIMPORTANT: Do NOT return URLs from these domains (they block automated access): ${avoidDomains.join(', ')}`
    : '';

  try {
    const resultText = await runLlmAgent(client, `Find a web source that supports this factual claim:

"${claim.text}"${claim.keyValue ? `\n(Key value: ${claim.keyValue})` : ''}${avoidClause}

Search the web and return the best source URL as JSON.`, {
      model: MODELS.haiku,
      maxTokens: 1000,
      systemPrompt: FIND_SOURCE_PROMPT,
      serverTools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }],
      maxToolTurns: 3,
      retryLabel: 'find-source',
      costTracker,
    });

    const parsed = parseJsonFromLlm<FindSourceResult>(
      resultText,
      'find-source',
      () => ({ url: '', title: '', snippet: '' }),
    );

    if (!parsed.url || parsed.url.length < 10) return null;

    // Basic URL validation
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(parsed.url);
    } catch {
      return null;
    }

    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      console.warn(`    [!] Unsupported URL scheme: ${parsed.url}`);
      return null;
    }

    // Block circular citations (our own wiki)
    const blockedDomains = [
      'longtermwiki.com', 'www.longtermwiki.com',
      'longterm.wiki', 'www.longterm.wiki',
    ];
    if (blockedDomains.includes(parsedUrl.hostname)) {
      console.warn(`    [!] Blocked circular citation: ${parsed.url}`);
      return null;
    }

    // Warn about fragile URLs (database IDs, temp pages)
    if (/\/rec[A-Za-z0-9]{10,}/.test(parsed.url)) {
      console.warn(`    [!] Fragile URL (database ID): ${parsed.url}`);
      return null;
    }

    return {
      url: parsed.url,
      title: parsed.title || '',
      snippet: parsed.snippet || '',
    };
  } catch (e) {
    console.warn(`    Warning: source search failed for "${claim.text.slice(0, 50)}...": ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

// ── Source content fetching ──────────────────────────────────────────

/**
 * Thin wrapper around the shared cache-only fetchSourceContent.
 * Returns the cached content as a plain string, or null on miss/error.
 * No live HTTP fetching — the resource-ingest pipeline populates the cache.
 */
async function fetchSourceContent(url: string): Promise<string | null> {
  const result = await fetchCachedContent(url, undefined, '[add-citations]');
  return result.content;
}

// ── Independent claim sourcing ───────────────────────────────────

type VerifyVerdict = 'supported' | 'contradicted' | 'insufficient';

/**
 * Independently verify whether fetched source content supports a claim.
 * This is the critical quality gate — prevents inserting citations where
 * the source doesn't actually say what we claim it says.
 */
async function verifyClaimAgainstContent(
  claim: ExtractedClaim,
  sourceContent: string,
  client: ReturnType<typeof createLlmClient>,
  costTracker: CostTracker,
): Promise<{ verdict: VerifyVerdict; reasoning: string }> {
  const result = await callLlm(client, {
    system: `You verify whether source text supports a specific factual claim. Be strict.

Output JSON:
{
  "verdict": "supported" | "contradicted" | "insufficient",
  "reasoning": "One sentence explaining why"
}

Rules:
- "supported": The source text EXPLICITLY states or clearly implies the claim. The specific facts (numbers, dates, names) must match.
- "contradicted": The source text explicitly states something different from the claim.
- "insufficient": The source text doesn't address this specific claim, or is too vague to confirm it. When in doubt, say "insufficient".
- Be STRICT: the source must contain the specific information, not just be about the same topic.`,
    user: `Claim to verify: "${claim.text}"${claim.keyValue ? `\n(Key value: ${claim.keyValue})` : ''}

Source content (first ${sourceContent.length} chars):
${sourceContent.slice(0, 4000)}

Does this source text support the claim?`,
  }, {
    model: MODELS.haiku,
    maxTokens: 300,
    retryLabel: 'verify-against-content',
  });

  if (result.usage) costTracker.record(MODELS.haiku, result.usage, 'verify-content');

  const parsed = parseJsonFromLlm<{ verdict: VerifyVerdict; reasoning: string }>(
    result.text,
    'verify-content',
    () => ({ verdict: 'insufficient' as VerifyVerdict, reasoning: 'Failed to parse' }),
  );

  const validVerdicts = new Set<VerifyVerdict>(['supported', 'contradicted', 'insufficient']);
  return {
    verdict: validVerdicts.has(parsed.verdict) ? parsed.verdict : 'insufficient',
    reasoning: parsed.reasoning || '',
  };
}

// ── Footnote ID generation ───────────────────────────────────────────

function generateRefId(data: string, existingIds: Set<string>): string {
  const hash = createHash('sha256').update(data).digest('hex');
  for (let offset = 0; offset < hash.length - 4; offset++) {
    const candidate = `rc-${hash.slice(offset, offset + 4)}`;
    if (!existingIds.has(candidate)) {
      existingIds.add(candidate);
      return candidate;
    }
  }
  const fallback = `rc-${hash.slice(0, 8)}`;
  existingIds.add(fallback);
  return fallback;
}

// ── Claim-to-line mapping ────────────────────────────────────────────

/**
 * Find the line in the MDX content where a claim's source text appears,
 * and the best position to insert a footnote reference.
 *
 * Returns the line index and character position after which to insert [^rc-XXXX].
 * Targets the end of the sentence containing the claim.
 */
function findInsertionPoint(
  claim: ExtractedClaim,
  lines: string[],
): { line: number; col: number } | null {
  // Build search terms from the claim
  const searchTerms: string[] = [];

  if (claim.keyValue && claim.keyValue.length > 2) {
    searchTerms.push(claim.keyValue.toLowerCase());
  }

  const numbers = claim.text.toLowerCase().match(/\d[\d,.]+/g);
  if (numbers) {
    for (const num of numbers) {
      if (num.length >= 2) searchTerms.push(num);
    }
  }

  // Also use a distinctive phrase
  const words = claim.text.toLowerCase().split(/\s+/).filter(w => w.length > 4);
  if (words.length >= 3) {
    searchTerms.push(words.slice(0, 4).join(' '));
  }

  if (searchTerms.length === 0) return null;

  // Find where frontmatter ends
  let bodyStart = 0;
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        bodyStart = i + 1;
        break;
      }
    }
  }

  // Track code/Mermaid blocks to skip
  let insideCodeBlock = false;
  let insideMermaidOrComponent = false;

  // Search lines for the best match (skip frontmatter, imports, tables, headings)
  for (let i = bodyStart; i < lines.length; i++) {
    const rawTrimmed = lines[i].trim();

    // Track code blocks (```)
    if (rawTrimmed.startsWith('```')) {
      insideCodeBlock = !insideCodeBlock;
      continue;
    }
    if (insideCodeBlock) continue;

    // Track Mermaid/JSX component blocks
    if (/^<Mermaid\s/.test(rawTrimmed) || /chart=\{`$/.test(rawTrimmed)) {
      insideMermaidOrComponent = true;
      continue;
    }
    if (insideMermaidOrComponent) {
      if (rawTrimmed === '`} />' || rawTrimmed === '/>') {
        insideMermaidOrComponent = false;
      }
      continue;
    }

    // Skip non-prose lines
    if (rawTrimmed.startsWith('|')) continue;          // table rows
    if (rawTrimmed.startsWith('import ')) continue;     // imports
    if (rawTrimmed.startsWith('export ')) continue;     // exports
    if (rawTrimmed.startsWith('#')) continue;           // headings
    if (rawTrimmed.startsWith('[^')) continue;          // footnote definitions
    if (rawTrimmed.startsWith('- [')) continue;         // reference list items (links)
    if (rawTrimmed.length < 20) continue;              // very short lines
    // Skip self-closing component lines like <Mermaid ... /> or <Aside ...>
    if (/^<[A-Z]\w+[^>]*\/>$/.test(rawTrimmed)) continue;

    // Strip tags for matching to a fixed point so spliced-together angle
    // brackets can't re-form a tag.
    let lineStripped = lines[i].toLowerCase();
    let linePrev: string;
    do {
      linePrev = lineStripped;
      lineStripped = lineStripped.replace(/<[^>]+>/g, '');
    } while (lineStripped !== linePrev);
    const lineLower = lineStripped
      .replace(/\[\^[\w:.-]+\]/g, '') // strip existing footnotes
      .replace(/\\(\$)/g, '$1');      // unescape

    let matchCount = 0;
    for (const term of searchTerms) {
      if (lineLower.includes(term)) matchCount++;
    }

    const singleTermMatch = searchTerms.length === 1 || searchTerms[0] === claim.keyValue?.toLowerCase();
    if (matchCount >= 2 || (matchCount >= 1 && singleTermMatch)) {
      // Found the line. Find the sentence end closest to where the claim content is.
      const rawLine = lines[i];

      // Find the position of the key term in the raw line
      const keyTerm = searchTerms[0];
      const keyIdx = rawLine.toLowerCase().indexOf(keyTerm);
      if (keyIdx === -1) continue;

      // Find the next sentence-ending punctuation after the key term
      const afterKey = rawLine.slice(keyIdx);
      const sentenceEnd = afterKey.match(/[.!?](?:\[\^[\w:.-]+\])*(?:\s|$)/);
      if (sentenceEnd && sentenceEnd.index !== undefined) {
        // Insert after the period (and any existing footnotes)
        const periodPos = keyIdx + sentenceEnd.index;
        // Find the end of any existing footnote chain
        const afterPeriod = rawLine.slice(periodPos);
        const footnoteChain = afterPeriod.match(/^[.!?](\[\^[\w:.-]+\])*/);
        const insertCol = periodPos + (footnoteChain ? footnoteChain[0].length : 1);
        return { line: i, col: insertCol };
      }

      // Fallback: insert at end of line before any trailing whitespace
      return { line: i, col: rawLine.trimEnd().length };
    }
  }

  return null;
}

// ── Main command ─────────────────────────────────────────────────────

export async function addCitationsCommand(
  pageId: string,
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = !!options.dryRun;
  const budget = Number(options.budget) || 3;
  const limit = Number(options.limit) || 20;
  const startTime = Date.now();

  // Load page
  const loadedPage = findPageById(pageId);
  if (!loadedPage) {
    return { exitCode: 1, output: `Page not found: ${pageId}` };
  }
  // Narrow to non-null for the closure body — TS doesn't propagate the
  // `if (!page)` narrowing across a nested function declaration.
  const page = loadedPage;

  console.log(`\n  Adding citations to: ${page.title} (${page.slug})`);
  console.log(`  Mode: ${dryRun ? 'dry-run' : 'apply'}, limit: ${limit}, budget: $${budget}\n`);

  const costTracker = new CostTracker();

  async function addCitationsBody(): Promise<CommandResult> {
  // Step 1: Extract claims and classify
  console.log('  [1/4] Extracting claims...');
  const claims = await extractClaims(page.content);
  const footnotedParagraphs = extractFootnotedSentences(page.content);

  const uncitedCheckWorthy = claims
    .filter(c => !claimHasCitation(c, footnotedParagraphs) && isCheckWorthy(c))
    .slice(0, limit);

  console.log(`         ${claims.length} claims, ${uncitedCheckWorthy.length} uncited check-worthy (processing up to ${limit})`);

  if (uncitedCheckWorthy.length === 0) {
    return { exitCode: 0, output: `No uncited check-worthy claims found in ${page.title}` };
  }

  // Step 2: Find sources for uncited claims
  console.log('  [2/4] Finding sources...');
  const client = createLlmClient();

  // Collect existing footnote IDs to avoid collisions
  const existingIds = new Set<string>();
  const existingRefPattern = /\[\^((?:rc|cr)-[a-f0-9]+|kb-[^\]]+)\]/g;
  let match;
  while ((match = existingRefPattern.exec(page.content)) !== null) {
    existingIds.add(match[1]);
  }

  const citationsToAdd: CitationToAdd[] = [];
  const usedPositions = new Set<string>();  // track which (line,col) already got a citation
  const usedUrls = new Map<string, string>();   // URL → refId (reuse ref for same source)
  const lines = page.content.split('\n');

  for (const claim of uncitedCheckWorthy) {
    if (costTracker.totalCost >= budget) {
      console.log(`         Budget limit reached ($${budget})`);
      break;
    }

    // Steps A-C: Find source, fetch content, verify — with retry on failure
    const MAX_SOURCE_ATTEMPTS = 3;
    const avoidDomains: string[] = [];
    let verifiedSource: FoundSource | null = null;
    let verifiedContent: string | null = null;

    for (let attempt = 0; attempt < MAX_SOURCE_ATTEMPTS; attempt++) {
      if (costTracker.totalCost >= budget) break;

      // Step A: Find a candidate source URL via web search
      const source = await findSourceForClaim(claim, client, costTracker, avoidDomains);
      if (!source) {
        if (attempt === 0) console.log(`    [-] No source found: ${claim.text.slice(0, 60)}...`);
        break; // no point retrying if search returns nothing
      }

      // If we already verified this URL, reuse the existing refId
      if (usedUrls.has(source.url)) {
        verifiedSource = source;
        verifiedContent = null; // already verified
        break;
      }

      // Step B: Fetch the actual source content
      const sourceContent = await fetchSourceContent(source.url);
      if (!sourceContent) {
        const domain = new URL(source.url).hostname;
        avoidDomains.push(domain);
        if (attempt < MAX_SOURCE_ATTEMPTS - 1) {
          console.log(`    [↻] Can't fetch ${domain} — retrying with different source...`);
        } else {
          console.log(`    [!] Can't fetch any source for: ${claim.text.slice(0, 50)}...`);
        }
        continue;
      }

      // Step C: Independently verify the claim against fetched content
      const claimCheck = await verifyClaimAgainstContent(claim, sourceContent, client, costTracker);
      if (claimCheck.verdict !== 'supported') {
        const domain = new URL(source.url).hostname;
        avoidDomains.push(domain);
        if (attempt < MAX_SOURCE_ATTEMPTS - 1) {
          console.log(`    [↻] Source doesn't verify (${claimCheck.verdict}) — retrying...`);
        } else {
          console.log(`    [✗] No verified source found: ${claim.text.slice(0, 50)}...`);
          if (claimCheck.reasoning) console.log(`        ${claimCheck.reasoning}`);
        }
        continue;
      }

      // Success — source found, fetched, and verified
      verifiedSource = source;
      verifiedContent = sourceContent;
      break;
    }

    if (!verifiedSource) continue;

    // Step D: Find insertion point in the MDX
    const insertion = findInsertionPoint(claim, lines);
    if (!insertion) {
      console.log(`    [?] Can't find insertion point: ${claim.text.slice(0, 60)}...`);
      continue;
    }

    // Skip if this exact position already got a citation in this run
    const posKey = `${insertion.line},${insertion.col}`;
    if (usedPositions.has(posKey)) {
      console.log(`    [=] Position ${insertion.line + 1}:${insertion.col} already cited, skipping`);
      continue;
    }

    // Reuse existing refId for same URL, or generate a new one
    const refId = usedUrls.get(verifiedSource.url) ?? generateRefId(`cite:${page.slug}:${verifiedSource.url}`, existingIds);

    citationsToAdd.push({
      claim,
      source: verifiedSource,
      refId,
      insertionLine: insertion.line,
      insertionColumn: insertion.col,
    });

    usedPositions.add(posKey);
    if (!usedUrls.has(verifiedSource.url)) {
      usedUrls.set(verifiedSource.url, refId);
    }

    console.log(`    [✓] VERIFIED: ${claim.text.slice(0, 50)}... → ${verifiedSource.url.slice(0, 50)}`);
  }

  console.log(`\n  [3/4] ${citationsToAdd.length} citations to add`);

  if (citationsToAdd.length === 0) {
    return {
      exitCode: 0,
      output: `No sources found for uncited claims in ${page.title}. Cost: $${costTracker.totalCost.toFixed(3)}`,
    };
  }

  // Step 3: Apply changes to the MDX
  if (dryRun) {
    const output = formatDryRun(page.title, citationsToAdd, costTracker.totalCost, Date.now() - startTime);
    return { exitCode: 0, output };
  }

  console.log('  [4/4] Inserting footnotes...');

  // Sort insertions by line (reverse) so we can insert without offset issues
  const sorted = [...citationsToAdd].sort((a, b) => {
    if (a.insertionLine !== b.insertionLine) return b.insertionLine - a.insertionLine;
    return b.insertionColumn - a.insertionColumn;
  });

  const modifiedLines = [...lines];

  for (const citation of sorted) {
    const line = modifiedLines[citation.insertionLine];
    const ref = `[^${citation.refId}]`;
    modifiedLines[citation.insertionLine] =
      line.slice(0, citation.insertionColumn) + ref + line.slice(citation.insertionColumn);
  }

  // Add footnote definitions at the end
  const escapeLinkText = (text: string) =>
    text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]');

  // Only add footnote defs for unique refIds (avoid duplicates when URL is reused)
  const addedRefIds = new Set<string>();
  modifiedLines.push('');
  for (const citation of citationsToAdd) {
    if (addedRefIds.has(citation.refId)) continue;
    addedRefIds.add(citation.refId);
    const label = escapeLinkText(citation.source.title || 'Source');
    const destination = `<${citation.source.url.replace(/>/g, '%3E')}>`;
    const def = `[^${citation.refId}]: [${label}](${destination})`;
    modifiedLines.push(def);
  }

  const newContent = modifiedLines.join('\n');
  fs.writeFileSync(page.filePath, newContent);

  console.log(`\n  Done. Added ${citationsToAdd.length} citations to ${page.filePath}`);

  const output = [
    `\n  Citation Addition Report: ${page.title}`,
    `  ${'─'.repeat(50)}`,
    `  Citations added: ${citationsToAdd.length}`,
    `  Cost: $${costTracker.totalCost.toFixed(3)}`,
    `  Duration: ${((Date.now() - startTime) / 1000).toFixed(1)}s`,
    '',
    '  Added:',
    ...citationsToAdd.map(c => `    [^${c.refId}] ${c.claim.text.slice(0, 50)}... → ${c.source.url.slice(0, 50)}`),
  ].join('\n');

  return { exitCode: 0, output };
  }

  return withPipelineRun(
    {
      pipelineName: 'add-citations',
      entityId: page.slug,
      shape: dryRun ? 'dry-run' : 'apply',
      allowOffline: true,
      tracker: costTracker,
    },
    addCitationsBody,
  );
}

// ── Dry run formatting ───────────────────────────────────────────────

function formatDryRun(
  title: string,
  citations: CitationToAdd[],
  cost: number,
  durationMs: number,
): string {
  const lines: string[] = [];
  lines.push(`\n  Citation Addition DRY RUN: ${title}`);
  lines.push(`  ${'─'.repeat(50)}`);
  lines.push(`  Would add ${citations.length} citations`);
  lines.push(`  Cost so far: $${cost.toFixed(3)}`);
  lines.push(`  Duration: ${(durationMs / 1000).toFixed(1)}s`);
  lines.push('');

  for (const c of citations) {
    lines.push(`  Line ${c.insertionLine + 1}: [^${c.refId}]`);
    lines.push(`    Claim: ${c.claim.text}`);
    lines.push(`    Source: ${c.source.title || c.source.url}`);
    lines.push(`    URL: ${c.source.url}`);
    lines.push('');
  }

  lines.push('  Run without --dry-run to apply.');
  return lines.join('\n');
}
