import type { Metadata } from "next";
import Link from "next/link";
import { getTypedEntities, isEvent } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { getWikiHref } from "@/data/entity-nav";

export const metadata: Metadata = {
  title: "Events",
  description:
    "Directory of notable AI safety events tracked in the knowledge base.",
};

export default function EventsPage() {
  const events = getTypedEntities().filter(isEvent);

  const stats = [
    { label: "Events", value: String(events.length) },
    {
      label: "With Description",
      value: String(events.filter((e) => e.description).length),
    },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">Events</h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Notable AI safety events, incidents, and milestones.
        </p>
      </div>

      <div className="grid grid-cols-2 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {events
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((event) => {
            const wikiHref = getWikiHref(event.id);
            // Extract key fields from customFields
            const statusField = event.customFields.find(
              (f) => f.label === "Status",
            );
            const triggerField = event.customFields.find(
              (f) => f.label === "Trigger Event",
            );
            return (
              <div
                key={event.id}
                className="rounded-xl border border-border/60 bg-card p-4 hover:bg-muted/20 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <Link
                    href={`/events/${event.id}`}
                    className="font-semibold text-sm hover:text-primary transition-colors line-clamp-2"
                  >
                    {event.title}
                  </Link>
                  {statusField && (
                    <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300">
                      {statusField.value}
                    </span>
                  )}
                </div>
                {event.description && (
                  <p className="text-xs text-muted-foreground line-clamp-3 mb-3">
                    {event.description}
                  </p>
                )}
                {triggerField && (
                  <p className="text-xs text-muted-foreground mb-2">
                    <span className="font-medium">Trigger:</span>{" "}
                    {triggerField.value}
                  </p>
                )}
                <div className="flex items-center gap-3 text-xs">
                  {event.tags.length > 0 && (
                    <span className="text-muted-foreground">
                      {event.tags.slice(0, 3).join(", ")}
                      {event.tags.length > 3 && " ..."}
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
