/**
 * Pipeline orchestration for the page-improver.
 *
 * Coordinates the phase sequence based on the selected tier.
 */

import fs from 'fs';
import { execSync } from 'child_process';
import { appendEditLog, getDefaultRequestedBy } from '../../lib/edit-log.ts';
import type {
  PageData, AnalysisResult, ResearchResult, ReviewResult,
  PipelineOptions, PipelineResults, TriageResult,
} from './types.ts';
import { ROOT, NODE_TSX, TIERS, log, getFilePath, writeTemp, loadPages, findPage } from './utils.ts';
import { startHeartbeat } from './api.ts';
import {
  analyzePhase, researchPhase, improvePhase, reviewPhase,
  validatePhase, gapFillPhase, triagePhase,
} from './phases.ts';

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

  console.log('\n' + '='.repeat(60));
  console.log(`Improving: "${page.title}"`);
  if (triageResult) {
    console.log(`Triage: ${triageResult.reason}`);
  }
  console.log(`Tier: ${tierConfig.name} (${tierConfig.cost})`);
  console.log(`Phases: ${tierConfig.phases.join(' → ')}`);
  if (directions) console.log(`Directions: ${directions}`);
  console.log('='.repeat(60) + '\n');

  const startTime: number = Date.now();
  let analysis: AnalysisResult | undefined, research: ResearchResult | undefined;
  let improvedContent: string | undefined, review: ReviewResult | undefined;

  // Run phases based on tier
  for (const phase of tierConfig.phases) {
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
          const footnoteCount = new Set(improvedContent.match(/\[\^\d+\]/g) || []).size;
          if (footnoteCount > 0) {
            log('improve', `⚠ ${footnoteCount} footnote citations added without web research — citations are LLM-generated and should be verified`);
          }
        }
        // Extra hallucination warnings for person/org pages
        if (page.path.includes('/people/') || page.path.includes('/organizations/')) {
          logBiographicalWarnings(improvedContent, page, tier);
        }
        break;

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

  // Write final output
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
    // Apply changes directly
    fs.copyFileSync(finalPath, filePath);
    console.log(`\nChanges applied to ${filePath}`);

    appendEditLog(page.id, {
      tool: 'crux-improve',
      agency: 'ai-directed',
      requestedBy: getDefaultRequestedBy(),
      note: directions
        ? `Improved (${tier}): ${directions.slice(0, 120)}`
        : `Improved (${tier})`,
    });

    // Run grading if requested
    if (options.grade) {
      console.log('\nRunning grade-content.ts...');
      try {
        execSync(`${NODE_TSX} crux/authoring/grade-content.ts --page "${page.id}" --apply`, {
          cwd: ROOT,
          stdio: 'inherit'
        });
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('Grading failed:', error.message);
      }
    }
  }

  const results: PipelineResults = {
    pageId: page.id,
    title: page.title,
    tier,
    directions,
    duration: totalDuration,
    phases: tierConfig.phases,
    review,
    outputPath: finalPath
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
