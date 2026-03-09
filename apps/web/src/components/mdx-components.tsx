import Image from "next/image";
import { EntityLink, MultiEntityLinks } from "@/components/wiki/EntityLink";
import { ResourceLink, R } from "@/components/wiki/ResourceLink";
import { References } from "@/components/wiki/References";
import { KBF } from "@/components/wiki/KBF";
import { Calc } from "@/components/wiki/Calc";
import { MermaidDiagram } from "@/components/wiki/MermaidDiagram";
import { DataInfoBox } from "@/components/wiki/DataInfoBox";
import { Backlinks } from "@/components/wiki/Backlinks";
import { DataExternalLinks } from "@/components/wiki/DataExternalLinks";
import { InfoBox } from "@/components/wiki/InfoBox";
import { ExternalLinks } from "@/components/wiki/ExternalLinks";
import { SquiggleEstimate } from "@/components/wiki/SquiggleEstimate";
import { Callout } from "@/components/wiki/Callout";
import { StarlightCard, CardGrid, LinkCard } from "@/components/wiki/StarlightCards";
import { ComparisonTable } from "@/components/wiki/ComparisonTable";
import CauseEffectGraph from "@/components/wiki/CauseEffectGraph";
import { PageCauseEffectGraph } from "@/components/wiki/PageCauseEffectGraph";
import { OverviewBanner } from "@/components/wiki/OverviewBanner";
import { AnthropicStakeholdersTable } from "@/components/wiki/AnthropicStakeholdersTable";

// KB (Knowledge Base) components — typed facts, properties, items
import { KBFactTable } from "@/components/wiki/kb/KBFactTable";
import { KBItemTable } from "@/components/wiki/kb/KBItemTable";
import { KBFactValue } from "@/components/wiki/kb/KBFactValue";
import { KBEntityFacts } from "@/components/wiki/kb/KBEntityFacts";
import { KBItemCollection } from "@/components/wiki/kb/KBItemCollection";
import { KBEntitySidebar } from "@/components/wiki/kb/KBEntitySidebar";
import { KBRefLink } from "@/components/wiki/kb/KBRefLink";
import { KBCompareTable } from "@/components/wiki/kb/KBCompareTable";

// Table view components
import SafetyApproachesTableView from "@/components/tables/views/SafetyApproachesTableView";
import AccidentRisksTableView from "@/components/tables/views/AccidentRisksTableView";
import EvalTypesTableView from "@/components/tables/views/EvalTypesTableView";
import ArchitectureScenariosTableView from "@/components/tables/views/ArchitectureScenariosTableView";
import DeploymentArchitecturesTableView from "@/components/tables/views/DeploymentArchitecturesTableView";
import SafetyGeneralizabilityTableView from "@/components/tables/views/SafetyGeneralizabilityTableView";

// Summary components
import { KeyTakeaways } from "@/components/wiki/KeyTakeaways";

// Epic tracking — use on multi-issue coordination pages (see content/docs/internal/epic-page-conventions.mdx)
// Usage: <EpicTracker issues={[1043, 1065, 1074]} /> — renders live GitHub issue status table
import { EpicTracker } from "@/components/wiki/EpicTracker";

// KB Data section content components (public structured data at /kb/)
import { KBOverviewContent } from "@/app/kb/kb-overview-content";
import { KBFactsExplorerContent } from "@/app/kb/kb-facts-content";
import { KBPropertiesExplorerContent } from "@/app/kb/kb-properties-content";
import { KBEntityCoverageContent } from "@/app/kb/kb-entities-content";
import { KBItemsExplorerContent } from "@/app/kb/kb-items-content";

