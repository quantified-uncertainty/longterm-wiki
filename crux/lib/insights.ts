/**
 * Insights Quality Library
 *
 * Pure functions for managing and analyzing insights data.
 * All functions return structured data; CLI handles output formatting.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// === Types ===

export interface Insight {
  id: string;
  insight: string;
  source: string;
  tags?: string[];
  type: string;
  surprising: number;
  important: number;
  actionable: number;
  neglected: number;
  compact: number;
  added?: string;
  lastVerified?: string;
  tableRef?: string;
  [key: string]: unknown;
}

export interface CheckIssue {
  severity: 'error' | 'warning' | 'info';
  message: string;
  details: Record<string, unknown>;
}

export interface CheckResult {
  passed: boolean;
  total: number;
  issues: CheckIssue[];
  stats?: Record<string, unknown>;
  pairs?: DuplicatePair[];
}

export interface DuplicatePair {
  id1: string;
  id2: string;
  similarity: number;
  text1: string;
  text2: string;
}

export interface InsightsData {
  insights: Insight[];
}

export interface RatingDistribution {
  min: number;
  max: number;
  mean: number;
  median: number;
}

export interface InsightStats {
  total: number;
  byType: Record<string, number>;
  topTags: Array<{ tag: string; count: number }>;
  ratings: Record<string, RatingDistribution>;
  topByComposite: Array<{ id: string; composite: number; text: string }>;
  verification: {
    verified: number;
    unverified: number;
    percentVerified: number;
  };
}

export interface AllChecksResult {
  passed: boolean;
  total: number;
  checksRun: number;
  totalIssues: number;
  results: Record<string, CheckResult>;
}

// === Data Loading ===

/**
 * Load insights from YAML file or directory
 */
export function loadInsights(pathOrDir: string): InsightsData {
  if (!existsSync(pathOrDir)) {
    throw new Error(`Insights file not found: ${pathOrDir}`);
  }

  // Check if it's a directory
  if (statSync(pathOrDir).isDirectory()) {
    return loadInsightsDir(pathOrDir);
  }

  const content = readFileSync(pathOrDir, 'utf-8');
  return parseYaml(content) as InsightsData;
}

/**
 * Load insights from a directory of YAML files
 */
export function loadInsightsDir(dirPath: string): InsightsData {
  const files = readdirSync(dirPath).filter((f: string) => f.endsWith('.yaml'));
  const allInsights: Insight[] = [];

  for (const file of files) {
    const filePath = join(dirPath, file);
    const content = readFileSync(filePath, 'utf-8');
    const data = parseYaml(content) as InsightsData | null;
    if (data?.insights) {
      allInsights.push(...data.insights);
    }
  }

  return { insights: allInsights };
}

/**
 * Save insights to YAML file
 */
export function saveInsights(filePath: string, data: InsightsData): void {
  const content = stringifyYaml(data, {
    lineWidth: 120,
    defaultStringType: 'QUOTE_DOUBLE',
  });
  writeFileSync(filePath, content, 'utf-8');
}

// === Validation Checks ===

export interface DuplicateCheckOptions {
  threshold?: number;
}

/**
 * Check for duplicate or near-duplicate insights
 */
export function checkDuplicates(insights: Insight[], options: DuplicateCheckOptions = {}): CheckResult {
  const threshold = options.threshold ?? 0.7;
  const issues: CheckIssue[] = [];
  const pairs: DuplicatePair[] = [];

  for (let i = 0; i < insights.length; i++) {
    for (let j = i + 1; j < insights.length; j++) {
      const similarity = computeSimilarity(insights[i], insights[j]);
      if (similarity >= threshold) {
        pairs.push({
          id1: insights[i].id,
          id2: insights[j].id,
          similarity: Math.round(similarity * 100) / 100,
          text1: insights[i].insight.substring(0, 80) + '...',
          text2: insights[j].insight.substring(0, 80) + '...',
        });
        issues.push({
          severity: similarity >= 0.9 ? 'error' : 'warning',
          message: `Potential duplicate: ${insights[i].id} ↔ ${insights[j].id} (${Math.round(similarity * 100)}% similar)`,
          details: { id1: insights[i].id, id2: insights[j].id, similarity },
        });
      }
    }
  }

  return {
    passed: issues.filter(i => i.severity === 'error').length === 0,
    total: insights.length,
    issues,
    stats: {
      pairsChecked: (insights.length * (insights.length - 1)) / 2,
      duplicatesFound: pairs.length,
      threshold,
    },
    pairs,
  };
}

