/**
 * Auto-Verify Stakeholder Positions
 *
 * Fetches source URLs for stakeholder positions on policy entities,
 * sends the content to an LLM for verification, and records results
 * via the wiki-server API.
 *
 * Subcommands:
 *   verify    Verify stakeholder positions against their source URLs
 *
 * Flags:
 *   --policy=<id>     Only verify stakeholders for one policy entity
 *   --dry-run         Show what would be verified without API calls
 *   --budget=<N>      Maximum number of LLM calls to make (default: unlimited)
 *   --json            Output results as JSON
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { PROJECT_ROOT } from '../../lib/content-types.ts';
import { createLlmClient, callLlm, MODELS } from '../../lib/llm.ts';
import { CostTracker } from '../../lib/cost-tracker.ts';
import { fetchSource } from '../../lib/search/source-fetcher.ts';
import {
  getVerdictByRecord,
  storeEvidence,
  storeVerdict,
  type VerdictByRecordResult,
} from '../../lib/wiki-server/verifications.ts';
import { createLogger } from '../../lib/output.ts';
import { parseIntOpt, type CommandResult } from '../../lib/cli.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Stakeholder {
  name: string;
  entityId?: string;
  position: 'support' | 'oppose' | 'neutral' | 'mixed';
  reason?: string;
  source?: string;
  context?: string[];
}

interface PolicyEntity {
  id: string;
  stableId: string;
  wikiId?: string;
  type: string;
  title: string;
  stakeholders?: Stakeholder[];
}

type VerificationVerdict = 'confirmed' | 'contradicted' | 'partial' | 'unverifiable';

interface VerificationResult {
  policyId: string;
  policyTitle: string;
  stakeholderName: string;
  position: string;
  reason?: string;
  sourceUrl: string;
  verdict: VerificationVerdict;
  confidence: number;
  extractedEvidence: string;
  notes: string;
  sourceStatus: string;
  skipped: boolean;
  skipReason?: string;
}

interface ExistingVerdict {
  recordType: string;
  recordId: string;
  verdict: string;
  confidence: number | null;
  needsRecheck: boolean;
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadPolicyEntities(): PolicyEntity[] {
  const yamlPath = join(PROJECT_ROOT, 'data/entities/responses.yaml');
  const raw = readFileSync(yamlPath, 'utf-8');
  const entities = parseYaml(raw) as PolicyEntity[];

  return entities.filter(
    (e) => e.type === 'policy' && Array.isArray(e.stakeholders) && e.stakeholders.length > 0,
  );
}

/**
 * Build a record ID for a stakeholder position verification.
 */
function buildStakeholderRecordId(policyId: string, stakeholderName: string): string {
  const slug = stakeholderName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return `${policyId}:${slug}`;
}

const STAKEHOLDER_RECORD_TYPE = 'policy-stakeholder';

// ---------------------------------------------------------------------------
// Existing verdict check
// ---------------------------------------------------------------------------

