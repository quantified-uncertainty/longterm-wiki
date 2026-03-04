"use client";

import { Fragment, useState } from "react";
import Link from "next/link";
import { ChevronDown, ChevronUp, ExternalLink, Clock } from "lucide-react";
import { VerdictBadge } from "@components/wiki/VerdictBadge";
import { getDomain, isSafeUrl } from "@components/wiki/resource-utils";
import { formatStatementValue } from "@lib/statement-display";
import type { StatementWithDetails } from "@lib/statement-types";

const INITIAL_ROWS = 8;

function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return "";
  if (start && !end) return start;
  if (!start && end) return `until ${end}`;
  return `${start}–${end}`;
}

/**
 * Score a statement for deduplication ranking. Higher = better quality.
 * Prefers: has citations > has verdict > has date > most recent ID.
 */
function qualityScore(s: StatementWithDetails): number {
  let score = 0;
  if (s.citations.length > 0) score += 100;
  if (s.verdict && s.verdict !== "not_verifiable") score += 50;
  if (s.validStart || s.validEnd) score += 25;
  if (s.verdictScore != null) score += 10;
  // Tiebreak: higher ID = more recent extraction
  score += s.id / 1_000_000;
  return score;
}

/**
 * A statement is considered "low quality" if it has no sources, no real verdict,
 * and no date — it's unverifiable noise that hurts the display.
 */
function isLowQuality(s: StatementWithDetails): boolean {
  const hasSource = s.citations.length > 0;
  const hasVerdict = s.verdict != null && s.verdict !== "not_verifiable";
  const hasDate = !!(s.validStart || s.validEnd);
  // Keep if it has ANY signal
  return !hasSource && !hasVerdict && !hasDate;
}

/**
 * Filter out low-quality noise, then deduplicate statements that share the
 * same property label and date. Keep the highest-quality one per group.
 */
function cleanStatements(statements: StatementWithDetails[]): StatementWithDetails[] {
  // Step 1: Remove low-quality rows
  const filtered = statements.filter((s) => !isLowQuality(s));

  // Step 2: Deduplicate by (property, date)
  const groups = new Map<string, StatementWithDetails[]>();
  for (const s of filtered) {
    const label = s.property?.label ?? s.propertyId ?? "—";
    const date = s.validStart ?? s.validEnd ?? "";
    const key = `${label}||${date}`;
    const list = groups.get(key) ?? [];
    list.push(s);
    groups.set(key, list);
  }

  const result: StatementWithDetails[] = [];
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0]);
    } else {
      group.sort((a, b) => qualityScore(b) - qualityScore(a));
      result.push(group[0]);
    }
  }

  // Preserve original ordering
  result.sort((a, b) => {
    const aIdx = filtered.indexOf(a);
    const bIdx = filtered.indexOf(b);
    return aIdx - bIdx;
  });

  return result;
}

/** Show up to 2 citation domains inline, with a +N indicator for more */
function InlineDomainLinks({ citations }: { citations: StatementWithDetails["citations"] }) {
  if (citations.length === 0) {
    return <span className="text-muted-foreground/40">—</span>;
  }

  const seen = new Map<string, string>();
  for (const cit of citations) {
    if (!cit.url || !isSafeUrl(cit.url)) continue;
    const domain = getDomain(cit.url) ?? cit.url;
    if (!seen.has(domain)) seen.set(domain, cit.url);
  }

  const entries = [...seen.entries()];
  if (entries.length === 0) {
    return <span className="text-muted-foreground/40">{citations.length}</span>;
  }

  const shown = entries.slice(0, 2);
  const extra = entries.length - shown.length;

  return (
    <span className="inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
      {shown.map(([domain, url]) => (
        <a
          key={domain}
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-0.5 text-blue-600 hover:underline text-[10px]"
          onClick={(e) => e.stopPropagation()}
        >
          {domain}
          <ExternalLink className="w-2.5 h-2.5 shrink-0" />
        </a>
      ))}
      {extra > 0 && (
        <span className="text-muted-foreground/60 text-[10px]">+{extra}</span>
      )}
    </span>
  );
}

