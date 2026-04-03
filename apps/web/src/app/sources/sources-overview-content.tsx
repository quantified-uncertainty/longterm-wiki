import Link from "next/link";
import { getAllPublications, getAllResources, getPagesForResource } from "@/data";

export function SourcesOverviewContent() {
  const publications = getAllPublications();
  const resources = getAllResources();

  const peerReviewed = publications.filter((p) => p.peer_reviewed).length;
  const withSummary = resources.filter((r) => r.summary).length;
  const citedResources = resources.filter(
    (r) => getPagesForResource(r.id).length > 0,
  ).length;

  const stats = [
    { label: "Resources", value: resources.length, href: "/resources" },
    { label: "Publications", value: publications.length, href: "/publications" },
    { label: "Peer-Reviewed Venues", value: peerReviewed },
    { label: "With Summaries", value: withSummary },
    { label: "Cited by Pages", value: citedResources },
  ];

  return (
    <div>
      <p className="text-sm text-muted-foreground mb-6 max-w-prose">
        Sources tracks the external resources (papers, articles, reports) and
        publication venues cited across the wiki. Resources are loaded from a
        local snapshot (database.json) — no runtime API calls. Publications
        define venue-level credibility ratings.
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
          className="group block rounded-lg border border-border bg-card p-5 no-underline hover:border-primary/50 transition-colors"
        >
          <h3 className="text-base font-semibold mb-1 group-hover:text-primary transition-colors">
            Resources
          </h3>
          <p className="text-sm text-muted-foreground">
            {resources.length.toLocaleString()} external documents (papers,
            articles, reports) indexed from citations across wiki pages.
            Includes metadata, summaries, and credibility ratings.
          </p>
          <span className="text-xs font-medium text-primary mt-2 inline-block">
            Browse &rarr;
          </span>
        </Link>

        <Link
          href="/publications"
          className="group block rounded-lg border border-border bg-card p-5 no-underline hover:border-primary/50 transition-colors"
        >
          <h3 className="text-base font-semibold mb-1 group-hover:text-primary transition-colors">
            Publications
          </h3>
          <p className="text-sm text-muted-foreground">
            {publications.length} publication venues with credibility ratings
            (1&ndash;5 scale). Maps domains to venues for automatic resource
            credibility assignment.
          </p>
          <span className="text-xs font-medium text-primary mt-2 inline-block">
            Browse &rarr;
          </span>
        </Link>

        <Link
          href="/source-checks"
          className="group block rounded-lg border border-border bg-card p-5 no-underline hover:border-primary/50 transition-colors"
        >
          <h3 className="text-base font-semibold mb-1 group-hover:text-primary transition-colors">
            Source Checks
          </h3>
          <p className="text-sm text-muted-foreground">
            Automated verification of FactBase claims against their cited
            sources. Shows verdicts (supported, contradicted, unverifiable) and
            coverage across entities.
          </p>
          <span className="text-xs font-medium text-primary mt-2 inline-block">
            View &rarr;
          </span>
        </Link>

        <Link
          href="/data-sources"
          className="group block rounded-lg border border-border bg-card p-5 no-underline hover:border-primary/50 transition-colors"
        >
          <h3 className="text-base font-semibold mb-1 group-hover:text-primary transition-colors">
            Data Sources
          </h3>
          <p className="text-sm text-muted-foreground">
            Overview of the structured data powering the wiki &mdash; entities,
            resources, publications, and FactBase coverage by entity type.
          </p>
          <span className="text-xs font-medium text-primary mt-2 inline-block">
            View &rarr;
          </span>
        </Link>
      </div>
    </div>
  );
}
