import { safeHref } from "@/lib/directory-utils";

interface EntitySource {
  title: string;
  url?: string;
  author?: string;
  date?: string;
}

/**
 * Renders the entity-level sources array as a "References" section.
 * These come from the entity YAML `sources` field (e.g., EA Forum, Wikipedia, Ballotpedia links).
 */
export function EntitySources({ sources }: { sources: EntitySource[] }) {
  if (sources.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-bold tracking-tight mb-3">References</h2>
      <ul className="space-y-2">
        {sources.map((source, i) => (
          <li key={`${source.title}-${i}`} className="flex items-start gap-2">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              className="w-4 h-4 mt-0.5 shrink-0 text-muted-foreground/60"
              aria-hidden="true"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M13.19 8.688a4.5 4.5 0 011.242 7.244l-4.5 4.5a4.5 4.5 0 01-6.364-6.364l1.757-1.757m9.924-1.024a4.5 4.5 0 00-1.242-7.244l-4.5-4.5a4.5 4.5 0 00-6.364 6.364L4.34 8.364"
              />
            </svg>
            <div className="text-sm leading-snug">
              {source.url ? (
                <a
                  href={safeHref(source.url)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-primary hover:underline font-medium"
                >
                  {source.title}
                </a>
              ) : (
                <span className="font-medium">{source.title}</span>
              )}
              {source.author && (
                <span className="text-muted-foreground ml-1">
                  — {source.author}
                </span>
              )}
              {source.date && (
                <span className="text-muted-foreground/60 ml-1">
                  ({source.date})
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
