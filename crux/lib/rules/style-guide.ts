/**
 * Style Guide Compliance Validation Rule
 *
 * Ports all checks from crux/validate/validate-style-guide.ts into a
 * ValidationEngine rule:
 * - Missing required sections (models, risks, responses)
 * - Missing recommended sections (warning when 1-2 missing)
 * - Mechanism without magnitude (models only)
 * - Risk/response cross-links
 * - Flat hierarchy (10+ h2s with few h3s)
 * - Mermaid diagram complexity (nodes, subgraphs, horizontal width)
 * - Sparse arguments (Case For/Against)
 * - Missing model ratings
 * - Missing model description
 * - Description missing conclusion
 */

import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';

// ============================================================================
// TYPES
// ============================================================================

interface SectionPattern {
  pattern: RegExp;
  name: string;
}

interface ContentTypeConfig {
  pathPattern: RegExp;
  requiredSections: SectionPattern[];
  recommendedSections: SectionPattern[];
  requireMagnitude?: boolean;
  requireResponseLinks?: boolean;
  requireRiskLinks?: boolean;
}

interface ContentTypes {
  [type: string]: ContentTypeConfig;
}

// ============================================================================
// CONSTANTS
// ============================================================================

const CONTENT_TYPES: ContentTypes = {
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

const MAGNITUDE_PATTERNS: RegExp[] = [
  /\d+\s*-\s*\d+\s*%/,                     // "10-30%"
  /share\s+of\s+.*risk/i,                   // "share of total AI risk"
  /rank(s|ing|ed)?.*priority/i,             // "priority ranking"
  /(more|less)\s+important\s+than/i,        // comparative importance
  /warrants?\s+\d+.*%?\s*(of\s+)?resources/i, // resource allocation
  /\|\s*magnitude\s*\|/i,                   // magnitude table header
  /comparative\s+(ranking|importance)/i,    // comparative section
];

const CONCLUSION_PATTERNS: RegExp[] = [
  /\bThis model\s+(estimates?|finds?|concludes?|projects?|suggests?|indicates?|shows?|identifies|provides|analyzes|maps|tracks|catalogs|examines|assesses|evaluates|models|quantifies|measures|predicts|forecasts)\s+\w/i,
  /\b(estimates?|finds?|concludes?|projects?|suggests?|indicates?|shows?|identifies)\s+(that|a|an|the|\d|key|how|when|critical)/i,
  /\d+\s*[-–]\s*\d+\s*%/,                  // "10-30%"
  /\d+(\.\d+)?x\s/i,                       // "1.5x " (any multiplier)
  /\d+\s*[-–]\s*\d+x\b/,                   // "2-3x"
  /probability\s+of\s+\d/i,                // "probability of 60%"
  /\d+\s*[-–]\s*\d+\s*(year|month|day)/i,  // "5-10 years"
  /within\s+\d+\s*(year|month|day)/i,      // "within 5 years"
  /by\s+20\d{2}/i,                         // "by 2030"
];

// ============================================================================
// HELPERS
// ============================================================================

function getContentType(filePath: string): string | null {
  for (const [type, config] of Object.entries(CONTENT_TYPES)) {
    if (config.pathPattern.test(filePath)) {
      return type;
    }
  }
  return null;
}

function checkCrossLinks(body: string, contentType: string, filePath: string): Issue[] {
  const issues: Issue[] = [];

  if (contentType === 'risk') {
    const hasResponseTable = /^###?\s+responses?\s+(that\s+)?address/im.test(body);
    const hasResponseLinks = /\]\(.*\/responses\//.test(body);

    if (!hasResponseTable && !hasResponseLinks) {
      issues.push(new Issue({
        rule: 'style-guide',
        file: filePath,
        message: 'Risk page lacks links to responses/interventions — add a "Responses That Address This Risk" section with links to relevant response pages',
        severity: Severity.INFO,
      }));
    }
  }

  if (contentType === 'response') {
    const hasRisksTable = /^###?\s+risks?\s+addressed/im.test(body);
    const hasRiskLinks = /\]\(.*\/risks\//.test(body);

    if (!hasRisksTable && !hasRiskLinks) {
      issues.push(new Issue({
        rule: 'style-guide',
        file: filePath,
        message: 'Response page lacks links to risks it addresses — add a "Risks Addressed" section with links to relevant risk pages',
        severity: Severity.INFO,
      }));
    }
  }

  return issues;
}

function checkHierarchy(body: string, filePath: string): Issue | null {
  const h2Count = (body.match(/^##\s+/gm) || []).length;
  const h3Count = (body.match(/^###\s+/gm) || []).length;

  if (h2Count >= 10 && h3Count < h2Count / 2) {
    return new Issue({
      rule: 'style-guide',
      file: filePath,
      message: `${h2Count} h2 sections with only ${h3Count} h3 subsections — consider grouping related sections under h2 headers with h3 subsections`,
      severity: Severity.INFO,
    });
  }
  return null;
}

function checkMermaidDiagrams(content: string, filePath: string): Issue[] {
  const issues: Issue[] = [];
  const mermaidRegex = /<Mermaid[^>]*chart=\{`([^`]+)`\}/gs;

  let match: RegExpExecArray | null;
  while ((match = mermaidRegex.exec(content)) !== null) {
    const chart = match[1];
    const lineNum = content.substring(0, match.index).split('\n').length;

    // Check for horizontal flowchart with many nodes
    if (/flowchart\s+LR/i.test(chart)) {
      const nodeCount = (chart.match(/\[[^\]]+\]/g) || []).length;
      if (nodeCount > 8) {
        issues.push(new Issue({
          rule: 'style-guide',
          file: filePath,
          line: lineNum,
          message: `Horizontal flowchart (LR) with ${nodeCount} nodes may render poorly — consider using flowchart TD (vertical) or split into multiple diagrams`,
          severity: Severity.INFO,
        }));
      }
    }

    // Check for too many nodes
    const nodeCount = (chart.match(/\[[^\]]+\]/g) || []).length;
    if (nodeCount > 15) {
      issues.push(new Issue({
        rule: 'style-guide',
        file: filePath,
        line: lineNum,
        message: `Diagram has ${nodeCount} nodes (max recommended: 15) — split into multiple diagrams or use a table for details + summary diagram`,
        severity: Severity.WARNING,
      }));
    }

    // Check for too many subgraphs
    const subgraphCount = (chart.match(/subgraph/gi) || []).length;
    if (subgraphCount > 3) {
      issues.push(new Issue({
        rule: 'style-guide',
        file: filePath,
        line: lineNum,
        message: `Diagram has ${subgraphCount} subgraphs (max recommended: 3) — consider simplifying or splitting the diagram`,
        severity: Severity.INFO,
      }));
    }
  }

  return issues;
}

function checkSparseArguments(body: string, filePath: string): Issue[] {
  const issues: Issue[] = [];

  const caseForMatch = body.match(/^##\s+case\s+for\s*\n([\s\S]*?)(?=^##\s|$)/im);
  const caseAgainstMatch = body.match(/^##\s+case\s+against\s*\n([\s\S]*?)(?=^##\s|$)/im);

  const checkSection = (match: RegExpMatchArray | null, name: string): void => {
    if (!match) return;
    const sectionContent = match[1];
    const wordCount = sectionContent.split(/\s+/).filter((w: string) => w.length > 0).length;
    const h3Count = (sectionContent.match(/^###\s+/gm) || []).length;

    if (wordCount < 50 || (h3Count > 2 && wordCount / h3Count < 30)) {
      issues.push(new Issue({
        rule: 'style-guide',
        file: filePath,
        message: `"${name}" section appears sparse (${wordCount} words, ${h3Count} subsections) — consider integrating arguments into prose or adding more substantive content`,
        severity: Severity.INFO,
      }));
    }
  };

  checkSection(caseForMatch, 'Case For');
  checkSection(caseAgainstMatch, 'Case Against');

  return issues;
}

// ============================================================================
// RULE
// ============================================================================

export const styleGuideRule = {
  id: 'style-guide',
  name: 'Style Guide Compliance',
  description: 'Validate content against style guide rules: required/recommended sections, magnitude, cross-links, hierarchy, diagrams, arguments, ratings, descriptions',
  scope: 'file' as const,

  check(contentFile: ContentFile, _engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const filePath = contentFile.path;
    const body = contentFile.body || '';
    const raw = contentFile.raw || '';

    // Skip style guide pages themselves
    if (filePath.includes('/style-guides/')) {
      return issues;
    }

    // Skip index pages
    if (contentFile.isIndex) {
      return issues;
    }

    const contentType = getContentType(filePath);
    const config = contentType ? CONTENT_TYPES[contentType] : null;

    if (config) {
      // Check required sections
      for (const section of config.requiredSections) {
        if (!section.pattern.test(body)) {
          issues.push(new Issue({
            rule: 'style-guide',
            file: filePath,
            message: `Missing required section: ${section.name} — add an "${section.name}" section`,
            severity: Severity.WARNING,
          }));
        }
      }

      // Check recommended sections (info level, only when 1-2 missing)
      const missingRecommended: string[] = [];
      for (const section of config.recommendedSections) {
        if (!section.pattern.test(body)) {
          missingRecommended.push(section.name);
        }
      }
      if (missingRecommended.length > 0 && missingRecommended.length <= 2) {
        issues.push(new Issue({
          rule: 'style-guide',
          file: filePath,
          message: `Consider adding: ${missingRecommended.join(', ')} — see style guide for recommended section structure`,
          severity: Severity.INFO,
        }));
      }

      // Check mechanism without magnitude for models
      if (config.requireMagnitude) {
        const hasStrategicSection = /^##\s+strategic\s+importance/im.test(body);
        const hasMagnitudeContent = MAGNITUDE_PATTERNS.some((p: RegExp) => p.test(body));

        if (!hasStrategicSection && !hasMagnitudeContent) {
          issues.push(new Issue({
            rule: 'style-guide',
            file: filePath,
            message: 'Model explains mechanism but lacks strategic importance/magnitude assessment — add a "Strategic Importance" section with magnitude, comparative ranking, and resource implications (see style-guides/models.mdx)',
            severity: Severity.WARNING,
          }));
        }
      }

      // Check cross-links
      if (config.requireResponseLinks || config.requireRiskLinks) {
        issues.push(...checkCrossLinks(body, contentType!, filePath));
      }
    }

    // Check hierarchy (all content types)
    const hierarchyIssue = checkHierarchy(body, filePath);
    if (hierarchyIssue) {
      issues.push(hierarchyIssue);
    }

    // Check Mermaid diagrams (use raw content to capture full component syntax)
    issues.push(...checkMermaidDiagrams(raw, filePath));

    // Check for sparse Case For/Against
    issues.push(...checkSparseArguments(body, filePath));

    // Model-specific frontmatter checks
    if (contentType === 'model') {
      const frontmatter = contentFile.frontmatter;

      // Check for model ratings in frontmatter
      if (!frontmatter?.ratings) {
        issues.push(new Issue({
          rule: 'style-guide',
          file: filePath,
          message: 'Model page lacks ratings in frontmatter — add ratings: { novelty: N, rigor: N, actionability: N, completeness: N } to frontmatter',
          severity: Severity.INFO,
        }));
      }

      // Check for description and conclusion
      const description = (frontmatter?.description as string) || '';

      if (!description) {
        issues.push(new Issue({
          rule: 'style-guide',
          file: filePath,
          message: 'Model page lacks description in frontmatter — add description: "This model [methodology]. It estimates/finds that [conclusion with numbers]."',
          severity: Severity.WARNING,
        }));
      } else {
        const hasConclusion = CONCLUSION_PATTERNS.some((p: RegExp) => p.test(description));
        if (!hasConclusion) {
          issues.push(new Issue({
            rule: 'style-guide',
            file: filePath,
            message: 'Model description lacks conclusions/findings (no quantified estimates found) — update description to include key findings, e.g., "This model [does X]. It estimates/finds that [Y with numbers]."',
            severity: Severity.WARNING,
          }));
        }
      }
    }

    return issues;
  },
};
