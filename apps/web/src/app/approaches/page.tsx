import type { Metadata } from "next";
import Link from "next/link";
import { getTypedEntities, isApproach } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { getWikiHref } from "@/data/entity-nav";

export const metadata: Metadata = {
  title: "Approaches",
  description:
    "Directory of AI safety approaches, techniques, and strategies tracked in the knowledge base.",
};

export default function ApproachesPage() {
  const approaches = getTypedEntities().filter(isApproach);

  const uniqueTagCount = new Set(approaches.flatMap((a) => a.tags ?? [])).size;

  const stats = [
    { label: "Approaches", value: String(approaches.length) },
    {
      label: "With Description",
      value: String(approaches.filter((a) => a.description).length),
    },
    { label: "Unique Tags", value: String(uniqueTagCount) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Approaches
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          AI safety approaches, techniques, and strategies -- from alignment
          methods and evaluation frameworks to governance mechanisms and
          deployment safeguards.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {approaches
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((approach) => {
            const wikiHref = getWikiHref(approach.id);
            return (
              <div
                key={approach.id}
                className="rounded-xl border border-border/60 bg-card p-4 hover:bg-muted/20 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <Link
                    href={`/approaches/${approach.id}`}
                    className="font-semibold text-sm hover:text-primary transition-colors line-clamp-1"
                  >
                    {approach.title}
                  </Link>
                </div>
                {approach.description && (
                  <p className="text-xs text-muted-foreground line-clamp-3 mb-3">
                    {approach.description}
                  </p>
                )}
                <div className="flex items-center gap-3 text-xs">
                  {approach.tags.length > 0 && (
                    <span className="text-muted-foreground">
                      {approach.tags.slice(0, 3).join(", ")}
                      {approach.tags.length > 3 && " ..."}
                    </span>
                  )}
                  {wikiHref && (
                    <Link
                      href={wikiHref}
                      className="text-primary hover:underline ml-auto"
                    >
                      Wiki &rarr;
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
