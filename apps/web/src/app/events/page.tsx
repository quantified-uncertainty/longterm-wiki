import { Suspense } from "react";
import type { Metadata } from "next";
import { getTypedEntities, isEvent } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { EventsTable, type EventRow } from "./events-table";

export const metadata: Metadata = {
  title: "Events",
  description:
    "Directory of notable AI safety events tracked in the knowledge base.",
};

export default function EventsPage() {
  const events = getTypedEntities().filter(isEvent);
  const isSparse = events.length < 5;

  const rows: EventRow[] = events.map((e) => {
    const statusField = e.customFields.find((f) => f.label === "Status");
    return {
      id: e.id,
      title: e.title,
      description: e.description ?? null,
      status: statusField?.value ?? null,
      tags: e.tags ?? [],
      wikiId: e.wikiId ?? null,
    };
  });

  const uniqueTagCount = new Set(rows.flatMap((r) => r.tags)).size;

  const stats = [
    { label: "Events", value: String(rows.length) },
    {
      label: "With Description",
      value: String(rows.filter((r) => r.description).length),
    },
    { label: "Unique Tags", value: String(uniqueTagCount) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">Events</h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          Notable AI safety events, incidents, and milestones.
        </p>
      </div>

      {isSparse && (
        <div className="rounded-lg border border-border/60 bg-muted/30 px-4 py-3 mb-8 text-sm text-muted-foreground">
          This directory is being populated. Currently tracking{" "}
          {events.length} {events.length === 1 ? "event" : "events"}.
        </div>
      )}

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      <Suspense fallback={<div>Loading...</div>}>
        <EventsTable rows={rows} />
      </Suspense>
    </div>
  );
}
