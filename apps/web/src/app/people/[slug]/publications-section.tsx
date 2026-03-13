import type { PersonPublicationEntry } from "@/data/database";
import { safeHref } from "@/lib/directory-utils";

export function PublicationsSection({
  publications,
}: {
  publications: PersonPublicationEntry[];
}) {
  if (publications.length === 0) return null;

  const sorted = [...publications].sort(
    (a, b) => (b.year ?? 0) - (a.year ?? 0),
  );

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-4">
        Publications & Resources
        <span className="ml-2 text-sm font-normal text-muted-foreground">
          {publications.length}
        </span>
      </h2>
      <div className="border border-border/60 rounded-xl bg-card divide-y divide-border/40">
        {sorted.map((pub, idx) => (
          <div key={`${idx}-${pub.title}`} className="px-4 py-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                {pub.link ? (
                  <a
                    href={safeHref(pub.link)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-sm text-foreground hover:text-primary transition-colors"
                  >
                    {pub.title}
                  </a>
                ) : (
                  <span className="font-medium text-sm">{pub.title}</span>
                )}
                <div className="flex items-center gap-2 mt-0.5">
                  {pub.year && (
                    <span className="text-xs text-muted-foreground tabular-nums">
                      {pub.year}
                    </span>
                  )}
                  {pub.type && (
                    <span className="text-xs text-muted-foreground/60">
                      {pub.type}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground/40">
                    {pub.category}
                  </span>
                </div>
              </div>
              {pub.link && (
                <a
                  href={pub.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="shrink-0 text-xs text-muted-foreground/50 hover:text-primary transition-colors"
                  title="Open link"
                >
                  &rarr;
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
