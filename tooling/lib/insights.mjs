/**
 * Insights Quality Library
 *
 * Pure functions for managing and analyzing insights data.
 * All functions return structured data; CLI handles output formatting.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

// === Types (JSDoc) ===

/**
 * @typedef {Object} Insight
 * @property {string} id
 * @property {string} insight
 * @property {string} source
 * @property {string[]} [tags]
 * @property {string} type
 * @property {number} surprising
 * @property {number} important
 * @property {number} actionable
 * @property {number} neglected
 * @property {number} compact
 * @property {string} [added]
 * @property {string} [lastVerified]
 * @property {string} [tableRef]
 */

/**
 * @typedef {Object} CheckResult
 * @property {boolean} passed
 * @property {number} total
 * @property {Object[]} issues
 * @property {Object} [stats]
 */

/**
 * @typedef {Object} InsightsData
 * @property {Insight[]} insights
 */

// === Data Loading ===

/**
 * Load insights from YAML file or directory
 * @param {string} pathOrDir - Path to insights.yaml or insights/ directory
 * @returns {InsightsData} Parsed insights data
 */
export function loadInsights(pathOrDir) {
  if (!existsSync(pathOrDir)) {
    throw new Error(`Insights file not found: ${pathOrDir}`);
  }

  // Check if it's a directory
  if (statSync(pathOrDir).isDirectory()) {
    return loadInsightsDir(pathOrDir);
  }

  const content = readFileSync(pathOrDir, 'utf-8');
  return parseYaml(content);
}

/**
 * Load insights from a directory of YAML files
 * @param {string} dirPath - Path to insights directory
 * @returns {InsightsData} Merged insights data
 */
export function loadInsightsDir(dirPath) {
  const files = readdirSync(dirPath).filter(f => f.endsWith('.yaml'));
  const allInsights = [];

  for (const file of files) {
    const filePath = join(dirPath, file);
    const content = readFileSync(filePath, 'utf-8');
    const data = parseYaml(content);
    if (data?.insights) {
      allInsights.push(...data.insights);
    }
  }

  return { insights: allInsights };
}

/**
 * Save insights to YAML file
 * @param {string} filePath - Path to insights.yaml
 * @param {InsightsData} data - Insights data to save
 */
export function saveInsights(filePath, data) {
  const content = stringifyYaml(data, {
    lineWidth: 120,
    defaultStringType: 'QUOTE_DOUBLE',
  });
  writeFileSync(filePath, content, 'utf-8');
}

// === Validation Checks ===

/**
 * Check for duplicate or near-duplicate insights
 * @param {Insight[]} insights - Array of insights
 * @param {Object} options - Options
 * @param {number} [options.threshold=0.7] - Similarity threshold (0-1)
 * @returns {CheckResult}
 */
