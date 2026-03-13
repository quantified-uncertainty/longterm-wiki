import Link from "next/link";
import { getAllPublications, getAllResources } from "@/data";

export function SourcesOverviewContent() {
  const publications = getAllPublications();
  const resources = getAllResources();

  const peerReviewed = publications.filter((p) => p.peer_reviewed).length;
  const withSummary = resources.filter((r) => r.summary).length;
  const citedResources = resources.filter(
    (r) => r.cited_by && r.cited_by.length > 0,
  ).length;

  const stats = [
    { label: "Resources", value: resources.length, href: "/resources" },
    { label: "Publications", value: publications.length, href: "/wiki/E1044" },
    { label: "Peer-Reviewed Venues", value: peerReviewed },
    { label: "With Summaries", value: withSummary },
    { label: "Cited by Pages", value: citedResources },
  ];

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-6 max-w-prose">
        Sources tracks the external resources (papers, articles, reports) and
        publication venues cited across the wiki. Resources are indexed from
        PostgreSQL; publications define venue-level credibility ratings.
      </p>

      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4"
          >
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
              {stat.label}
            </div>
            <div className="text-2xl font-bold tabular-nums tracking-tight">
              {"href" in stat && stat.href ? (
                <Link
                  href={stat.href}
                  className="text-foreground hover:text-primary transition-colors no-underline"
                >
                  {stat.value.toLocaleString()}
                </Link>
              ) : (
                stat.value.toLocaleString()
              )}
            </div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Link
          href="/resources"
          className="group block rounded-xl border border-border/60 bg-card p-6 no-underline transition-all hover:shadow-md hover:border-border"
        >
          <h3 className="text-lg font-bold mb-2 group-hover:text-primary transition-colors">
            Resources
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {resources.length.toLocaleString()} external documents (papers,
            articles, reports) indexed from citations across wiki pages.
            Includes metadata, summaries, and credibility ratings.
          </p>
        </Link>

        <Link
          href="/wiki/E1044"
          className="group block rounded-xl border border-border/60 bg-card p-6 no-underline transition-all hover:shadow-md hover:border-border"
        >
          <h3 className="text-lg font-bold mb-2 group-hover:text-primary transition-colors">
            Publications
          </h3>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {publications.length} publication venues with credibility ratings
            (1-5 scale). Maps domains to venues for automatic resource
            credibility assignment.
          </p>
        </Link>
      </div>
    </div>
  );
}
