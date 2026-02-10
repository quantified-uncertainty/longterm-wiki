#!/usr/bin/env node

/**
 * Cross-Page Consistency Validation Script
 *
 * Checks for consistency across content pages:
 * - Probability estimates: flags when same topic has non-overlapping ranges
 * - Causal claims: checks if prose claims match entity relationships
 * - Terminology: identifies inconsistent term usage
 *
 * Usage: node scripts/validate-consistency.mjs [--ci]
 *
 * Exit codes:
 *   0 = No consistency issues (info items don't block)
 *   1 = Significant inconsistencies found
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';
import { findMdxFiles } from '../lib/file-utils.mjs';
import { getContentBody } from '../lib/mdx-utils.mjs';
import { getColors, formatPath } from '../lib/output.mjs';
import { CONTENT_DIR, DATA_DIR } from '../lib/content-types.js';

const CI_MODE = process.argv.includes('--ci');
const colors = getColors(CI_MODE);

// Pages that intentionally document ranges of views (should be skipped for consistency checks)
// These pages quote different experts/sources with varying estimates by design
const MULTI_VIEW_PAGES = [
  '/metrics/',
  '/getting-started/',
  '/arguments/',
  '/debates/',
  '/models/',
  '/people/',           // Researcher pages document individual estimates
  '/organizations/',    // Organization pages document key researchers' estimates
  '/core-argument/',    // These pages explicitly present different perspectives
  '/scenarios/',        // Scenario pages have different assumptions
  '/guides/',           // Guide pages explain the range of views
];

// Topics where varying estimates across pages are expected and should not be flagged as warnings
// These are inherently multi-view topics where experts disagree - most probability claims
// in this knowledge base document the range of expert opinion, not contradictions
const EXPECTED_VARIANCE_TOPICS = [
  'p-doom',
  'timelines',
  'alignment-difficulty',
  'deceptive-alignment',
  'mesa-optimization',
  'bioweapons',
  'cyberweapons',
];

// Keywords that help identify which topic a probability claim relates to
const TOPIC_KEYWORDS = {
  'p-doom': ['doom', 'extinction', 'existential', 'x-risk', 'catastroph', 'human extinction'],
  'alignment-difficulty': ['alignment', 'difficult', 'hard', 'solve', 'tractab'],
  'timelines': ['timeline', 'agi', 'tai', '203', '204', 'years', 'decade'],
  'deceptive-alignment': ['deceptive', 'deception', 'scheming', 'hidden goal'],
  'mesa-optimization': ['mesa', 'inner optimizer', 'inner objective'],
  'bioweapons': ['bio', 'pathogen', 'pandemic', 'virus', 'uplift'],
  'cyberweapons': ['cyber', 'vulnerability', 'exploit', 'zero-day', 'infrastructure'],
};

// Terms that should be used consistently
const TERM_VARIANTS = {
  'AGI': ['AGI', 'Artificial General Intelligence', 'general AI', 'human-level AI'],
  'ASI': ['ASI', 'Artificial Superintelligence', 'superintelligent AI', 'superintelligence'],
  'TAI': ['TAI', 'Transformative AI', 'transformative artificial intelligence'],
  'p(doom)': ['p(doom)', 'p-doom', 'P(doom)', 'probability of doom', 'extinction probability'],
  'x-risk': ['x-risk', 'X-risk', 'existential risk', 'xrisk'],
};

/**
 * Load entities from YAML
 */
function loadEntities() {
  const entitiesPath = join(DATA_DIR, 'entities.yaml');
  if (!existsSync(entitiesPath)) return [];
  try {
    const content = readFileSync(entitiesPath, 'utf-8');
    return parseYaml(content) || [];
  } catch {
    return [];
  }
}

/**
 * Extract probability claims from content
 */
