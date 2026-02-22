/**
 * Eval Harness
 *
 * Orchestrates the inject → detect → score pipeline for a single page:
 * 1. Load golden page content
 * 2. Inject errors according to plan
 * 3. Run detection systems against corrupted content
 * 4. Score results (match findings to injected errors)
 * 5. Return structured eval result
 *
 * Each detector is run independently and their findings are merged.
 * The harness is detector-agnostic — new detectors can be plugged in
 * by implementing the DetectorAdapter interface.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ErrorManifest,
  DetectorFinding,
  DetectorName,
  PageEvalResult,
  SuiteEvalResult,
} from './types.ts';
import { injectErrors, type InjectionPlan } from './injectors/inject.ts';
import { matchFindings, computeScores, formatScoreReport } from './score.ts';

// ---------------------------------------------------------------------------
// Detector adapter interface
// ---------------------------------------------------------------------------

/**
 * Adapter for a detection system. Each detector takes page content and
 * returns findings (potential hallucinations/errors it detected).
 */
export interface DetectorAdapter {
  name: DetectorName;
  /** Run detection on the given content. Returns findings. */
  detect(content: string, pageId: string): Promise<DetectorFinding[]>;
  /** Whether this detector requires network access (for budgeting). */
  requiresNetwork: boolean;
  /** Whether this detector requires LLM calls (for budgeting). */
  requiresLlm: boolean;
}

// ---------------------------------------------------------------------------
// Built-in detector adapters
// ---------------------------------------------------------------------------

/**
 * Content integrity detector — pure static analysis, no LLM needed.
 * Checks for orphaned footnotes, duplicate definitions, fabricated arxiv IDs.
 */
export function contentIntegrityDetector(): DetectorAdapter {
  return {
    name: 'content-integrity',
    requiresNetwork: false,
    requiresLlm: false,
    async detect(content: string, _pageId: string): Promise<DetectorFinding[]> {
      const { detectOrphanedFootnotes, detectDuplicateFootnoteDefs, detectSequentialArxivIds } =
        await import('../lib/content-integrity.ts');

      const findings: DetectorFinding[] = [];

      const orphaned = detectOrphanedFootnotes(content);
      if (orphaned.orphanedRefs.length > 0) {
        findings.push({
          detector: 'content-integrity',
          description: `Orphaned footnote refs: [^${orphaned.orphanedRefs.join('], [^')}]`,
          severity: 'warning',
        });
      }

      const duplicates = detectDuplicateFootnoteDefs(content);
      if (duplicates.length > 0) {
        findings.push({
          detector: 'content-integrity',
          description: `Duplicate footnote definitions: [^${duplicates.join('], [^')}]`,
          severity: 'warning',
        });
      }

      const arxiv = detectSequentialArxivIds(content);
      if (arxiv.suspicious) {
        findings.push({
          detector: 'content-integrity',
          description: `Sequential arxiv IDs detected (fabrication signal): ${arxiv.sequentialIds.join(', ')}`,
          severity: 'critical',
        });
      }

      return findings;
    },
  };
}

/**
 * Hallucination risk scorer — static analysis with metadata.
 * Computes a risk score based on page characteristics.
 */
