"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { VerdictBadge } from "@components/wiki/VerdictBadge";
import { getDomain, isSafeUrl } from "@components/wiki/resource-utils";
import { formatStatementValue } from "@lib/statement-display";
import type { StatementWithDetails } from "@lib/statement-types";

function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  if (start && !end) return start;
  if (!start && end) return `until ${end}`;
  return `${start}–${end}`;
}

function InlineCitations({ citations }: { citations: StatementWithDetails["citations"] }) {
  const [open, setOpen] = useState(false);

  if (citations.length === 0) {
    return <span className="text-muted-foreground/40">—</span>;
  }

  return (
    <div className="inline-flex flex-col items-end">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300 text-[11px] font-medium hover:bg-emerald-200 dark:hover:bg-emerald-900/50 transition-colors cursor-pointer"
        aria-expanded={open}
      >
        {citations.length}
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 rounded-lg border border-border bg-popover p-2 shadow-lg text-left">
          <div className="space-y-1.5">
            {citations.map((cit) => (
              <div key={cit.id} className="rounded border border-border/40 p-1.5 text-xs">
                {cit.url && isSafeUrl(cit.url) ? (
                  <a
                    href={cit.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-0.5 text-blue-600 hover:underline truncate"
                  >
                    <span className="truncate">{getDomain(cit.url) ?? cit.url}</span>
                    <ExternalLink className="w-3 h-3 shrink-0" />
                  </a>
                ) : cit.resourceId ? (
                  <a href={`/source/${cit.resourceId}`} className="text-blue-600 hover:underline text-[10px]">
                    {cit.resourceId}
                  </a>
                ) : (
                  <span className="text-muted-foreground/60">No URL</span>
                )}
                {cit.sourceQuote && (
                  <p className="text-muted-foreground border-l-2 border-border pl-1.5 mt-1 line-clamp-2 italic text-[10px]">
                    &ldquo;{cit.sourceQuote}&rdquo;
                  </p>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Compact table of structured statements grouped by property category.
 * Shows property, value, date, verdict, and expandable citation details.
 */
export function StructuredStatementsTable({
  statements,
}: {
  statements: StatementWithDetails[];
}) {
  // Group by category
  const byCategory = new Map<string, StatementWithDetails[]>();
  for (const s of statements) {
    const cat = s.property?.category ?? (s.statementText ? "text claims" : "uncategorized");
    const list = byCategory.get(cat) ?? [];
    list.push(s);
    byCategory.set(cat, list);
  }

  if (byCategory.size === 0) return null;

  return (
    <div className="space-y-3">
      {[...byCategory.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .map(([category, stmts]) => (
            <div key={category}>
              <h4 className="text-xs font-semibold capitalize text-muted-foreground mb-1">
                {category}
              </h4>
              <div className="rounded-lg border border-border/60 overflow-hidden">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border/60 bg-muted/30">
                      <th className="text-left px-3 py-1.5 text-[11px] font-medium">Property</th>
                      <th className="text-left px-3 py-1.5 text-[11px] font-medium">Value</th>
                      <th className="text-left px-3 py-1.5 text-[11px] font-medium">Date</th>
                      <th className="text-left px-3 py-1.5 text-[11px] font-medium">Verdict</th>
                      <th className="text-right px-3 py-1.5 text-[11px] font-medium">Sources</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stmts.map((s) => {
                      const value = formatStatementValue(s, s.property);
                      const isTextOnly = !s.propertyId && !!s.statementText;
                      const displayValue = value !== "—" ? value : (s.statementText ?? "—");

                      return (
                        <tr key={s.id} className="border-b border-border/30 last:border-0">
                          <td className="px-3 py-1.5 text-xs text-muted-foreground">
                            {s.property?.label ?? s.propertyId ?? "—"}
                          </td>
                          <td className={`px-3 py-1.5 text-xs ${isTextOnly ? "italic text-muted-foreground" : "font-semibold tabular-nums"}`}>
                            {s.valueEntityId ? (
                              <Link href={`/wiki/${s.valueEntityId}`} className="text-blue-600 hover:underline">
                                {displayValue}
                              </Link>
                            ) : (
                              displayValue
                            )}
                          </td>
                          <td className="px-3 py-1.5 text-xs text-muted-foreground">
                            {formatPeriod(s.validStart, s.validEnd)}
                          </td>
                          <td className="px-3 py-1.5 text-xs">
                            <VerdictBadge verdict={s.verdict} score={s.verdictScore} />
                          </td>
                          <td className="px-3 py-1.5 text-xs text-right relative">
                            <InlineCitations citations={s.citations} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
        ))}
    </div>
  );
}