function extractProbabilityClaims(content, filePath) {
  const claims = [];
  const lines = content.split('\n');

  // Pattern: "X-Y%" or "X%" with surrounding context
  const percentPattern = /(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)\s*%|(\d+(?:\.\d+)?)\s*%/g;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match;

    while ((match = percentPattern.exec(line)) !== null) {
      // Get surrounding context (100 chars each side for topic detection)
      const contextStart = Math.max(0, i - 2);
      const contextEnd = Math.min(lines.length - 1, i + 2);
      const context = lines.slice(contextStart, contextEnd + 1).join(' ').toLowerCase();

      // Determine topic from context
      let topic = 'unknown';
      for (const [t, keywords] of Object.entries(TOPIC_KEYWORDS)) {
        if (keywords.some(k => context.includes(k.toLowerCase()))) {
          topic = t;
          break;
        }
      }

      // Skip unknown topics (too noisy)
      if (topic === 'unknown') continue;

      const low = parseFloat(match[1] || match[3]);
      const high = parseFloat(match[2] || match[3]);

      claims.push({
        filePath,
        line: i + 1,
        value: match[1] && match[2] ? `${match[1]}-${match[2]}%` : `${match[3]}%`,
        low,
        high,
        topic,
        lineContent: line.substring(0, 100),
      });
    }
  }

  return claims;
}

/**
 * Check if a file path matches any multi-view page pattern
 */
function isMultiViewPage(filePath) {
  return MULTI_VIEW_PAGES.some(pattern => filePath.includes(pattern));
}

/**
 * Check for inconsistent probability estimates across pages
 */
