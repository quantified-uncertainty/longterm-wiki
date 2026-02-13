import Link from "next/link";
import { getRelatedGraphFor, getPageById, getEntityById } from "@/data";
import { getEntityTypeIcon } from "./wiki/EntityTypeIcon";
import styles from "./wiki/tooltip.module.css";
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

// Entity type → color for the dot indicator
const TYPE_COLOR: Record<string, string> = {
  researcher: "bg-blue-400",
  lab: "bg-violet-400",
  "lab-academic": "bg-violet-400",
  "lab-research": "bg-violet-400",
  organization: "bg-slate-400",
  "safety-agenda": "bg-emerald-400",
  approach: "bg-teal-400",
  risk: "bg-red-400",
  policy: "bg-amber-400",
  concept: "bg-sky-400",
  capability: "bg-sky-400",
  model: "bg-indigo-400",
  "ai-transition-model-parameter": "bg-indigo-400",
  "ai-transition-model-factor": "bg-indigo-400",
  "ai-transition-model-metric": "bg-indigo-400",
  "ai-transition-model-scenario": "bg-indigo-400",
  "ai-transition-model-subitem": "bg-indigo-400",
  analysis: "bg-orange-400",
  project: "bg-orange-400",
  crux: "bg-rose-400",
  argument: "bg-rose-400",
  historical: "bg-stone-400",
  event: "bg-stone-400",
  parameter: "bg-cyan-400",
  funder: "bg-lime-400",
};

// Preferred group ordering per source entity type.
// Groups not listed fall back to score-based ordering after the listed ones.
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

function formatEntityType(type: string): string {
  return type
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

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

  // Context-aware ordering: use preferred order for source type if available,
  // then fall back to score-based ordering for unlisted groups
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

function TypeDot({ type }: { type: string }) {
  const color = TYPE_COLOR[type] || "bg-gray-400";
  return <span className={`inline-block w-1.5 h-1.5 rounded-full ${color} shrink-0`} />;
}

function RelationshipLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center px-1.5 py-0 text-[0.6rem] leading-4 font-medium rounded bg-muted text-muted-foreground shrink-0">
      {label}
    </span>
  );
}

function ItemTooltip({ item }: { item: RelatedPageItem }) {
  const entity = getEntityById(item.id);
  const page = getPageById(item.id);
  const summary = page?.llmSummary || page?.description || entity?.description;
  const TypeIcon = entity ? getEntityTypeIcon(entity.type) : null;

  if (!summary && !entity?.type) return null;

  return (
    <span
      className={cn(
        styles.tooltip,
        "absolute left-0 bottom-full mb-1 z-50 w-[280px] p-3 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible"
      )}
      role="tooltip"
    >
      {entity?.type && (
        <span className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
          {TypeIcon && <TypeIcon className="w-3 h-3" />}
          <span className="uppercase tracking-wide">{formatEntityType(entity.type)}</span>
        </span>
      )}
      <span className="block font-semibold text-foreground mb-1.5 text-sm">
        {item.title}
      </span>
      {summary && (
        <span className="block text-muted-foreground text-[0.8rem] leading-snug">
          {truncate(summary, 200)}
        </span>
      )}
      {page?.quality && (
        <span className="block mt-2 text-xs text-muted-foreground">
          Quality: {page.quality}/100
        </span>
      )}
    </span>
  );
}

function TopItem({ item }: { item: RelatedPageItem }) {
  const groupName = TYPE_TO_GROUP[item.type] || "Other";
  return (
    <div className={cn(styles.wrapper, "flex items-start gap-2 py-0.5")}>
      <TypeDot type={item.type} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5 flex-wrap">
          <Link
            href={item.href}
            className="text-[13px] font-medium text-accent-foreground no-underline hover:underline"
          >
            {item.title}
          </Link>
          {item.label && <RelationshipLabel label={item.label} />}
          <span className="text-[0.6rem] text-muted-foreground/60">{groupName}</span>
        </div>
        {item.description && (
          <p className="text-xs text-muted-foreground mt-0 mb-0 leading-snug line-clamp-1">
            {item.description}
          </p>
        )}
      </div>
      <ItemTooltip item={item} />
    </div>
  );
}

function CompactItem({ item }: { item: RelatedPageItem }) {
  return (
    <div className={cn(styles.wrapper, "flex items-center gap-1.5 py-0.5")}>
      <TypeDot type={item.type} />
      <Link
        href={item.href}
        className="text-[13px] text-accent-foreground no-underline hover:underline truncate"
      >
        {item.title}
      </Link>
      {item.label && <RelationshipLabel label={item.label} />}
      <ItemTooltip item={item} />
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="text-xs font-medium text-muted-foreground/70 uppercase tracking-wide mb-0.5">
      {children}
    </h3>
  );
}

function GroupSection({ group }: { group: TypeGroup }) {
  return (
    <div>
      <SectionHeading>{group.label}</SectionHeading>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-x-4 gap-y-0">
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
  const allItems: RelatedPageItem[] = getRelatedGraphFor(entityId).map(
    (entry) => {
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
        description: desc
          ? desc.length > 120
            ? desc.slice(0, 117) + "..."
            : desc
          : undefined,
      };
    }
  );

  if (allItems.length === 0) return null;

  const sourceType = entity?.type;
  const bounded = allItems.slice(0, MAX_TOTAL);

  // Top items: highest-scored, shown with descriptions
  const topItems = bounded.slice(0, TOP_ITEMS_COUNT);
  const topIds = new Set(topItems.map((i) => i.id));

  // Remaining items: grouped by type
  const remaining = bounded.filter((i) => !topIds.has(i.id));
  const groups = groupByType(remaining, sourceType);

  return (
    <section className="not-prose mt-10 pt-5 border-t border-border">
      <SectionHeading>Related Pages</SectionHeading>
      <div className="mb-3">
        {topItems.map((item) => (
          <TopItem key={item.id} item={item} />
        ))}
      </div>
      {groups.length > 0 && (
        <div className="space-y-1.5">
          {groups.map((group) => (
            <GroupSection key={group.label} group={group} />
          ))}
        </div>
      )}
    </section>
  );
}