/**
 * Check rating calibration and consistency
 */
export function checkRatings(insights: Insight[], _options: Record<string, unknown> = {}): CheckResult {
  const issues: CheckIssue[] = [];
  const ratingFields: (keyof Insight)[] = ['surprising', 'important', 'actionable', 'neglected', 'compact'];

  for (const insight of insights) {
    // Check for missing ratings
    for (const field of ratingFields) {
      if (insight[field] === undefined || insight[field] === null) {
        issues.push({
          severity: 'error',
          message: `Missing rating '${String(field)}' for insight ${insight.id}`,
          details: { id: insight.id, field: String(field) },
        });
      } else if (typeof insight[field] !== 'number') {
        issues.push({
          severity: 'error',
          message: `Invalid rating type for '${String(field)}' in insight ${insight.id}: expected number, got ${typeof insight[field]}`,
          details: { id: insight.id, field: String(field), value: insight[field] },
        });
      } else if ((insight[field] as number) < 1 || (insight[field] as number) > 5) {
        issues.push({
          severity: 'warning',
          message: `Rating '${String(field)}' out of range [1-5] for insight ${insight.id}: ${insight[field]}`,
          details: { id: insight.id, field: String(field), value: insight[field] },
        });
      }
    }

    // Check for suspiciously uniform ratings
    const ratings = ratingFields.map(f => insight[f]).filter(v => typeof v === 'number') as number[];
    if (ratings.length === ratingFields.length) {
      const allSame = ratings.every(r => r === ratings[0]);
      if (allSame) {
        issues.push({
          severity: 'warning',
          message: `All ratings identical (${ratings[0]}) for insight ${insight.id} - consider if this is intentional`,
          details: { id: insight.id, ratings },
        });
      }
    }
  }

  // Compute rating distributions
  const distributions: Record<string, RatingDistribution> = {};
  for (const field of ratingFields) {
    const values = insights.map(i => i[field]).filter(v => typeof v === 'number') as number[];
    distributions[String(field)] = {
      min: Math.min(...values),
      max: Math.max(...values),
      mean: values.reduce((a, b) => a + b, 0) / values.length,
      median: values.sort((a, b) => a - b)[Math.floor(values.length / 2)],
    };
  }

  return {
    passed: issues.filter(i => i.severity === 'error').length === 0,
    total: insights.length,
    issues,
    stats: { distributions },
  };
}

/**
 * Check that source paths exist
 */
export function checkSources(insights: Insight[], contentDir: string): CheckResult {
  const issues: CheckIssue[] = [];
  const validSources: string[] = [];
  const invalidSources: string[] = [];

  for (const insight of insights) {
    if (!insight.source) {
      issues.push({
        severity: 'error',
        message: `Missing source for insight ${insight.id}`,
        details: { id: insight.id },
      });
      invalidSources.push(insight.id);
      continue;
    }

    // Convert source path to file path
    // e.g., /knowledge-base/cruxes/accident-risks -> content/docs/knowledge-base/cruxes/accident-risks.mdx
    const sourcePath = insight.source.replace(/^\//, '');
    const possiblePaths = [
      join(contentDir, sourcePath + '.mdx'),
      join(contentDir, sourcePath + '.md'),
      join(contentDir, sourcePath, 'index.mdx'),
      join(contentDir, sourcePath, 'index.md'),
    ];

    const exists = possiblePaths.some(p => existsSync(p));
    if (!exists) {
      issues.push({
        severity: 'warning',
        message: `Source path not found for insight ${insight.id}: ${insight.source}`,
        details: { id: insight.id, source: insight.source, checkedPaths: possiblePaths },
      });
      invalidSources.push(insight.id);
    } else {
      validSources.push(insight.id);
    }
  }

  return {
    passed: issues.filter(i => i.severity === 'error').length === 0,
    total: insights.length,
    issues,
    stats: {
      validSources: validSources.length,
      invalidSources: invalidSources.length,
    },
  };
}

export interface StalenessCheckOptions {
  staleDays?: number;
}

/**
 * Check for stale/unverified insights
 */
export function checkStaleness(insights: Insight[], options: StalenessCheckOptions = {}): CheckResult {
  const staleDays = options.staleDays ?? 90;
  const issues: CheckIssue[] = [];
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000);

  const stale: string[] = [];
  const unverified: string[] = [];
  const recent: string[] = [];

  for (const insight of insights) {
    if (!insight.lastVerified) {
      unverified.push(insight.id);
      issues.push({
        severity: 'info',
        message: `Insight ${insight.id} has never been verified`,
        details: { id: insight.id },
      });
    } else {
      const verifiedDate = new Date(insight.lastVerified);
      if (verifiedDate < staleThreshold) {
        stale.push(insight.id);
        issues.push({
          severity: 'warning',
          message: `Insight ${insight.id} is stale (last verified: ${insight.lastVerified})`,
          details: { id: insight.id, lastVerified: insight.lastVerified },
        });
      } else {
        recent.push(insight.id);
      }
    }
  }

  return {
    passed: true, // Staleness is informational, not a failure
    total: insights.length,
    issues,
    stats: {
      stale: stale.length,
      unverified: unverified.length,
      recent: recent.length,
      staleDays,
    },
  };
}

