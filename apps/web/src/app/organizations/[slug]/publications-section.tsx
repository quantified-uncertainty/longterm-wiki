/**
 * Key Publications section for organization profile pages.
 * Shows papers from literature.yaml that are attributed to this org.
 */
import Link from "next/link";
import type { LiteraturePaper } from "@/data";
import { SectionHeader, Badge, safeHref } from "./org-shared";
import type { AuthorRef } from "./org-data";

const TYPE_COLORS: Record<string, string> = {
  Paper: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  Book: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  "Technical Report":
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  "Blog Post":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "Policy Document":
    "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  "Open Letter":
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

export function KeyPublicationsSection({
  publications,
  resolvedAuthors,
}: {
  publications: LiteraturePaper[];
  resolvedAuthors?: Map<string, AuthorRef>;
}) {
  if (publications.length === 0) return null;

  return (
    <section>
      <SectionHeader
        title="Key Publications"
        count={publications.length}
      />
      <div className="border border-border/60 rounded-xl bg-card px-4">
        {publications.map((paper, idx) => (
          <div
            key={`${paper.title}-${idx}`}
            className="flex items-start gap-3 py-3 border-b border-border/40 last:border-b-0"
          >
            <div className="min-w-[40px] text-xs text-muted-foreground pt-0.5 tabular-nums">
              {paper.year}
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-baseline gap-2 flex-wrap">
                {paper.link ? (
                  <a
                    href={safeHref(paper.link)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-sm text-primary hover:underline"
                  >
                    {paper.title}
                    <span className="sr-only"> (opens in new tab)</span>
                  </a>
                ) : (
                  <span className="font-medium text-sm">{paper.title}</span>
                )}
                <Badge
                  color={
                    TYPE_COLORS[paper.type] ??
                    "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300"
                  }
                >
                  {paper.type}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {paper.authors.map((name, i) => {
                  const ref = resolvedAuthors?.get(name);
                  return (
                    <span key={i}>
                      {i > 0 && ", "}
                      {ref?.href ? (
                        <Link href={ref.href} className="hover:text-primary hover:underline">
                          {name}
                        </Link>
                      ) : (
                        name
                      )}
                    </span>
                  );
                })}
              </div>
              {paper.summary && (
                <p className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">
                  {paper.summary}
                </p>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
