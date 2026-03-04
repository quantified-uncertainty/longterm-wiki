"use client";

import Link from "next/link";
import { VerdictBadge } from "@components/wiki/VerdictBadge";
import type { StatementWithDetails } from "@lib/statement-types";

/**
 * Compact list of attributed statements showing quoted text,
 * attribution, verdict, and citation count.
 */
export function AttributedStatementsTable({
  statements,
}: {
  statements: StatementWithDetails[];
}) {
  if (statements.length === 0) return null;

  return (
    <div className="space-y-2">
      {statements.map((s) => (
        <div
          key={s.id}
          className="rounded-lg border border-border/60 p-3"
        >
          <div className="flex items-start justify-between gap-3">
            <div className="flex-1 min-w-0">
              {s.statementText && (
                <p className="text-sm italic text-muted-foreground line-clamp-3">
                  &ldquo;{s.statementText}&rdquo;
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2 mt-1.5 text-xs text-muted-foreground">
                {s.attributedTo && (
                  <span>
                    Attributed to{" "}
                    <Link
                      href={`/wiki/${s.attributedTo}`}
                      className="text-blue-600 hover:underline"
                    >
                      {s.attributedTo}
                    </Link>
                  </span>
                )}
                {s.validStart && <span>{s.validStart}</span>}
                {s.citations.length > 0 && (
                  <span className="text-emerald-600">
                    {s.citations.length} source{s.citations.length !== 1 ? "s" : ""}
                  </span>
                )}
              </div>
            </div>
            <div className="shrink-0">
              <VerdictBadge verdict={s.verdict} score={s.verdictScore} />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
