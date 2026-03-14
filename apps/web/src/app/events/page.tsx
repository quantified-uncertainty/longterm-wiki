import type { Metadata } from "next";
import Link from "next/link";
import { getTypedEntities } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { getWikiHref } from "@/data/entity-nav";

export const metadata: Metadata = {
  title: "Events",
  description:
    "Timeline of key events and milestones in AI safety, governance, and frontier AI development.",
};

const TYPE_COLORS: Record<string, string> = {
  summit: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  incident: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  announcement: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  publication: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  policy: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  milestone: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

const SIGNIFICANCE_COLORS: Record<string, string> = {
  critical: "text-red-600 dark:text-red-400",
  high: "text-amber-600 dark:text-amber-400",
  medium: "text-blue-600 dark:text-blue-400",
  low: "text-muted-foreground",
};

export default function EventsPage() {
  const allEntities = getTypedEntities();
  // Include both event and historical entity types
  const events = allEntities.filter(
    (e) => e.entityType === "event" || e.entityType === "historical",
  );

  // Sort by date (most recent first), undated at end
  const sorted = [...events].sort((a, b) => {
    const dateA = (a as Record<string, unknown>).eventDate as string | undefined;
    const dateB = (b as Record<string, unknown>).eventDate as string | undefined;
    if (!dateA && !dateB) return a.title.localeCompare(b.title);
    if (!dateA) return 1;
    if (!dateB) return -1;
    return dateB.localeCompare(dateA);
  });

  const stats = [
    { label: "Events", value: String(events.length) },
    { label: "With Date", value: String(events.filter((e) => (e as Record<string, unknown>).eventDate).length) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">Events</h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Key events, milestones, and historical moments in AI safety and
          frontier AI development.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-8 max-w-xs">
        {stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      {/* Timeline */}
      <div className="relative pl-8 border-l-2 border-border space-y-6 max-w-3xl">
        {sorted.map((event) => {
          const eventDate = (event as Record<string, unknown>).eventDate as string | undefined;
          const eventType = (event as Record<string, unknown>).eventType as string | undefined;
          const location = (event as Record<string, unknown>).location as string | undefined;
          const significance = (event as Record<string, unknown>).significance as string | undefined;
          const wikiHref = event.numericId ? getWikiHref(event.id) : null;

          return (
            <div key={event.id} className="relative">
              <div className={`absolute -left-[33px] w-4 h-4 rounded-full border-2 border-background ${
                significance === "critical" ? "bg-red-500"
                  : significance === "high" ? "bg-amber-500"
                  : significance === "medium" ? "bg-blue-500"
                  : "bg-muted-foreground/50"
              }`} />
              <div className="rounded-xl border border-border/60 bg-card p-4 hover:bg-muted/20 transition-colors">
                <div className="flex items-start justify-between gap-2 mb-1">
                  <Link
                    href={`/events/${event.id}`}
                    className="font-semibold text-sm hover:text-primary transition-colors"
                  >
                    {event.title}
                  </Link>
                  <div className="flex items-center gap-2 shrink-0">
                    {eventType && (
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${TYPE_COLORS[eventType] ?? "bg-gray-100 text-gray-600"}`}>
                        {eventType}
                      </span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-3 text-xs text-muted-foreground mb-2">
                  {eventDate && <span className="font-medium">{eventDate}</span>}
                  {location && <span>{location}</span>}
                  {significance && (
                    <span className={`font-semibold uppercase tracking-wider ${SIGNIFICANCE_COLORS[significance] ?? ""}`}>
                      {significance}
                    </span>
                  )}
                </div>
                {event.description && (
                  <p className="text-xs text-muted-foreground line-clamp-3">
                    {event.description}
                  </p>
                )}
                <div className="flex items-center gap-3 mt-2 text-xs">
                  {wikiHref && (
                    <Link href={wikiHref} className="text-primary hover:underline">
                      Read more &rarr;
                    </Link>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {events.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          No events tracked yet.
        </div>
      )}
    </div>
  );
}
