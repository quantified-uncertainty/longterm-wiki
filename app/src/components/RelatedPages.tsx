import Link from "next/link";
import { getRelatedGraphFor, getPageById, getEntityById } from "@/data";
import { ENTITY_TYPES } from "@/data/entity-ontology";
import { getEntityTypeIcon } from "./wiki/EntityTypeIcon";
import { getTypeLabel, getTypeColor } from "./explore/explore-utils";
import { EntityLink } from "./wiki/EntityLink";
import { cn } from "@lib/utils";

// Map entity types to display group names
const TYPE_TO_GROUP: Record<string, string> = {
  researcher: "People",
  lab: "Labs",
  "lab-academic": "Labs",
  "lab-research": "Labs",
  organization: "Organizations",
  "safety-agenda": "Safety Research",
  approach: "Approaches",
  risk: "Risks",
  policy: "Policy",
  concept: "Concepts",
  capability: "Concepts",
  model: "Models",
  "ai-transition-model-parameter": "Transition Model",
  "ai-transition-model-factor": "Transition Model",
  "ai-transition-model-metric": "Transition Model",
  "ai-transition-model-scenario": "Transition Model",
  "ai-transition-model-subitem": "Transition Model",
  analysis: "Analysis",
  project: "Analysis",
  crux: "Key Debates",
  argument: "Key Debates",
  historical: "Historical",
  event: "Historical",
  parameter: "Parameters",
  funder: "Funders",
};

// Representative icon type for each group (used for group headers)
const GROUP_ICON_TYPE: Record<string, string> = {
  People: "person",
  Labs: "organization",
  Organizations: "organization",
  "Safety Research": "safety-agenda",
  Approaches: "approach",
  Risks: "risk",
  Policy: "policy",
  Concepts: "concept",
  Models: "model",
  "Transition Model": "parameter",
  Analysis: "analysis",
  "Key Debates": "crux",
  Historical: "historical",
  Parameters: "parameter",
  Funders: "funder",
};

// Preferred group ordering per source entity type.
const GROUP_ORDER_BY_SOURCE_TYPE: Record<string, string[]> = {
  lab: ["People", "Safety Research", "Approaches", "Analysis", "Risks", "Labs", "Policy", "Organizations"],
  "lab-research": ["People", "Safety Research", "Approaches", "Analysis", "Risks", "Labs"],
  "lab-academic": ["People", "Safety Research", "Approaches", "Analysis", "Risks", "Labs"],
  researcher: ["Labs", "Organizations", "Safety Research", "Approaches", "People", "Analysis", "Risks"],
  risk: ["Approaches", "Safety Research", "People", "Labs", "Analysis", "Risks", "Models", "Policy"],
  approach: ["Safety Research", "Risks", "People", "Labs", "Analysis", "Approaches", "Models"],
  "safety-agenda": ["Approaches", "People", "Labs", "Risks", "Analysis", "Models"],
  concept: ["Approaches", "Risks", "People", "Labs", "Analysis", "Safety Research"],
  policy: ["Organizations", "Labs", "Risks", "Approaches", "People", "Analysis"],
  analysis: ["People", "Labs", "Risks", "Approaches", "Analysis", "Safety Research"],
  organization: ["People", "Labs", "Safety Research", "Approaches", "Analysis", "Policy"],
  model: ["Risks", "Approaches", "Safety Research", "Analysis", "People", "Labs", "Models"],
};

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 3) + "...";
}

interface RelatedPageItem {
  id: string;
  title: string;
  href: string;
  type: string;
  score: number;
  label?: string;
  description?: string;
}

interface TypeGroup {
  label: string;
  items: RelatedPageItem[];
  maxScore: number;
}

const MAX_PER_GROUP = 6;
const MAX_TOTAL = 25;
const TOP_ITEMS_COUNT = 5;

