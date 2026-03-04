/**
 * Statement Verification — verify extracted statements against their cited sources.
 *
 * For each statement with citations, fetches the cited source text and uses an
 * LLM to determine whether the source supports the statement.
 *
 * Assigns:
 *   - verdict: "verified" | "unsupported" | "disputed" | "unverified"
 *   - verdictScore: 0-1 confidence
 *   - verdictModel: which LLM did the checking
 *   - sourceQuote: relevant excerpt from the source
 *
 * Usage:
 *   pnpm crux statements verify <page-id>
 *   pnpm crux statements verify <page-id> --apply
 *   pnpm crux statements verify <page-id> --fetch     # fetch missing sources
 *   pnpm crux statements verify <page-id> --model=X
 *
 * Requires: OPENROUTER_API_KEY or ANTHROPIC_API_KEY
 */

import { fileURLToPath } from 'url';
import { parseCliArgs } from '../lib/cli.ts';
import { getColors } from '../lib/output.ts';
import { callOpenRouter, stripCodeFences, parseJsonWithRepair, DEFAULT_CITATION_MODEL } from '../lib/quote-extractor.ts';
import { isServerAvailable } from '../lib/wiki-server/client.ts';
import { patchStatement } from '../lib/wiki-server/statements.ts';
import {
  getStatementsByEntity,
} from '../lib/wiki-server/statements.ts';
import { resolveSource, MIN_SOURCE_CONTENT_LENGTH } from '../lib/citation/citation-auditor.ts';
import { getResourceById } from '../lib/search/resource-lookup.ts';

const MAX_SOURCE_CHARS = 80_000;

// ---------------------------------------------------------------------------
// LLM verification
// ---------------------------------------------------------------------------

type VerificationVerdict = 'verified' | 'unsupported' | 'disputed';

const VERIFY_SYSTEM_PROMPT = `You are a fact-checking assistant. Given a statement from a wiki article and the full text of its cited source, determine whether the source supports the statement.

Verdicts:
- "verified": the source clearly and directly supports the statement
- "unsupported": the source does not contain relevant information to support this statement
- "disputed": the source contains information that contradicts or conflicts with the statement

Rules:
- Be strict: specific numbers, dates, and names must match exactly
- Return "unsupported" only if you've checked the full source
- Keep the explanation concise (1-2 sentences)
- Extract a specific, relevant quote from the source that addresses the statement

Respond ONLY with JSON:
{"verdict": "verified", "relevantQuote": "exact text from source", "explanation": "reason", "confidence": 0.95}`;