// Dashboard content components (rendered via MDX stubs at /wiki/E<id>)
import { FactsPageContent } from "@/app/internal/facts/facts-content";
import { PageCoverageContent } from "@/app/internal/page-coverage/page-coverage-content";
import { UpdateScheduleContent } from "@/app/internal/updates/updates-content";
import { EntitiesContent } from "@/app/internal/entities/entities-content";
import { PageChangesContent } from "@/app/internal/page-changes/page-changes-content";
import { SuggestedPagesContent } from "@/app/internal/suggested-pages/suggested-pages-content";
import { ImproveRunsContent } from "@/app/internal/improve-runs/improve-runs-content";
import { AgentSessionsContent } from "@/app/internal/agent-sessions/agent-sessions-content";
import { SessionInsightsContent } from "@/app/internal/session-insights/session-insights-content";
import { AutoUpdateRunsContent } from "@/app/internal/auto-update-runs/auto-update-runs-content";
import { AutoUpdateNewsContent } from "@/app/internal/auto-update-news/auto-update-news-content";
import { CitationAccuracyContent } from "@/app/internal/citation-accuracy/citation-accuracy-content";
import { CitationContentContent } from "@/app/internal/citation-content/citation-content-content";
import { HallucinationRiskContent } from "@/app/internal/hallucination-risk/hallucination-risk-content";
import { HallucinationEvalsContent } from "@/app/internal/hallucination-evals/hallucination-evals-content";
import { ActiveAgentsContent } from "@/app/internal/active-agents/active-agents-content";
import { GroundskeeperRunsContent } from "@/app/internal/groundskeeper-runs/groundskeeper-runs-content";
import { SystemHealthContent } from "@/app/internal/system-health/system-health-content";
import { PRDashboardContent } from "@/app/internal/pr-dashboard/pr-dashboard-content";

// Ported stub components — high priority
import { Section } from "@/components/wiki/Section";
import { KeyQuestions } from "@/components/wiki/KeyQuestions";
import { KeyPeople } from "@/components/wiki/KeyPeople";
import { DisagreementMap } from "@/components/wiki/DisagreementMap";
import { Crux } from "@/components/wiki/Crux";
import { CruxList } from "@/components/wiki/CruxList";

// Ported stub components — medium priority
import { Tags } from "@/components/wiki/Tags";
import { ModelsList } from "@/components/wiki/ModelsList";
import { MdxTabs, MdxTabItem } from "@/components/wiki/MdxTabs";
import { Badge } from "@/components/ui/badge";

// Footnote tooltip — intercepts <sup> to add rich hover cards on footnote refs
import { FootnoteSup } from "@/components/wiki/FootnoteSup";

// Legacy compat shim: Starlight's <Aside> mapped to our <Callout> component
type CalloutVariant = "note" | "tip" | "caution" | "warning" | "danger";
function Aside({ type, title, children }: { type?: string; title?: string; children?: React.ReactNode }) {
  const variant = (type && ["note", "tip", "caution", "warning", "danger"].includes(type))
    ? type as CalloutVariant
    : "note";
  return <Callout variant={variant} title={title}>{children}</Callout>;
}

// Stub for legacy Astro/Starlight components still referenced in MDX content
function Stub({ children }: { children?: React.ReactNode }) {
  return <div className="p-2 bg-muted/50 rounded text-sm text-muted-foreground">{children}</div>;
}

// Legacy component names still referenced in MDX content, rendered as stubs.
// Dead stubs removed: Code, Steps, Icon, FileTree
// Ported stubs removed: Badge, Crux, CruxList, DisagreementMap,
//   FactorRelationshipDiagram, ImpactList, KeyPeople,
//   KeyQuestions, ModelsList, Section, TabItem, Tabs, Tags
const stubNames = [
  "AnthropicFact", "ArticleSources",
  "ConceptsDirectory", "DataCrux", "DataEstimateBox",
  "DualOutcomeChart", "EntityGraph", "EstimateBox",
  "FactorAttributionMatrix", "FactorGauges",
  "FullModelDiagram", "ImpactGrid",
  "InsightGridExperiments", "InsightScoreMatrix", "InsightsTable",
  "KnowledgeTreemap",
  "OutcomesTable", "PageIndex", "PixelDensityMap",
  "PriorityMatrix", "QualityDashboard", "ResearchFrontier", "ResourceCite",
  "ResourcesIndex", "RiskDashboard", "RiskTrajectoryExperiments",
  "RootFactorsTable", "ScenariosTable", "SparseKnowledgeGrid",
  "Table", "TableBody", "TableCell", "TableHead", "TableHeader",
  "TableRow", "TagBrowser", "TimelineViz", "TopicQuestionGrid",
  "TrajectoryLines",
] as const;

const stubs = Object.fromEntries(stubNames.map((name) => [name, Stub]));

