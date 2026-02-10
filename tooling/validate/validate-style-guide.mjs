#!/usr/bin/env node

/**
 * Style Guide Validation Script
 *
 * Validates content against style guide rules:
 * - Model pages have required sections (Overview, Quantitative Analysis, Limitations)
 * - "Mechanism without magnitude" anti-pattern detection
 * - Risk pages link to responses, response pages link to risks
 * - Mermaid diagrams follow conventions (max 15 nodes, prefer TD, max 3 subgraphs)
 * - Proper h2/h3 hierarchy (warns on 10+ flat h2 sections)
 *
 * Usage: node scripts/validate-style-guide.mjs [--ci]
 *
 * Exit codes:
 *   0 = All checks passed (warnings don't block)
 *   1 = Errors found
 */

import { readFileSync } from 'fs';
import { findMdxFiles } from '../lib/file-utils.mjs';
import { parseFrontmatter, getContentBody } from '../lib/mdx-utils.mjs';
import { getColors, formatPath } from '../lib/output.mjs';
import { CONTENT_DIR } from '../lib/content-types.js';

const CI_MODE = process.argv.includes('--ci');
const colors = getColors(CI_MODE);

// Content type definitions with their requirements (validator-specific, more detailed than shared)
const CONTENT_TYPES = {
  model: {
    pathPattern: /\/models\//,
    requiredSections: [
      { pattern: /^##\s+overview/im, name: 'Overview' },
    ],
    recommendedSections: [
      { pattern: /^##\s+(quantitative|analysis|magnitude)/im, name: 'Quantitative Analysis' },
      { pattern: /^##\s+limitations?/im, name: 'Limitations' },
      { pattern: /^##\s+strategic\s+importance/im, name: 'Strategic Importance' },
      { pattern: /^###?\s+key\s+crux/im, name: 'Key Cruxes' },
    ],
    requireMagnitude: true,
  },
  risk: {
    pathPattern: /\/risks\//,
    requiredSections: [
      { pattern: /^##\s+overview/im, name: 'Overview' },
    ],
    recommendedSections: [
      { pattern: /^###?\s+risk\s+assessment/im, name: 'Risk Assessment' },
      { pattern: /^###?\s+responses?\s+(that\s+)?address/im, name: 'Responses That Address This Risk' },
      { pattern: /^##\s+key\s+uncertainties/im, name: 'Key Uncertainties' },
    ],
    requireResponseLinks: true,
  },
  response: {
    pathPattern: /\/responses\//,
    requiredSections: [
      { pattern: /^##\s+overview/im, name: 'Overview' },
    ],
    recommendedSections: [
      { pattern: /^###?\s+quick\s+assessment/im, name: 'Quick Assessment' },
      { pattern: /^###?\s+risks?\s+addressed/im, name: 'Risks Addressed' },
      { pattern: /^##\s+how\s+it\s+works/im, name: 'How It Works' },
    ],
    requireRiskLinks: true,
  },
};

// Patterns for detecting magnitude/strategic importance
const MAGNITUDE_PATTERNS = [
  /\d+\s*-\s*\d+\s*%/,                     // "10-30%"
  /share\s+of\s+.*risk/i,                   // "share of total AI risk"
  /rank(s|ing|ed)?.*priority/i,             // "priority ranking"
  /(more|less)\s+important\s+than/i,        // comparative importance
  /warrants?\s+\d+.*%?\s*(of\s+)?resources/i, // resource allocation
  /\|\s*magnitude\s*\|/i,                   // magnitude table header
  /comparative\s+(ranking|importance)/i,    // comparative section
];

// Patterns for detecting conclusions in model descriptions
const CONCLUSION_PATTERNS = [
  // Verbs followed by any content (indicating the model does something substantive)
  /\bThis model\s+(estimates?|finds?|concludes?|projects?|suggests?|indicates?|shows?|identifies|provides|analyzes|maps|tracks|catalogs|examines|assesses|evaluates|models|quantifies|measures|predicts|forecasts)\s+\w/i,
  // Also match without "This model" prefix but with specific following words
  /\b(estimates?|finds?|concludes?|projects?|suggests?|indicates?|shows?|identifies)\s+(that|a|an|the|\d|key|how|when|critical)/i,
  /\d+\s*[-–]\s*\d+\s*%/,                  // "10-30%"
  /\d+(\.\d+)?x\s/i,                       // "1.5x " (any multiplier)
  /\d+\s*[-–]\s*\d+x\b/,                   // "2-3x"
  /probability\s+of\s+\d/i,                // "probability of 60%"
  /\d+\s*[-–]\s*\d+\s*(year|month|day)/i,  // "5-10 years"
  /within\s+\d+\s*(year|month|day)/i,      // "within 5 years"
  /by\s+20\d{2}/i,                         // "by 2030"
];

/**
 * Determine content type based on file path (local version with validator-specific types)
 */
function getContentType(filePath) {
  for (const [type, config] of Object.entries(CONTENT_TYPES)) {
    if (config.pathPattern.test(filePath)) {
      return type;
    }
  }
  return null;
}

/**
 * Extract all h2 sections from content
 */
function extractH2Sections(content) {
  const sections = [];
  const regex = /^##\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const lineNum = content.substring(0, match.index).split('\n').length;
    sections.push({
      title: match[1].trim(),
      line: lineNum,
    });
  }
  return sections;
}

/**
 * Check for "mechanism without magnitude" anti-pattern
 */
function checkMechanismWithoutMagnitude(content, body) {
  // Check for strategic importance section
  const hasStrategicSection = /^##\s+strategic\s+importance/im.test(body);

  // Check for magnitude indicators in content
  const hasMagnitudeContent = MAGNITUDE_PATTERNS.some(p => p.test(body));

  // If neither, this is the anti-pattern
  if (!hasStrategicSection && !hasMagnitudeContent) {
    return {
      id: 'mechanism-without-magnitude',
      severity: 'warning',
      description: 'Model explains mechanism but lacks strategic importance/magnitude assessment',
      fix: 'Add a "Strategic Importance" section with magnitude, comparative ranking, and resource implications (see style-guides/models.mdx)',
    };
  }
  return null;
}

/**
 * Check for cross-links between risks and responses
 */
function checkCrossLinks(body, contentType) {
  const issues = [];

  if (contentType === 'risk') {
    // Check for links to responses
    const hasResponseTable = /^###?\s+responses?\s+(that\s+)?address/im.test(body);
    const hasResponseLinks = /\]\(.*\/responses\//.test(body);

    if (!hasResponseTable && !hasResponseLinks) {
      issues.push({
        id: 'risk-missing-response-links',
        severity: 'info',
        description: 'Risk page lacks links to responses/interventions',
        fix: 'Add a "Responses That Address This Risk" section with links to relevant response pages',
      });
    }
  }

  if (contentType === 'response') {
    // Check for links to risks
    const hasRisksTable = /^###?\s+risks?\s+addressed/im.test(body);
    const hasRiskLinks = /\]\(.*\/risks\//.test(body);

    if (!hasRisksTable && !hasRiskLinks) {
      issues.push({
        id: 'response-missing-risk-links',
        severity: 'info',
        description: 'Response page lacks links to risks it addresses',
        fix: 'Add a "Risks Addressed" section with links to relevant risk pages',
      });
    }
  }

  return issues;
}

/**
 * Check for flat h2 structure (too many h2s without h3s)
 */
function checkHierarchy(body) {
  const h2Count = (body.match(/^##\s+/gm) || []).length;
  const h3Count = (body.match(/^###\s+/gm) || []).length;

  // Warn if 10+ h2 sections with few h3s
  if (h2Count >= 10 && h3Count < h2Count / 2) {
    return {
      id: 'flat-hierarchy',
      severity: 'info',
      description: `${h2Count} h2 sections with only ${h3Count} h3 subsections - consider grouping related sections`,
      fix: 'Use h2 for major sections and h3 for subsections within them',
    };
  }
  return null;
}

/**
 * Check Mermaid diagrams for style issues
 */
function checkMermaidDiagrams(content) {
  const issues = [];
  const mermaidRegex = /<Mermaid[^>]*chart=\{`([^`]+)`\}/gs;

  let match;
  while ((match = mermaidRegex.exec(content)) !== null) {
    const chart = match[1];
    const lineNum = content.substring(0, match.index).split('\n').length;

    // Check for horizontal flowchart with many nodes
    if (/flowchart\s+LR/i.test(chart)) {
      const nodeCount = (chart.match(/\[[^\]]+\]/g) || []).length;
      if (nodeCount > 8) {
        issues.push({
          id: 'wide-horizontal-diagram',
          severity: 'info',
          line: lineNum,
          description: `Horizontal flowchart (LR) with ${nodeCount} nodes may render poorly`,
          fix: 'Consider using flowchart TD (vertical) or split into multiple diagrams',
        });
      }
    }

    // Check for too many nodes
    const nodeCount = (chart.match(/\[[^\]]+\]/g) || []).length;
    if (nodeCount > 15) {
      issues.push({
        id: 'too-many-nodes',
        severity: 'warning',
        line: lineNum,
        description: `Diagram has ${nodeCount} nodes (max recommended: 15)`,
        fix: 'Split into multiple diagrams or use a table for details + summary diagram',
      });
    }

    // Check for too many subgraphs
    const subgraphCount = (chart.match(/subgraph/gi) || []).length;
    if (subgraphCount > 3) {
      issues.push({
        id: 'too-many-subgraphs',
        severity: 'info',
        line: lineNum,
        description: `Diagram has ${subgraphCount} subgraphs (max recommended: 3)`,
        fix: 'Consider simplifying or splitting the diagram',
      });
    }
  }

  return issues;
}

/**
 * Check for sparse Case For/Against sections
 */
function checkSparseArguments(body) {
  const issues = [];

  // Look for Case For/Against sections
  const caseForMatch = body.match(/^##\s+case\s+for\s*\n([\s\S]*?)(?=^##\s|$)/im);
  const caseAgainstMatch = body.match(/^##\s+case\s+against\s*\n([\s\S]*?)(?=^##\s|$)/im);

  const checkSection = (match, name) => {
    if (!match) return;
    const sectionContent = match[1];
    const wordCount = sectionContent.split(/\s+/).filter(w => w.length > 0).length;
    const h3Count = (sectionContent.match(/^###\s+/gm) || []).length;

    // Warn if sparse (few words per subsection or very short overall)
    if (wordCount < 50 || (h3Count > 2 && wordCount / h3Count < 30)) {
      issues.push({
        id: 'sparse-arguments',
        severity: 'info',
        description: `"${name}" section appears sparse (${wordCount} words, ${h3Count} subsections)`,
        fix: 'Consider integrating arguments into prose or adding more substantive content',
      });
    }
  };

  checkSection(caseForMatch, 'Case For');
  checkSection(caseAgainstMatch, 'Case Against');

  return issues;
}

/**
 * Check a single file
 */
function checkFile(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const frontmatter = parseFrontmatter(content);
  const body = getContentBody(content);
  const contentType = getContentType(filePath);
  const issues = [];

  // Skip style guide pages themselves
  if (filePath.includes('/style-guides/')) {
    return issues;
  }

  // Skip index pages
  if (filePath.endsWith('index.mdx') || filePath.endsWith('index.md')) {
    return issues;
  }

  // Get content type config
  const config = contentType ? CONTENT_TYPES[contentType] : null;

  if (config) {
    // Check required sections
    for (const section of config.requiredSections) {
      if (!section.pattern.test(body)) {
        issues.push({
          id: 'missing-required-section',
          severity: 'warning',
          description: `Missing required section: ${section.name}`,
          fix: `Add an "${section.name}" section`,
        });
      }
    }

    // Check recommended sections (info level)
    let missingRecommended = [];
    for (const section of config.recommendedSections) {
      if (!section.pattern.test(body)) {
        missingRecommended.push(section.name);
      }
    }
    if (missingRecommended.length > 0 && missingRecommended.length <= 2) {
      issues.push({
        id: 'missing-recommended-sections',
        severity: 'info',
        description: `Consider adding: ${missingRecommended.join(', ')}`,
        fix: 'See style guide for recommended section structure',
      });
    }

    // Check mechanism without magnitude for models
    if (config.requireMagnitude) {
      const magnitudeIssue = checkMechanismWithoutMagnitude(content, body);
      if (magnitudeIssue) {
        issues.push(magnitudeIssue);
      }
    }

    // Check cross-links
    if (config.requireResponseLinks || config.requireRiskLinks) {
      issues.push(...checkCrossLinks(body, contentType));
    }
  }

  // Check hierarchy (all content types)
  const hierarchyIssue = checkHierarchy(body);
  if (hierarchyIssue) {
    issues.push(hierarchyIssue);
  }

  // Check Mermaid diagrams
  issues.push(...checkMermaidDiagrams(content));

  // Check for sparse Case For/Against
  issues.push(...checkSparseArguments(body));

  // Check for model ratings in frontmatter
  if (contentType === 'model') {
    if (!frontmatter.ratings) {
      issues.push({
        id: 'missing-model-ratings',
        severity: 'info',
        description: 'Model page lacks ratings in frontmatter',
        fix: 'Add ratings: { novelty: N, rigor: N, actionability: N, completeness: N } to frontmatter',
      });
    }

    // Check for executive summary with conclusions in description
    const description = frontmatter.description || '';
    const hasConclusion = CONCLUSION_PATTERNS.some(p => p.test(description));

    if (!description) {
      issues.push({
        id: 'missing-model-description',
        severity: 'warning',
        description: 'Model page lacks description in frontmatter',
        fix: 'Add description: "This model [methodology]. It estimates/finds that [conclusion with numbers]."',
      });
    } else if (!hasConclusion) {
      issues.push({
        id: 'description-missing-conclusion',
        severity: 'warning',
        description: 'Model description lacks conclusions/findings (no quantified estimates found)',
        fix: 'Update description to include key findings, e.g., "This model [does X]. It estimates/finds that [Y with numbers]."',
      });
    }
  }

  return issues;
}


/**
 * Main function
 */
function main() {
  const files = findMdxFiles(CONTENT_DIR);
  const allIssues = [];
  let errorCount = 0;
  let warningCount = 0;
  let infoCount = 0;

  // Track by content type for summary
  const byType = { model: 0, risk: 0, response: 0, other: 0 };
  const issuesByType = { model: [], risk: [], response: [], other: [] };

  if (!CI_MODE) {
    console.log(`${colors.blue}Checking ${files.length} files against style guides...${colors.reset}\n`);
  }

  for (const file of files) {
    const contentType = getContentType(file) || 'other';
    byType[contentType]++;

    const issues = checkFile(file);
    if (issues.length > 0) {
      allIssues.push({ file, issues });
      issuesByType[contentType].push({ file, issues });

      for (const issue of issues) {
        if (issue.severity === 'error') errorCount++;
        else if (issue.severity === 'warning') warningCount++;
        else infoCount++;
      }
    }
  }

  if (CI_MODE) {
    console.log(JSON.stringify({
      files: files.length,
      byType,
      errors: errorCount,
      warnings: warningCount,
      infos: infoCount,
      issues: allIssues,
    }, null, 2));
  } else {
    if (allIssues.length === 0) {
      console.log(`${colors.green}✓ All files comply with style guides${colors.reset}\n`);
    } else {
      // Group by content type for readability
      for (const [type, typeIssues] of Object.entries(issuesByType)) {
        if (typeIssues.length === 0) continue;

        console.log(`${colors.bold}${colors.blue}${type.toUpperCase()} PAGES${colors.reset}\n`);

        for (const { file, issues } of typeIssues) {
          const relPath = formatPath(file);
          console.log(`${colors.bold}${relPath}${colors.reset}`);

          for (const issue of issues) {
            let icon;
            if (issue.severity === 'error') icon = `${colors.red}✗`;
            else if (issue.severity === 'warning') icon = `${colors.yellow}⚠`;
            else icon = `${colors.blue}ℹ`;

            const lineInfo = issue.line ? ` (line ${issue.line})` : '';
            console.log(`  ${icon} ${issue.description}${lineInfo}${colors.reset}`);
            console.log(`    ${colors.dim}Fix: ${issue.fix}${colors.reset}`);
          }
          console.log();
        }
      }

      console.log(`${colors.bold}Summary:${colors.reset}`);
      console.log(`  Files checked: ${files.length} (${byType.model} models, ${byType.risk} risks, ${byType.response} responses)`);
      if (errorCount > 0) {
        console.log(`  ${colors.red}${errorCount} error(s)${colors.reset}`);
      }
      if (warningCount > 0) {
        console.log(`  ${colors.yellow}${warningCount} warning(s)${colors.reset}`);
      }
      if (infoCount > 0) {
        console.log(`  ${colors.blue}${infoCount} suggestion(s)${colors.reset}`);
      }
      console.log();
    }
  }

  // Exit with error code only if there are errors (warnings don't block)
  process.exit(errorCount > 0 ? 1 : 0);
}

main();
