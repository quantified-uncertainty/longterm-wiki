import Link from "next/link";
import { getExploreItems, getAllPages } from "@/data";
import { ContentCard } from "@/components/explore/ContentCard";
import type { ExploreItem } from "@/data";

// Field clusters with descriptions for the topic sections
const TOPIC_SECTIONS = [
  {
    label: "AI Safety",
    cluster: "ai-safety",
    description: "Alignment, interpretability, and technical approaches to safe AI systems.",
  },
  {
    label: "Governance",
    cluster: "governance",
    description: "Policy, regulation, and institutional approaches to AI risk management.",
  },
  {
    label: "Biorisks",
    cluster: "biorisks",
    description: "Biological risks from AI capabilities and dual-use research.",
  },
  {
    label: "Epistemics",
    cluster: "epistemics",
    description: "Forecasting, decision-making, and reasoning about AI futures.",
  },
];

function score(item: ExploreItem): number {
  return (item.importance || 0) * 2 + (item.quality || 0);
}

export default function Home() {
  const allItems = getExploreItems().filter(
    (item) =>
      !item.type.startsWith("ai-transition-model") &&
      item.type !== "insight" &&
      item.type !== "table" &&
      item.type !== "diagram"
  );
  const pages = getAllPages();

  // Stats
  const totalPages = pages.length;
  const totalEntities = allItems.length;

  // Top items per topic cluster
  const topicData = TOPIC_SECTIONS.map((topic) => {
    const clusterItems = allItems
      .filter((item) => item.clusters.includes(topic.cluster))
      .sort((a, b) => score(b) - score(a))
      .slice(0, 3);
    return { ...topic, items: clusterItems };
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
    <div className="max-w-7xl mx-auto px-6">
      {/* Hero */}
      <section className="py-16 sm:py-20">
        <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
          AI Safety Knowledge Base
        </h1>
        <p className="text-lg sm:text-xl text-muted-foreground max-w-2xl mb-8 leading-relaxed">
          A structured reference covering risks, technical approaches, governance,
          organizations, and key people shaping the future of AI safety.
        </p>
        <div className="flex flex-wrap gap-3">
          <Link
            href="/wiki"
            className="inline-flex items-center px-5 py-2.5 bg-foreground text-background rounded-lg text-sm font-medium no-underline hover:opacity-90 transition-opacity"
          >
            Browse all {totalEntities} entries
          </Link>
          <Link
            href="/wiki?entity=risks"
            className="inline-flex items-center px-5 py-2.5 border border-border rounded-lg text-sm font-medium no-underline hover:bg-muted transition-colors"
          >
            View risks
          </Link>
        </div>
      </section>

      {/* Stats strip */}
      <section className="grid grid-cols-2 sm:grid-cols-4 gap-4 pb-12">
        <StatCard value={totalPages} label="Wiki pages" />
        <StatCard value={riskCount} label="Risks documented" />
        <StatCard value={approachCount} label="Approaches & policies" />
        <StatCard value={orgCount} label="Organizations" />
      </section>

      {/* Topic sections */}
      <section className="pb-12">
        <h2 className="text-2xl font-semibold mb-6">Explore by topic</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {topicData.map((topic) => (
            <div
              key={topic.cluster}
              className="border border-border rounded-lg p-5 bg-card"
            >
              <div className="mb-4">
                <h3 className="text-lg font-semibold mb-1">{topic.label}</h3>
                <p className="text-sm text-muted-foreground">{topic.description}</p>
              </div>
              <div className="space-y-2">
                {topic.items.map((item) => (
                  <Link
                    key={item.id}
                    href={item.href || `/wiki/${item.numericId}`}
                    className="flex items-center justify-between p-2.5 -mx-1 rounded-md hover:bg-muted transition-colors no-underline group"
                  >
                    <span className="text-sm font-medium text-foreground group-hover:text-accent-foreground">
                      {item.title}
                    </span>
                    <span className="text-xs text-muted-foreground ml-2 flex-shrink-0">
                      {item.type}
                    </span>
                  </Link>
                ))}
              </div>
              <Link
                href={`/wiki?tag=${topic.label.toLowerCase()}`}
                className="inline-block mt-3 text-xs text-muted-foreground hover:text-foreground no-underline transition-colors"
              >
                View all {topic.label.toLowerCase()} &rarr;
              </Link>
            </div>
          ))}
        </div>
      </section>

      {/* Recently updated */}
      <section className="pb-16">
        <div className="flex items-center justify-between mb-6">
          <h2 className="text-2xl font-semibold">Recently updated</h2>
          <Link
            href="/wiki"
            className="text-sm text-muted-foreground hover:text-foreground no-underline transition-colors"
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
    </div>
  );
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="border border-border rounded-lg p-4 bg-card text-center">
      <div className="text-2xl font-bold text-foreground">{value}</div>
      <div className="text-xs text-muted-foreground mt-1">{label}</div>
    </div>
  );
}