export function hallucinationRiskDetector(): DetectorAdapter {
  return {
    name: 'hallucination-risk',
    requiresNetwork: false,
    requiresLlm: false,
    async detect(content: string, _pageId: string): Promise<DetectorFinding[]> {
      const { computeHallucinationRisk } = await import('../lib/hallucination-risk.ts');

      // Extract basic stats for risk computation
      const lines = content.split('\n');
      const footnoteRefs = content.match(/\[\^\d+\]/g) || [];
      const wordCount = content.split(/\s+/).length;
      const externalLinks = (content.match(/https?:\/\//g) || []).length;

      const result = computeHallucinationRisk({
        entityType: null,
        wordCount,
        footnoteCount: footnoteRefs.length,
        externalLinks,
        rigor: null,
        quality: null,
      });

      const findings: DetectorFinding[] = [];

      if (result.level === 'high') {
        findings.push({
          detector: 'hallucination-risk',
          description: `High hallucination risk (score: ${result.score}). Factors: ${result.factors.join(', ')}`,
          severity: 'critical',
        });
      } else if (result.level === 'medium') {
        findings.push({
          detector: 'hallucination-risk',
          description: `Medium hallucination risk (score: ${result.score}). Factors: ${result.factors.join(', ')}`,
          severity: 'warning',
        });
      }

      return findings;
    },
  };
}

/**
 * Citation auditor — requires network to fetch sources and LLM to verify.
 * This is the most expensive but most powerful detector.
 */
export function citationAuditorDetector(): DetectorAdapter {
  return {
    name: 'citation-auditor',
    requiresNetwork: true,
    requiresLlm: true,
    async detect(content: string, _pageId: string): Promise<DetectorFinding[]> {
      const { auditCitations } = await import('../lib/citation-auditor.ts');

      try {
        const result = await auditCitations({
          content,
          fetchMissing: true,
          passThreshold: 0.8,
        });

        const findings: DetectorFinding[] = [];

        for (const citation of result.citations) {
          if (citation.verdict === 'misattributed') {
            findings.push({
              detector: 'citation-auditor',
              description: `Citation [^${citation.footnoteRef}] is misattributed: ${citation.explanation}`,
              flaggedText: citation.claim,
              severity: 'critical',
            });
          } else if (citation.verdict === 'unsupported') {
            findings.push({
              detector: 'citation-auditor',
              description: `Citation [^${citation.footnoteRef}] is unsupported: ${citation.explanation}`,
              flaggedText: citation.claim,
              severity: 'warning',
            });
          } else if (citation.verdict === 'url-dead') {
            findings.push({
              detector: 'citation-auditor',
              description: `Citation [^${citation.footnoteRef}] URL is dead`,
              severity: 'warning',
            });
          }
        }

        return findings;
      } catch (err) {
        console.warn('Citation auditor failed:', (err as Error).message);
        return [];
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Eval harness
// ---------------------------------------------------------------------------

export interface HarnessOptions {
  /** Which detectors to run. Default: all non-LLM detectors. */
  detectors?: DetectorAdapter[];
  /** Injection plan. */
  injectionPlan?: InjectionPlan;
  /** Whether to include expensive (LLM/network) detectors. */
  includeExpensive?: boolean;
  /** Print progress to console. */
  verbose?: boolean;
}

/**
 * Run the eval harness on a single page.
 */
export async function evalPage(
  pageId: string,
  content: string,
  options: HarnessOptions = {},
): Promise<PageEvalResult> {
  const start = Date.now();
  const verbose = options.verbose ?? false;

  // 1. Select detectors
  const detectors = options.detectors ?? getDefaultDetectors(options.includeExpensive ?? false);

  if (verbose) console.log(`[eval] Running on page "${pageId}" with ${detectors.length} detectors`);

  // 2. Inject errors
  if (verbose) console.log('[eval] Injecting errors...');
  const manifest = await injectErrors(pageId, content, options.injectionPlan);
  if (verbose) console.log(`[eval] Injected ${manifest.errors.length} errors`);

  // 3. Run detectors against corrupted content
  const allFindings: DetectorFinding[] = [];

  for (const detector of detectors) {
    if (verbose) console.log(`[eval] Running detector: ${detector.name}`);
    try {
      const findings = await detector.detect(manifest.corruptedContent, pageId);
      allFindings.push(...findings);
      if (verbose) console.log(`[eval]   → ${findings.length} findings`);
    } catch (err) {
      console.warn(`[eval] Detector ${detector.name} failed:`, (err as Error).message);
    }
  }

  // 4. Score results
  const { matches, truePositiveFindings } = matchFindings(manifest.errors, allFindings);
  const scores = computeScores(matches, allFindings, truePositiveFindings.size);

  return {
    pageId,
    matches,
    allFindings,
    scores,
    runAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}

/**
 * Run the eval harness across multiple pages.
 */
export async function evalSuite(
  pages: Array<{ id: string; content: string }>,
  options: HarnessOptions = {},
): Promise<SuiteEvalResult> {
  const start = Date.now();
  const verbose = options.verbose ?? false;

  if (verbose) console.log(`[eval-suite] Running on ${pages.length} pages`);

  const results: PageEvalResult[] = [];

  for (const page of pages) {
    const result = await evalPage(page.id, page.content, options);
    results.push(result);

    if (verbose) {
      console.log(`[eval-suite] ${page.id}: recall=${(result.scores.recall * 100).toFixed(0)}% precision=${(result.scores.precision * 100).toFixed(0)}%`);
    }
  }

  // Aggregate scores across all pages
  const allMatches = results.flatMap(r => r.matches);
  const allFindings = results.flatMap(r => r.allFindings);
  const totalTP = results.reduce((sum, r) => sum + r.scores.truePositives, 0);
  const aggregate = computeScores(allMatches, allFindings, totalTP);

  return {
    suite: 'injection',
    pages: results,
    aggregate,
    runAt: new Date().toISOString(),
    durationMs: Date.now() - start,
  };
}

/**
 * Get default detectors (cheap ones by default, expensive ones opt-in).
 */
function getDefaultDetectors(includeExpensive: boolean): DetectorAdapter[] {
  const detectors: DetectorAdapter[] = [
    contentIntegrityDetector(),
    hallucinationRiskDetector(),
  ];

  if (includeExpensive) {
    detectors.push(citationAuditorDetector());
  }

  return detectors;
}

/**
 * Load a golden page from the content directory.
 * First checks for test fixtures, then uses findPageFile() for real pages.
 */
export async function loadGoldenPage(pageId: string): Promise<string> {
  const { findPageFile } = await import('../lib/file-utils.ts');

  // 1. Check for test fixtures first (allow controlled test data)
  const fixturePath = join(process.cwd(), 'crux/evals/fixtures', `${pageId}.mdx`);
  try {
    return await readFile(fixturePath, 'utf-8');
  } catch {
    // Not a fixture — try real content
  }

  // 2. Use the canonical page finder (searches all content directories)
  const pagePath = findPageFile(pageId);
  if (pagePath) {
    return await readFile(pagePath, 'utf-8');
  }

  throw new Error(`Golden page not found: ${pageId}. Checked fixtures and all content directories.`);
}
