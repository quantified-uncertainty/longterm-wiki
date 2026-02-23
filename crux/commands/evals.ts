/**
 * Evals Command Handlers
 *
 * Hallucination detection eval framework. Run controlled experiments to
 * measure whether our detection systems catch known errors, and deploy
 * adversarial agents to hunt for hallucinations in the live wiki.
 *
 * Usage:
 *   crux evals run --suite=injection [--pages=id1,id2] [--verbose]
 *   crux evals run --suite=fake-entity [--verbose]
 *   crux evals run --suite=cross-ref [--limit=50]
 *   crux evals hunt --agent=reference-sniffer --page=anthropic [--no-llm]
 *   crux evals hunt --agent=description-auditor --page=miri [--no-llm]
 *   crux evals hunt --agent=cross-ref --limit=100
 *   crux evals inject <page-id> [--count=3] [--categories=wrong-number,exaggeration]
 *   crux evals report
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { CommandResult } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/**
 * Run an eval suite.
 */
async function run(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;
  const verbose = !!(options.verbose ?? false);
  const suite = (options.suite as string) || 'injection';

  if (suite === 'injection') {
    return runInjectionSuite(args, options, verbose, log, c);
  } else if (suite === 'fake-entity') {
    return runFakeEntitySuite(verbose, log, c);
  } else if (suite === 'cross-ref') {
    return runCrossRefSuite(options, verbose, log, c);
  } else {
    return { output: `${c.red}Unknown suite: ${suite}. Available: injection, fake-entity, cross-ref${c.reset}`, exitCode: 1 };
  }
}

async function runInjectionSuite(
  _args: string[],
  options: Record<string, unknown>,
  verbose: boolean,
  log: ReturnType<typeof createLogger>,
  c: ReturnType<typeof createLogger>['colors'],
): Promise<CommandResult> {
  const { evalSuite, loadGoldenPage } = await import('../evals/harness.ts');
  const { formatScoreReport } = await import('../evals/score.ts');

  // Determine which pages to test
  const pageIds = (options.pages as string)?.split(',') || ['anthropic', 'miri'];

  log.info(`Running injection eval on ${pageIds.length} pages...`);

  const pages: Array<{ id: string; content: string }> = [];
  for (const id of pageIds) {
    try {
      const content = await loadGoldenPage(id);
      pages.push({ id, content });
    } catch (err) {
      log.warn(`Could not load page "${id}": ${(err as Error).message}`);
    }
  }

  if (pages.length === 0) {
    return { output: `${c.red}No golden pages found. Provide --pages=id1,id2 or add fixtures.${c.reset}`, exitCode: 1 };
  }

  const categories = (options.categories as string)?.split(',') as import('../evals/types.ts').ErrorCategory[] | undefined;

  const result = await evalSuite(pages, {
    verbose,
    injectionPlan: {
      errorsPerCategory: parseInt(options.count as string || '1', 10),
      categories,
    },
    includeExpensive: !!(options.expensive ?? false),
  });

  const report = formatScoreReport(result.aggregate);

  // Save results
  const resultsDir = join(process.cwd(), 'crux/evals/results');
  await mkdir(resultsDir, { recursive: true });
  const resultFile = join(resultsDir, `injection-${Date.now()}.json`);
  await writeFile(resultFile, JSON.stringify(result, null, 2));

  let output = '';
  output += `${c.bold}Injection Eval Results${c.reset}\n\n`;
  output += report + '\n\n';
  output += `${c.dim}Duration: ${(result.durationMs / 1000).toFixed(1)}s | Results saved: ${resultFile}${c.reset}\n`;

  return { output, exitCode: 0 };
}

async function runFakeEntitySuite(
  _verbose: boolean,
  log: ReturnType<typeof createLogger>,
  c: ReturnType<typeof createLogger>['colors'],
): Promise<CommandResult> {
  const { evalAllFakeEntities, formatFakeEntityReport } = await import('../evals/fake-entity-eval.ts');

  log.info('Running fake entity eval...');
  const { results, passRate } = await evalAllFakeEntities();
  const report = formatFakeEntityReport(results);

  let output = '';
  output += `${c.bold}Fake Entity Eval Results${c.reset}\n\n`;
  output += report + '\n';

  return { output, exitCode: passRate >= 0.8 ? 0 : 1 };
}

