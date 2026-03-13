import Link from "next/link";
import { SectionHeader } from "./org-shared";
import type { OrgResourceRow } from "./org-data";

const TYPE_COLORS: Record<string, string> = {
  paper: "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300",
  blog: "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300",
  report: "bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300",
  book: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  web: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
  government: "bg-indigo-100 text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300",
  talk: "bg-orange-100 text-orange-700 dark:bg-orange-900/40 dark:text-orange-300",
  podcast: "bg-pink-100 text-pink-700 dark:bg-pink-900/40 dark:text-pink-300",
};

const DEFAULT_COLOR = "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300";

function ResourceCard({ resource }: { resource: OrgResourceRow }) {
  return (
    <div className="flex items-start gap-3 py-3 border-b border-border/40 last:border-0">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 mb-0.5">
          <span className={`text-[10px] px-1.5 py-0.5 rounded font-medium shrink-0 ${TYPE_COLORS[resource.type] ?? DEFAULT_COLOR}`}>
            {resource.type}
          </span>
          {resource.publishedDate && (
            <span className="text-[11px] text-muted-foreground font-mono shrink-0">
              {resource.publishedDate.slice(0, 10)}
            </span>
          )}
        </div>
        <Link
          href={`/resources/${resource.id}`}
          className="text-sm font-medium text-foreground hover:text-primary transition-colors line-clamp-2"
          title={resource.title}
        >
          {resource.title}
        </Link>
        <div className="flex items-center gap-2 mt-0.5">
          {resource.publicationName && (
            <span className="text-xs text-muted-foreground italic">
              {resource.publicationName}
            </span>
          )}
          {resource.authors.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {resource.authors.slice(0, 3).join(", ")}
              {resource.authors.length > 3 && ` +${resource.authors.length - 3}`}
            </span>
          )}
        </div>
      </div>
      <a
        href={resource.url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs text-primary hover:text-primary/80 shrink-0 mt-1"
        title={resource.url}
      >
        &#8599;
      </a>
    </div>
  );
}

export function OrgResourcesSection({
  resources,
  title,
  emptyMessage,
}: {
  resources: OrgResourceRow[];
  title: string;
  emptyMessage: string;
}) {
  if (resources.length === 0) {
    return (
      <section>
        <SectionHeader title={title} count={0} />
        <p className="text-sm text-muted-foreground py-4">{emptyMessage}</p>
      </section>
    );
  }

  // Group by type for a summary row
  const typeCounts = new Map<string, number>();
  for (const r of resources) {
    typeCounts.set(r.type, (typeCounts.get(r.type) || 0) + 1);
  }
  const typeEntries = [...typeCounts.entries()].sort((a, b) => b[1] - a[1]);

  return (
    <section>
      <SectionHeader title={title} count={resources.length} />

      {/* Type summary chips */}
      {typeEntries.length > 1 && (
        <div className="flex flex-wrap gap-1.5 mb-4">
          {typeEntries.map(([type, count]) => (
            <span
              key={type}
              className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${TYPE_COLORS[type] ?? DEFAULT_COLOR}`}
            >
              {count} {type}{count !== 1 ? "s" : ""}
            </span>
          ))}
        </div>
      )}

      {/* Resource list */}
      <div className="rounded-lg border border-border/60 bg-card px-4">
        {resources.map((r) => (
          <ResourceCard key={r.id} resource={r} />
        ))}
      </div>
    </section>
  );
}
