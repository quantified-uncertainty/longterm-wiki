/**
 * KBEntitySidebar -- Wikipedia-style infobox for KB entities.
 *
 * Server component that renders a compact sidebar showing key facts about a KB
 * entity. Shows: name, type, founded date, headquarters, latest revenue/valuation,
 * headcount, legal structure, and safety level. Only shows facts that exist.
 *
 * Designed to complement the existing InfoBox component with KB-sourced data,
 * providing a structured data alternative that pulls directly from the knowledge
 * base rather than frontmatter.
 *
 * Usage in MDX:
 *   <KBEntitySidebar entity="anthropic" />
 *   <KBEntitySidebar entity="anthropic" properties={["revenue", "valuation", "headcount"]} />
 */

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { getKBEntity, getKBLatest, getKBProperties } from "@data/kb";
import type { Fact, Property } from "@longterm-wiki/kb";
import { formatKBDate, titleCase } from "./format";
import { KBFactValueDisplay } from "./KBFactValueDisplay";

interface KBEntitySidebarProps {
  /** KB entity ID (e.g., "anthropic") */
  entity: string;
  /** Optional list of property IDs to show (defaults to key properties for the entity type) */
  properties?: string[];
  /** Optional heading override */
  title?: string;
  className?: string;
}

/** Default properties to show for each entity type, in display order.
 *
 * Each list is derived from the schema's `required` + `recommended` properties
 * (in `packages/kb/data/schemas/<type>.yaml`), with `description` excluded
 * (it belongs in the page content, not the sidebar).
 */
const DEFAULT_PROPERTIES: Record<string, string[]> = {
  organization: [
    "founded-date",
    "headquarters",
    "legal-structure",
    "headcount",
    "revenue",
    "valuation",
    "total-funding",
    "gross-margin",
    "enterprise-market-share",
    "coding-market-share",
    "monthly-active-users",
    "business-customers",
    "safety-level",
    "safety-researcher-count",
  ],
  person: [
    "born-year",
    "employed-by",
    "role",
    "founder-of",
    "education",
    "notable-for",
  ],
  "ai-model": [
    "developed-by",
    "model-release-date",
    "model-family",
    "parameter-count",
    "context-window",
    "modality",
    "license-type",
    "training-compute",
  ],
  analysis: [
    "evidence-strength",
    "publication-date",
  ],
  approach: [
    "intervention-type",
    "maturity-level",
    "time-horizon",
    "tractability",
    "evidence-strength",
    "expert-consensus-level",
  ],
  argument: [
    "evidence-strength",
    "expert-consensus-level",
  ],
  capability: [
    "maturity-level",
    "evidence-strength",
    "expert-consensus-level",
    "time-horizon",
  ],
  concept: [
    "expert-consensus-level",
    "evidence-strength",
    "time-horizon",
    "research-consensus",
  ],
  debate: [
    "core-question",
    "expert-consensus-level",
    "evidence-strength",
    "time-horizon",
  ],
  event: [
    "publication-date",
  ],
  incident: [
    "incident-date",
    "organizations-involved",
    "incident-status",
    "financial-impact",
    "casualties",
  ],
  policy: [
    "time-horizon",
    "evidence-strength",
  ],
  project: [
    "developed-by",
    "launched-date",
    "maturity-level",
  ],
  risk: [
    "severity-level",
    "likelihood-estimate",
    "time-horizon",
    "reversibility",
    "evidence-strength",
    "expert-consensus-level",
  ],
};

export function KBEntitySidebar({
  entity,
  properties,
  title,
  className,
}: KBEntitySidebarProps) {
  const kbEntity = getKBEntity(entity);
  if (!kbEntity) {
    if (process.env.NODE_ENV === "development") {
      console.warn(`[KBEntitySidebar] Unknown KB entity: "${entity}"`);
    }
    return null;
  }

  const allProperties = getKBProperties();
  const propertyMap = new Map(allProperties.map((p) => [p.id, p]));

  // Determine which properties to show
  const propsToShow = properties ?? DEFAULT_PROPERTIES[kbEntity.type] ?? [];

  // Collect latest facts for each property
  const rows: Array<{
    propertyId: string;
    property: Property | undefined;
    fact: Fact;
  }> = [];

  for (const propId of propsToShow) {
    const fact = getKBLatest(entity, propId);
    if (fact) {
      rows.push({
        propertyId: propId,
        property: propertyMap.get(propId),
        fact,
      });
    }
  }

  if (rows.length === 0) {
    return null; // Nothing to show
  }

  const heading = title ?? kbEntity.name;
  const entityType = titleCase(kbEntity.type);

  return (
    <Card
      className={cn(
        "float-right w-[280px] mb-4 ml-6 overflow-visible text-sm max-md:float-none max-md:w-full max-md:ml-0 max-md:mb-6",
        className,
      )}
    >
      {/* Header */}
      <div className="px-3 py-2.5 bg-primary/10 rounded-t-lg">
        <span className="block text-xs uppercase tracking-wide text-muted-foreground/70 mb-0.5">
          {entityType}
        </span>
        <h3 className="m-0 text-sm font-semibold leading-tight text-foreground">
          {heading}
        </h3>
        {kbEntity.aliases && kbEntity.aliases.length > 0 && (
          <span className="block text-xs text-muted-foreground/60 mt-0.5">
            Also: {kbEntity.aliases.join(", ")}
          </span>
        )}
      </div>

      {/* Facts */}
      <div className="py-1">
        {rows.map(({ propertyId, property, fact }) => (
          <div
            key={propertyId}
            className="flex py-1.5 border-b border-border last:border-b-0 px-4"
          >
            <span className="flex-shrink-0 w-[100px] min-w-[100px] text-muted-foreground font-medium pr-2 text-xs">
              {property?.name ?? titleCase(propertyId)}
            </span>
            <div className="flex-1 text-xs break-words">
              <KBFactValueDisplay fact={fact} property={property} className="font-semibold text-foreground" />
              {fact.asOf && (
                <span className="block text-xs text-muted-foreground/60 mt-0.5">
                  as of {formatKBDate(fact.asOf)}
                </span>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-2 border-t border-border">
        <span className="text-xs text-muted-foreground/60 font-mono">
          kb:{entity}
        </span>
      </div>
    </Card>
  );
}
