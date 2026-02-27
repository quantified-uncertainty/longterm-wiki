/**
 * Pipeline orchestration for the page-improver.
 *
 * Coordinates the phase sequence based on the selected tier.
 */

import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { appendEditLog, getDefaultRequestedBy } from '../../lib/edit-log.ts';
import { createSession } from '../../lib/wiki-server/sessions.ts';
import { saveArtifacts } from '../../lib/wiki-server/artifacts.ts';
import { isServerAvailable } from '../../lib/wiki-server/client.ts';
import type {
  PageData, AnalysisResult, ResearchResult, ReviewResult,
  PipelineOptions, PipelineResults, TriageResult, AdversarialLoopResult,
  EnrichResult, AuditResult, PhaseContext,
} from './types.ts';
import { ROOT, TEMP_DIR, TIERS, log, getFilePath, writeTemp, loadPages, findPage } from './utils.ts';
import { startHeartbeat } from './api.ts';
import { FOOTNOTE_REF_RE } from '../../lib/patterns.ts';
import { createDbEntriesForRcFootnotes } from '../../claims/convert-new-footnotes.ts';
import { isBiographicalPage } from '../../lib/page-analysis.ts';
import { validateMdxContent } from '../../lib/validate-mdx-content.ts';
import {
  analyzePhase, researchPhase, improvePhase, improveSectionsPhase,
  enrichPhase, reviewPhase,
  validatePhase, gapFillPhase, triagePhase, adversarialLoopPhase,
  citationAuditPhase,
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
  serverAvailable: boolean,
): Promise<void> {
  try {
    const today = new Date().toISOString().split('T')[0];
    const branch = getCurrentBranch();
    let summary = buildSessionSummary(page, tier, review, totalDuration);

    // Append a constraint note if the wiki server was unreachable during the session.
    // This surfaces in the page-changes dashboard so reviewers know cross-reference
    // checks and citation data may have been skipped.
    if (!serverAvailable) {
      summary += '\n\nConstraint: wiki server was unreachable. Cross-reference checks, citation verification, and backlink context were unavailable during this session.';
    }

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
      issuesJson: !serverAvailable
        ? [{ type: 'server-unavailable', message: 'Wiki server was unreachable during session' }]
        : null,
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

  // Check wiki server availability upfront so the session log can record if the
  // server was unreachable (which means cross-reference checks and citation
  // verification were silently skipped during this run).
  const serverAvailable = await isServerAvailable();
  if (!serverAvailable) {
    console.warn('  Warning: wiki server unavailable — cross-reference checks and citation data will be skipped.');
  }

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

  // PhaseContext: single typed accumulator for all phase outputs.
  // Replaces scattered let variables with a structured object.
  const ctx: PhaseContext = {
    page,
    options,
    tier,
    directions,
    phases,
    results: {},
    tempDir: path.join(TEMP_DIR, page.id),
    phaseDurations: [],
  };

  // Convenience aliases — write to ctx.results, read via these
  const r = ctx.results;

  // Run phases based on tier
  for (const phase of phases) {
    const phaseStart: number = Date.now();
    const stopPhaseHeartbeat = startHeartbeat(phase, 60);

    try { switch (phase) {
      case 'analyze':
        r.analysis = await analyzePhase(page, directions, options);
        break;

      case 'research':
        r.research = await researchPhase(page, r.analysis!, { ...options, deep: false });
        break;

      case 'research-deep':
        r.research = await researchPhase(page, r.analysis!, { ...options, deep: true });
        break;

      case 'improve':
        r.improvedContent = await improvePhase(page, r.analysis!, r.research || { sources: [] }, directions, options);
        // Warn about unverified citations in tiers without research
        if (tier === 'polish' && !r.research?.sources?.length) {
          const footnoteCount = new Set(r.improvedContent.match(FOOTNOTE_REF_RE) || []).size;
          if (footnoteCount > 0) {
            log('improve', `⚠ ${footnoteCount} footnote citations added without web research — citations are LLM-generated and should be verified`);
          }
        }
        // Extra hallucination warnings for person/org pages
        if (isBiographicalPage(page)) {
          logBiographicalWarnings(r.improvedContent, page, tier);
        }
        break;

      case 'improve-sections':
        r.improvedContent = await improveSectionsPhase(
          page, r.analysis!, r.research || { sources: [] }, directions, options,
        );
        break;

      case 'enrich': {
        if (options.skipEnrich) {
          log('enrich', 'Skipped (--skip-enrich)');
        } else {
          const enrichOutput = await enrichPhase(page, r.improvedContent!, options);
          r.improvedContent = enrichOutput.content;
          r.enrichResult = enrichOutput.result;
        }
        break;
      }

      case 'citation-audit': {
        if (options.skipCitationAudit) {
          log('citation-audit', 'Skipped (--skip-citation-audit)');
        } else {
          try {
            r.auditResult = await citationAuditPhase(page, r.improvedContent!, r.research, options);
          } catch (err: unknown) {
            const error = err instanceof Error ? err : new Error(String(err));
            if (options.citationGate) {
              throw new Error(`Citation audit failed with --citation-gate: ${error.message}`);
            }
            log('citation-audit', `⚠ Citation audit failed: ${error.message} — continuing without audit`);
          }
        }
        break;
      }

      case 'validate': {
        const validation = await validatePhase(page, r.improvedContent!, options);
        r.improvedContent = validation.improvedContent;
        r.validationResult = validation;
        if (validation.hasCritical) {
          log('validate', 'Critical validation issues found - may need manual fixes');
        }
        break;
      }

      case 'gap-fill':
        r.improvedContent = await gapFillPhase(page, r.improvedContent!, r.review || { valid: true, issues: [] }, options);
        break;

      case 'adversarial-loop': {
        try {
          const loopResult = await adversarialLoopPhase(
            page,
            r.improvedContent!,
            r.analysis!,
            r.research || { sources: [] },
            directions,
            options,
          );
          r.adversarialLoopResult = loopResult;
          r.improvedContent = loopResult.finalContent;
          // Merge any additional research back so gap-fill has full context
          if (loopResult.additionalResearch.sources.length > 0) {
            r.research = {
              sources: [...(r.research?.sources || []), ...loopResult.additionalResearch.sources],
              summary: r.research?.summary,
            };
          }
        } catch (err: unknown) {
          const error = err instanceof Error ? err : new Error(String(err));
          log('adversarial-loop', `⚠ Adversarial loop failed: ${error.message} — continuing with pre-loop content`);
        }
        break;
      }

      case 'review':
        r.review = await reviewPhase(page, r.improvedContent!, options);
        break;
    }

    } finally {
      stopPhaseHeartbeat();
    }

    const phaseDurationMs = Date.now() - phaseStart;
    ctx.phaseDurations.push({ phase, durationMs: phaseDurationMs });
    log(phase, `Duration: ${(phaseDurationMs / 1000).toFixed(1)}s`);
  }

  const totalDuration: string = ((Date.now() - startTime) / 1000).toFixed(1);

  // Write final output (preserves CROSS-PAGE CHECK comments for review)
  const finalPath = writeTemp(page.id, 'final.mdx', r.improvedContent!);

  console.log('\n' + '='.repeat(60));
  console.log('Pipeline Complete');
  console.log('='.repeat(60));
  console.log(`Duration: ${totalDuration}s`);
  console.log(`Output: ${finalPath}`);

  if (r.review) {
    console.log(`Quality: ${r.review.qualityScore || 'N/A'}`);
    if (r.review.issues?.length > 0) {
      console.log(`Issues: ${r.review.issues.length}`);
      r.review.issues.slice(0, 3).forEach(i => console.log(`  - ${i}`));
    }
  }

  if (r.auditResult) {
    const { total, verified, failed, unchecked } = r.auditResult.summary;
    console.log(`Citations: ${total} total — ${verified} verified, ${failed} failed, ${unchecked} unchecked`);
    if (!r.auditResult.pass) {
      if (options.citationGate && dryRun) {
        console.log(`⚠ Citation audit FAILED (--citation-gate inactive in dry-run; would block --apply)`);
      } else if (options.citationGate && !dryRun) {
        console.log(`⚠ Citation audit FAILED — blocking apply (--citation-gate)`);
      } else {
        console.log(`⚠ Citation audit FAILED (advisory)`);
      }
    }
  }

  // Gate mode: abort --apply when citation audit fails
  if (options.citationGate && !dryRun && r.auditResult && !r.auditResult.pass) {
    const auditPath = path.join(TEMP_DIR, page.id, 'citation-audit.json');
    console.error('\nApply blocked: citation audit failed and --citation-gate is set.');
    console.error(`Review ${auditPath} for per-citation details.`);
    process.exit(1);
  }

  if (dryRun) {
    console.log('\nTo apply changes:');
    console.log(`  cp "${finalPath}" "${filePath}"`);
    console.log('\nOr review the diff:');
    console.log(`  diff "${filePath}" "${finalPath}"`);
  } else {
    // Apply changes: strip pipeline review comments before writing to disk (#628)
    let contentToApply = fs.readFileSync(finalPath, 'utf-8');
    contentToApply = contentToApply.replace(/\n?{\/\*\s*CROSS-PAGE CHECK[^*]*\*\/}\n?/g, '\n');

    // Validate content structure before writing (#818)
    const contentValidation = validateMdxContent(contentToApply);
    if (!contentValidation.valid) {
      console.error(`\n❌ MDX validation failed — refusing to write to ${filePath}`);
      console.error(`   Error: ${contentValidation.error}`);
      console.error(`   Content preview: ${contentToApply.slice(0, 200).replace(/\n/g, '\\n')}`);
      console.error(`   Pipeline output preserved at: ${finalPath}`);
      process.exit(1);
    }

    fs.writeFileSync(filePath, contentToApply);
    console.log(`\nChanges applied to ${filePath}`);

    // Create DB citation entries for any [^rc-XXXX] footnotes in the applied content
    try {
      const rcCreated = await createDbEntriesForRcFootnotes(contentToApply, page.id);
      if (rcCreated > 0) {
        log('apply', `Created ${rcCreated} DB citation entries for [^rc-XXXX] footnotes`);
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log('apply', `Warning: DB citation creation failed: ${error.message}`);
    }

    const adversarialNote = r.adversarialLoopResult
      ? ` [adversarial: ${r.adversarialLoopResult.iterations} iter, ${r.adversarialLoopResult.adversarialReview.gaps.length} gaps]`
      : '';
    appendEditLog(page.id, {
      tool: 'crux-improve',
      agency: 'ai-directed',
      requestedBy: getDefaultRequestedBy(),
      note: directions
        ? `Improved (${tier})${adversarialNote}: ${directions.slice(0, 100)}`
        : `Improved (${tier})${adversarialNote}`,
    });

    // Auto-grade after applying changes
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

    // Auto-log session to wiki-server DB
    if (!options.skipSessionLog) {
      await autoLogSession(page, tier, r.review, totalDuration, tierConfig.cost, serverAvailable);
    }
  }

  const results: PipelineResults = {
    pageId: page.id,
    title: page.title,
    tier,
    directions,
    duration: totalDuration,
    phases,
    review: r.review,
    adversarialLoopResult: r.adversarialLoopResult,
    enrichResult: r.enrichResult,
    auditResult: r.auditResult,
    outputPath: finalPath,
  };
  writeTemp(page.id, 'pipeline-results.json', results);

  // ── Save artifacts to wiki-server (fire-and-forget) ──────────────────────

  if (options.saveArtifacts !== false) {
    const completedAt = new Date().toISOString();
    const trimmedSourceCache = (r.research?.sources || []).map(
      (s) => ({
        id: s.url,
        url: s.url,
        title: s.title,
        author: s.author,
        date: s.date,
        facts: s.facts,
      }),
    );

    saveArtifacts({
      pageId: page.id,
      engine: 'v1' as const,
      tier: tier as 'polish' | 'standard' | 'deep',
      directions: directions || null,
      startedAt: new Date(startTime).toISOString(),
      completedAt,
      durationS: parseFloat(totalDuration),
      totalCost: null,
      sourceCache: trimmedSourceCache.length > 0 ? trimmedSourceCache : null,
      researchSummary: r.research?.summary ?? null,
      citationAudit: r.auditResult ? (r.auditResult as unknown as Record<string, unknown>) : null,
      costEntries: null,
      costBreakdown: null,
      sectionDiffs: null,
      qualityMetrics: null,
      qualityGatePassed: null,
      qualityGaps: null,
      toolCallCount: null,
      refinementCycles: null,
      phasesRun: phases,
    }).then(result => {
      if (result.ok) {
        log('artifacts', `Artifacts saved to wiki-server (id: ${result.data.id})`);
      } else {
        log('artifacts', `Warning: could not save artifacts: ${result.message}`);
      }
    }).catch(err => {
      log('artifacts', `Warning: artifact save failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

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