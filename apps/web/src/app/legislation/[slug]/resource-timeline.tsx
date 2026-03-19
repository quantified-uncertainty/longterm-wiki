"use client";

// ── Types ───────────────────────────────────────────────────────────────

export interface TimelineEvent {
  label: string;
  date: string; // display string like "May 21, 2024" or "2024-05"
  sortDate: string; // ISO-ish for sorting, e.g., "2024-05-21"
  type: "event";
}

export interface TimelineResource {
  id: string;
  title: string;
  url: string;
  domain: string | null;
  publishedDate: string; // ISO date
  type: "resource";
  resourceType: string; // "web", "paper", "government", etc.
  category: "official" | "analysis" | "press";
}

export type TimelineItem = TimelineEvent | TimelineResource;

interface ResourceTimelineProps {
  events: TimelineEvent[];
  resources: TimelineResource[];
}

// ── Date helpers ────────────────────────────────────────────────────────

const MONTH_NAMES: Record<string, string> = {
  "01": "Jan",
  "02": "Feb",
  "03": "Mar",
  "04": "Apr",
  "05": "May",
  "06": "Jun",
  "07": "Jul",
  "08": "Aug",
  "09": "Sep",
  "10": "Oct",
  "11": "Nov",
  "12": "Dec",
};

/** Format an ISO date string (YYYY-MM-DD or YYYY-MM) to a short display string. */
function formatShortDate(iso: string): string {
  const parts = iso.split("-");
  if (parts.length >= 3) {
    const month = MONTH_NAMES[parts[1]] ?? parts[1];
    const day = parseInt(parts[2], 10);
    return `${month} ${day}`;
  }
  if (parts.length === 2) {
    const month = MONTH_NAMES[parts[1]] ?? parts[1];
    return `${month} ${parts[0]}`;
  }
  return iso;
}

/**
 * Parse a display date string into a sortable ISO-ish string.
 * Handles formats like:
 *   "May 21, 2024" -> "2024-05-21"
 *   "2024-05"      -> "2024-05-01"
 *   "2024-05-21"   -> "2024-05-21"
 *   "May 2024"     -> "2024-05-01"
 */
const MONTH_TO_NUM: Record<string, string> = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
  jan: "01", feb: "02", mar: "03", apr: "04",
  jun: "06", jul: "07", aug: "08",
  sep: "09", oct: "10", nov: "11", dec: "12",
};

export function parseDisplayDateToISO(display: string): string | null {
  if (!display) return null;

  // Already ISO: "2024-05-21" or "2024-05"
  const isoFull = display.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoFull) return display;
  const isoPartial = display.match(/^(\d{4})-(\d{2})$/);
  if (isoPartial) return `${display}-01`;

  // "May 21, 2024" or "May 21 2024"
  const mdyMatch = display.match(
    /^([A-Za-z]+)\s+(\d{1,2}),?\s+(\d{4})$/
  );
  if (mdyMatch) {
    const month = MONTH_TO_NUM[mdyMatch[1].toLowerCase()];
    if (month) {
      const day = mdyMatch[2].padStart(2, "0");
      return `${mdyMatch[3]}-${month}-${day}`;
    }
  }

  // "May 2024"
  const myMatch = display.match(/^([A-Za-z]+)\s+(\d{4})$/);
  if (myMatch) {
    const month = MONTH_TO_NUM[myMatch[1].toLowerCase()];
    if (month) return `${myMatch[2]}-${month}-01`;
  }

  return null;
}

// ── Event dot color ─────────────────────────────────────────────────────

function getEventDotColor(label: string): string {
  if (label === "Introduced") return "bg-blue-500";
  if (label === "Signed" || label === "Enacted" || label === "Effective" || label === "In Force")
    return "bg-green-500";
  if (label === "Vetoed") return "bg-red-500";
  return "bg-violet-500";
}

function getEventTextColor(label: string): string {
  if (label === "Introduced") return "text-blue-700 dark:text-blue-400";
  if (label === "Signed" || label === "Enacted" || label === "Effective" || label === "In Force")
    return "text-green-700 dark:text-green-400";
  if (label === "Vetoed") return "text-red-700 dark:text-red-400";
  return "text-violet-700 dark:text-violet-400";
}

// ── Category badge colors ───────────────────────────────────────────────

function getCategoryBadge(category: "official" | "analysis" | "press"): {
  label: string;
  className: string;
} {
  switch (category) {
    case "official":
      return {
        label: "Official",
        className:
          "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
      };
    case "analysis":
      return {
        label: "Analysis",
        className:
          "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
      };
    case "press":
      return {
        label: "Press",
        className:
          "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
      };
  }
}

// ── Grouping logic ──────────────────────────────────────────────────────

interface EventGroup {
  event: TimelineEvent;
  resources: TimelineResource[];
}

interface OrphanGroup {
  resources: TimelineResource[];
}