/**
 * Check schema compliance
 */
export function checkSchema(insights: Insight[]): CheckResult {
  const issues: CheckIssue[] = [];
  const requiredFields = ['id', 'insight', 'source', 'type', 'surprising', 'important', 'actionable'];
  const validTypes = ['claim', 'research-gap', 'counterintuitive', 'quantitative', 'disagreement', 'neglected'];

  for (const insight of insights) {
    // Check required fields
    for (const field of requiredFields) {
      if ((insight as Record<string, unknown>)[field] === undefined || (insight as Record<string, unknown>)[field] === null) {
        issues.push({
          severity: 'error',
          message: `Missing required field '${field}' for insight ${insight.id || '(unknown)'}`,
          details: { id: insight.id, field },
        });
      }
    }

    // Check type validity
    if (insight.type && !validTypes.includes(insight.type)) {
      issues.push({
        severity: 'error',
        message: `Invalid type '${insight.type}' for insight ${insight.id}. Valid types: ${validTypes.join(', ')}`,
        details: { id: insight.id, type: insight.type, validTypes },
      });
    }

    // Check ID format
    if (insight.id && !/^[a-zA-Z0-9_-]+$/.test(insight.id)) {
      issues.push({
        severity: 'warning',
        message: `ID contains unusual characters for insight ${insight.id}`,
        details: { id: insight.id },
      });
    }

    // Check tags is an array
    if (insight.tags && !Array.isArray(insight.tags)) {
      issues.push({
        severity: 'error',
        message: `Tags must be an array for insight ${insight.id}`,
        details: { id: insight.id, tags: insight.tags },
      });
    }
  }

  // Check for duplicate IDs
  const ids = insights.map(i => i.id);
  const duplicateIds = ids.filter((id, idx) => ids.indexOf(id) !== idx);
  for (const dupId of [...new Set(duplicateIds)]) {
    issues.push({
      severity: 'error',
      message: `Duplicate insight ID: ${dupId}`,
      details: { id: dupId },
    });
  }

  return {
    passed: issues.filter(i => i.severity === 'error').length === 0,
    total: insights.length,
    issues,
    stats: {
      schemaErrors: issues.filter(i => i.severity === 'error').length,
      schemaWarnings: issues.filter(i => i.severity === 'warning').length,
    },
  };
}

export interface RunAllChecksOptions {
  only?: string[];
  skip?: string[];
  threshold?: number;
  staleDays?: number;
}

/**
 * Run all checks on insights
 */
export function runAllChecks(insights: Insight[], contentDir: string, options: RunAllChecksOptions = {}): AllChecksResult {
  const checks: Record<string, () => CheckResult> = {
    schema: () => checkSchema(insights),
    duplicates: () => checkDuplicates(insights, options),
    ratings: () => checkRatings(insights),
    sources: () => checkSources(insights, contentDir),
    staleness: () => checkStaleness(insights, options),
  };

  const results: Record<string, CheckResult> = {};
  let allPassed = true;
  let totalIssues = 0;

  for (const [name, checkFn] of Object.entries(checks)) {
    // Filter checks based on only/skip
    if (options.only && !options.only.includes(name)) continue;
    if (options.skip && options.skip.includes(name)) continue;

    const result = checkFn();
    results[name] = result;
    if (!result.passed) allPassed = false;
    totalIssues += result.issues.length;
  }

  return {
    passed: allPassed,
    total: insights.length,
    checksRun: Object.keys(results).length,
    totalIssues,
    results,
  };
}

