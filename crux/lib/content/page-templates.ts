/**
 * Page Template Definitions
 *
 * Shared template definitions used by grading (grade-by-template.ts) and
 * potentially authoring tools (page-creator, page-improver) in the future.
 *
 * Each template defines:
 * - Required/optional frontmatter fields with weights
 * - Required/optional sections (matched by heading text)
 * - Quality criteria (tables, diagrams, citations, word count, etc.)
 */

export interface FrontmatterField {
  name: string;
  required: boolean;
  weight: number;
}

export interface SectionDef {
  id: string;
  label: string;
  alternateLabels: string[];
  required: boolean;
  weight: number;
}

export interface QualityCriterion {
  id: string;
  label: string;
  weight: number;
  detection: string;
  pattern?: string;
}

export type ContentFormat = 'article' | 'table' | 'diagram' | 'index' | 'dashboard';

export interface PageTemplate {
  id: string;
  name: string;
  contentFormat?: ContentFormat;
  minWordCount?: number;
  frontmatter: FrontmatterField[];
  sections: SectionDef[];
  qualityCriteria: QualityCriterion[];
}

export const PAGE_TEMPLATES: Record<string, PageTemplate> = {
  'knowledge-base-risk': {
    id: 'knowledge-base-risk',
    name: 'Knowledge Base - Risk',
    minWordCount: 800,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'quality', required: true, weight: 10 },
      { name: 'lastEdited', required: false, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: [], required: true, weight: 15 },
      { id: 'risk-assessment', label: 'Risk Assessment', alternateLabels: ['Assessment', 'Risk Summary'], required: true, weight: 15 },
      { id: 'mechanisms', label: 'How It Works', alternateLabels: ['Mechanisms', 'How This Happens', 'Pathways', 'Attack Pathways'], required: true, weight: 15 },
      { id: 'responses', label: 'Responses', alternateLabels: ['Responses That Address This', 'Mitigations', 'Interventions'], required: true, weight: 10 },
      { id: 'uncertainties', label: 'Key Uncertainties', alternateLabels: ['Uncertainties', "What We Don't Know"], required: true, weight: 10 },
    ],
    qualityCriteria: [
      { id: 'has-risk-table', label: 'Has Risk Assessment Table', weight: 20, detection: 'table', pattern: 'severity|likelihood|timeline' },
      { id: 'has-diagram', label: 'Has Mechanism Diagram', weight: 15, detection: 'diagram' },
      { id: 'has-citations', label: 'Has Citations', weight: 15, detection: 'citation', pattern: '<R id=|\\[.*\\]\\(http' },
      { id: 'word-count', label: 'Sufficient Length', weight: 10, detection: 'content' },
      { id: 'has-responses', label: 'Links to Responses', weight: 10, detection: 'content', pattern: '/knowledge-base/responses/' },
    ],
  },
  'knowledge-base-response': {
    id: 'knowledge-base-response',
    name: 'Knowledge Base - Response',
    minWordCount: 600,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'quality', required: true, weight: 10 },
      { name: 'lastEdited', required: false, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: [], required: true, weight: 15 },
      { id: 'quick-assessment', label: 'Quick Assessment', alternateLabels: ['Assessment', 'Summary Assessment', 'Evaluation'], required: true, weight: 15 },
      { id: 'how-it-works', label: 'How It Works', alternateLabels: ['Mechanism', 'Approach', 'Method'], required: true, weight: 15 },
      { id: 'risks-addressed', label: 'Risks Addressed', alternateLabels: ['Addresses These Risks', 'Target Risks'], required: true, weight: 10 },
      { id: 'limitations', label: 'Limitations', alternateLabels: ['Challenges', 'Weaknesses', "What This Doesn't Solve"], required: true, weight: 10 },
    ],
    qualityCriteria: [
      { id: 'has-assessment-table', label: 'Has Assessment Table', weight: 20, detection: 'table', pattern: 'tractability|effectiveness|grade' },
      { id: 'has-diagram', label: 'Has Diagram', weight: 10, detection: 'diagram' },
      { id: 'has-citations', label: 'Has Citations', weight: 15, detection: 'citation', pattern: '<R id=|\\[.*\\]\\(http' },
      { id: 'word-count', label: 'Sufficient Length', weight: 10, detection: 'content' },
      { id: 'has-risk-links', label: 'Links to Risks', weight: 15, detection: 'content', pattern: '/knowledge-base/risks/' },
    ],
  },
  // Template key kept as 'knowledge-base-model' for backward compatibility.
  // Entity type 'model' was merged into 'analysis' — new pages use entityType: analysis.
  'knowledge-base-model': {
    id: 'knowledge-base-model',
    name: 'Knowledge Base - Analysis Model',
    minWordCount: 600,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 20 },
      { name: 'quality', required: true, weight: 10 },
      { name: 'lastEdited', required: false, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: [], required: true, weight: 15 },
      { id: 'framework', label: 'Conceptual Framework', alternateLabels: ['Framework', 'Model Structure', 'Methodology', 'Model'], required: true, weight: 20 },
      { id: 'analysis', label: 'Quantitative Analysis', alternateLabels: ['Analysis', 'Results', 'Findings', 'Key Findings'], required: true, weight: 20 },
      { id: 'importance', label: 'Strategic Importance', alternateLabels: ['Implications', 'Why This Matters', 'Key Insights'], required: true, weight: 10 },
      { id: 'limitations', label: 'Limitations', alternateLabels: ['Caveats', "What This Doesn't Capture"], required: true, weight: 10 },
    ],
    qualityCriteria: [
      { id: 'has-framework-diagram', label: 'Has Framework Diagram', weight: 20, detection: 'diagram' },
      { id: 'has-data-tables', label: 'Has Quantitative Tables', weight: 20, detection: 'table', pattern: '\\d+%|\\d+-\\d+|±' },
      { id: 'has-citations', label: 'Has Citations', weight: 10, detection: 'citation', pattern: '<R id=|\\[.*\\]\\(http' },
      { id: 'word-count', label: 'Sufficient Length', weight: 10, detection: 'content' },
    ],
  },
  'knowledge-base-concept': {
    id: 'knowledge-base-concept',
    name: 'Knowledge Base - Concept',
    minWordCount: 300,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'lastEdited', required: false, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: ['Definition'], required: true, weight: 25 },
    ],
    qualityCriteria: [
      { id: 'has-examples', label: 'Has Examples', weight: 20, detection: 'content', pattern: 'example|instance|case' },
      { id: 'word-count', label: 'Sufficient Length', weight: 15, detection: 'content' },
    ],
  },
  'data-table': {
    id: 'data-table',
    name: 'Interactive Data Table',
    contentFormat: 'table',
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'contentFormat', required: true, weight: 5 },
      { name: 'lastEdited', required: false, weight: 5 },
      { name: 'update_frequency', required: true, weight: 5 },
    ],
    sections: [],
    qualityCriteria: [
      { id: 'has-description', label: 'Has Contextual Description', weight: 15, detection: 'content', pattern: '\\w{20,}' },
      { id: 'has-data-source', label: 'Documents Data Sources', weight: 20, detection: 'content', pattern: 'source|methodology|data|based on' },
      { id: 'has-methodology', label: 'Explains Rating Methodology', weight: 20, detection: 'content', pattern: 'methodology|criteria|rating|scale|how .* rated' },
      { id: 'has-component', label: 'Has Table Component', weight: 25, detection: 'component', pattern: 'TableView|Table' },
      { id: 'has-changelog', label: 'Documents Recent Changes', weight: 15, detection: 'content', pattern: 'changelog|changes|updated|added|removed' },
    ],
  },
  'visualization': {
    id: 'visualization',
    name: 'Diagram / Visualization',
    contentFormat: 'diagram',
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'contentFormat', required: true, weight: 5 },
      { name: 'lastEdited', required: false, weight: 5 },
    ],
    sections: [],
    qualityCriteria: [
      { id: 'has-description', label: 'Has Contextual Description', weight: 20, detection: 'content', pattern: '\\w{20,}' },
      { id: 'has-visualization', label: 'Has Visualization Component', weight: 30, detection: 'component', pattern: 'Graph|Chart|Mermaid|CauseEffect|Visualization' },
      { id: 'has-data-source', label: 'Documents Data Sources', weight: 20, detection: 'content', pattern: 'source|data|based on' },
      { id: 'has-interpretation', label: 'Has Interpretation Guide', weight: 20, detection: 'content', pattern: 'interpret|reading|legend|meaning|represents' },
    ],
  },
  'knowledge-base-person': {
    id: 'knowledge-base-person',
    name: 'Knowledge Base - Person',
    minWordCount: 400,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'lastEdited', required: false, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: [], required: true, weight: 15 },
      { id: 'background', label: 'Professional Background', alternateLabels: ['Background', 'Career', 'Education and Career', 'Early Career'], required: true, weight: 15 },
      { id: 'contributions', label: 'Key Contributions', alternateLabels: ['Contributions', 'Research', 'Notable Work', 'Publications', 'Technical Contributions'], required: false, weight: 10 },
      { id: 'positions', label: 'Positions and Views', alternateLabels: ['Views', 'Philosophy', 'Core Philosophy', 'Key Positions'], required: false, weight: 10 },
      { id: 'criticism', label: 'Criticism', alternateLabels: ['Criticisms', 'Concerns', 'Controversies', 'Limitations', 'Debate'], required: false, weight: 10 },
    ],
    qualityCriteria: [
      { id: 'has-citations', label: 'Has Citations (critical for accuracy)', weight: 25, detection: 'citation', pattern: '<R id=|\\[\\^\\d+\\]|\\[.*\\]\\(http' },
      { id: 'has-primary-sources', label: 'Has Primary Sources', weight: 15, detection: 'content', pattern: 'interview|testimony|blog post|paper|tweet|announcement' },
      { id: 'has-data-table', label: 'Has Background/Role Table', weight: 10, detection: 'table' },
      { id: 'word-count', label: 'Sufficient Length', weight: 10, detection: 'content' },
      { id: 'has-entitylinks', label: 'Links to Related Entities', weight: 10, detection: 'component', pattern: 'EntityLink' },
    ],
  },
  'knowledge-base-organization': {
    id: 'knowledge-base-organization',
    name: 'Knowledge Base - Organization',
    minWordCount: 500,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'lastEdited', required: false, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: [], required: true, weight: 15 },
      { id: 'history', label: 'History', alternateLabels: ['Background', 'Founding', 'Origins'], required: true, weight: 10 },
      { id: 'activities', label: 'Key Activities', alternateLabels: ['Activities', 'Programs', 'Research Areas', 'Products', 'Services', 'Mission'], required: true, weight: 15 },
      { id: 'funding', label: 'Funding', alternateLabels: ['Funding and Financials', 'Financials', 'Revenue', 'Budget'], required: false, weight: 10 },
      { id: 'criticism', label: 'Criticism', alternateLabels: ['Criticisms', 'Concerns', 'Controversies', 'Limitations'], required: false, weight: 10 },
      { id: 'people', label: 'Key People', alternateLabels: ['Leadership', 'Team', 'Staff', 'Notable Members'], required: false, weight: 5 },
    ],
    qualityCriteria: [
      { id: 'has-citations', label: 'Has Citations (critical for accuracy)', weight: 25, detection: 'citation', pattern: '<R id=|\\[\\^\\d+\\]|\\[.*\\]\\(http' },
      { id: 'has-primary-sources', label: 'Has Primary Sources', weight: 15, detection: 'content', pattern: 'annual report|tax filing|press release|official|announcement|blog post' },
      { id: 'has-data-table', label: 'Has Data Tables', weight: 10, detection: 'table' },
      { id: 'word-count', label: 'Sufficient Length', weight: 10, detection: 'content' },
      { id: 'has-entitylinks', label: 'Links to Related Entities', weight: 10, detection: 'component', pattern: 'EntityLink' },
    ],
  },
  'knowledge-base-overview': {
    id: 'knowledge-base-overview',
    name: 'Knowledge Base - Overview',
    contentFormat: 'index',
    minWordCount: 200,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'entityType', required: true, weight: 10 },
    ],
    sections: [
      { id: 'intro', label: 'Introduction', alternateLabels: ['Overview', 'Context'], required: false, weight: 10 },
    ],
    qualityCriteria: [
      { id: 'has-entitylinks', label: 'Has EntityLinks to Child Pages', weight: 30, detection: 'component', pattern: 'EntityLink' },
      { id: 'has-overview-banner', label: 'Has OverviewBanner', weight: 15, detection: 'component', pattern: 'OverviewBanner' },
      { id: 'has-categorization', label: 'Organizes Pages into Categories', weight: 20, detection: 'content', pattern: '##' },
      { id: 'word-count', label: 'Sufficient Length', weight: 10, detection: 'content' },
    ],
  },
};
