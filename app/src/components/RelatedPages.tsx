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

interface RelatedPageItem {
  id: string;
  title: string;
  href: string;
  type: string;
  score: number;
}

interface TypeGroup {
  label: string;
  items: RelatedPageItem[];
  maxScore: number;
}

const MAX_PER_GROUP = 6;
const MAX_TOTAL = 25;

function groupByType(items: RelatedPageItem[]): TypeGroup[] {
  const groups = new Map<string, RelatedPageItem[]>();

  for (const item of items) {
    const groupLabel = TYPE_TO_GROUP[item.type] || "Other";
    if (!groups.has(groupLabel)) groups.set(groupLabel, []);
    groups.get(groupLabel)!.push(item);
  }

  // Convert to array, compute max score per group, sort groups by max score
  return [...groups.entries()]
    .map(([label, groupItems]) => ({
      label,
      items: groupItems.slice(0, MAX_PER_GROUP),
      maxScore: Math.max(...groupItems.map((i) => i.score)),
    }))
    .sort((a, b) => b.maxScore - a.maxScore);
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
          </div>
        ))}
      </div>
    </div>
  );
}

export function RelatedPages({
  entityId,
}: {
  entityId: string;
  entity?: unknown;
}) {
  const allItems: RelatedPageItem[] = getRelatedGraphFor(entityId).map(
    (entry) => ({
      id: entry.id,
      title: entry.title,
      href: entry.href,
      type: entry.type,
      score: entry.score,
    })
  );

  if (allItems.length === 0) return null;

  const groups = groupByType(allItems.slice(0, MAX_TOTAL));

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
