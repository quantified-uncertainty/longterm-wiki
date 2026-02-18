/**
 * Hallucination Risk Report
 *
 * Identifies pages most vulnerable to hallucination based on:
 *   - Citation count (fewer citations = higher risk)
 *   - Entity type (person/org pages are higher risk for biographical claims)
 *   - Quality score (lower quality correlates with less-verified content)
 *   - Structural indicators (unsourced biographical claims, evaluative flattery)
 *
 * Outputs a ranked list of pages with risk scores and actionable recommendations.
 *
 * Usage:
 *   pnpm crux validate hallucination-risk
 *   pnpm crux validate hallucination-risk --json
 *   pnpm crux validate hallucination-risk --top=20
 *
 * Part of the hallucination risk reduction initiative (issue #200).
 */

import { readFileSync } from 'fs';
import { join, relative, basename } from 'path';
import { PROJECT_ROOT, CONTENT_DIR_ABS } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { parseFrontmatterAndBody } from '../lib/mdx-utils.ts';
import { countFootnoteRefs, countWords } from '../lib/metrics-extractor.ts';
import { getColors } from '../lib/output.ts';
import { parseCliArgs } from '../lib/cli.ts';
import { readReviews } from '../lib/review-tracking.ts';
import { stripFrontmatter } from '../lib/patterns.ts';
import { getEntityTypeFromPath } from '../lib/page-analysis.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RiskAssessment {
  pageId: string;
  path: string;
  title: string;
  entityType: string | null;
  quality: number;
  wordCount: number;
  citationCount: number;
  rComponentCount: number;
  totalCitations: number;
  hasHumanReview: boolean;
  riskScore: number;
  riskLevel: 'high' | 'medium' | 'low';
  riskFactors: string[];
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------

/** Entity type risk multipliers — higher = more sensitive to hallucination */
const ENTITY_TYPE_RISK: Record<string, number> = {
  person: 1.5,       // Biographical claims about real people
  organization: 1.4, // Organizational facts (funding, headcount, etc.)
  historical: 1.3,   // Historical dates and events
  risk: 1.0,
  response: 0.9,
  model: 0.9,
  concept: 0.8,
  overview: 0.8,
  metric: 0.7,
  debate: 0.8,
  crux: 0.7,
};

function countRComponents(body: string): number {
  const matches = body.match(/<R\s+id=/g);
  return matches ? matches.length : 0;
}

