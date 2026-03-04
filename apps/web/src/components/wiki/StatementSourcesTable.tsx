"use client";

import { ExternalLink } from "lucide-react";
import { getDomain } from "@components/wiki/resource-utils";
import type { StatementWithDetails } from "@lib/statement-types";

interface SourceGroup {
  domain: string;
  urls: Map<string, { url: string; count: number; verdicts: Record<string, number> }>;
  totalStatements: number;
  verdicts: Record<string, number>;
}

function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function VerdictSummary({ verdicts }: { verdicts: Record<string, number> }) {
  const parts: { label: string; count: number; color: string }[] = [];
  if (verdicts.accurate) parts.push({ label: "verified", count: verdicts.accurate, color: "text-emerald-600" });
  if (verdicts.minor_issues) parts.push({ label: "minor issues", count: verdicts.minor_issues, color: "text-amber-600" });
  if (verdicts.inaccurate) parts.push({ label: "disputed", count: verdicts.inaccurate, color: "text-red-600" });
  if (verdicts.unsupported) parts.push({ label: "unsupported", count: verdicts.unsupported, color: "text-red-500" });

  if (parts.length === 0) return <span className="text-muted-foreground/50">—</span>;

  return (
    <span className="text-[11px]">
      {parts.map((p, i) => (
        <span key={p.label}>
          {i > 0 && ", "}
          <span className={p.color}>{p.count} {p.label}</span>
        </span>
      ))}
    </span>
  );
}

/**
 * Table showing unique citation sources grouped by domain,
 * with statement counts and aggregate verdict summaries.
 */
export function StatementSourcesTable({
  statements,
}: {
  statements: StatementWithDetails[];
}) {
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

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-border/60 bg-muted/30">
            <th className="text-left px-3 py-1.5 text-[11px] font-medium">Source</th>
            <th className="text-right px-3 py-1.5 text-[11px] font-medium">Statements</th>
            <th className="text-left px-3 py-1.5 text-[11px] font-medium">Verdicts</th>
          </tr>
        </thead>
        <tbody>
          {groups.map((group) => {
            const firstUrl = [...group.urls.values()][0]?.url;
            return (
              <tr key={group.domain} className="border-b border-border/30 last:border-0">
                <td className="px-3 py-1.5 text-xs">
                  {firstUrl && isSafeUrl(firstUrl) ? (
                    <a
                      href={firstUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-1 text-blue-600 hover:underline"
                    >
                      {group.domain}
                      <ExternalLink className="w-3 h-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-muted-foreground">{group.domain}</span>
                  )}
                  {group.urls.size > 1 && (
                    <span className="text-muted-foreground/60 text-[10px] ml-1">
                      ({group.urls.size} pages)
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-xs text-right tabular-nums">
                  {group.totalStatements}
                </td>
                <td className="px-3 py-1.5">
                  <VerdictSummary verdicts={group.verdicts} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
