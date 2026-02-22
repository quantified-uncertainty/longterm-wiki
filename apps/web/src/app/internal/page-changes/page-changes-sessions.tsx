"use client";

import { useState, useMemo } from "react";
import Link from "next/link";
import type { PageChangesSession } from "@/data";
import { GITHUB_REPO_URL } from "@lib/site-config";

// ── helpers ──────────────────────────────────────────────────────────────────

function formatRelativeDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  const now = new Date();
  const diffDays = Math.floor(
    (now.getTime() - date.getTime()) / (1000 * 60 * 60 * 24)
  );
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  if (diffDays < 365) return `${Math.floor(diffDays / 30)}mo ago`;
  return `${Math.floor(diffDays / 365)}y ago`;
}

function formatDate(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year:
      date.getFullYear() !== new Date().getFullYear() ? "numeric" : undefined,
  });
}

/** Returns a week-bucket label for a given ISO date string. */
function weekLabel(dateStr: string): string {
  const date = new Date(dateStr + "T12:00:00Z");
  const now = new Date();
  // Start of this week (Monday)
  const startOfThisWeek = new Date(now);
  startOfThisWeek.setUTCDate(now.getUTCDate() - ((now.getUTCDay() + 6) % 7));
  startOfThisWeek.setUTCHours(0, 0, 0, 0);
  const startOfLastWeek = new Date(startOfThisWeek);
  startOfLastWeek.setUTCDate(startOfThisWeek.getUTCDate() - 7);

  if (date >= startOfThisWeek) return "This Week";
  if (date >= startOfLastWeek) return "Last Week";

  // Group by month for older entries
  return date.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

// ── sub-components ────────────────────────────────────────────────────────────

function ModelBadge({ model }: { model: string }) {
  return (
    <span className="inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-300 whitespace-nowrap">
      {model}
    </span>
  );
}

function InsightsList({
  label,
  items,
  color,
}: {
  label: string;
  items: string[];
  color: "amber" | "sky" | "emerald";
}) {
  const colorMap = {
    amber: "text-amber-600 dark:text-amber-400",
    sky: "text-sky-600 dark:text-sky-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
  };
  return (
    <div>
      <span className={`text-[10px] font-semibold uppercase tracking-wide ${colorMap[color]} mr-1`}>
        {label}:
      </span>
      <ul className="mt-0.5 space-y-0.5">
        {items.map((item) => (
          <li key={item} className="text-[11px] text-muted-foreground leading-relaxed flex gap-1">
            <span className="shrink-0 mt-0.5 text-muted-foreground/40">·</span>
            <span>{item}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function SessionRow({ session }: { session: PageChangesSession }) {
  const branchShort = session.branch.replace("claude/", "");
  const maxVisiblePages = 8;
  const visiblePages = session.pages.slice(0, maxVisiblePages);
  const hiddenCount = session.pages.length - maxVisiblePages;

  const hasInsights =
    (session.issues?.length ?? 0) > 0 ||
    (session.learnings?.length ?? 0) > 0 ||
    (session.recommendations?.length ?? 0) > 0;

  return (
    <div className="py-3 flex flex-col gap-1.5">
      {/* Header row */}
      <div className="flex items-start gap-2 flex-wrap">
        {/* Date */}
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground whitespace-nowrap pt-0.5">
          <span className="font-medium text-foreground">
            {formatDate(session.date)}
          </span>
          <span className="ml-1 text-muted-foreground/60">
            ({formatRelativeDate(session.date)})
          </span>
        </span>

        {/* Session title */}
        <span className="text-sm font-medium text-foreground flex-1 min-w-0">
          {session.sessionTitle}
        </span>

        {/* Badges cluster */}
        <div className="flex items-center gap-1.5 shrink-0 flex-wrap">
          {session.model && <ModelBadge model={session.model} />}
          {(session.duration || session.cost) && (
            <span className="text-[10px] text-muted-foreground whitespace-nowrap">
              {[session.duration, session.cost].filter(Boolean).join(" · ")}
            </span>
          )}
          {session.pr && (
            <a
              href={`${GITHUB_REPO_URL}/pull/${session.pr}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-sky-500 hover:text-sky-600 font-medium whitespace-nowrap"
            >
              PR #{session.pr}
            </a>
          )}
        </div>
      </div>

      {/* Summary */}
      {session.summary && (
        <p className="text-[11px] text-muted-foreground leading-relaxed line-clamp-2 pr-4">
          {session.summary}
        </p>
      )}

      {/* Pages */}
      {session.pages.length > 0 && (
        <div className="flex flex-wrap gap-1 items-center">
          {visiblePages.map((page) => (
            <Link
              key={page.pageId}
              href={page.pagePath}
              className="inline-flex items-center rounded px-1.5 py-0.5 text-[10px] bg-muted hover:bg-muted/80 text-foreground no-underline font-medium transition-colors whitespace-nowrap"
            >
              {page.pageTitle}
            </Link>
          ))}
          {hiddenCount > 0 && (
            <span className="text-[10px] text-muted-foreground italic">
              +{hiddenCount} more
            </span>
          )}
        </div>
      )}

      {/* Issues / Learnings / Recommendations — collapsible */}
      {hasInsights && (
        <details className="group">
          <summary className="cursor-pointer list-none flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors w-fit select-none">
            <span className="inline-block transition-transform group-open:rotate-90">▶</span>
            <span>
              {[
                session.issues?.length ? `${session.issues.length} issue${session.issues.length !== 1 ? "s" : ""}` : null,
                session.learnings?.length ? `${session.learnings.length} learning${session.learnings.length !== 1 ? "s" : ""}` : null,
                session.recommendations?.length ? `${session.recommendations.length} recommendation${session.recommendations.length !== 1 ? "s" : ""}` : null,
              ]
                .filter(Boolean)
                .join(", ")}
            </span>
          </summary>
          <div className="mt-1.5 pl-3 border-l border-border/50 flex flex-col gap-2">
            {session.issues && session.issues.length > 0 && (
              <InsightsList label="Issues" items={session.issues} color="amber" />
            )}
            {session.learnings && session.learnings.length > 0 && (
              <InsightsList label="Learnings" items={session.learnings} color="sky" />
            )}
            {session.recommendations && session.recommendations.length > 0 && (
              <InsightsList label="Recommendations" items={session.recommendations} color="emerald" />
            )}
          </div>
        </details>
      )}

      {/* Branch (collapsed, muted) */}
      <div className="text-[10px] text-muted-foreground/50 font-mono">
        {branchShort}
      </div>
    </div>
  );
}

// ── main component ────────────────────────────────────────────────────────────

export function PageChangesSessions({
  sessions,
}: {
  sessions: PageChangesSession[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    if (!query.trim()) return sessions;
    const q = query.toLowerCase();
    return sessions.filter(
      (s) =>
        s.sessionTitle?.toLowerCase().includes(q) ||
        s.summary?.toLowerCase().includes(q) ||
        s.pages.some((p) => p.pageTitle?.toLowerCase().includes(q)) ||
        s.branch?.toLowerCase().includes(q) ||
        s.issues?.some((item) => item.toLowerCase().includes(q)) ||
        s.learnings?.some((item) => item.toLowerCase().includes(q)) ||
        s.recommendations?.some((item) => item.toLowerCase().includes(q))
    );
  }, [sessions, query]);

  // Group into week buckets
  const grouped = useMemo(() => {
    const map = new Map<string, PageChangesSession[]>();
    for (const session of filtered) {
      const label = weekLabel(session.date);
      if (!map.has(label)) map.set(label, []);
      map.get(label)!.push(session);
    }
    return Array.from(map.entries());
  }, [filtered]);

  return (
    <div className="not-prose">
      {/* Search */}
      <div className="mb-4">
        <input
          type="search"
          placeholder="Search sessions, pages, or branches..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="w-full max-w-md rounded-md border border-input bg-background px-3 py-1.5 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
        />
        {query && (
          <span className="ml-3 text-xs text-muted-foreground">
            {filtered.length} session{filtered.length !== 1 ? "s" : ""}
          </span>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-muted-foreground italic">
          No sessions match your search.
        </p>
      ) : (
        <div className="space-y-6">
          {grouped.map(([label, groupSessions]) => (
            <section key={label}>
              <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-1 pb-1 border-b border-border/60">
                {label}
                <span className="ml-2 font-normal normal-case">
                  ({groupSessions.length} session
                  {groupSessions.length !== 1 ? "s" : ""},{" "}
                  {groupSessions.reduce((n, s) => n + s.pages.length, 0)} page
                  {groupSessions.reduce((n, s) => n + s.pages.length, 0) !== 1
                    ? "s"
                    : ""}
                  )
                </span>
              </h3>
              <div className="divide-y divide-border/40">
                {groupSessions.map((session) => (
                  <SessionRow key={session.sessionKey} session={session} />
                ))}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}
