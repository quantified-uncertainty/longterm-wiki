import Link from "next/link";
import { getRelatedGraphFor } from "@/data";

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

interface RelatedPageItem {
  id: string;
  title: string;
  href: string;
  type: string;
  score: number;
  label?: string;
}

interface TypeGroup {
  label: string;
  items: RelatedPageItem[];
  maxScore: number;
}

const MAX_PER_GROUP = 6;
const MAX_TOTAL = 25;

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
      // Both in preferred list: use preferred order
      if (aIdx !== -1 && bIdx !== -1) return aIdx - bIdx;
      // Only one in preferred list: it comes first
      if (aIdx !== -1) return -1;
      if (bIdx !== -1) return 1;
      // Neither in list: fall back to score
      return b.maxScore - a.maxScore;
    });
  } else {
    result.sort((a, b) => b.maxScore - a.maxScore);
  }

  return result;
}

function GroupSection({ group }: { group: TypeGroup }) {
  return (
    <div>
      <h3 className="text-sm font-medium text-muted-foreground mb-2">
        {group.label}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-0.5">
        {group.items.map((item) => (
          <div key={item.id} className="flex items-center gap-2 py-1">
            <Link
              href={item.href}
              className="text-sm text-accent-foreground no-underline hover:underline truncate"
            >
              {item.title}
            </Link>
            {item.label && (
              <span className="text-[0.65rem] text-muted-foreground shrink-0">
                {item.label}
              </span>
            )}
          </div>
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
    (entry) => ({
      id: entry.id,
      title: entry.title,
      href: entry.href,
      type: entry.type,
      score: entry.score,
      label: entry.label,
    })
  );

  if (allItems.length === 0) return null;

  const sourceType = entity?.type;
  const groups = groupByType(allItems.slice(0, MAX_TOTAL), sourceType);

  return (
    <section className="mt-12 pt-6 border-t border-border">
      <h2 className="text-lg font-semibold mb-4">Related Pages</h2>
      <div className="space-y-4">
        {groups.map((group) => (
          <GroupSection key={group.label} group={group} />
        ))}
      </div>
    </section>
  );
}