// === Statistics ===

/**
 * Compute statistics about insights
 */
export function computeStats(insights: Insight[]): InsightStats {
  const ratingFields: (keyof Insight)[] = ['surprising', 'important', 'actionable', 'neglected', 'compact'];

  // Type distribution
  const byType: Record<string, number> = {};
  for (const insight of insights) {
    byType[insight.type] = (byType[insight.type] || 0) + 1;
  }

  // Tag frequency
  const tagCounts: Record<string, number> = {};
  for (const insight of insights) {
    if (insight.tags) {
      for (const tag of insight.tags) {
        tagCounts[tag] = (tagCounts[tag] || 0) + 1;
      }
    }
  }

  // Top tags
  const topTags = Object.entries(tagCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([tag, count]) => ({ tag, count }));

  // Rating distributions
  const ratings: Record<string, RatingDistribution> = {};
  for (const field of ratingFields) {
    const values = insights.map(i => i[field]).filter(v => typeof v === 'number') as number[];
    if (values.length > 0) {
      const sorted = [...values].sort((a, b) => a - b);
      ratings[String(field)] = {
        min: sorted[0],
        max: sorted[sorted.length - 1],
        mean: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
        median: sorted[Math.floor(sorted.length / 2)],
      };
    }
  }

  // Composite scores (top insights)
  const withComposite = insights.map(i => ({
    ...i,
    composite: (i.surprising + i.important + i.actionable) / 3,
  }));
  const topByComposite = withComposite
    .sort((a, b) => b.composite - a.composite)
    .slice(0, 10)
    .map(i => ({
      id: i.id,
      composite: Math.round(i.composite * 100) / 100,
      text: i.insight.substring(0, 60) + '...',
    }));

  // Verification status
  const verified = insights.filter(i => i.lastVerified).length;
  const unverified = insights.length - verified;

  return {
    total: insights.length,
    byType,
    topTags,
    ratings,
    topByComposite,
    verification: {
      verified,
      unverified,
      percentVerified: Math.round((verified / insights.length) * 100),
    },
  };
}

// === Transformations ===

/**
 * Add verification dates to insights
 */
export function addVerificationDates(insights: Insight[], date: string | null = null): Insight[] {
  const verifyDate = date || new Date().toISOString().split('T')[0];
  return insights.map(insight => ({
    ...insight,
    lastVerified: verifyDate,
  }));
}

/**
 * Normalize ratings to be within valid range
 */
export function normalizeRatings(insights: Insight[]): Insight[] {
  const ratingFields: (keyof Insight)[] = ['surprising', 'important', 'actionable', 'neglected', 'compact'];

  return insights.map(insight => {
    const normalized = { ...insight };
    for (const field of ratingFields) {
      if (typeof normalized[field] === 'number') {
        (normalized as Record<string, unknown>)[field as string] = Math.max(1, Math.min(5, normalized[field] as number));
      }
    }
    return normalized;
  });
}

// === Similarity ===

/**
 * Compute text similarity between two insights
 * Uses Jaccard similarity on word n-grams
 */
export function computeSimilarity(insight1: Insight, insight2: Insight): number {
  const text1 = insight1.insight.toLowerCase();
  const text2 = insight2.insight.toLowerCase();

  // Get word bigrams
  const getBigrams = (text: string): Set<string> => {
    const words = text.split(/\s+/).filter(w => w.length > 2);
    const bigrams = new Set<string>();
    for (let i = 0; i < words.length - 1; i++) {
      bigrams.add(`${words[i]} ${words[i + 1]}`);
    }
    return bigrams;
  };

  const bigrams1 = getBigrams(text1);
  const bigrams2 = getBigrams(text2);

  if (bigrams1.size === 0 || bigrams2.size === 0) return 0;

  // Jaccard similarity
  let intersection = 0;
  for (const bigram of bigrams1) {
    if (bigrams2.has(bigram)) intersection++;
  }

  const union = bigrams1.size + bigrams2.size - intersection;
  return intersection / union;
}