/**
 * MDX component map — these are injected into every MDX page
 * so import statements in the source can be safely stripped.
 */
export const mdxComponents: Record<string, React.ComponentType<any>> = {
  // Fully ported
  EntityLink,
  MultiEntityLinks,
  ResourceLink,
  R,
  References,
  KBF,
  Calc,
  DataInfoBox,
  Backlinks,
  DataExternalLinks,
  InfoBox,
  ExternalLinks,

  // Mermaid — client-side rendered diagrams
  Mermaid: MermaidDiagram,

  // Squiggle — probabilistic estimate visualizations
  SquiggleEstimate,

  // Callout — rendered from :::note, :::tip, :::caution, :::danger directives
  Callout,

  // Summary — prominent key takeaways box at top of articles
  KeyTakeaways,

  // Aside — Starlight callout component, mapped to Callout
  Aside,

  // Comparison table
  ComparisonTable,

  // Cause-Effect Graph components
  CauseEffectGraph,
  PageCauseEffectGraph,

  // Overview banner
  OverviewBanner,

  // Anthropic-specific table
  AnthropicStakeholdersTable,

  // KB (Knowledge Base) — typed facts, item collections, entity data
  KBFactTable,
  KBItemTable,
  KBFactValue,
  KBEntityFacts,
  KBItemCollection,
  KBEntitySidebar,
  KBRefLink,
  KBCompareTable,

  // Epic tracking
  EpicTracker,

  // KB Data section components
  KBOverviewContent,
  KBFactsExplorerContent,
  KBPropertiesExplorerContent,
  KBEntityCoverageContent,
  KBItemsExplorerContent,

  // Dashboard content components
  FactsPageContent,
  PageCoverageContent,
  UpdateScheduleContent,
  EntitiesContent,
  PageChangesContent,
  SuggestedPagesContent,
  ImproveRunsContent,
  AgentSessionsContent,
  SessionInsightsContent,
  AutoUpdateRunsContent,
  AutoUpdateNewsContent,
  CitationAccuracyContent,
  CitationContentContent,
  HallucinationRiskContent,
  HallucinationEvalsContent,
  ActiveAgentsContent,
  GroundskeeperRunsContent,
  SystemHealthContent,
  PRDashboardContent,

  // Table view components
  SafetyApproachesTableView,
  AccidentRisksTableView,
  EvalTypesTableView,
  ArchitectureScenariosTableView,
  DeploymentArchitecturesTableView,
  SafetyGeneralizabilityTableView,

  // Starlight card components
  Card: StarlightCard,
  CardGrid,
  LinkCard,

  // Ported stub components — high priority (used across many pages)
  Section,
  KeyQuestions,
  KeyPeople,
  DisagreementMap,
  Crux,
  CruxList,

  // Ported stub components — medium priority
  Tags,
  Badge,
  ModelsList,
  Tabs: MdxTabs,
  TabItem: MdxTabItem,

  // Override sup to add rich tooltips on footnote superscripts
  sup: FootnoteSup,

  // Override pre/code to detect ```mermaid fenced code blocks
  pre: ({ children, ...props }: React.ComponentProps<"pre">) => {
    // Check if this is a mermaid code block
    const child = children as React.ReactElement<{ className?: string; children?: unknown }> | undefined;
    if (child?.props?.className === "language-mermaid") {
      const code = child.props.children;
      if (typeof code === "string") {
        return <MermaidDiagram chart={code.trim()} />;
      }
    }
    return <pre {...props}>{children}</pre>;
  },

  // Override img to use Next.js Image for optimization
  img: ({ src, alt, title }: React.ComponentProps<"img">) => {
    if (!src || typeof src !== "string") return null;
    const isExternal =
      src.startsWith("http") || src.startsWith("//") || src.startsWith("data:");
    return (
      <Image
        src={src}
        alt={alt || ""}
        {...(title ? { title } : {})}
        width={800}
        height={450}
        sizes="(max-width: 768px) 100vw, 768px"
        className="w-full h-auto"
        unoptimized={isExternal}
      />
    );
  },

  // Remaining legacy stubs — low priority, kept to prevent MDX compilation errors
  ...stubs,
};