async function getExistingVerdict(recordId: string): Promise<ExistingVerdict | null> {
  const result = await getVerdictByRecord(STAKEHOLDER_RECORD_TYPE, recordId);

  if (result.ok && result.data.verdicts.length > 0) {
    return result.data.verdicts[0] as unknown as ExistingVerdict;
  }

  // 404 = no verdict yet, which is fine
  if (!result.ok && result.message.startsWith('404')) {
    return null;
  }

  // For other errors (unavailable, timeout), log and return null
  if (!result.ok) {
    console.warn(`[auto-verify] Could not check existing verdict for ${recordId}: ${result.message}`);
    return null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// LLM verification
// ---------------------------------------------------------------------------

interface LlmVerificationResult {
  verdict: VerificationVerdict;
  confidence: number;
  extractedEvidence: string;
  notes: string;
}

async function verifyStakeholderPosition(
  client: ReturnType<typeof createLlmClient>,
  tracker: CostTracker,
  stakeholder: Stakeholder,
  policyTitle: string,
  sourceContent: string,
): Promise<LlmVerificationResult> {
  const prompt = `You are verifying a stakeholder position claim against a source document.

CLAIM TO VERIFY:
- Stakeholder: ${stakeholder.name}
- Policy: ${policyTitle}
- Stated position: ${stakeholder.position}
- Stated reason: ${stakeholder.reason || '(none provided)'}

SOURCE CONTENT (from ${stakeholder.source}):
${sourceContent.slice(0, 50_000)}

INSTRUCTIONS:
Based on the source content above, verify whether it supports the claimed position.
Respond in exactly this JSON format (no markdown fencing):

{
  "verdict": "<one of: confirmed, contradicted, partial, unverifiable>",
  "confidence": <number between 0.0 and 1.0>,
  "extractedEvidence": "<specific text from the source that supports or contradicts the claim, max 500 chars>",
  "notes": "<brief explanation of your verdict, max 300 chars>"
}

VERDICT DEFINITIONS:
- "confirmed": The source clearly confirms the stakeholder's position and reason
- "contradicted": The source contradicts the claimed position or reason
- "partial": The source partially confirms the position but some details differ
- "unverifiable": The source does not contain enough information to verify the claim

Be conservative: if the source is ambiguous or doesn't mention the stakeholder, use "unverifiable".
If the source mentions the stakeholder but with a different position, use "contradicted".
If the position matches but the reason is different, use "partial".`;

  const result = await callLlm(client, prompt, {
    model: MODELS.haiku,
    maxTokens: 1000,
    temperature: 0,
    tracker,
    label: 'verify-stakeholder',
    retryLabel: 'verify-stakeholder',
  });

  try {
    // Try to parse the JSON response, handling possible markdown code blocks
    let text = result.text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    const parsed = JSON.parse(text) as {
      verdict?: string;
      confidence?: number;
      extractedEvidence?: string;
      notes?: string;
    };

    const validVerdicts: VerificationVerdict[] = ['confirmed', 'contradicted', 'partial', 'unverifiable'];
    const verdict = validVerdicts.includes(parsed.verdict as VerificationVerdict)
      ? (parsed.verdict as VerificationVerdict)
      : 'unverifiable';

    const confidence = typeof parsed.confidence === 'number'
      ? Math.max(0, Math.min(1, parsed.confidence))
      : 0.5;

    return {
      verdict,
      confidence,
      extractedEvidence: (parsed.extractedEvidence || '').slice(0, 500),
      notes: (parsed.notes || '').slice(0, 300),
    };
  } catch (parseErr: unknown) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    console.warn(`[auto-verify] Failed to parse LLM response: ${msg}`);
    return {
      verdict: 'unverifiable',
      confidence: 0.0,
      extractedEvidence: '',
      notes: `LLM response parsing failed: ${msg.slice(0, 200)}`,
    };
  }
}

// ---------------------------------------------------------------------------
// Recording results to wiki-server
// ---------------------------------------------------------------------------

interface PostVerificationBody {
  recordType: string;
  recordId: string;
  sourceUrl: string;
  fieldName: string;
  expectedValue: string;
  verdict: VerificationVerdict;
  confidence: number;
  extractedValue: string;
  checkerModel: string;
  isPrimarySource: boolean;
  notes: string;
}

interface PostVerdictBody {
  recordType: string;
  recordId: string;
  verdict: VerificationVerdict | 'unchecked';
  confidence: number;
  reasoning: string;
  sourcesChecked: number;
}

async function recordVerification(verification: PostVerificationBody): Promise<boolean> {
  const result = await storeEvidence(verification as unknown as Record<string, unknown>);
  if (!result.ok) {
    console.warn(`[auto-verify] Failed to record verification: ${result.message}`);
    return false;
  }
  return true;
}

async function recordVerdict(verdict: PostVerdictBody): Promise<boolean> {
  const result = await storeVerdict(verdict as unknown as Record<string, unknown>);
  if (!result.ok) {
    console.warn(`[auto-verify] Failed to record verdict: ${result.message}`);
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Main verification pipeline
// ---------------------------------------------------------------------------

interface VerifyOptions {
  policy?: string;
  dryRun?: boolean;
  budget?: string | number;
  json?: boolean;
  ci?: boolean;
  [key: string]: unknown;
}

async function verify(_args: string[], options: VerifyOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const dryRun = Boolean(options.dryRun);
  const budgetLimit = parseIntOpt(options.budget, 0); // 0 = unlimited
  const policyFilter = options.policy as string | undefined;

  // 1. Load policy entities
  const policyEntities = loadPolicyEntities();
  const filtered = policyFilter
    ? policyEntities.filter((p) => p.id === policyFilter)
    : policyEntities;

  if (filtered.length === 0) {
    const msg = policyFilter
      ? `No policy entity found with id "${policyFilter}"`
      : 'No policy entities with stakeholders found in responses.yaml';
    return { output: msg, exitCode: 1 };
  }

  // 2. Collect all stakeholders with source URLs
  interface StakeholderWithPolicy {
    policy: PolicyEntity;
    stakeholder: Stakeholder;
    thingId: string;
  }

  const allStakeholders: StakeholderWithPolicy[] = [];
  for (const policy of filtered) {
    for (const stakeholder of policy.stakeholders || []) {
      if (!stakeholder.source) continue;
      const thingId = buildStakeholderRecordId(policy.id, stakeholder.name);
      allStakeholders.push({ policy, stakeholder, thingId });
    }
  }

  if (allStakeholders.length === 0) {
    return { output: 'No stakeholders with source URLs found.', exitCode: 0 };
  }

  console.log(`${c.bold}Auto-Verify Stakeholder Positions${c.reset}`);
  console.log(`${c.dim}Found ${allStakeholders.length} stakeholders with source URLs across ${filtered.length} policies${c.reset}`);

  if (dryRun) {
    console.log(`\n${c.yellow}DRY RUN — no API calls will be made${c.reset}\n`);
  }

  // 3. Filter out already-verified stakeholders
  const toVerify: StakeholderWithPolicy[] = [];
  const skippedAlreadyVerified: VerificationResult[] = [];

  for (const item of allStakeholders) {
    if (dryRun) {
      // In dry-run mode, include everything
      toVerify.push(item);
      continue;
    }

    const existingVerdict = await getExistingVerdict(item.thingId);
    if (existingVerdict && !existingVerdict.needsRecheck) {
      skippedAlreadyVerified.push({
        policyId: item.policy.id,
        policyTitle: item.policy.title,
        stakeholderName: item.stakeholder.name,
        position: item.stakeholder.position,
        reason: item.stakeholder.reason,
        sourceUrl: item.stakeholder.source!,
        verdict: existingVerdict.verdict as VerificationVerdict,
        confidence: existingVerdict.confidence ?? 0,
        extractedEvidence: '',
        notes: 'Already verified — skipped',
        sourceStatus: 'cached',
        skipped: true,
        skipReason: 'already-verified',
      });
      continue;
    }
    toVerify.push(item);
  }

  if (skippedAlreadyVerified.length > 0) {
    console.log(`${c.dim}Skipping ${skippedAlreadyVerified.length} already-verified stakeholders${c.reset}`);
  }

  // 4. Apply budget limit
  const effectiveBudget = budgetLimit > 0 ? budgetLimit : toVerify.length;
  const limited = toVerify.slice(0, effectiveBudget);

  if (budgetLimit > 0 && toVerify.length > budgetLimit) {
    console.log(`${c.yellow}Budget limit: processing ${budgetLimit} of ${toVerify.length} remaining stakeholders${c.reset}`);
  }

  console.log(`\n${c.bold}Processing ${limited.length} stakeholders...${c.reset}\n`);

  // 5. Dry run output
  if (dryRun) {
    let output = `\n${c.bold}Stakeholders to verify:${c.reset}\n\n`;
    for (const item of limited) {
      output += `  ${c.cyan}${item.policy.id}${c.reset} / ${item.stakeholder.name}\n`;
      output += `    Position: ${item.stakeholder.position}\n`;
      output += `    Source: ${item.stakeholder.source}\n`;
      output += `    Thing ID: ${item.thingId}\n\n`;
    }
    output += `\n${c.dim}Total: ${limited.length} stakeholders would be verified${c.reset}\n`;

    if (options.json) {
      return {
        output: JSON.stringify(
          limited.map((i) => ({
            policyId: i.policy.id,
            stakeholderName: i.stakeholder.name,
            position: i.stakeholder.position,
            sourceUrl: i.stakeholder.source,
            thingId: i.thingId,
          })),
          null,
          2,
        ),
        exitCode: 0,
      };
    }

    return { output, exitCode: 0 };
  }

  // 6. Create LLM client and cost tracker
  let client: ReturnType<typeof createLlmClient>;
  try {
    client = createLlmClient();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Failed to create LLM client: ${msg}`, exitCode: 1 };
  }
  const tracker = new CostTracker();

  // 7. Process each stakeholder
  const results: VerificationResult[] = [...skippedAlreadyVerified];
  let verified = 0;
  let failed = 0;

  for (const item of limited) {
    const { policy, stakeholder, thingId } = item;
    const sourceUrl = stakeholder.source!;

    console.log(`  ${c.dim}[${verified + failed + 1}/${limited.length}]${c.reset} ${policy.id} / ${stakeholder.name}...`);

    // 7a. Fetch source content
    let sourceContent: string;
    let sourceStatus: string;
    try {
      const fetched = await fetchSource({
        url: sourceUrl,
        extractMode: 'full',
      });

      sourceStatus = fetched.status;

      if (fetched.status !== 'ok' || !fetched.content || fetched.content.length < 50) {
        const reason = fetched.status === 'dead'
          ? 'Source URL is dead'
          : fetched.status === 'paywall'
            ? 'Source is behind a paywall'
            : fetched.content.length < 50
              ? 'Source content too short to verify'
              : `Source fetch status: ${fetched.status}`;

        results.push({
          policyId: policy.id,
          policyTitle: policy.title,
          stakeholderName: stakeholder.name,
          position: stakeholder.position,
          reason: stakeholder.reason,
          sourceUrl,
          verdict: 'unverifiable',
          confidence: 0,
          extractedEvidence: '',
          notes: reason,
          sourceStatus,
          skipped: true,
          skipReason: 'fetch-failed',
        });
        console.log(`    ${c.yellow}skipped (${reason})${c.reset}`);
        failed++;
        continue;
      }

      sourceContent = fetched.content;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        policyId: policy.id,
        policyTitle: policy.title,
        stakeholderName: stakeholder.name,
        position: stakeholder.position,
        reason: stakeholder.reason,
        sourceUrl,
        verdict: 'unverifiable',
        confidence: 0,
        extractedEvidence: '',
        notes: `Fetch error: ${msg.slice(0, 200)}`,
        sourceStatus: 'error',
        skipped: true,
        skipReason: 'fetch-error',
      });
      console.log(`    ${c.red}fetch error: ${msg.slice(0, 100)}${c.reset}`);
      failed++;
      continue;
    }

    // 7b. LLM verification
    let llmResult: LlmVerificationResult;
    try {
      llmResult = await verifyStakeholderPosition(
        client,
        tracker,
        stakeholder,
        policy.title,
        sourceContent,
      );
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      results.push({
        policyId: policy.id,
        policyTitle: policy.title,
        stakeholderName: stakeholder.name,
        position: stakeholder.position,
        reason: stakeholder.reason,
        sourceUrl,
        verdict: 'unverifiable',
        confidence: 0,
        extractedEvidence: '',
        notes: `LLM error: ${msg.slice(0, 200)}`,
        sourceStatus,
        skipped: true,
        skipReason: 'llm-error',
      });
      console.log(`    ${c.red}LLM error: ${msg.slice(0, 100)}${c.reset}`);
      failed++;
      continue;
    }

    // 7c. Record verification to wiki-server
    const recordedVerification = await recordVerification({
      recordType: STAKEHOLDER_RECORD_TYPE,
      recordId: thingId,
      sourceUrl,
      fieldName: 'position',
      expectedValue: `${stakeholder.position}: ${stakeholder.reason || ''}`.slice(0, 5000),
      verdict: llmResult.verdict,
      confidence: llmResult.confidence,
      extractedValue: llmResult.extractedEvidence.slice(0, 5000),
      checkerModel: MODELS.haiku,
      isPrimarySource: true,
      notes: llmResult.notes.slice(0, 10000),
    });

    if (!recordedVerification) {
      console.log(`    ${c.yellow}warning: failed to record verification to wiki-server${c.reset}`);
    }

    // 7d. Update aggregate verdict
    const recordedVerdict = await recordVerdict({
      recordType: STAKEHOLDER_RECORD_TYPE,
      recordId: thingId,
      verdict: llmResult.verdict,
      confidence: llmResult.confidence,
      reasoning: llmResult.notes,
      sourcesChecked: 1,
    });

    if (!recordedVerdict) {
      console.log(`    ${c.yellow}warning: failed to record verdict to wiki-server${c.reset}`);
    }

    const verdictColor = llmResult.verdict === 'confirmed'
      ? c.green
      : llmResult.verdict === 'contradicted'
        ? c.red
        : llmResult.verdict === 'partial'
          ? c.yellow
          : c.dim;

    console.log(`    ${verdictColor}${llmResult.verdict}${c.reset} (${(llmResult.confidence * 100).toFixed(0)}% confidence)`);

    results.push({
      policyId: policy.id,
      policyTitle: policy.title,
      stakeholderName: stakeholder.name,
      position: stakeholder.position,
      reason: stakeholder.reason,
      sourceUrl,
      verdict: llmResult.verdict,
      confidence: llmResult.confidence,
      extractedEvidence: llmResult.extractedEvidence,
      notes: llmResult.notes,
      sourceStatus,
      skipped: false,
    });

    verified++;
  }

  // 8. Summary output
  const activeResults = results.filter((r) => !r.skipped);
  const confirmed = activeResults.filter((r) => r.verdict === 'confirmed').length;
  const contradicted = activeResults.filter((r) => r.verdict === 'contradicted').length;
  const partial = activeResults.filter((r) => r.verdict === 'partial').length;
  const unverifiable = activeResults.filter((r) => r.verdict === 'unverifiable').length;

  let output = `\n${c.bold}Verification Summary${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(50)}${c.reset}\n`;
  output += `  ${c.green}Confirmed:${c.reset}    ${confirmed}\n`;
  output += `  ${c.red}Contradicted:${c.reset} ${contradicted}\n`;
  output += `  ${c.yellow}Partial:${c.reset}      ${partial}\n`;
  output += `  ${c.dim}Unverifiable:${c.reset} ${unverifiable}\n`;
  output += `  Skipped:       ${results.filter((r) => r.skipped).length}\n`;
  output += `  Failed:        ${failed}\n`;
  output += `\n  Cost: $${tracker.totalCost.toFixed(4)}\n`;
  output += `  Tokens: ${tracker.totalTokens.input} in / ${tracker.totalTokens.output} out\n`;

  if (options.json) {
    return {
      output: JSON.stringify(
        {
          results,
          summary: { confirmed, contradicted, partial, unverifiable, skipped: skippedAlreadyVerified.length, failed },
          cost: tracker.toJSON(),
        },
        null,
        2,
      ),
      exitCode: contradicted > 0 ? 1 : 0,
    };
  }

  return { output, exitCode: contradicted > 0 ? 1 : 0 };
}

// ── Command Registry ────────────────────────────────────────────────────────

export const commands = {
  default: verify,
  verify,
};

export function getHelp(): string {
  return `
Auto-Verify Stakeholder Positions

Verifies stakeholder position claims in policy entities against their source URLs.
Fetches source content, uses an LLM to check claims, and records results via wiki-server.

Commands:
  verify (default)   Verify stakeholder positions against source URLs

Options:
  --policy=<id>      Only verify stakeholders for one policy (e.g., --policy=california-sb1047)
  --dry-run          Show what would be verified without making any API calls
  --budget=<N>       Maximum number of LLM verification calls (default: unlimited)
  --json             Output results as JSON

Examples:
  pnpm crux w auto-verify-stakeholders --dry-run
  pnpm crux w auto-verify-stakeholders --policy=california-sb1047 --budget=5
  pnpm crux w auto-verify-stakeholders --json
`;
}