/** Expandable detail row showing verdict quotes, verification timestamp, and full citation list */
function DetailRow({ statement }: { statement: StatementWithDetails }) {
  return (
    <tr>
      <td colSpan={5} className="px-2 py-1.5 bg-muted/20 border-b border-border/30">
        <div className="space-y-1.5 text-xs">
          {(statement.verifiedAt || statement.claimCategory) && (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
              {statement.verifiedAt && (
                <span className="inline-flex items-center gap-0.5">
                  <Clock className="w-2.5 h-2.5" />
                  Verified {new Date(statement.verifiedAt).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" })}
                </span>
              )}
              {statement.claimCategory && (
                <span className="inline-flex items-center rounded-full bg-muted/50 px-1.5 py-0.5 text-[10px] font-medium">
                  {statement.claimCategory}
                </span>
              )}
              {statement.verdictModel && (
                <span className="text-[10px] text-muted-foreground/60">
                  via {statement.verdictModel}
                </span>
              )}
            </div>
          )}

          {statement.verdictQuotes && (
            <blockquote className="border-l-2 border-border pl-2 text-[11px] italic text-muted-foreground line-clamp-3">
              {statement.verdictQuotes}
            </blockquote>
          )}

          {statement.citations.length > 0 && (
            <div className="space-y-1">
              {statement.citations.map((cit) => (
                <div key={cit.id} className="flex items-start gap-1.5">
                  {cit.url && isSafeUrl(cit.url) ? (
                    <a
                      href={cit.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex items-center gap-0.5 text-blue-600 hover:underline text-[11px] shrink-0"
                    >
                      {getDomain(cit.url) ?? cit.url}
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  ) : cit.resourceId ? (
                    <a href={`/source/${cit.resourceId}`} className="text-blue-600 hover:underline text-[10px]">
                      {cit.resourceId}
                    </a>
                  ) : null}
                  {cit.sourceQuote && (
                    <span className="text-[10px] italic text-muted-foreground line-clamp-1">
                      &ldquo;{cit.sourceQuote}&rdquo;
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </td>
    </tr>
  );
}

/** A single category table with optional show-more */
function CategoryTable({
  category,
  statements,
  expanded,
  onToggle,
}: {
  category: string;
  statements: StatementWithDetails[];
  expanded: Set<number>;
  onToggle: (id: number) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  const deduped = cleanStatements(statements);
  const visible = showAll ? deduped : deduped.slice(0, INITIAL_ROWS);
  const hiddenCount = deduped.length - INITIAL_ROWS;

  return (
    <div>
      <h4 className="text-xs font-semibold capitalize text-muted-foreground mb-1">
        {category}
        <span className="ml-1 text-[10px] font-normal text-muted-foreground/60">
          ({deduped.length})
        </span>
      </h4>
      <div className="rounded-lg border border-border/60 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/30">
              <th className="text-left px-2 py-0.5 text-[11px] font-medium">Property</th>
              <th className="text-left px-2 py-0.5 text-[11px] font-medium">Value</th>
              <th className="text-left px-2 py-0.5 text-[11px] font-medium">Date</th>
              <th className="text-left px-2 py-0.5 text-[11px] font-medium">Verdict</th>
              <th className="text-right px-2 py-0.5 text-[11px] font-medium">Sources</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((s) => {
              const value = formatStatementValue(s, s.property);
              const isTextOnly = !s.propertyId && !!s.statementText;
              const displayValue = value !== "—" ? value : (s.statementText ?? "—");
              const isExpanded = expanded.has(s.id);
              const hasDetails = !!(s.verdictQuotes || s.verifiedAt || s.citations.length > 0);

              return (
                <Fragment key={s.id}>
                  <tr
                    className={`border-b border-border/30 last:border-0 ${hasDetails ? "cursor-pointer hover:bg-muted/20" : ""}`}
                    onClick={hasDetails ? () => onToggle(s.id) : undefined}
                  >
                    <td className="px-2 py-0.5 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-0.5">
                        {hasDetails && (
                          isExpanded
                            ? <ChevronUp className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                            : <ChevronDown className="w-3 h-3 shrink-0 text-muted-foreground/50" />
                        )}
                        {s.property?.label ?? s.propertyId ?? "—"}
                      </span>
                    </td>
                    <td className={`px-2 py-0.5 text-xs max-w-[280px] ${isTextOnly ? "italic text-muted-foreground" : "font-semibold tabular-nums"}`}>
                      <span className="line-clamp-2">
                        {s.valueEntityId ? (
                          <Link href={`/wiki/${s.valueEntityId}`} className="text-blue-600 hover:underline">
                            {displayValue}
                          </Link>
                        ) : (
                          displayValue
                        )}
                      </span>
                    </td>
                    <td className="px-2 py-0.5 text-xs text-muted-foreground">
                      {formatPeriod(s.validStart, s.validEnd)}
                    </td>
                    <td className="px-2 py-0.5 text-xs">
                      <VerdictBadge verdict={s.verdict} score={s.verdictScore} />
                    </td>
                    <td className="px-2 py-0.5 text-xs text-right">
                      <InlineDomainLinks citations={s.citations} />
                    </td>
                  </tr>
                  {isExpanded && <DetailRow statement={s} />}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
      {!showAll && hiddenCount > 0 && (
        <button
          type="button"
          onClick={() => setShowAll(true)}
          className="mt-1 text-xs text-blue-600 hover:underline inline-flex items-center gap-0.5 cursor-pointer"
        >
          Show {hiddenCount} more
          <ChevronDown className="w-3 h-3" />
        </button>
      )}
    </div>
  );
}

/**
 * Compact table of structured statements grouped by property category.
 * Deduplicates same-property rows, shows 8 per category initially.
 * Rows expand on click to show verdict quotes and full citations.
 */
export function StructuredStatementsTable({
  statements,
}: {
  statements: StatementWithDetails[];
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());

  const toggle = (id: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Group by category
  const byCategory = new Map<string, StatementWithDetails[]>();
  for (const s of statements) {
    const cat = s.property?.category ?? "uncategorized";
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
          <CategoryTable
            key={category}
            category={category}
            statements={stmts}
            expanded={expanded}
            onToggle={toggle}
          />
        ))}
    </div>
  );
}
