/**
 * Pipeline orchestration for the page-improver.
 *
 * Coordinates the phase sequence based on the selected tier.
 */

import fs from 'fs';
import { execFileSync } from 'child_process';
import { appendEditLog, getDefaultRequestedBy } from '../../lib/edit-log.ts';
import { createSession } from '../../lib/wiki-server/sessions.ts';
import type {
  PageData, AnalysisResult, ResearchResult, ReviewResult,
  PipelineOptions, PipelineResults, TriageResult, AdversarialLoopResult,
  EnrichResult,
} from './types.ts';
import { ROOT, TIERS, log, getFilePath, writeTemp, loadPages, findPage } from './utils.ts';
import { startHeartbeat } from './api.ts';
import { FOOTNOTE_REF_RE } from '../../lib/patterns.ts';
import {
  analyzePhase, researchPhase, improvePhase, improveSectionsPhase,
  enrichPhase, reviewPhase,
  validatePhase, gapFillPhase, triagePhase, adversarialLoopPhase,
} from './phases.ts';

// ── Session log helpers ───────────────────────────────────────────────────────

function getCurrentBranch(): string | null {
  try {
    return execFileSync('git', ['branch', '--show-current'], { cwd: ROOT, encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

function buildSessionSummary(
  page: PageData,
  tier: string,
  review: ReviewResult | undefined,
  duration: string,
): string {
  if (review) {
    const score = review.qualityScore;
    const topIssues = (review.issues || []).slice(0, 3);
    const issueText = topIssues.length > 0
      ? ` Issues resolved: ${topIssues.map(i => i.slice(0, 60)).join('; ')}.`
      : '';
    const scoreText = score != null ? ` Quality score: ${score}.` : '';
    return `Improved "${page.title}" via ${tier} pipeline (${duration}s).${scoreText}${issueText}`;
  }
  const verb = tier === 'polish' ? `Polish pass on "${page.title}"` : `Improved "${page.title}" via ${tier} pipeline`;
  return `${verb}. Duration: ${duration}s.`;
}

/**
 * Post a minimal session log entry to the wiki-server after --apply.
 * Fire-and-forget: errors are logged but never throw.
 */
async function autoLogSession(
  page: PageData,
  tier: string,
  review: ReviewResult | undefined,
  totalDuration: string,
  tierCost: string,
): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const branch = getCurrentBranch();
    const summary = buildSessionSummary(page, tier, review, totalDuration);

    const entry = {
      date: today,
      branch,
      title: `Auto-improve (${tier}): ${page.title}`,
      summary,
      model: null,
      duration: `${totalDuration}s`,
      cost: tierCost,
      prUrl: null,
      pages: [page.id],
    };

    const result = await createSession(entry);
    if (result.ok) {
      log('session', `Session log written to wiki-server (id: ${result.data.id})`);
    } else {
      log('session', `Warning: could not write session log to wiki-server: ${result.message}`);
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('session', `Warning: session log failed: ${error.message}`);
  }
}

// ── Pipeline ──────────────────────────────────────────────────────────────────

/** Main pipeline orchestration. */
export async function runPipeline(pageId: string, options: PipelineOptions = {}): Promise<PipelineResults> {
  let { tier = 'standard', directions = '', dryRun = false } = options;

  // Find page
  const pages = loadPages();
  const page = findPage(pages, pageId);
  if (!page) {
    console.error(`Page not found: ${pageId}`);
    console.log('Try: node crux/authoring/page-improver.ts -- --list');
    process.exit(1);
  }

  const filePath = getFilePath(page.path);
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`);
    process.exit(1);
  }

  // Handle triage tier: run news check to auto-select the real tier
  let triageResult: TriageResult | undefined;
  if (tier === 'triage') {
    const content = fs.readFileSync(filePath, 'utf-8');
    const fmMatch = content.match(/lastEdited:\s*["']?(\d{4}-\d{2}-\d{2})["']?/);
    const lastEdited = fmMatch?.[1] || 'unknown';
    triageResult = await triagePhase(page, lastEdited);

    if (triageResult.recommendedTier === 'skip') {
      console.log(`\nTriage: SKIP — ${triageResult.reason}`);
      return {
        pageId: page.id,
        title: page.title,
        tier: 'skip',
        directions,
        duration: '0',
        phases: ['triage'],
        review: undefined,
        outputPath: '',
      };
    }

    tier = triageResult.recommendedTier;
    if (triageResult.newDevelopments.length > 0) {
      const triageDirections = `New developments to incorporate: ${triageResult.newDevelopments.join('; ')}`;
      directions = directions ? `${directions}\n\n${triageDirections}` : triageDirections;
    }
    log('triage', `Auto-selected tier: ${tier}`);
  }

  const tierConfig = TIERS[tier];
  if (!tierConfig) {
    console.error(`Unknown tier: ${tier}. Available: ${Object.keys(TIERS).join(', ')}, triage`);
    process.exit(1);
  }

  // When --section-level is set, substitute 'improve' with 'improve-sections'
  const phases = tierConfig.phases.map(p =>
    p === 'improve' && options.sectionLevel ? 'improve-sections' : p,
  );

  console.log('\n' + '='.repeat(60));
  console.log(`Improving: "${page.title}"`);
  if (triageResult) {
    console.log(`Triage: ${triageResult.reason}`);
  }
  console.log(`Tier: ${tierConfig.name} (${tierConfig.cost})`);
  if (options.sectionLevel) console.log('Mode: section-level (--section-level)');
  console.log(`Phases: ${phases.join(' → ')}`);
  if (directions) console.log(`Directions: ${directions}`);
  console.log('='.repeat(60) + '\n');

  const startTime: number = Date.now();
  let analysis: AnalysisResult | undefined, research: ResearchResult | undefined;
  let improvedContent: string | undefined, review: ReviewResult | undefined;
  let adversarialLoopResult: AdversarialLoopResult | undefined;
  let enrichResult: EnrichResult | undefined;

  // Run phases based on tier
  for (const phase of phases) {
    const phaseStart: number = Date.now();
    const stopPhaseHeartbeat = startHeartbeat(phase, 60);

    try { switch (phase) {
      case 'analyze':
        analysis = await analyzePhase(page, directions, options);
        break;

      case 'research':
        research = await researchPhase(page, analysis!, { ...options, deep: false });
        break;

      case 'research-deep':
        research = await researchPhase(page, analysis!, { ...options, deep: true });
        break;

      case 'improve':
        improvedContent = await improvePhase(page, analysis!, research || { sources: [] }, directions, options);
        // Warn about unverified citations in tiers without research
        if (tier === 'polish' && !research?.sources?.length) {
          const footnoteCount = new Set(improvedContent.match(FOOTNOTE_REF_RE) || []).size;
          if (footnoteCount > 0) {
            log('improve', `⚠ ${footnoteCount} footnote citations added without web research — citations are LLM-generated and should be verified`);
          }
        }
        // Extra hallucination warnings for person/org pages
        if (page.path.includes('/people/') || page.path.includes('/organizations/')) {
          logBiographicalWarnings(improvedContent, page, tier);
        }
        break;

      case 'improve-sections':
        improvedContent = await improveSectionsPhase(
          page, analysis!, research || { sources: [] }, directions, options,
        );
        break;

      case 'enrich': {
        if (options.skipEnrich) {
          log('enrich', 'Skipped (--skip-enrich)');
        } else {
          const enrichOutput = await enrichPhase(page, improvedContent!, options);
          improvedContent = enrichOutput.content;
          enrichResult = enrichOutput.result;
        }
        break;
      }

      case 'validate': {
        const validation = await validatePhase(page, improvedContent!, options);
        improvedContent = validation.improvedContent;
        if (validation.hasCritical) {
          log('validate', 'Critical validation issues found - may need manual fixes');
        }
        break;
      }

      case 'gap-fill':
        improvedContent = await gapFillPhase(page, improvedContent!, review || { valid: true, issues: [] }, options);
        break;

      case 'adversarial-loop': {
        try {
          const loopResult = await adversarialLoopPhase(
            page,
            improvedContent!,
            analysis!,
            research || { sources: [] },
            directions,
            options,
          );
          adversarialLoopResult = loopResult;
          improvedContent = loopResult.finalContent;
          // Merge any additional research back so gap-fill has full context
          if (loopResult.additionalResearch.sources.length > 0) {
            research = {
              sources: [...(research?.sources || []), ...loopResult.additionalResearch.sources],
              summary: research?.summary,
            };
          }
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          log('adversarial-loop', `⚠ Adversarial loop failed: ${error.message} — continuing with pre-loop content`);
          // Don't overwrite improvedContent; continue pipeline with the last good state
        }
        break;
      }

      case 'review':
        review = await reviewPhase(page, improvedContent!, options);
        break;
    }

    } finally {
      stopPhaseHeartbeat();
    }

    const phaseDuration: string = ((Date.now() - phaseStart) / 1000).toFixed(1);
    log(phase, `Duration: ${phaseDuration}s`);
  }

  const totalDuration: string = ((Date.now() - startTime) / 1000).toFixed(1);

  // Write final output (preserves CROSS-PAGE CHECK comments for review)
  const finalPath = writeTemp(page.id, 'final.mdx', improvedContent!);

  console.log('\n' + '='.repeat(60));
  console.log('Pipeline Complete');
  console.log('='.repeat(60));
  console.log(`Duration: ${totalDuration}s`);
  console.log(`Output: ${finalPath}`);

  if (review) {
    console.log(`Quality: ${review.qualityScore || 'N/A'}`);
    if (review.issues?.length > 0) {
      console.log(`Issues: ${review.issues.length}`);
      review.issues.slice(0, 3).forEach(i => console.log(`  - ${i}`));
    }
  }

  if (dryRun) {
    console.log('\nTo apply changes:');
    console.log(`  cp "${finalPath}" "${filePath}"`);
    console.log('\nOr review the diff:');
    console.log(`  diff "${filePath}" "${finalPath}"`);
  } else {
    // Apply changes: strip pipeline review comments before writing to disk (#628)
    // Comments are preserved in the temp file (finalPath) for review
    let contentToApply = fs.readFileSync(finalPath, 'utf-8');
    contentToApply = contentToApply.replace(/\n?{\/\*\s*CROSS-PAGE CHECK[^*]*\*\/}\n?/g, '\n');
    fs.writeFileSync(filePath, contentToApply);
    console.log(`\nChanges applied to ${filePath}`);

    const adversarialNote = adversarialLoopResult
      ? ` [adversarial: ${adversarialLoopResult.iterations} iter, ${adversarialLoopResult.adversarialReview.gaps.length} gaps]`
      : '';
    appendEditLog(page.id, {
      tool: 'crux-improve',
      agency: 'ai-directed',
      requestedBy: getDefaultRequestedBy(),
      note: directions
        ? `Improved (${tier})${adversarialNote}: ${directions.slice(0, 100)}`
        : `Improved (${tier})${adversarialNote}`,
    });

    // Auto-grade after applying changes (default: on; skip with grade: false)
    if (options.grade !== false) {
      console.log('\nRunning grade-content.ts...');
      try {
        execFileSync('node', ['--import', 'tsx/esm', '--no-warnings', 'crux/authoring/grade-content.ts', '--page', page.id, '--apply'], {
          cwd: ROOT,
          stdio: 'inherit'
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('Grading failed:', error.message);
      }
    }

    // Auto-log session to wiki-server DB (default: on; skip with skipSessionLog: true)
    if (!options.skipSessionLog) {
      await autoLogSession(page, tier, review, totalDuration, tierConfig.cost);
    }
  }

  const results: PipelineResults = {
    pageId: page.id,
    title: page.title,
    tier,
    directions,
    duration: totalDuration,
    phases,
    review,
    adversarialLoopResult,
    enrichResult,
    outputPath: finalPath,
  };
  writeTemp(page.id, 'pipeline-results.json', results);

  return results;
}

/** Log biographical accuracy warnings for person/org pages. */
function logBiographicalWarnings(content: string, page: PageData, tier: string): void {
  log('improve', '⚠ PERSON/ORG PAGE — high hallucination risk. Verifying biographical claims...');
  const bioPatterns = [
    { pattern: /\b(?:joined|left|departed)\b.*\b(?:in|since)\s+\d{4}\b/gi, label: 'employment dates' },
    { pattern: /\bPhD|Ph\.D\.|doctorate|master's|bachelor's|degree\b.*\b(?:from|at)\s+[A-Z]/gi, label: 'education claims' },
    { pattern: /\b(?:founded|co-founded|established)\b.*\b(?:in|circa)\s+\d{4}\b/gi, label: 'founding dates' },
    { pattern: /\b(?:co-authored|coauthored|authored|published|wrote)\b.*(?:with\s+[A-Z]|\b\d{4}\b)/gi, label: 'publication/co-authorship claims' },
    { pattern: /\bcited\s+(?:over\s+)?\d[\d,]*\s+times\b/gi, label: 'citation count claims' },
    { pattern: /\bover\s+\d[\d,]*\s+(?:publications|papers|articles)\b/gi, label: 'publication count claims' },
  ];
  let bioWarnings = 0;
  const lines = content.split('\n');
  for (const line of lines) {
    if (/\[\^\d+\]|<R\s+id=|\]\(https?:\/\//.test(line)) continue;
    for (const { pattern, label } of bioPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(line)) {
        bioWarnings++;
        if (bioWarnings <= 5) {
          log('improve', `  ⚠ Unsourced ${label}: "${line.trim().slice(0, 70)}..."`);
        }
      }
    }
  }
  if (bioWarnings > 5) {
    log('improve', `  ... and ${bioWarnings - 5} more unsourced biographical claims`);
  }
  if (bioWarnings > 0) {
    log('improve', `  TOTAL: ${bioWarnings} biographical claims without citations — review these carefully`);
    if (tier === 'polish') {
      log('improve', '  Consider using --tier=standard to add research-backed citations');
    }
  }
}