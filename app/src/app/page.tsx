import Link from "next/link";
import { getExploreItems, getAllPages } from "@/data";
import { ContentCard } from "@/components/explore/ContentCard";
import { getTypeLabel, getTypeColor } from "@/components/explore/explore-utils";
import { Shield, Bug, Scale, Brain, BookOpen, Building2 } from "lucide-react";
import type { ExploreItem } from "@/data";
import type { LucideIcon } from "lucide-react";

// Field clusters with descriptions for the topic sections
const TOPIC_SECTIONS: {
  label: string;
  cluster: string;
  icon: LucideIcon;
  accentColor: string;
}[] = [
  {
    label: "AI Safety",
    cluster: "ai-safety",
    icon: Shield,
    accentColor: "text-emerald-600 dark:text-emerald-400",
  },
  {
    label: "Governance",
    cluster: "governance",
    icon: Scale,
    accentColor: "text-violet-600 dark:text-violet-400",
  },
  {
    label: "Biorisks",
    cluster: "biorisks",
    icon: Bug,
    accentColor: "text-red-600 dark:text-red-400",
  },
  {
    label: "Epistemics",
    cluster: "epistemics",
    icon: Brain,
    accentColor: "text-blue-600 dark:text-blue-400",
  },
];

// Depth-oriented types that signal non-introductory content
const DEPTH_TYPES = new Set(["model", "analysis", "crux", "argument", "case-study"]);

function score(item: ExploreItem): number {
  const imp = item.readerImportance || 0;
  const qual = item.quality || 0;
  // Favor pages with substantial content (not stubs or thin introductions)
  const words = item.wordCount || 0;
  const depthBonus = words > 2000 ? 20 : words > 1000 ? 10 : words > 500 ? 5 : 0;
  // Boost analytical/model types that experienced readers want
  const typeBonus = DEPTH_TYPES.has(item.type) ? 15 : 0;
  // Penalize very short pages that are likely thin overviews
  const stubPenalty = words < 300 ? -20 : 0;
  return imp * 2 + qual + depthBonus + typeBonus + stubPenalty;
}

/** Pick top items with type diversity — avoid showing 5 of the same type */
function pickDiverse(items: ExploreItem[], count: number): ExploreItem[] {
  const sorted = [...items].sort((a, b) => score(b) - score(a));
  const result: ExploreItem[] = [];
  const typeCounts = new Map<string, number>();

  for (const item of sorted) {
    if (result.length >= count) break;
    const tc = typeCounts.get(item.type) || 0;
    // Allow at most 2 of the same type in the first pass
    if (tc < 2) {
      result.push(item);
      typeCounts.set(item.type, tc + 1);
    }
  }

  // If we didn't get enough, fill from remaining
  if (result.length < count) {
    const picked = new Set(result.map((r) => r.id));
    for (const item of sorted) {
      if (result.length >= count) break;
      if (!picked.has(item.id)) {
        result.push(item);
      }
    }
  }

  return result;
}

