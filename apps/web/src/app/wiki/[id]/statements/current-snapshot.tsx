import Link from "next/link";
import { ExternalLink } from "lucide-react";
import { VerdictBadge } from "@components/wiki/VerdictBadge";
import { formatStatementValue, formatPeriod } from "@lib/statement-display";
import { getDomain, isSafeUrl } from "@components/wiki/resource-utils";
import type { ResolvedStatement } from "@lib/statement-types";
import { snapshotKey } from "./statement-processing";

interface CurrentSnapshotProps {
  snapshot: ResolvedStatement[];
  conflicts: [string, ResolvedStatement[]][];
}

/**
 * Compact key-value table showing the current state of each property.
 * Server-renderable — no "use client".
 */
export function CurrentSnapshot({ snapshot, conflicts }: CurrentSnapshotProps) {
  if (snapshot.length === 0) return null;

  const conflictSet = new Set(conflicts.map(([key]) => key));
  const conflictMap = new Map(conflicts);

  // Determine if verdict column is useful (>10% have actual verdicts)
  const withVerdict = snapshot.filter(
    (s) => s.verdict != null && s.verdict !== "not_verifiable"
  ).length;
  const showVerdict = withVerdict / snapshot.length > 0.1;

  return (
    <div className="mb-8">
      <h2 className="text-lg font-semibold mb-1">Current Snapshot</h2>
      <p className="text-xs text-muted-foreground mb-3">
        Latest active value for each property.
        {conflicts.length > 0 && (
          <span className="ml-1 text-muted-foreground">
            {conflicts.length}{" "}
            {conflicts.length === 1
              ? "property has multiple open values"
              : "properties have multiple open values"}
            .
          </span>
        )}
      </p>
      <div className="rounded-lg border border-border/60 overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border/60 bg-muted/30">
              <th className="text-left px-3 py-2 text-xs font-medium">
                Property
              </th>
              <th className="text-left px-3 py-2 text-xs font-medium">
                Value
              </th>
              <th className="text-left px-3 py-2 text-xs font-medium">
                As of
              </th>
              <th className="text-left px-3 py-2 text-xs font-medium">
                Source
              </th>
              {showVerdict && (
                <th className="text-left px-3 py-2 text-xs font-medium">
                  Verdict
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {snapshot.map((s) => {
              const key = snapshotKey(s);
              const hasConflict = conflictSet.has(key);
              const conflictingStmts = conflictMap.get(key);

              return (
                <SnapshotRow
                  key={s.id}
                  statement={s}
                  hasConflict={hasConflict}
                  conflictingStatements={conflictingStmts}
                  showVerdict={showVerdict}
                />
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SnapshotRow({
  statement: s,
  hasConflict,
  conflictingStatements,
  showVerdict,
}: {
  statement: ResolvedStatement;
  hasConflict: boolean;
  conflictingStatements?: ResolvedStatement[];
  showVerdict: boolean;
}) {
  const value = formatStatementValue(s, s.property);
  const displayValue =
    s.valueEntityTitle ?? (value !== "—" ? value : (s.statementText ?? "—"));

  // Show qualifier context if present — format "category:value" as just "value"
  const qualifierLabel = s.qualifierKey
    ? (
        s.qualifierKey.includes(":")
          ? s.qualifierKey.split(":").slice(1).join(":")
          : s.qualifierKey
      ).replace(/-/g, " ")
    : null;

  // First citation URL for inline source
  const firstUrl = s.citations.find((c) => c.url && isSafeUrl(c.url))?.url;
  const domain = firstUrl ? getDomain(firstUrl) : null;

  return (
    <tr className="border-b border-border/30 last:border-0">
      <td className="px-3 py-2 text-xs font-medium text-muted-foreground">
        {s.property?.label ?? s.propertyId ?? "—"}
        {qualifierLabel && (
          <span className="ml-1 text-[10px] text-muted-foreground/60">
            ({qualifierLabel})
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-xs font-semibold tabular-nums">
        {s.valueEntityId ? (
          <Link
            href={`/wiki/${s.valueEntityId}`}
            className="text-blue-600 hover:underline"
          >
            {displayValue}
          </Link>
        ) : (
          displayValue
        )}
        {hasConflict && conflictingStatements && (
          <ConflictValues
            statements={conflictingStatements}
            currentId={s.id}
          />
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {s.validStart ? formatPeriod(s.validStart, null).replace(/^since /, "") : "—"}
      </td>
      <td className="px-3 py-2 text-xs">
        {firstUrl && domain ? (
          <a
            href={firstUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-blue-600 hover:underline"
          >
            <span className="truncate max-w-[120px]">{domain}</span>
            <ExternalLink className="w-3 h-3 shrink-0" />
          </a>
        ) : s.citations.length > 0 ? (
          <span className="text-muted-foreground">
            {s.citations.length} cite{s.citations.length !== 1 ? "s" : ""}
          </span>
        ) : (
          <span className="text-muted-foreground/40">—</span>
        )}
      </td>
      {showVerdict && (
        <td className="px-3 py-2 text-xs">
          <VerdictBadge verdict={s.verdict} score={s.verdictScore} size="sm" />
        </td>
      )}
    </tr>
  );
}

const MAX_CONFLICT_DISPLAY = 3;

function ConflictValues({
  statements,
  currentId,
}: {
  statements: ResolvedStatement[];
  currentId: number;
}) {
  const others = statements
    .filter((s) => s.id !== currentId)
    .sort((a, b) => (b.validStart ?? "").localeCompare(a.validStart ?? ""));
  if (others.length === 0) return null;

  const shown = others.slice(0, MAX_CONFLICT_DISPLAY);
  const remaining = others.length - shown.length;

  return (
    <span className="ml-2 text-muted-foreground font-normal text-[11px]">
      (prev:{" "}
      {shown.map((s, i) => {
        const val =
          s.valueEntityTitle ?? formatStatementValue(s, s.property);
        const date = s.validStart ? ` [${s.validStart}]` : "";
        return (
          <span key={s.id}>
            {i > 0 && ", "}
            {val}
            {date && (
              <span className="text-muted-foreground/60">{date}</span>
            )}
          </span>
        );
      })}
      {remaining > 0 && `, +${remaining} more`}
      )
    </span>
  );
}