export function checkDuplicates(insights, options = {}) {
  const threshold = options.threshold ?? 0.7;
  const issues = [];
  const pairs = [];

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
 * @param {Insight[]} insights - Array of insights
 * @param {Object} options - Options
 * @returns {CheckResult}
 */
export function checkRatings(insights, options = {}) {
  const issues = [];
  const ratingFields = ['surprising', 'important', 'actionable', 'neglected', 'compact'];

  for (const insight of insights) {
    // Check for missing ratings
    for (const field of ratingFields) {
      if (insight[field] === undefined || insight[field] === null) {
        issues.push({
          severity: 'error',
          message: `Missing rating '${field}' for insight ${insight.id}`,
          details: { id: insight.id, field },
        });
      } else if (typeof insight[field] !== 'number') {
        issues.push({
          severity: 'error',
          message: `Invalid rating type for '${field}' in insight ${insight.id}: expected number, got ${typeof insight[field]}`,
          details: { id: insight.id, field, value: insight[field] },
        });
      } else if (insight[field] < 1 || insight[field] > 5) {
        issues.push({
          severity: 'warning',
          message: `Rating '${field}' out of range [1-5] for insight ${insight.id}: ${insight[field]}`,
          details: { id: insight.id, field, value: insight[field] },
        });
      }
    }

    // Check for suspiciously uniform ratings
    const ratings = ratingFields.map(f => insight[f]).filter(v => typeof v === 'number');
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
  const distributions = {};
  for (const field of ratingFields) {
    const values = insights.map(i => i[field]).filter(v => typeof v === 'number');
    distributions[field] = {
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
 * @param {Insight[]} insights - Array of insights
 * @param {string} contentDir - Path to content directory
 * @returns {CheckResult}
 */
export function checkSources(insights, contentDir) {
  const issues = [];
  const validSources = [];
  const invalidSources = [];

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

/**
 * Check for stale/unverified insights
 * @param {Insight[]} insights - Array of insights
 * @param {Object} options - Options
 * @param {number} [options.staleDays=90] - Days before insight is considered stale
 * @returns {CheckResult}
 */
export function checkStaleness(insights, options = {}) {
  const staleDays = options.staleDays ?? 90;
  const issues = [];
  const now = new Date();
  const staleThreshold = new Date(now.getTime() - staleDays * 24 * 60 * 60 * 1000);

  const stale = [];
  const unverified = [];
  const recent = [];

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
 * @param {Insight[]} insights - Array of insights
 * @returns {CheckResult}
 */
export function checkSchema(insights) {
  const issues = [];
  const requiredFields = ['id', 'insight', 'source', 'type', 'surprising', 'important', 'actionable'];
  const validTypes = ['claim', 'research-gap', 'counterintuitive', 'quantitative', 'disagreement', 'neglected'];

  for (const insight of insights) {
    // Check required fields
    for (const field of requiredFields) {
      if (insight[field] === undefined || insight[field] === null) {
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

/**
 * Run all checks on insights
 * @param {Insight[]} insights - Array of insights
 * @param {string} contentDir - Path to content directory
 * @param {Object} options - Options
 * @param {string[]} [options.only] - Run only these checks
 * @param {string[]} [options.skip] - Skip these checks
 * @returns {Object} Combined results from all checks
 */
export function runAllChecks(insights, contentDir, options = {}) {
  const checks = {
    schema: () => checkSchema(insights),
    duplicates: () => checkDuplicates(insights, options),
    ratings: () => checkRatings(insights, options),
    sources: () => checkSources(insights, contentDir),
    staleness: () => checkStaleness(insights, options),
  };

  const results = {};
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
 * @param {Insight[]} insights - Array of insights
 * @returns {Object} Statistics
 */
export function computeStats(insights) {
  const ratingFields = ['surprising', 'important', 'actionable', 'neglected', 'compact'];

  // Type distribution
  const byType = {};
  for (const insight of insights) {
    byType[insight.type] = (byType[insight.type] || 0) + 1;
  }

  // Tag frequency
  const tagCounts = {};
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
  const ratings = {};
  for (const field of ratingFields) {
    const values = insights.map(i => i[field]).filter(v => typeof v === 'number');
    if (values.length > 0) {
      const sorted = [...values].sort((a, b) => a - b);
      ratings[field] = {
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
 * @param {Insight[]} insights - Array of insights
 * @param {string} [date] - Date to use (defaults to today)
 * @returns {Insight[]} Modified insights
 */
export function addVerificationDates(insights, date = null) {
  const verifyDate = date || new Date().toISOString().split('T')[0];
  return insights.map(insight => ({
    ...insight,
    lastVerified: verifyDate,
  }));
}

/**
 * Normalize ratings to be within valid range
 * @param {Insight[]} insights - Array of insights
 * @returns {Insight[]} Modified insights with clamped ratings
 */
export function normalizeRatings(insights) {
  const ratingFields = ['surprising', 'important', 'actionable', 'neglected', 'compact'];

  return insights.map(insight => {
    const normalized = { ...insight };
    for (const field of ratingFields) {
      if (typeof normalized[field] === 'number') {
        normalized[field] = Math.max(1, Math.min(5, normalized[field]));
      }
    }
    return normalized;
  });
}

// === Similarity ===

/**
 * Compute text similarity between two insights
 * Uses Jaccard similarity on word n-grams
 * @param {Insight} insight1 - First insight
 * @param {Insight} insight2 - Second insight
 * @returns {number} Similarity score (0-1)
 */
export function computeSimilarity(insight1, insight2) {
  const text1 = insight1.insight.toLowerCase();
  const text2 = insight2.insight.toLowerCase();

  // Get word bigrams
  const getBigrams = (text) => {
    const words = text.split(/\s+/).filter(w => w.length > 2);
    const bigrams = new Set();
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