export default function Home() {
  const allItems = getExploreItems().filter(
    (item) =>
      !item.type.startsWith("ai-transition-model") &&
      item.type !== "table" &&
      item.type !== "diagram"
  );
  const pages = getAllPages();

  // Stats
  const totalPages = pages.length;

  // Top items per topic cluster — 5 items with type diversity
  const topicData = TOPIC_SECTIONS.map((topic) => {
    const clusterItems = allItems.filter((item) => item.clusters.includes(topic.cluster));
    return { ...topic, items: pickDiverse(clusterItems, 5) };
  });

  // Recently updated pages — quality >= 40, sorted by lastUpdated descending
  const recentlyUpdated = allItems
    .filter((item) => item.lastUpdated && (item.quality ?? 0) >= 40)
    .sort((a, b) => new Date(b.lastUpdated!).getTime() - new Date(a.lastUpdated!).getTime())
    .slice(0, 8);

  // Entity type counts for the stats
  const riskCount = allItems.filter((i) => i.type === "risk" || i.type === "risk-factor").length;
  const approachCount = allItems.filter(
    (i) => i.type === "approach" || i.type === "safety-agenda" || i.type === "policy"
  ).length;
  const orgCount = allItems.filter((i) => i.type === "organization").length;

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-b from-slate-50 to-background dark:from-slate-950 dark:to-background" />
        <div className="relative max-w-7xl mx-auto px-6 pt-14 sm:pt-16 pb-10">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            AI Safety Knowledge Base
          </h1>
          <p className="text-lg text-muted-foreground max-w-2xl mb-8 leading-relaxed">
            A structured reference covering risks, technical approaches, governance,
            organizations, and key people shaping the future of AI safety.
          </p>
          <div className="flex flex-wrap gap-3 mb-10">
            <Link
              href="/wiki"
              className="inline-flex items-center px-5 py-2.5 bg-foreground text-background rounded-lg text-sm font-medium no-underline hover:opacity-90 transition-opacity group"
            >
              Browse all {totalPages} pages
              <span className="ml-1.5 inline-block transition-transform group-hover:translate-x-0.5">
                &rarr;
              </span>
            </Link>
            <Link
              href="/wiki?entity=risks"
              className="inline-flex items-center px-5 py-2.5 border border-border rounded-lg text-sm font-medium no-underline hover:bg-muted transition-colors bg-background/80"
            >
              View risks
            </Link>
          </div>

          {/* Stats strip */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-px rounded-lg overflow-hidden border border-border bg-border">
            <StatCard value={totalPages} label="Wiki pages" icon={BookOpen} color="text-slate-500 dark:text-slate-400" />
            <StatCard value={riskCount} label="Risks documented" icon={Bug} color="text-amber-600 dark:text-amber-400" />
            <StatCard value={approachCount} label="Approaches & policies" icon={Shield} color="text-emerald-600 dark:text-emerald-400" />
            <StatCard value={orgCount} label="Organizations" icon={Building2} color="text-slate-600 dark:text-slate-400" />
          </div>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-6">
        {/* Topic sections */}
        <section className="py-10">
          <div className="flex items-center gap-4 mb-6">
            <h2 className="text-2xl font-semibold">Explore by topic</h2>
            <div className="flex-1 h-px bg-border" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-6">
            {topicData.map((topic) => {
              const TopicIcon = topic.icon;
              return (
                <div key={topic.cluster}>
                  <div className="flex items-center gap-2 mb-2">
                    <TopicIcon className={`w-4 h-4 ${topic.accentColor}`} />
                    <h3 className="text-sm font-semibold">{topic.label}</h3>
                  </div>
                  <div className="space-y-0">
                    {topic.items.map((item) => (
                      <Link
                        key={item.id}
                        href={item.href || `/wiki/${item.numericId}`}
                        className="flex items-center justify-between py-2 border-b border-border/50 last:border-b-0 no-underline group"
                      >
                        <span className="text-sm text-foreground group-hover:text-accent-foreground">
                          {item.title}
                        </span>
                        <span className={`text-[0.6rem] font-medium px-1.5 py-0.5 rounded ml-2 flex-shrink-0 ${getTypeColor(item.type)}`}>
                          {getTypeLabel(item.type)}
                        </span>
                      </Link>
                    ))}
                  </div>
                  <Link
                    href={`/wiki?tag=${topic.label.toLowerCase()}`}
                    className="inline-block mt-2 text-xs text-muted-foreground hover:text-foreground no-underline transition-colors"
                  >
                    View all &rarr;
                  </Link>
                </div>
              );
            })}
          </div>
        </section>

        {/* Recently updated */}
        <section className="pb-12">
          <div className="flex items-center gap-4 mb-6">
            <h2 className="text-2xl font-semibold">Recently updated</h2>
            <div className="flex-1 h-px bg-border" />
            <Link
              href="/wiki"
              className="text-sm text-muted-foreground hover:text-foreground no-underline transition-colors flex-shrink-0"
            >
              View all &rarr;
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {recentlyUpdated.map((item) => (
              <ContentCard key={item.id} item={item} />
            ))}
          </div>
        </section>

        {/* Footer */}
        <section className="pb-16">
          <div className="border-t border-border pt-8 text-center">
            <p className="text-sm text-muted-foreground">
              {totalPages} pages &middot; Continuously updated
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

function StatCard({
  value,
  label,
  icon: Icon,
  color,
}: {
  value: number;
  label: string;
  icon: LucideIcon;
  color: string;
}) {
  return (
    <div className="bg-card p-4">
      <div className="flex items-center gap-2">
        <Icon className={`w-4 h-4 ${color}`} />
        <div className="text-2xl font-bold text-foreground tabular-nums">{value}</div>
      </div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
