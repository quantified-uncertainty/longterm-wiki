"use client";

import { useState, useEffect } from "react";
import { ShieldCheck, ChevronRight } from "lucide-react";
import { cn } from "@lib/utils";
import { formatDateDeterministic } from "@lib/format";

// ── Types ────────────────────────────────────────────────────────────────

interface VerdictRow {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number;
  needsRecheck: boolean;
  lastComputedAt: string | null;
}

// ── Verdict styling (matches entity-verifications-viewer) ────────────────

const VERDICT_STYLES: Record<string, { bg: string; text: string; dot: string }> = {
  confirmed: { bg: "bg-emerald-500/15", text: "text-emerald-600", dot: "bg-emerald-500" },
  contradicted: { bg: "bg-red-500/15", text: "text-red-600", dot: "bg-red-500" },
  outdated: { bg: "bg-amber-500/15", text: "text-amber-600", dot: "bg-amber-500" },
  partial: { bg: "bg-amber-400/15", text: "text-amber-500", dot: "bg-amber-400" },
  unverifiable: { bg: "bg-gray-500/15", text: "text-gray-500", dot: "bg-gray-400" },
  unchecked: { bg: "bg-gray-400/15", text: "text-gray-400", dot: "bg-gray-300" },
};

function getVerdictStyle(verdict: string) {
  return VERDICT_STYLES[verdict] ?? VERDICT_STYLES.unchecked;
}

// ── Component ────────────────────────────────────────────────────────────

interface VerificationStatusProps {
  entityId: string;
}

/**
 * VerificationStatus — compact summary of entity-level verification verdicts.
 *
 * Client component that fetches verification verdicts for an entity and renders
 * a summary section on wiki entity pages. Shows nothing if no verdicts exist.
 */
export function VerificationStatus({ entityId }: VerificationStatusProps) {
  const [verdicts, setVerdicts] = useState<VerdictRow[] | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    let cancelled = false;

    (async () => {
      try {
        const res = await fetch(
          `/api/entity-verifications-proxy?entity_id=${encodeURIComponent(entityId)}&limit=50`
        );
        if (!res.ok) {
          // Non-200 responses: if server is down or entity has no data, just hide
          if (res.status === 503 || res.status === 502) {
            if (!cancelled) {
              setVerdicts([]);
              setIsLoading(false);
            }
            return;
          }
          throw new Error(`HTTP ${res.status}`);
        }
        const data = await res.json();
        if (!cancelled) {
          setVerdicts(data.verdicts ?? []);
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [entityId]);

  // Don't render anything while loading, on error, or if no verdicts
  if (isLoading || error || !verdicts || verdicts.length === 0) {
    return null;
  }

  // Compute summary stats
  const total = verdicts.length;
  const verdictCounts = new Map<string, number>();
  let totalConfidence = 0;
  let confidenceCount = 0;

  for (const v of verdicts) {
    verdictCounts.set(v.verdict, (verdictCounts.get(v.verdict) ?? 0) + 1);
    if (v.confidence != null) {
      totalConfidence += v.confidence;
      confidenceCount++;
    }
  }

  const confirmed = verdictCounts.get("confirmed") ?? 0;
  const avgConfidence = confidenceCount > 0 ? totalConfidence / confidenceCount : null;

  // Sort verdict types by count descending for the distribution display
  const sortedVerdicts = [...verdictCounts.entries()].sort(([, a], [, b]) => b - a);

  return (
    <section className="not-prose mt-6 mb-4" aria-labelledby="verification-status-heading">
      <div className="rounded-lg border border-border/60 bg-card/50">
        {/* Header */}
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border/40">
          <ShieldCheck size={14} className="text-emerald-500/70" />
          <h2
            id="verification-status-heading"
            className="text-sm font-bold tracking-tight"
          >
            Verification Status
          </h2>
          <span className="text-xs text-muted-foreground ml-1">
            {confirmed} of {total} claims confirmed
            {avgConfidence != null && (
              <span className="text-muted-foreground/60">
                {" "}· {Math.round(avgConfidence * 100)}% avg confidence
              </span>
            )}
          </span>
        </div>

        {/* Verdict distribution */}
        <div className="px-4 py-2.5 flex items-center gap-3 flex-wrap">
          {sortedVerdicts.map(([verdict, count]) => {
            const style = getVerdictStyle(verdict);
            return (
              <span
                key={verdict}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold",
                  style.bg,
                  style.text,
                )}
              >
                <span className={cn("w-1.5 h-1.5 rounded-full", style.dot)} />
                {verdict}
                <span className="tabular-nums opacity-70">{count}</span>
              </span>
            );
          })}
        </div>

        {/* Expandable details */}
        <div className="border-t border-border/30">
          <button
            type="button"
            onClick={() => setShowDetails((prev) => !prev)}
            className="flex items-center gap-1.5 px-4 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors w-full text-left"
          >
            <ChevronRight
              size={12}
              className={cn(
                "transition-transform",
                showDetails && "rotate-90",
              )}
            />
            {showDetails ? "Hide details" : "Show details"}
          </button>

          {showDetails && (
            <div className="px-4 pb-3 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/40 text-left text-muted-foreground">
                    <th className="py-1.5 pr-3 font-medium">Type</th>
                    <th className="py-1.5 pr-3 font-medium">Field</th>
                    <th className="py-1.5 pr-3 font-medium">Verdict</th>
                    <th className="py-1.5 pr-3 font-medium">Confidence</th>
                    <th className="py-1.5 pr-3 font-medium">Reasoning</th>
                    <th className="py-1.5 font-medium">Checked</th>
                  </tr>
                </thead>
                <tbody>
                  {verdicts.map((v, i) => {
                    const style = getVerdictStyle(v.verdict);
                    return (
                      <tr
                        key={`${v.recordType}:${v.recordId}:${v.fieldName ?? ""}:${i}`}
                        className="border-b border-border/20 last:border-0"
                      >
                        <td className="py-1.5 pr-3 capitalize">{v.recordType}</td>
                        <td className="py-1.5 pr-3 text-muted-foreground">
                          {v.fieldName ?? "-"}
                        </td>
                        <td className="py-1.5 pr-3">
                          <span
                            className={cn(
                              "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold",
                              style.bg,
                              style.text,
                            )}
                          >
                            {v.verdict}
                          </span>
                        </td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {v.confidence != null
                            ? `${Math.round(v.confidence * 100)}%`
                            : "-"}
                        </td>
                        <td className="py-1.5 pr-3 max-w-[250px] text-muted-foreground">
                          <span
                            className="line-clamp-2"
                            title={v.reasoning ?? undefined}
                          >
                            {v.reasoning ?? "-"}
                          </span>
                        </td>
                        <td className="py-1.5 tabular-nums text-muted-foreground whitespace-nowrap">
                          {v.lastComputedAt
                            ? formatDateDeterministic(v.lastComputedAt)
                            : "-"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