function groupByType(
  items: RelatedPageItem[],
  sourceType?: string
): TypeGroup[] {
  const groups = new Map<string, RelatedPageItem[]>();

  for (const item of items) {
    const groupLabel = TYPE_TO_GROUP[item.type] || "Other";
    if (!groups.has(groupLabel)) groups.set(groupLabel, []);
    groups.get(groupLabel)!.push(item);
  }

  const result = [...groups.entries()].map(([label, groupItems]) => ({
    label,
    items: groupItems.slice(0, MAX_PER_GROUP),
    maxScore: Math.max(...groupItems.map((i) => i.score)),
  }));

  const preferredOrder = sourceType
    ? GROUP_ORDER_BY_SOURCE_TYPE[sourceType]
    : undefined;

  if (preferredOrder) {
    result.sort((a, b) => {
      const aIdx = preferredOrder.indexOf(a.label);
      const bIdx = preferredOrder.indexOf(b.label);
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      return b.maxScore - a.maxScore;
    });
  } else {
    result.sort((a, b) => b.maxScore - a.maxScore);
  }

  return result;
}

function FeaturedItem({ item }: { item: RelatedPageItem }) {
  return (
    <Link
      href={item.href}
      className="group block p-4 border border-border rounded-lg hover:border-foreground/30 hover:shadow-sm transition-all no-underline [&_*]:no-underline bg-card"
    >
      <div className="flex items-center justify-between mb-2">
        <span className={`text-xs font-medium px-2 py-0.5 rounded ${getTypeColor(item.type)}`}>
          {getTypeLabel(item.type)}
        </span>
      </div>
      <h3 className="text-sm font-semibold text-foreground mb-1.5 group-hover:text-accent-foreground">
        {item.title}
      </h3>
      {item.description && item.description !== item.title && (
        <p className="text-xs text-muted-foreground leading-relaxed mb-0">
          {truncate(item.description, 150)}
        </p>
      )}
    </Link>
  );
}

function CompactItem({ item }: { item: RelatedPageItem }) {
  return <EntityLink id={item.id} />;
}

function GroupSection({ group }: { group: TypeGroup }) {
  const iconType = GROUP_ICON_TYPE[group.label];
  const Icon = iconType ? getEntityTypeIcon(iconType) : null;
  const iconColor = iconType ? ENTITY_TYPES[iconType]?.iconColor : undefined;

  return (
    <div>
      <h3 className="text-[0.65rem] font-medium text-muted-foreground uppercase tracking-wide flex items-center gap-1.5 mb-2">
        {Icon && <Icon className={cn("w-4 h-4 opacity-50", iconColor)} />}
        {group.label}
      </h3>
      <div className="flex flex-wrap gap-1.5">
        {group.items.map((item) => (
          <CompactItem key={item.id} item={item} />
        ))}
      </div>
    </div>
  );
}

export function RelatedPages({
  entityId,
  entity,
}: {
  entityId: string;
  entity?: { type?: string } | null;
}) {
  const allItems: RelatedPageItem[] = getRelatedGraphFor(entityId)
    .filter((entry) => !entry.id.startsWith("__index__"))
    .map((entry) => {
      const page = getPageById(entry.id);
      const desc =
        page?.structuredSummary?.oneLiner ||
        page?.description ||
        page?.llmSummary ||
        undefined;
      return {
        id: entry.id,
        title: entry.title,
        href: entry.href,
        type: entry.type,
        score: entry.score,
        label: entry.label,
        description: desc ? truncate(desc, 150) : undefined,
      };
    });

  if (allItems.length === 0) return null;

  const sourceType = entity?.type;
  const bounded = allItems.slice(0, MAX_TOTAL);

  // Top items: highest-scored, shown as featured cards
  const topItems = bounded.slice(0, TOP_ITEMS_COUNT);
  const topIds = new Set(topItems.map((i) => i.id));

  // Remaining items: grouped by type
  const remaining = bounded.filter((i) => !topIds.has(i.id));
  const groups = groupByType(remaining, sourceType);

  return (
    <section className="not-prose mt-10 pt-6 border-t border-border">
      <h2 className="text-2xl font-bold text-foreground mb-6">Related Pages</h2>
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4">
        Top Related Pages
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-10">
        {topItems.map((item) => (
          <FeaturedItem key={item.id} item={item} />
        ))}
      </div>
      {groups.length > 0 && (
        <div className="columns-2 lg:columns-3 gap-6">
          {groups.map((group) => (
            <div key={group.label} className="break-inside-avoid mb-8">
              <GroupSection group={group} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