interface UndatedGroup {
  resources: TimelineResource[];
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

function buildGroups(
  events: TimelineEvent[],
  resources: TimelineResource[]
): { eventGroups: EventGroup[]; orphans: OrphanGroup; undated: UndatedGroup } {
  // Sort events newest-first
  const sortedEvents = [...events].sort(
    (a, b) => b.sortDate.localeCompare(a.sortDate)
  );

  // Separate dated and undated resources
  const datedResources = resources
    .filter((r) => r.publishedDate)
    .sort((a, b) => b.publishedDate.localeCompare(a.publishedDate));
  const undatedResources = resources.filter((r) => !r.publishedDate);

  // Assign each dated resource to the nearest preceding event (within 30 days after)
  const claimed = new Set<string>();
  const eventGroups: EventGroup[] = sortedEvents.map((event) => {
    const eventTime = new Date(event.sortDate).getTime();
    const attached = datedResources.filter((r) => {
      if (claimed.has(r.id)) return false;
      const rTime = new Date(r.publishedDate).getTime();
      const diff = rTime - eventTime;
      // Resource published 0-30 days after event
      return diff >= 0 && diff <= THIRTY_DAYS_MS;
    });
    for (const r of attached) claimed.add(r.id);
    return { event, resources: attached };
  });

  // Remaining dated resources not attached to any event
  const orphanResources = datedResources.filter((r) => !claimed.has(r.id));

  return {
    eventGroups,
    orphans: { resources: orphanResources },
    undated: { resources: undatedResources },
  };
}

// ── Subcomponents ───────────────────────────────────────────────────────

function ResourceRow({ resource }: { resource: TimelineResource }) {
  const badge = getCategoryBadge(resource.category);
  const shortDate = formatShortDate(resource.publishedDate);

  return (
    <div className="flex items-start gap-2 py-1 group">
      <div className="relative flex items-center justify-center mt-1.5 shrink-0 w-4">
        <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30 group-hover:bg-muted-foreground/50 transition-colors" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline truncate max-w-[24rem]"
            title={resource.title}
          >
            {resource.title}
          </a>
          <span
            className={`inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold uppercase tracking-wide ${badge.className}`}
          >
            {badge.label}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground/70 mt-0.5">
          {resource.domain && <span>{resource.domain}</span>}
          <span>{shortDate}</span>
        </div>
      </div>
    </div>
  );
}

function EventEntry({
  group,
}: {
  group: EventGroup;
}) {
  const { event, resources } = group;
  const dotColor = getEventDotColor(event.label);
  const textColor = getEventTextColor(event.label);

  return (
    <div className="relative">
      {/* Event dot on the timeline line */}
      <div
        className={`absolute -left-[25px] top-1 w-3 h-3 rounded-full border-2 border-background ${dotColor}`}
      />
      <div className="flex items-baseline justify-between gap-3">
        <span className={`font-bold text-sm ${textColor}`}>
          {event.label}
        </span>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {event.date}
        </span>
      </div>
      {resources.length > 0 && (
        <div className="mt-1 ml-1 border-l border-border/40 pl-2 space-y-0.5">
          {resources.map((r) => (
            <ResourceRow key={r.id} resource={r} />
          ))}
        </div>
      )}
    </div>
  );
}

function OrphanResourceEntry({ resource }: { resource: TimelineResource }) {
  const badge = getCategoryBadge(resource.category);
  const shortDate = formatShortDate(resource.publishedDate);

  return (
    <div className="relative flex items-start gap-2 py-1 group">
      <div
        className="absolute -left-[23px] top-2 w-2 h-2 rounded-full bg-muted-foreground/20 group-hover:bg-muted-foreground/40 transition-colors"
      />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <a
            href={resource.url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline truncate max-w-[24rem]"
            title={resource.title}
          >
            {resource.title}
          </a>
          <span
            className={`inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold uppercase tracking-wide ${badge.className}`}
          >
            {badge.label}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground/70 mt-0.5">
          {resource.domain && <span>{resource.domain}</span>}
          <span>{shortDate}</span>
        </div>
      </div>
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

export function ResourceTimeline({ events, resources }: ResourceTimelineProps) {
  if (events.length === 0 && resources.length === 0) return null;

  const { eventGroups, orphans, undated } = buildGroups(events, resources);

  // Interleave event groups and orphan resources by date for a unified timeline
  type Section =
    | { kind: "event-group"; group: EventGroup; sortDate: string }
    | { kind: "orphan"; resource: TimelineResource; sortDate: string };

  const sections: Section[] = [];
  for (const group of eventGroups) {
    sections.push({
      kind: "event-group",
      group,
      sortDate: group.event.sortDate,
    });
  }
  for (const r of orphans.resources) {
    sections.push({ kind: "orphan", resource: r, sortDate: r.publishedDate });
  }
  sections.sort((a, b) => b.sortDate.localeCompare(a.sortDate));

  const datedCount = resources.filter((r) => r.publishedDate).length;
  const totalCount = resources.length;

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-bold">Coverage Timeline</h2>
        <span className="text-xs text-muted-foreground">
          {totalCount} resource{totalCount !== 1 ? "s" : ""}
          {datedCount < totalCount && ` (${totalCount - datedCount} undated)`}
        </span>
      </div>

      <div className="relative pl-6 border-l-2 border-border space-y-4">
        {sections.map((section, i) => {
          if (section.kind === "event-group") {
            return (
              <EventEntry
                key={`event-${section.group.event.label}-${i}`}
                group={section.group}
              />
            );
          }
          return (
            <OrphanResourceEntry
              key={`orphan-${section.resource.id}`}
              resource={section.resource}
            />
          );
        })}
      </div>

      {/* Undated resources */}
      {undated.resources.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-muted-foreground/70 uppercase tracking-wider mb-2">
            Undated
          </h3>
          <div className="space-y-1.5 pl-2">
            {undated.resources.map((r) => {
              const badge = getCategoryBadge(r.category);
              return (
                <div
                  key={r.id}
                  className="flex items-baseline gap-2 py-0.5 group"
                >
                  <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/20 shrink-0 mt-1.5" />
                  <a
                    href={r.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline truncate max-w-[24rem]"
                    title={r.title}
                  >
                    {r.title}
                  </a>
                  <span
                    className={`inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold uppercase tracking-wide ${badge.className}`}
                  >
                    {badge.label}
                  </span>
                  {r.domain && (
                    <span className="text-xs text-muted-foreground/70">
                      {r.domain}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
