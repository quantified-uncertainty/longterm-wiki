import Image from "next/image";
import { EntityLink, MultiEntityLinks } from "@/components/wiki/EntityLink";
import { ResourceLink, R } from "@/components/wiki/ResourceLink";
import { F } from "@/components/wiki/F";
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

// Aside → Callout adapter (Starlight uses `type`, our Callout uses `variant`)
type CalloutVariant = "note" | "tip" | "caution" | "warning" | "danger";
function Aside({ type, title, children }: { type?: string; title?: string; children?: React.ReactNode }) {
  const variant = (type && ["note", "tip", "caution", "warning", "danger"].includes(type))
    ? type as CalloutVariant
    : "note";
  return <Callout variant={variant} title={title}>{children}</Callout>;
}

// Placeholder for Astro-only or not-yet-ported components
function Stub({ children }: { children?: React.ReactNode }) {
  return <div className="p-2 bg-muted/50 rounded text-sm text-muted-foreground">{children}</div>;
}

// All component names found in MDX content that aren't yet ported
const stubNames = [
  "AnthropicFact", "ArticleSources",
  "Badge",
  "ConceptsDirectory", "Crux", "CruxList", "DataCrux", "DataEstimateBox",
  "DisagreementMap", "DualOutcomeChart", "EntityGraph", "EstimateBox",
  "FactorAttributionMatrix", "FactorGauges", "FactorRelationshipDiagram",
  "FullModelDiagram", "FullWidthLayout", "ImpactGrid",
  "ImpactList", "InsightGridExperiments", "InsightScoreMatrix", "InsightsTable",
  "KeyPeople", "KeyQuestions", "KnowledgeTreemap", "ModelsList",
  "OutcomesTable", "PageIndex", "PixelDensityMap",
  "PriorityMatrix", "QualityDashboard", "ResearchFrontier", "ResourceCite",
  "ResourceList", "ResourcesIndex", "RiskDashboard", "RiskTrajectoryExperiments",
  "RootFactorsTable", "ScenariosTable", "Section", "SparseKnowledgeGrid",
  "TabItem", "Table", "TableBody", "TableCell", "TableHead", "TableHeader",
  "TableRow", "Tabs", "TagBrowser", "Tags", "TimelineViz", "TopicQuestionGrid",
  "TrajectoryLines",
  "Code", "Steps", "Icon", "FileTree",
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

  // Starlight card components
  Card: StarlightCard,
  CardGrid,
  LinkCard,

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

  // All other Astro/custom components as stubs
  ...stubs,
};
