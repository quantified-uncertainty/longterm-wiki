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

export interface PageTemplate {
  id: string;
  name: string;
  minWordCount?: number;
  usesATMPage?: boolean;
  frontmatter: FrontmatterField[];
  sections: SectionDef[];
  qualityCriteria: QualityCriterion[];
}

export const PAGE_TEMPLATES: Record<string, PageTemplate> = {
  'ai-transition-model-factor': {
    id: 'ai-transition-model-factor',
    name: 'AI Transition Model - Root Factor',
    minWordCount: 300,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 10 },
      { name: 'pageTemplate', required: true, weight: 5 },
      { name: 'lastEdited', required: true, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: [], required: true, weight: 20 },
      { id: 'sub-factors', label: 'Sub-Factors', alternateLabels: ['Components', 'Sub-Items'], required: true, weight: 15 },
    ],
    qualityCriteria: [
      { id: 'has-diagram', label: 'Has Diagram', weight: 15, detection: 'diagram' },
      { id: 'has-table', label: 'Has Data Table', weight: 10, detection: 'table' },
      { id: 'word-count', label: 'Sufficient Length', weight: 10, detection: 'content' },
    ],
  },
  'ai-transition-model-scenario': {
    id: 'ai-transition-model-scenario',
    name: 'AI Transition Model - Scenario Category',
    minWordCount: 300,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 10 },
      { name: 'pageTemplate', required: true, weight: 5 },
      { name: 'lastEdited', required: true, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: [], required: true, weight: 20 },
      { id: 'variants', label: 'Variants', alternateLabels: ['Scenario Variants', 'Types'], required: true, weight: 15 },
    ],
    qualityCriteria: [
      { id: 'has-diagram', label: 'Has Diagram', weight: 15, detection: 'diagram' },
      { id: 'has-probability', label: 'Has Probability Estimates', weight: 10, detection: 'content', pattern: '\\d+%|probability|likelihood' },
      { id: 'word-count', label: 'Sufficient Length', weight: 10, detection: 'content' },
    ],
  },
  'ai-transition-model-outcome': {
    id: 'ai-transition-model-outcome',
    name: 'AI Transition Model - Outcome',
    minWordCount: 400,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 10 },
      { name: 'pageTemplate', required: true, weight: 5 },
      { name: 'lastEdited', required: true, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: [], required: true, weight: 20 },
      { id: 'sub-dimensions', label: 'Sub-dimensions', alternateLabels: ['Dimensions', 'Components'], required: true, weight: 15 },
      { id: 'what-contributes', label: 'What Contributes', alternateLabels: ['Contributing Factors', 'What Shapes', 'What Shapes Long-term Trajectory'], required: true, weight: 15 },
      { id: 'why-matters', label: 'Why This Matters', alternateLabels: [], required: true, weight: 10 },
    ],
    qualityCriteria: [
      { id: 'has-diagram', label: 'Has Diagram', weight: 15, detection: 'diagram' },
      { id: 'has-impact-list', label: 'Has Impact Scores', weight: 10, detection: 'component', pattern: 'ImpactList' },
      { id: 'word-count', label: 'Sufficient Length', weight: 10, detection: 'content' },
    ],
  },
  'ai-transition-model-sub-item': {
    id: 'ai-transition-model-sub-item',
    name: 'AI Transition Model - Sub-Item',
    usesATMPage: true,
    frontmatter: [
      { name: 'title', required: true, weight: 10 },
      { name: 'pageTemplate', required: true, weight: 5 },
    ],
    sections: [],
    qualityCriteria: [
      { id: 'uses-atmpage', label: 'Uses ATMPage Component', weight: 30, detection: 'component', pattern: 'ATMPage' },
    ],
  },
  'ai-transition-model-parameter': {
    id: 'ai-transition-model-parameter',
    name: 'AI Transition Model - Parameter',
    minWordCount: 2000,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'pageTemplate', required: true, weight: 5 },
      { name: 'lastEdited', required: true, weight: 5 },
    ],
    sections: [
      { id: 'parameter-network', label: 'Parameter Network', alternateLabels: ['Relationships', 'Network'], required: true, weight: 15 },
      { id: 'current-state', label: 'Current State Assessment', alternateLabels: ['Current State', 'Assessment', 'Quantified'], required: true, weight: 15 },
      { id: 'healthy-state', label: 'What "Healthy" Looks Like', alternateLabels: ['Healthy State', 'Optimal State', 'Target State', 'What "Healthy'], required: true, weight: 10 },
      { id: 'threats', label: 'Factors That Decrease', alternateLabels: ['Threats', 'What Decreases', 'Negative Factors'], required: true, weight: 10 },
      { id: 'supports', label: 'Factors That Increase', alternateLabels: ['Supports', 'What Increases', 'Positive Factors'], required: true, weight: 10 },
      { id: 'why-matters', label: 'Why This Parameter Matters', alternateLabels: ['Why This Matters', 'Importance'], required: true, weight: 10 },
      { id: 'trajectory', label: 'Trajectory and Scenarios', alternateLabels: ['Trajectory', 'Scenarios', 'Projections', 'Scenario Analysis'], required: true, weight: 10 },
      { id: 'sources', label: 'Sources', alternateLabels: ['Sources & Key Research', 'References', 'Key Research'], required: true, weight: 10 },
    ],
    qualityCriteria: [
      { id: 'has-mermaid', label: 'Has Network Diagram', weight: 15, detection: 'diagram', pattern: 'Mermaid' },
      { id: 'has-data-tables', label: 'Has Data Tables', weight: 15, detection: 'table' },
      { id: 'has-citations', label: 'Has Citations', weight: 15, detection: 'citation', pattern: '<R id=' },
      { id: 'word-count', label: 'Comprehensive Length', weight: 10, detection: 'content' },
      { id: 'has-cause-effect', label: 'Has Cause-Effect Graph', weight: 10, detection: 'component', pattern: 'PageCauseEffectGraph' },
    ],
  },
  'knowledge-base-risk': {
    id: 'knowledge-base-risk',
    name: 'Knowledge Base - Risk',
    minWordCount: 800,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 15 },
      { name: 'quality', required: true, weight: 10 },
      { name: 'lastEdited', required: true, weight: 5 },
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
      { name: 'lastEdited', required: true, weight: 5 },
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
  'knowledge-base-model': {
    id: 'knowledge-base-model',
    name: 'Knowledge Base - Model',
    minWordCount: 600,
    frontmatter: [
      { name: 'title', required: true, weight: 5 },
      { name: 'description', required: true, weight: 20 },
      { name: 'quality', required: true, weight: 10 },
      { name: 'lastEdited', required: true, weight: 5 },
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
      { name: 'lastEdited', required: true, weight: 5 },
    ],
    sections: [
      { id: 'overview', label: 'Overview', alternateLabels: ['Definition'], required: true, weight: 25 },
    ],
    qualityCriteria: [
      { id: 'has-examples', label: 'Has Examples', weight: 20, detection: 'content', pattern: 'example|instance|case' },
      { id: 'word-count', label: 'Sufficient Length', weight: 15, detection: 'content' },
    ],
  },
};