async function verifyStatement(
  statementText: string,
  sourceText: string,
  opts: { model?: string } = {},
): Promise<{
  verdict: VerificationVerdict;
  quote: string;
  explanation: string;
  confidence: number;
}> {
  const truncated = sourceText.slice(0, MAX_SOURCE_CHARS);
  const userPrompt = `STATEMENT: ${statementText}\n\nSOURCE TEXT:\n${truncated}\n\nReturn JSON only.`;

  try {
    const raw = await callOpenRouter(VERIFY_SYSTEM_PROMPT, userPrompt, {
      model: opts.model ?? DEFAULT_CITATION_MODEL,
      maxTokens: 800,
      title: 'LongtermWiki Statement Verification',
    });

    const json = stripCodeFences(raw);
    const parsed = parseJsonWithRepair<{
      verdict?: string;
      relevantQuote?: string;
      explanation?: string;
      confidence?: number;
    }>(json);

    const verdict: VerificationVerdict =
      parsed.verdict === 'verified' ? 'verified' :
      parsed.verdict === 'disputed' ? 'disputed' :
      'unsupported';

    return {
      verdict,
      quote: typeof parsed.relevantQuote === 'string' ? parsed.relevantQuote : '',
      explanation: typeof parsed.explanation === 'string' ? parsed.explanation : '',
      confidence: typeof parsed.confidence === 'number' ? Math.max(0, Math.min(1, parsed.confidence)) : (verdict === 'verified' ? 0.8 : 0.5),
    };
  } catch (err) {
    throw new Error(`Verification failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Resolve source text from a resource ID
// ---------------------------------------------------------------------------

async function resolveResourceText(
  resourceId: string,
  fetchMissing: boolean,
): Promise<string | null> {
  // The resource ID might be an rc-XXXX reference — look up the resource
  const resource = getResourceById(resourceId);
  if (resource?.url) {
    const source = await resolveSource(resource.url, undefined, fetchMissing);
    if (source?.content && source.content.length >= MIN_SOURCE_CONTENT_LENGTH) {
      return source.content.slice(0, MAX_SOURCE_CHARS);
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

interface StatementWithCitations {
  id: number;
  statementText: string | null;
  citations: Array<{
    id: number;
    resourceId: string | null;
    url: string | null;
    sourceQuote: string | null;
    isPrimary: boolean;
  }>;
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = !args.apply;
  const fetchMissing = args.fetch === true;
  const model = typeof args.model === 'string' ? args.model : undefined;
  const c = getColors(false);
  const positional = (args._positional as string[]) || [];
  const pageId = positional[0];

  if (!pageId) {
    console.error(`${c.red}Error: provide a page ID${c.reset}`);
    console.error(`  Usage: pnpm crux statements verify <page-id> [--apply] [--fetch] [--model=X]`);
    process.exit(1);
  }

  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.error(`${c.red}Wiki server not available.${c.reset}`);
    process.exit(1);
  }

  // Fetch statements for this entity
  const result = await getStatementsByEntity(pageId);
  if (!result.ok) {
    console.error(`${c.red}Could not fetch statements for ${pageId}. Run extract first.${c.reset}`);
    console.error(`  pnpm crux statements extract ${pageId} --apply`);
    process.exit(1);
  }

  const allStatements: StatementWithCitations[] = [
    ...result.data.structured,
    ...result.data.attributed,
  ];

  if (allStatements.length === 0) {
    console.log(`${c.yellow}No statements found for ${pageId}. Run extract first.${c.reset}`);
    console.log(`  pnpm crux statements extract ${pageId} --apply`);
    process.exit(0);
  }

  console.log(`\n${c.bold}${c.blue}Statement Verification: ${pageId}${c.reset}\n`);
  console.log(`  Statements to verify: ${allStatements.length}`);
  if (dryRun) console.log(`  ${c.yellow}DRY RUN — use --apply to store results${c.reset}`);
  if (fetchMissing) console.log(`  ${c.yellow}--fetch: will fetch missing sources from web${c.reset}`);
  console.log('');

  // Verify each statement
  let verified = 0;
  let unsupported = 0;
  let disputed = 0;
  let noSource = 0;
  let noCitation = 0;
  let noText = 0;
  let errors = 0;

  for (const stmt of allStatements) {
    const text = stmt.statementText;
    if (!text) {
      noText++;
      continue;
    }

    const citations = stmt.citations ?? [];
    if (citations.length === 0) {
      noCitation++;
      process.stdout.write(`  ${c.dim}○ [no-citations] ${text.slice(0, 60)}...${c.reset}\n`);
      continue;
    }

    // Try to find source text from citations
    let sourceText: string | null = null;
    for (const cit of citations) {
      if (cit.resourceId) {
        sourceText = await resolveResourceText(cit.resourceId, fetchMissing);
        if (sourceText) break;
      }
      if (cit.url) {
        const source = await resolveSource(cit.url, undefined, fetchMissing);
        if (source?.content && source.content.length >= MIN_SOURCE_CONTENT_LENGTH) {
          sourceText = source.content.slice(0, MAX_SOURCE_CHARS);
          break;
        }
      }
    }

    if (!sourceText) {
      noSource++;
      process.stdout.write(`  ${c.dim}? [no-source] ${text.slice(0, 60)}...${c.reset}\n`);
      continue;
    }

    // Verify with LLM
    let verificationResult: Awaited<ReturnType<typeof verifyStatement>>;
    try {
      verificationResult = await verifyStatement(text, sourceText, { model });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`  ${c.dim}! [error] ${text.slice(0, 60)}... — ${msg.slice(0, 80)}${c.reset}\n`);
      errors++;
      continue;
    }

    const icon = verificationResult.verdict === 'verified' ? `${c.green}V${c.reset}` :
                 verificationResult.verdict === 'disputed' ? `${c.red}X${c.reset}` :
                 `${c.yellow}?${c.reset}`;
    process.stdout.write(`  ${icon} [${verificationResult.verdict}] ${text.slice(0, 60)}...\n`);

    if (verificationResult.verdict === 'verified') verified++;
    else if (verificationResult.verdict === 'disputed') disputed++;
    else unsupported++;

    // Update statement with verdict (via PATCH)
    if (!dryRun) {
      const patchResult = await patchStatement(stmt.id, {
        verdict: verificationResult.verdict,
        verdictScore: verificationResult.confidence,
        verdictQuotes: verificationResult.quote || null,
        verdictModel: model ?? DEFAULT_CITATION_MODEL,
      });
      if (!patchResult.ok) {
        console.warn(`  ${c.yellow}Failed to update statement ${stmt.id}: ${patchResult.message}${c.reset}`);
        errors++;
      }
    }
  }

  console.log(`\n${c.bold}Verification Summary:${c.reset}`);
  console.log(`  ${c.green}Verified:${c.reset}     ${verified}`);
  console.log(`  ${c.red}Disputed:${c.reset}     ${disputed}`);
  console.log(`  ${c.yellow}Unsupported:${c.reset}  ${unsupported}`);
  console.log(`  ${c.dim}No source:${c.reset}    ${noSource}`);
  console.log(`  ${c.dim}No citations:${c.reset} ${noCitation}`);
  if (noText > 0) console.log(`  ${c.dim}No text:${c.reset}      ${noText}`);
  if (errors > 0) console.log(`  ${c.red}Errors:${c.reset}       ${errors}`);

  // Suggest fetching source content if many are missing
  const sourcedTotal = allStatements.length - noCitation;
  if (noSource > 0 && sourcedTotal > 0 && noSource / sourcedTotal > 0.5) {
    console.log(`\n  ${c.yellow}Most cited statements lack cached source text.${c.reset}`);
    console.log(`  Fetch sources first: pnpm crux citations verify ${pageId}`);
    console.log(`  Then re-run: pnpm crux statements verify ${pageId} --apply`);
  }

  if (dryRun) {
    console.log(`\n${c.green}Dry run complete. Use --apply to store results.${c.reset}\n`);
  } else {
    console.log(`\n${c.green}Verification results stored.${c.reset}`);
    console.log(`  Run: pnpm crux statements quality ${pageId}\n`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error('Statement verification failed:', err);
    process.exit(1);
  });
}
