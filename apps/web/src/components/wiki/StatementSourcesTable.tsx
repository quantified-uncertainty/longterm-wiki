"use client";

import { useState } from "react";
import { ExternalLink, ChevronDown, ChevronUp } from "lucide-react";
import { getDomain, isSafeUrl, VERDICT_COLORS } from "@components/wiki/resource-utils";
import type { StatementWithDetails } from "@lib/statement-types";

const INITIAL_SHOW = 6;

interface UrlEntry {
  url: string;
  count: number;
  verdicts: Record<string, number>;
}

interface SourceGroup {
  domain: string;
  urls: Map<string, UrlEntry>;
  totalStatements: number;
  verdicts: Record<string, number>;
}

/** Colored dots summarizing verdict distribution */
function VerdictDots({ verdicts }: { verdicts: Record<string, number> }) {
  const entries = Object.entries(verdicts)
    .filter(([key]) => key in VERDICT_COLORS)
    .sort(([a], [b]) => {
      const order = ["accurate", "minor_issues", "inaccurate", "unsupported", "not_verifiable"];
      return order.indexOf(a) - order.indexOf(b);
    });

  if (entries.length === 0) return null;

  return (
    <span className="inline-flex items-center gap-0.5">
      {entries.map(([key, count]) => {
        const style = VERDICT_COLORS[key];
        if (!style) return null;
        return (
          <span
            key={key}
            title={`${count} ${style.title.toLowerCase()}`}
            className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground"
          >
            <span className={`inline-block w-2 h-2 rounded-full ${style.bg}`} />
            {count}
          </span>
        );
      })}
    </span>
  );
}

/** Expandable source card */
function SourceCard({ group }: { group: SourceGroup }) {
  const [open, setOpen] = useState(false);
  const firstUrl = group.urls.values().next().value?.url;
  const urlEntries = [...group.urls.values()];
  const hasMultiple = urlEntries.length > 1;

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 hover:bg-muted/20 transition-colors cursor-pointer text-left"
      >
        <div className="flex items-center gap-1.5 min-w-0">
          {firstUrl && isSafeUrl(firstUrl) ? (
            <span className="inline-flex items-center gap-0.5 text-xs text-blue-600 truncate">
              {group.domain}
              <ExternalLink className="w-3 h-3 shrink-0" />
            </span>
          ) : (
            <span className="text-xs text-muted-foreground truncate">{group.domain}</span>
          )}
          {hasMultiple && (
            <span className="text-[10px] text-muted-foreground/60 shrink-0">
              ({urlEntries.length} pages)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] tabular-nums text-muted-foreground">
            {group.totalStatements} cite{group.totalStatements !== 1 ? "s" : ""}
          </span>
          <VerdictDots verdicts={group.verdicts} />
          {open ? (
            <ChevronUp className="w-3 h-3 text-muted-foreground/50" />
          ) : (
            <ChevronDown className="w-3 h-3 text-muted-foreground/50" />
          )}
        </div>
      </button>

      {open && (
        <div className="border-t border-border/30 px-2.5 py-1.5 bg-muted/10 space-y-1">
          {urlEntries.map((entry) => {
            const path = (() => {
              try {
                const u = new URL(entry.url);
                const p = u.pathname + u.search;
                return p.length > 60 ? p.slice(0, 57) + "..." : p;
              } catch {
                return entry.url;
              }
            })();

            return (
              <div key={entry.url} className="flex items-center justify-between gap-2">
                <a
                  href={entry.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-0.5 text-[11px] text-blue-600 hover:underline truncate min-w-0"
                >
                  {path}
                  <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                </a>
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="text-[10px] tabular-nums text-muted-foreground">
                    {entry.count}
                  </span>
                  <VerdictDots verdicts={entry.verdicts} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/**
 * Expandable card grid showing citation sources grouped by domain.
 * Shows top 6 initially, expandable to show all.
 */
export function StatementSourcesTable({
  statements,
}: {
  statements: StatementWithDetails[];
}) {
  const [showAll, setShowAll] = useState(false);

  // Build source groups from citation URLs
  const domainGroups = new Map<string, SourceGroup>();

  for (const s of statements) {
    for (const cit of s.citations) {
      if (!cit.url) continue;
      const domain = getDomain(cit.url) ?? "unknown";
      let group = domainGroups.get(domain);
      if (!group) {
        group = { domain, urls: new Map(), totalStatements: 0, verdicts: {} };
        domainGroups.set(domain, group);
      }

      let urlEntry = group.urls.get(cit.url);
      if (!urlEntry) {
        urlEntry = { url: cit.url, count: 0, verdicts: {} };
        group.urls.set(cit.url, urlEntry);
      }
      urlEntry.count++;
      if (s.verdict) {
        urlEntry.verdicts[s.verdict] = (urlEntry.verdicts[s.verdict] ?? 0) + 1;
      }

      group.totalStatements++;
      if (s.verdict) {
        group.verdicts[s.verdict] = (group.verdicts[s.verdict] ?? 0) + 1;
      }
    }
  }

  const groups = [...domainGroups.values()].sort(
    (a, b) => b.totalStatements - a.totalStatements
  );

  if (groups.length === 0) return null;

  const visible = showAll ? groups : groups.slice(0, INITIAL_SHOW);
  const hiddenCount = groups.length - INITIAL_SHOW;

  return (
    <div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        {visible.map((group) => (
          <SourceCard key={group.domain} group={group} />
        ))}
      </div>
      {!showAll && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1.5 text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5 cursor-pointer"
        >
          Show {hiddenCount} more sources
          <ChevronDown className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}