function checkProbabilityConsistency(allClaims) {
  const issues = [];

  // Filter out claims from multi-view pages (they intentionally document diverse estimates)
  const filteredClaims = allClaims.filter(claim => !isMultiViewPage(claim.filePath));

  // Group claims by topic
  const byTopic = {};
  for (const claim of filteredClaims) {
    if (!byTopic[claim.topic]) byTopic[claim.topic] = [];
    byTopic[claim.topic].push(claim);
  }

  for (const [topic, claims] of Object.entries(byTopic)) {
    if (claims.length < 2) continue;

    // Check for non-overlapping ranges
    for (let i = 0; i < claims.length; i++) {
      for (let j = i + 1; j < claims.length; j++) {
        const a = claims[i];
        const b = claims[j];

        // Skip if same file
        if (a.filePath === b.filePath) continue;

        // Check for non-overlapping ranges
        if (a.high < b.low || b.high < a.low) {
          const gap = Math.min(Math.abs(a.high - b.low), Math.abs(b.high - a.low));

          // Only flag significant gaps (> 15 percentage points)
          if (gap > 15) {
            // Topics with expected variance (p-doom, timelines) are info, not warnings
            // since documenting diverse expert views is intentional
            const severity = EXPECTED_VARIANCE_TOPICS.includes(topic) ? 'info' : 'warning';

            issues.push({
              id: 'probability-inconsistency',
              severity,
              topic,
              description: `"${topic}" estimates differ significantly: ${a.value} vs ${b.value}`,
              gap: `${gap.toFixed(0)} percentage points apart`,
              locations: [
                { file: a.filePath, line: a.line, value: a.value },
                { file: b.filePath, line: b.line, value: b.value },
              ],
            });
          }
        }
      }
    }
  }

  // Deduplicate (same pair might be found multiple times)
  const seen = new Set();
  return issues.filter(issue => {
    const key = issue.locations.map(l => `${l.file}:${l.line}`).sort().join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Check for terminology consistency
 */
function checkTerminologyConsistency(allContent) {
  const issues = [];

  for (const [canonical, variants] of Object.entries(TERM_VARIANTS)) {
    const usage = {};

    for (const { content, filePath } of allContent) {
      for (const variant of variants) {
        // Case-sensitive match for acronyms, case-insensitive for phrases
        const regex = variant.length <= 5
          ? new RegExp(`\\b${variant}\\b`, 'g')
          : new RegExp(`\\b${variant}\\b`, 'gi');

        const matches = content.match(regex);
        if (matches && matches.length > 0) {
          if (!usage[variant]) usage[variant] = [];
          usage[variant].push({ filePath, count: matches.length });
        }
      }
    }

    const usedVariants = Object.keys(usage);

    // If more than 2 variants are used, flag it
    if (usedVariants.length > 2) {
      issues.push({
        id: 'terminology-inconsistency',
        severity: 'info',
        term: canonical,
        description: `Multiple variants used for "${canonical}"`,
        variants: usedVariants.map(v => ({
          variant: v,
          files: usage[v].length,
          totalUses: usage[v].reduce((sum, u) => sum + u.count, 0),
        })),
        suggestion: `Consider standardizing to "${canonical}" or the most common variant`,
      });
    }
  }

  return issues;
}

/**
 * Check if causal claims in prose match entity relationships
 */
function checkCausalConsistency(allContent, entities) {
  const issues = [];

  // Build a map of entity relationships
  const relationships = new Map();
  for (const entity of entities) {
    if (entity.relatedEntries) {
      for (const rel of entity.relatedEntries) {
        const key = `${entity.id}:${rel.id}`;
        relationships.set(key, rel.relationship || 'related');
      }
    }
  }

  // Build a map of entity titles to IDs for matching
  const titleToId = new Map();
  for (const entity of entities) {
    titleToId.set(entity.title.toLowerCase(), entity.id);
    if (entity.aliases) {
      for (const alias of entity.aliases) {
        titleToId.set(alias.toLowerCase(), entity.id);
      }
    }
  }

  // Causal claim patterns
  const causalPatterns = [
    { regex: /(\w[\w\s]{2,30}?)\s+(?:causes?|leads?\s+to|results?\s+in)\s+(\w[\w\s]{2,30})/gi, type: 'causes' },
    { regex: /(\w[\w\s]{2,30}?)\s+(?:mitigates?|prevents?|reduces?)\s+(\w[\w\s]{2,30})/gi, type: 'mitigates' },
    { regex: /(\w[\w\s]{2,30}?)\s+(?:enables?|allows?)\s+(\w[\w\s]{2,30})/gi, type: 'enables' },
  ];

  for (const { content, filePath } of allContent) {
    const body = getContentBody(content);

    for (const { regex, type } of causalPatterns) {
      let match;
      regex.lastIndex = 0;

      while ((match = regex.exec(body)) !== null) {
        const [, sourceTerm, targetTerm] = match;

        // Try to match terms to entities
        const sourceId = titleToId.get(sourceTerm.trim().toLowerCase());
        const targetId = titleToId.get(targetTerm.trim().toLowerCase());

        if (sourceId && targetId && sourceId !== targetId) {
          // Check if relationship exists in entities.yaml
          const forwardKey = `${sourceId}:${targetId}`;
          const reverseKey = `${targetId}:${sourceId}`;

          if (!relationships.has(forwardKey) && !relationships.has(reverseKey)) {
            issues.push({
              id: 'missing-entity-relationship',
              severity: 'info',
              description: `Causal claim "${sourceTerm.trim()} ${type} ${targetTerm.trim()}" not in entities.yaml`,
              sourceId,
              targetId,
              claimType: type,
              file: filePath,
              suggestion: `Consider adding relatedEntry from ${sourceId} to ${targetId} with relationship: "${type}"`,
            });
          }
        }
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  return issues.filter(issue => {
    const key = `${issue.sourceId}:${issue.targetId}:${issue.claimType}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Main function
 */
function main() {
  const files = findMdxFiles(CONTENT_DIR);
  const entities = loadEntities();

  if (!CI_MODE) {
    console.log(`${colors.blue}Checking ${files.length} files for cross-page consistency...${colors.reset}\n`);
  }

  // Load all content
  const allContent = [];
  const allClaims = [];

  for (const file of files) {
    // Skip style guides and index pages
    if (file.includes('/style-guides/') || file.endsWith('index.mdx') || file.endsWith('index.md')) {
      continue;
    }

    try {
      const content = readFileSync(file, 'utf-8');
      allContent.push({ content, filePath: file });

      const claims = extractProbabilityClaims(content, file);
      allClaims.push(...claims);
    } catch {
      // Skip files that can't be read
    }
  }

  // Run consistency checks
  const probabilityIssues = checkProbabilityConsistency(allClaims);
  const terminologyIssues = checkTerminologyConsistency(allContent);
  const causalIssues = checkCausalConsistency(allContent, entities);

  const allIssues = [...probabilityIssues, ...terminologyIssues, ...causalIssues];

  let warningCount = allIssues.filter(i => i.severity === 'warning').length;
  let infoCount = allIssues.filter(i => i.severity === 'info').length;

  if (CI_MODE) {
    console.log(JSON.stringify({
      files: files.length,
      probabilityClaims: allClaims.length,
      entities: entities.length,
      warnings: warningCount,
      infos: infoCount,
      issues: allIssues,
    }, null, 2));
  } else {
    if (allIssues.length === 0) {
      console.log(`${colors.green}✓ No cross-page consistency issues found${colors.reset}`);
      console.log(`${colors.dim}  Checked ${allClaims.length} probability claims across ${files.length} files${colors.reset}\n`);
    } else {
      // Group by type - only show actual warnings, not info-level items
      const probabilityWarnings = probabilityIssues.filter(i => i.severity === 'warning');
      if (probabilityWarnings.length > 0) {
        console.log(`${colors.bold}${colors.yellow}⚠️  Probability Estimate Inconsistencies${colors.reset}\n`);

        for (const issue of probabilityWarnings) {
          console.log(`  ${colors.yellow}Topic: ${issue.topic}${colors.reset}`);
          console.log(`    ${issue.description}`);
          console.log(`    ${colors.dim}Gap: ${issue.gap}${colors.reset}`);

          for (const loc of issue.locations) {
            const relPath = formatPath(loc.file);
            console.log(`    ${colors.dim}• ${relPath}:${loc.line} → ${loc.value}${colors.reset}`);
          }
          console.log();
        }
      }

      if (terminologyIssues.length > 0) {
        console.log(`${colors.bold}${colors.blue}ℹ️  Terminology Variations${colors.reset}\n`);

        for (const issue of terminologyIssues) {
          console.log(`  ${colors.blue}Term: ${issue.term}${colors.reset}`);
          for (const v of issue.variants) {
            console.log(`    ${colors.dim}• "${v.variant}" - ${v.totalUses} uses in ${v.files} files${colors.reset}`);
          }
          console.log(`    ${colors.dim}${issue.suggestion}${colors.reset}`);
          console.log();
        }
      }

      if (causalIssues.length > 0) {
        console.log(`${colors.bold}${colors.blue}ℹ️  Potential Missing Entity Relationships${colors.reset}\n`);

        // Only show first 10 to avoid noise
        for (const issue of causalIssues.slice(0, 10)) {
          console.log(`  ${colors.dim}${issue.sourceId} → ${issue.targetId} (${issue.claimType})${colors.reset}`);
        }

        if (causalIssues.length > 10) {
          console.log(`  ${colors.dim}...and ${causalIssues.length - 10} more${colors.reset}`);
        }
        console.log();
      }

      console.log(`${colors.bold}Summary:${colors.reset}`);
      if (warningCount > 0) {
        console.log(`  ${colors.yellow}${warningCount} warning(s)${colors.reset}`);
      }
      if (infoCount > 0) {
        console.log(`  ${colors.blue}${infoCount} suggestion(s)${colors.reset}`);
      }
      console.log();
    }
  }

  // Only exit with error if there are warnings (info doesn't block)
  process.exit(warningCount > 0 ? 1 : 0);
}

main();
