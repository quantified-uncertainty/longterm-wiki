/**
 * EntityTimeline — Renders a timeline of events for a FactBase entity.
 *
 * Reads entity_events from factbase-data.json (merged in from the PG
 * `entity_events` table at build time — see apps/web/scripts/lib/wiki-server-data.mjs).
 *
 * Usage in MDX:
 *   <EntityTimeline entity="manifund" />
 *   <EntityTimeline entity="80000-hours" sort="asc" showSignificance />
 *   <EntityTimeline entity="redwood-research" eventType="funding" />
 *
 * Usage in a React tree (e.g. EntityProfileShell):
 *   <EntityTimeline events={events} />
 */

import { getEntityEvents, type EntityEvent } from "@data/factbase";
import { formatKBDate, isUrl, shortDomain, titleCase } from "./factbase/format";
import { safeHref } from "@/lib/format-compact";

interface EntityTimelineProps {
  /** Slug, stableId, or wikiId of the entity. Ignored when `events` is provided. */
  entity?: string;
  /** Pre-fetched events (escape hatch for server components that already loaded them). */
  events?: EntityEvent[];
  /** Sort order. Default "asc" (oldest first — natural for a timeline). */
  sort?: "asc" | "desc";
  /** Filter to a specific eventType (founding, pivot, funding, etc.). */
  eventType?: string;
  /** Override auto-detection: force-show the Type column. */
  showType?: boolean;
  /** Opt in to the Significance column (hidden by default). */
  showSignificance?: boolean;
  /** Override auto-detection: force-show the Source column. */
  showSource?: boolean;
  /** Override auto-detection: force-show the Description column. */
  showDescription?: boolean;
  /** Cap the number of rows rendered. Undefined = show all. */
  maxItems?: number;
  /** Optional section heading. Renders nothing if omitted. */
  title?: string;
}

const SIGNIFICANCE_COLORS: Record<string, string> = {
  major:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  moderate:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  minor:
    "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

const EVENT_TYPE_COLORS: Record<string, string> = {
  founding:
    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
  acquisition:
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  pivot:
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  launch:
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  publication:
    "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  policy:
    "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  milestone:
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  "leadership-change":
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  incident:
    "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  funding:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  dissolution:
    "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  other: "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300",
};

/**
 * Compare two events by date, treating missing dates as "most recent"
 * (so they land at the bottom of an ascending sort and at the top of a
 * descending one — consistent with how date-less records are handled
 * elsewhere in the wiki).
 *
 * Dates are compared lexicographically, which is safe for the YYYY,
 * YYYY-MM, and YYYY-MM-DD formats the entity_events schema permits.
 */
function compareByDate(a: EntityEvent, b: EntityEvent, ascending: boolean): number {
  const ad = a.date;
  const bd = b.date;
  if (!ad && !bd) return 0;
  if (!ad) return 1;
  if (!bd) return -1;
  if (ad === bd) return 0;
  return ascending ? ad.localeCompare(bd) : bd.localeCompare(ad);
}

export function EntityTimeline({
  entity,
  events: providedEvents,
  sort = "asc",
  eventType,
  showType,
  showSignificance = false,
  showSource,
  showDescription,
  maxItems,
  title,
}: EntityTimelineProps) {
  const rawEvents =
    providedEvents ?? (entity ? getEntityEvents(entity) : []);

  const filtered = eventType
    ? rawEvents.filter((e) => e.eventType === eventType)
    : rawEvents;

  if (filtered.length === 0) return null;

  const sorted = [...filtered].sort((a, b) =>
    compareByDate(a, b, sort === "asc"),
  );

  // Column auto-detection runs against the full sorted set, not the
  // post-maxItems slice, so capping visible rows never hides a column
  // whose data lives in the tail.
  const autoHasType = sorted.some((e) => e.eventType);
  const autoHasDescription = sorted.some((e) => e.description);
  const autoHasSource = sorted.some((e) => e.source && isUrl(e.source));
  const autoHasSignificance = sorted.some((e) => e.significance);

  const rows = typeof maxItems === "number" ? sorted.slice(0, maxItems) : sorted;

  const renderType = showType ?? autoHasType;
  const renderDescription = showDescription ?? autoHasDescription;
  const renderSource = showSource ?? autoHasSource;
  const renderSignificance = showSignificance && autoHasSignificance;

  return (
    <section className="entity-timeline">
      {title && (
        <h3 className="text-base font-bold tracking-tight mb-3">{title}</h3>
      )}
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium whitespace-nowrap">
                Date
              </th>
              <th scope="col" className="py-2 px-3 text-left font-medium">
                Event
              </th>
              {renderType && (
                <th scope="col" className="py-2 px-3 text-left font-medium">
                  Type
                </th>
              )}
              {renderSignificance && (
                <th scope="col" className="py-2 px-3 text-left font-medium">
                  Significance
                </th>
              )}
              {renderDescription && (
                <th scope="col" className="py-2 px-3 text-left font-medium">
                  Description
                </th>
              )}
              {renderSource && (
                <th scope="col" className="py-2 px-3 text-left font-medium">
                  Source
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {rows.map((ev) => (
              <tr key={ev.id} className="hover:bg-muted/20 transition-colors align-top">
                <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap">
                  {ev.date ? formatKBDate(ev.date) : (
                    <span className="text-muted-foreground/40">{"\u2014"}</span>
                  )}
                </td>
                <td className="py-1.5 px-3 font-medium">{ev.title}</td>
                {renderType && (
                  <td className="py-1.5 px-3">
                    {ev.eventType && (
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded-full text-[11px] font-semibold ${
                          EVENT_TYPE_COLORS[ev.eventType] ??
                          EVENT_TYPE_COLORS.other
                        }`}
                      >
                        {titleCase(ev.eventType)}
                      </span>
                    )}
                  </td>
                )}
                {renderSignificance && (
                  <td className="py-1.5 px-3">
                    {ev.significance && (
                      <span
                        className={`inline-block px-1.5 py-0.5 rounded-full text-[11px] font-semibold ${
                          SIGNIFICANCE_COLORS[ev.significance] ??
                          SIGNIFICANCE_COLORS.minor
                        }`}
                      >
                        {titleCase(ev.significance)}
                      </span>
                    )}
                  </td>
                )}
                {renderDescription && (
                  <td className="py-1.5 px-3 text-muted-foreground text-xs">
                    {ev.description ?? (
                      <span className="text-muted-foreground/40">{"\u2014"}</span>
                    )}
                  </td>
                )}
                {renderSource && (
                  <td className="py-1.5 px-3">
                    {ev.source && isUrl(ev.source) ? (
                      <a
                        href={safeHref(ev.source)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[11px] text-primary/70 hover:text-primary hover:underline transition-colors"
                      >
                        {shortDomain(ev.source)}
                        <span className="sr-only"> (opens in new tab)</span>
                      </a>
                    ) : null}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