function assessPage(filePath: string): RiskAssessment | null {
  const relativePath = relative(join(PROJECT_ROOT, 'content/docs'), filePath);

  // Only assess knowledge-base pages
  if (!relativePath.startsWith('knowledge-base/')) return null;

  // Skip index pages
  if (basename(filePath).startsWith('index.')) return null;

  const raw = readFileSync(filePath, 'utf-8');
  const { frontmatter, body } = parseFrontmatterAndBody(raw);

  // Skip stubs and documentation pages
  if (frontmatter.pageType === 'stub' || frontmatter.pageType === 'documentation') return null;

  const bodyContent = stripFrontmatter(raw);
  const wordCount = countWords(bodyContent);

  // Skip very short pages
  if (wordCount < 200) return null;

  const pageId = basename(filePath, '.mdx');
  const entityType = getEntityTypeFromPath(relativePath);
  const quality = typeof frontmatter.quality === 'number' ? frontmatter.quality : 0;
  const citationCount = countFootnoteRefs(bodyContent);
  const rComponentCount = countRComponents(body);
  const totalCitations = citationCount + rComponentCount;
  const hasHumanReview = readReviews(pageId).length > 0;

  // Calculate risk score (0-100, higher = more at risk)
  const riskFactors: string[] = [];
  let riskScore = 0;

  // Factor 1: No citations (biggest risk)
  if (totalCitations === 0) {
    riskScore += 40;
    riskFactors.push('no-citations');
  } else if (totalCitations < 3) {
    riskScore += 20;
    riskFactors.push('few-citations');
  } else if (totalCitations < 5) {
    riskScore += 10;
    riskFactors.push('below-target-citations');
  }

  // Factor 2: Entity type sensitivity
  if (entityType) {
    const multiplier = ENTITY_TYPE_RISK[entityType] ?? 1.0;
    if (multiplier >= 1.3) {
      riskScore += 15;
      riskFactors.push(`biographical-claims`);
    }
  }

  // Factor 3: Low quality score
  if (quality < 40) {
    riskScore += 15;
    riskFactors.push('low-quality-score');
  } else if (quality < 60) {
    riskScore += 5;
  }

  // Factor 4: Few external sources relative to page length
  const citationsPerKWords = wordCount > 0 ? (totalCitations / wordCount) * 1000 : 0;
  if (citationsPerKWords < 2 && wordCount >= 500) {
    riskScore += 10;
    riskFactors.push('few-external-sources');
  }

  // Factor 5: Low rigor score
  const rigor = frontmatter.ratings?.rigor;
  if (typeof rigor === 'number' && rigor < 40) {
    riskScore += 10;
    riskFactors.push('low-rigor-score');
  }

  // Factor 6: No human review
  if (!hasHumanReview) {
    riskScore += 5;
    riskFactors.push('no-human-review');
  }

  // Apply entity type multiplier
  if (entityType) {
    const multiplier = ENTITY_TYPE_RISK[entityType] ?? 1.0;
    riskScore = Math.round(riskScore * multiplier);
  }

  // Cap at 100
  riskScore = Math.min(100, riskScore);

  // Classify risk level
  const riskLevel: 'high' | 'medium' | 'low' =
    riskScore >= 50 ? 'high' :
    riskScore >= 25 ? 'medium' :
    'low';

  return {
    pageId,
    path: relativePath,
    title: (frontmatter.title as string) || pageId,
    entityType,
    quality,
    wordCount,
    citationCount,
    rComponentCount,
    totalCitations,
    hasHumanReview,
    riskScore,
    riskLevel,
    riskFactors,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const ci = args.ci === true;
  const json = args.json === true;
  const topN = parseInt((args.top as string) || '0', 10);
  const colors = getColors(ci || json);

  // Assess all pages
  const files = findMdxFiles(CONTENT_DIR_ABS);
  const assessments: RiskAssessment[] = [];

  for (const f of files) {
    try {
      const a = assessPage(f);
      if (a) assessments.push(a);
    } catch {
      // Skip files that can't be parsed
    }
  }

  // Sort by risk score (highest first)
  assessments.sort((a, b) => b.riskScore - a.riskScore);

  // Aggregate stats
  const high = assessments.filter(a => a.riskLevel === 'high');
  const medium = assessments.filter(a => a.riskLevel === 'medium');
  const low = assessments.filter(a => a.riskLevel === 'low');
  const zeroCitations = assessments.filter(a => a.totalCitations === 0);

  // Count by entity type in high risk
  const highByType: Record<string, number> = {};
  for (const a of high) {
    const type = a.entityType || 'other';
    highByType[type] = (highByType[type] || 0) + 1;
  }

  // Count risk factors
  const factorCounts: Record<string, number> = {};
  for (const a of high) {
    for (const f of a.riskFactors) {
      factorCounts[f] = (factorCounts[f] || 0) + 1;
    }
  }

  if (ci || json) {
    const output = {
      summary: {
        totalAssessed: assessments.length,
        high: high.length,
        medium: medium.length,
        low: low.length,
        zeroCitations: zeroCitations.length,
      },
      highByEntityType: highByType,
      riskFactors: factorCounts,
      pages: topN > 0 ? assessments.slice(0, topN) : assessments,
    };
    console.log(JSON.stringify(output, null, 2));
    process.exit(0);
  }

  // Human-readable output
  const c = colors;
  console.log(`\n${c.bold}${c.blue}Hallucination Risk Report${c.reset}\n`);
  console.log(`  Total pages assessed: ${c.bold}${assessments.length}${c.reset}`);
  console.log(`  ${c.red}High risk:${c.reset}   ${high.length}`);
  console.log(`  ${c.yellow}Medium risk:${c.reset} ${medium.length}`);
  console.log(`  ${c.green}Low risk:${c.reset}    ${low.length}`);
  console.log(`  Zero citations: ${zeroCitations.length}\n`);

  // High risk by entity type
  if (Object.keys(highByType).length > 0) {
    console.log(`${c.bold}High-Risk Pages by Entity Type:${c.reset}`);
    for (const [type, count] of Object.entries(highByType).sort((a, b) => b[1] - a[1])) {
      console.log(`  ${type.padEnd(16)} ${count}`);
    }
    console.log('');
  }

  // Risk factors
  if (Object.keys(factorCounts).length > 0) {
    console.log(`${c.bold}Dominant Risk Factors (high-risk pages):${c.reset}`);
    for (const [factor, count] of Object.entries(factorCounts).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((count / high.length) * 100);
      console.log(`  ${factor.padEnd(24)} ${String(count).padStart(4)} (${pct}%)`);
    }
    console.log('');
  }

  // Top pages table
  const display = topN > 0 ? assessments.slice(0, topN) : assessments.slice(0, 30);
  console.log(`${c.bold}Top ${display.length} Highest-Risk Pages:${c.reset}`);
  console.log(`${'Risk'.padStart(5)}  ${'Cites'.padStart(5)}  ${'Words'.padStart(6)}  ${'Q'.padStart(3)}  ${'Type'.padEnd(14)} Page`);
  console.log(`${c.dim}${'─'.repeat(75)}${c.reset}`);

  for (const a of display) {
    const riskColor = a.riskLevel === 'high' ? c.red : a.riskLevel === 'medium' ? c.yellow : c.green;
    console.log(
      `${riskColor}${String(a.riskScore).padStart(5)}${c.reset}  ` +
      `${String(a.totalCitations).padStart(5)}  ` +
      `${String(a.wordCount).padStart(6)}  ` +
      `${String(a.quality).padStart(3)}  ` +
      `${(a.entityType || '-').padEnd(14)} ` +
      `${a.pageId}`
    );
  }

  console.log(`\n${c.dim}Run with --top=20 to limit results, or --json for machine-readable output${c.reset}\n`);

  // Exit with non-zero if there are high-risk pages (advisory, not blocking)
  process.exit(0);
}

main().catch((err: Error) => {
  console.error('Error:', err.message);
  process.exit(1);
});
