import Image from "next/image";
import { EntityLink, MultiEntityLinks } from "@/components/wiki/EntityLink";
import { ResourceLink, R } from "@/components/wiki/ResourceLink";
import { F } from "@/components/wiki/F";
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
import { ATMPage } from "@/components/wiki/ATMPage";
import { TransitionModelContent } from "@/components/wiki/TransitionModelContent";
import TransitionModelTable from "@/components/wiki/TransitionModelTable";
import { TransitionModelInteractive } from "@/components/wiki/TransitionModelTable";
import { FactorSubItemsList, AllFactorsSubItems } from "@/components/wiki/FactorSubItemsList";
import CauseEffectGraph from "@/components/wiki/CauseEffectGraph";
import { PageCauseEffectGraph } from "@/components/wiki/PageCauseEffectGraph";

// Table view components
import SafetyApproachesTableView from "@/components/tables/views/SafetyApproachesTableView";
import AccidentRisksTableView from "@/components/tables/views/AccidentRisksTableView";
import EvalTypesTableView from "@/components/tables/views/EvalTypesTableView";
import ArchitectureScenariosTableView from "@/components/tables/views/ArchitectureScenariosTableView";
import DeploymentArchitecturesTableView from "@/components/tables/views/DeploymentArchitecturesTableView";
import SafetyGeneralizabilityTableView from "@/components/tables/views/SafetyGeneralizabilityTableView";

// Summary components
import { KeyTakeaways } from "@/components/wiki/KeyTakeaways";

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
import { FactorRelationshipDiagram } from "@/components/wiki/FactorRelationshipDiagram";
import { ImpactList } from "@/components/wiki/ImpactList";
import { MdxTabs, MdxTabItem } from "@/components/wiki/MdxTabs";
import { Badge } from "@/components/ui/badge";

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
  "ResourceList", "ResourcesIndex", "RiskDashboard", "RiskTrajectoryExperiments",
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
  F,
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

  // AI Transition Model components
  ATMPage,
  TransitionModelContent,
  TransitionModelTable,
  TransitionModelInteractive,
  FactorSubItemsList,
  AllFactorsSubItems,

  // Cause-Effect Graph components
  CauseEffectGraph,
  PageCauseEffectGraph,

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
  FactorRelationshipDiagram,
  ImpactList,
  Tabs: MdxTabs,
  TabItem: MdxTabItem,

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
