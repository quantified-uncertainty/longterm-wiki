export interface NavItem {
  label: string;
  href: string;
}

export interface NavSection {
  title: string;
  defaultOpen?: boolean;
  items: NavItem[];
}

/**
 * Internal sidebar navigation.
 * Section semantics:
 *  - Overview: project-level pages (vision, strategy, roadmap)
 *  - Dashboards & Tools: interactive tools and dashboards
 *  - Architecture & Schema: technical docs (data schema, architecture, data flow)
 *  - Style Guides: writing and content style guides
 *  - Experiments: experimental features and prototypes
 *  - Research: research reports and proposals (theoretical, not technical docs)
 */
export const INTERNAL_NAV: NavSection[] = [
  {
    title: "Overview",
    defaultOpen: true,
    items: [
      { label: "Internal Home", href: "/internal" },
      { label: "About This Wiki", href: "/internal/about-this-wiki" },
      { label: "Vision", href: "/internal/longterm-vision" },
      { label: "Strategy", href: "/internal/longterm-strategy" },
      { label: "Roadmap", href: "/internal/project-roadmap" },
      { label: "Value Proposition", href: "/internal/longtermwiki-value-proposition" },
    ],
  },
  {
    title: "Dashboards & Tools",
    defaultOpen: true,
    items: [
      { label: "Enhancement Queue", href: "/internal/enhancement-queue" },
      { label: "Update Schedule", href: "/internal/updates" },
      { label: "Page Changes", href: "/internal/page-changes" },
      { label: "Fact Dashboard", href: "/internal/facts" },
      { label: "Automation Tools", href: "/internal/automation-tools" },
      { label: "Content Database", href: "/internal/content-database" },
    ],
  },
  {
    title: "Style Guides",
    items: [
      { label: "Common Writing Principles", href: "/internal/common-writing-principles" },
      { label: "Page Types", href: "/internal/page-types" },
      { label: "Knowledge Base", href: "/internal/knowledge-base" },
      { label: "Risk Pages", href: "/internal/risk-style-guide" },
      { label: "Response Pages", href: "/internal/response-style-guide" },
      { label: "Models", href: "/internal/models-style-guide" },
      { label: "Stub Pages", href: "/internal/stub-style-guide" },
      { label: "Rating System", href: "/internal/rating-system" },
      { label: "Mermaid Diagrams", href: "/internal/mermaid-diagrams" },
      { label: "Cause-Effect Diagrams", href: "/internal/cause-effect-diagrams" },
      { label: "Research Reports", href: "/internal/research-reports" },
      { label: "AI Transition Model", href: "/internal/ai-transition-model-style-guide" },
    ],
  },
  {
    title: "Experiments",
    items: [
      { label: "Insight Grid", href: "/internal/insight-grid-experiments" },
      { label: "Risk Trajectory", href: "/internal/risk-trajectory-experiments" },
    ],
  },
  {
    title: "Research",
    items: [
      { label: "Reports Index", href: "/internal/reports" },
      { label: "AI Research Workflows", href: "/internal/reports/ai-research-workflows" },
      { label: "Causal Diagram Visualization", href: "/internal/reports/causal-diagram-visualization" },
      { label: "Controlled Vocabulary", href: "/internal/reports/controlled-vocabulary" },
      { label: "Cross-Link Automation", href: "/internal/reports/cross-link-automation-proposal" },
      { label: "Diagram Naming", href: "/internal/reports/diagram-naming-research" },
      { label: "Page Creator Pipeline", href: "/internal/reports/page-creator-pipeline" },
    ],
  },
  {
    title: "Architecture & Schema",
    items: [
      { label: "Architecture", href: "/internal/architecture" },
      { label: "Schema Overview", href: "/internal/schema" },
      { label: "Entity Reference", href: "/internal/schema/entities" },
      { label: "Schema Diagrams", href: "/internal/schema/diagrams" },
    ],
  },
];