async function runCrossRefSuite(
  options: Record<string, unknown>,
  _verbose: boolean,
  log: ReturnType<typeof createLogger>,
  c: ReturnType<typeof createLogger>['colors'],
): Promise<CommandResult> {
  const { checkCrossReferences, loadAllPages } = await import('../evals/agents/cross-reference-checker.ts');

  const limit = parseInt(options.limit as string || '100', 10);
  log.info(`Running cross-reference check on up to ${limit} pages...`);

  const pages = await loadAllPages(limit);
  log.info(`Loaded ${pages.length} pages`);

  const findings = await checkCrossReferences(pages);

  let output = '';
  output += `${c.bold}Cross-Reference Check Results${c.reset}\n\n`;
  output += `Pages scanned: ${pages.length}\n`;
  output += `Contradictions found: ${findings.length}\n\n`;

  if (findings.length > 0) {
    // Deduplicate (same contradiction appears on both pages)
    const seen = new Set<string>();
    for (const f of findings) {
      const key = `${f.claim}:${f.evidence}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const sev = f.severity === 'critical' ? c.red : f.severity === 'warning' ? c.yellow : c.dim;
      output += `${sev}[${f.severity}]${c.reset} ${f.pageId}: ${f.claim}\n`;
      output += `  ${c.dim}${f.evidence.split('\n')[0]}${c.reset}\n\n`;
    }
  }

  return { output, exitCode: 0 };
}

/**
 * Run an adversarial hunting agent on specific pages.
 */
async function hunt(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const agent = (options.agent as string) || 'reference-sniffer';
  const pageId = options.page as string;
  const useLlm = !(options.noLlm ?? false);

  if (!pageId && agent !== 'cross-ref') {
    return { output: `${c.red}Error: --page=<id> required (or use --agent=cross-ref for multi-page).${c.reset}`, exitCode: 1 };
  }

  if (agent === 'reference-sniffer') {
    const { sniffPage } = await import('../evals/agents/reference-sniffer.ts');
    const { loadGoldenPage } = await import('../evals/harness.ts');

    const content = await loadGoldenPage(pageId);
    log.info(`Sniffing page: ${pageId}`);

    const findings = await sniffPage(pageId, content, { useLlm });
    return formatHuntResults(pageId, agent, findings, c);

  } else if (agent === 'description-auditor') {
    const { auditPageDescriptions } = await import('../evals/agents/description-auditor.ts');
    const { loadGoldenPage } = await import('../evals/harness.ts');

    const content = await loadGoldenPage(pageId);
    log.info(`Auditing descriptions: ${pageId}`);

    const findings = await auditPageDescriptions(pageId, content, { useLlm });
    return formatHuntResults(pageId, agent, findings, c);

  } else if (agent === 'cross-ref') {
    return runCrossRefSuite(options, true, log, c);

  } else {
    return { output: `${c.red}Unknown agent: ${agent}. Available: reference-sniffer, description-auditor, cross-ref${c.reset}`, exitCode: 1 };
  }
}

function formatHuntResults(
  pageId: string,
  agent: string,
  findings: import('../evals/types.ts').AdversarialFinding[],
  c: ReturnType<typeof createLogger>['colors'],
): CommandResult {
  let output = '';
  output += `${c.bold}Hunt Results: ${agent} on ${pageId}${c.reset}\n\n`;
  output += `Findings: ${findings.length}\n\n`;

  for (const f of findings) {
    const sev = f.severity === 'critical' ? c.red : f.severity === 'warning' ? c.yellow : c.dim;
    output += `${sev}[${f.severity}]${c.reset} ${f.category}\n`;
    output += `  Claim: ${f.claim.slice(0, 120)}\n`;
    output += `  Evidence: ${f.evidence.slice(0, 200)}\n`;
    if (f.suggestion) output += `  Fix: ${f.suggestion.slice(0, 150)}\n`;
    output += '\n';
  }

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  return { output, exitCode: criticalCount > 0 ? 1 : 0 };
}

/**
 * Inject errors into a page (for manual inspection).
 */
async function inject(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const pageId = args.find((a: string) => !a.startsWith('-'));
  if (!pageId) {
    return { output: `${c.red}Error: page ID required. Usage: crux evals inject <page-id>${c.reset}`, exitCode: 1 };
  }

  const { injectErrors } = await import('../evals/injectors/inject.ts');
  const { loadGoldenPage } = await import('../evals/harness.ts');

  const content = await loadGoldenPage(pageId);
  const count = parseInt(options.count as string || '1', 10);
  const categories = (options.categories as string)?.split(',') as import('../evals/types.ts').ErrorCategory[] | undefined;

  const manifest = await injectErrors(pageId, content, { errorsPerCategory: count, categories });

  let output = '';
  output += `${c.bold}Error Injection: ${pageId}${c.reset}\n\n`;
  output += `Injected ${manifest.errors.length} errors:\n\n`;

  for (const err of manifest.errors) {
    output += `${c.yellow}[${err.category}]${c.reset} ${err.description}\n`;
    if (err.originalText) output += `  ${c.red}- ${err.originalText.slice(0, 100)}${c.reset}\n`;
    if (err.corruptedText) output += `  ${c.green}+ ${err.corruptedText.slice(0, 100)}${c.reset}\n`;
    output += '\n';
  }

  // Optionally write corrupted content
  if (options.output) {
    await writeFile(options.output as string, manifest.corruptedContent);
    output += `${c.dim}Corrupted content written to: ${options.output}${c.reset}\n`;
  }

  return { output, exitCode: 0 };
}

/**
 * Scan pages with hunting agents in batch.
 *
 * pnpm crux evals scan [--agents=reference-sniffer,description-auditor,cross-ref]
 *   [--pages=all|high-risk|zero-citations|id1,id2] [--no-llm] [--limit=N]
 *   [--output=path] [--verbose] [--json]
 */
async function scan(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;
  const verbose = !!(options.verbose ?? false);

  const { scanPages, generateDirections } = await import('../evals/scan.ts');
  type AgentName = import('../evals/scan.ts').AgentName;

  // Parse agents
  const agentStr = (options.agents as string) || 'reference-sniffer';
  const agents = agentStr.split(',') as AgentName[];

  // Parse pages filter
  let pages: import('../evals/scan.ts').PageFilter = 'high-risk';
  const pagesStr = options.pages as string | undefined;
  if (pagesStr) {
    if (['all', 'high-risk', 'zero-citations'].includes(pagesStr)) {
      pages = pagesStr as 'all' | 'high-risk' | 'zero-citations';
    } else {
      pages = pagesStr.split(',');
    }
  }

  const useLlm = !(options.noLlm ?? options['no-llm'] ?? false);
  const limit = options.limit ? parseInt(options.limit as string, 10) : undefined;
  const output = options.output as string | undefined;

  log.info(`Scanning pages (filter: ${Array.isArray(pages) ? `${pages.length} specific` : pages}, agents: ${agents.join(',')}, llm: ${useLlm})`);

  const manifest = await scanPages({ agents, pages, useLlm, limit, output, verbose });

  if (options.json) {
    return { output: JSON.stringify(manifest, null, 2), exitCode: 0 };
  }

  // Format human-readable output
  let out = '';
  out += `${c.bold}${c.blue}Scan Results${c.reset}\n\n`;
  out += `  Pages scanned: ${c.bold}${manifest.pagesScanned}${c.reset}\n`;
  out += `  Agents: ${agents.join(', ')}\n`;
  out += `  LLM: ${useLlm ? 'yes' : 'no'}\n`;
  out += `  Total findings: ${manifest.totalFindings}\n`;
  out += `  Duration: ${(manifest.durationMs / 1000).toFixed(1)}s\n\n`;

  // Top pages by uncited claims
  const topPages = manifest.pages.slice(0, 30);
  if (topPages.length > 0) {
    out += `${c.bold}Top Pages by Uncited Factual Claims${c.reset}\n\n`;
    out += `${c.dim}  ${'Uncited'.padEnd(8)} ${'Claims'.padEnd(8)} ${'Cites'.padEnd(7)} ${'Words'.padEnd(7)} ${'Type'.padEnd(14)} Page${c.reset}\n`;
    out += `${c.dim}  ${'─'.repeat(70)}${c.reset}\n`;

    for (const p of topPages) {
      if (p.uncitedClaimCount === 0 && p.findings.length === 0) continue;
      const uncited = String(p.uncitedClaimCount).padEnd(8);
      const claims = String(p.claimCount).padEnd(8);
      const cites = String(p.citationCount).padEnd(7);
      const words = String(p.wordCount).padEnd(7);
      const type = (p.entityType || '—').padEnd(14);
      const color = p.uncitedClaimCount >= 5 ? c.red : p.uncitedClaimCount >= 2 ? c.yellow : '';
      out += `  ${color}${uncited}${c.reset} ${claims} ${cites} ${words} ${type} ${p.pageId}\n`;
    }
    out += '\n';
  }

  // Cross-ref contradictions
  if (manifest.crossRefContradictions.length > 0) {
    out += `${c.bold}${c.red}Cross-Reference Contradictions (${manifest.crossRefContradictions.length})${c.reset}\n\n`;
    const seen = new Set<string>();
    for (const f of manifest.crossRefContradictions.slice(0, 20)) {
      const key = `${f.claim}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out += `  ${c.red}[critical]${c.reset} ${f.pageId}: ${f.claim}\n`;
      out += `  ${c.dim}${f.evidence.split('\n')[0]}${c.reset}\n\n`;
    }
  }

  // Show direction preview for top page
  if (topPages.length > 0 && topPages[0].uncitedClaimCount > 0) {
    out += `${c.bold}Sample Directions (for ${topPages[0].pageId})${c.reset}\n`;
    out += `${c.dim}${generateDirections(topPages[0]).slice(0, 500)}...${c.reset}\n\n`;
  }

  const manifestPath = output || '.claude/temp/scan-manifest.json';
  out += `${c.dim}Full manifest: ${manifestPath}${c.reset}\n`;

  return { output: out, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

export const commands = {
  default: run,
  run,
  hunt,
  inject,
  scan,
};

export function getHelp(): string {
  return `
\x1b[1mcrux evals\x1b[0m — Hallucination detection evals & adversarial agents

\x1b[1mCommands:\x1b[0m
  run       Run an eval suite
  hunt      Run an adversarial agent on specific pages
  scan      Batch-scan pages with hunting agents (produces triage manifest)
  inject    Inject errors into a page (for manual inspection)

\x1b[1mBatch Scan (Phase 0 triage):\x1b[0m
  crux evals scan                                          Scan high-risk pages (no LLM, free)
  crux evals scan --pages=all --no-llm --limit=200         Scan top 200 pages
  crux evals scan --pages=zero-citations --verbose         Scan pages with no citations
  crux evals scan --agents=reference-sniffer,cross-ref     Multiple agents
  crux evals scan --pages=anthropic,miri,openai            Scan specific pages
  crux evals scan --json                                   Machine-readable output

\x1b[1mEval Suites:\x1b[0m
  crux evals run --suite=injection [--pages=id1,id2] [--verbose] [--expensive]
  crux evals run --suite=fake-entity [--verbose]
  crux evals run --suite=cross-ref [--limit=100]

\x1b[1mAdversarial Agents:\x1b[0m
  crux evals hunt --agent=reference-sniffer --page=<id> [--no-llm]
  crux evals hunt --agent=description-auditor --page=<id> [--no-llm]
  crux evals hunt --agent=cross-ref [--limit=100]

\x1b[1mInject Errors:\x1b[0m
  crux evals inject <page-id> [--count=2] [--categories=wrong-number,exaggeration]
  crux evals inject <page-id> --output=/tmp/corrupted.mdx

\x1b[1mScan Options:\x1b[0m
  --agents=A,B       Agents: reference-sniffer, description-auditor, cross-ref (default: reference-sniffer)
  --pages=FILTER     Page filter: all, high-risk (default), zero-citations, or comma-separated IDs
  --limit=N          Max pages to scan
  --no-llm           Skip LLM checks (free, fast — use for initial triage)
  --output=PATH      Manifest output path (default: .claude/temp/scan-manifest.json)
  --json             JSON output (full manifest)
  --verbose          Progress output

\x1b[1mOther Options:\x1b[0m
  --suite=NAME       Eval suite: injection, fake-entity, cross-ref
  --agent=NAME       Agent: reference-sniffer, description-auditor, cross-ref
  --page=ID          Target page ID
  --pages=ID,ID      Comma-separated page IDs
  --limit=N          Max pages for cross-ref scan
  --count=N          Errors per category for injection
  --categories=A,B   Error categories: wrong-number, fabricated-claim, exaggeration, fabricated-citation, missing-nuance
  --no-llm           Skip LLM-based checks (cheaper, faster)
  --expensive        Include expensive detectors (citation-auditor with network)
  --verbose          Detailed output
  --output=PATH      Write corrupted content to file
`;
}
