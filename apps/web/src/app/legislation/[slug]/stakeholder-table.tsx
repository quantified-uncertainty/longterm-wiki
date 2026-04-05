"use client";

import { useState } from "react";
import Link from "next/link";
import * as Popover from "@radix-ui/react-popover";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/verification/source-check-status";

const POSITION_COLORS: Record<string, string> = {
  support:
    "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  oppose: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
  neutral:
    "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
  mixed:
    "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
};

/** Compact circle indicator for stakeholder importance. */
function ImportanceIndicator({
  importance,
}: {
  importance: "high" | "medium" | "low";
}) {
  const size = 10;
  if (importance === "high") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 10 10"
        aria-label="High importance"
      >
        <circle cx="5" cy="5" r="4" className="fill-foreground/70" />
      </svg>
    );
  }
  if (importance === "medium") {
    return (
      <svg
        width={size}
        height={size}
        viewBox="0 0 10 10"
        aria-label="Medium importance"
      >
        <circle
          cx="5"
          cy="5"
          r="4"
          className="fill-none stroke-foreground/60"
          strokeWidth="1.2"
        />
        <path d="M5,1 A4,4 0 0,0 5,9 Z" className="fill-foreground/60" />
      </svg>
    );
  }
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 10 10"
      aria-label="Low importance"
    >
      <circle
        cx="5"
        cy="5"
        r="4"
        className="fill-none stroke-foreground/40"
        strokeWidth="1.2"
      />
    </svg>
  );
}

// ── Verdict badge config (duplicated from VerificationBadge for client use) ──
const VERDICT_CONFIG: Record<
  string,
  { label: string; title: string; className: string }
> = {
  confirmed: {
    label: "Verified",
    title: "Confirmed by source",
    className:
      "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  },
  contradicted: {
    label: "Disputed",
    title: "Source contradicts this data",
    className:
      "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300",
  },
  outdated: {
    label: "Outdated",
    title: "Source has newer data",
    className:
      "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  },
  partial: {
    label: "Partial",
    title: "Partially confirmed by source",
    className:
      "bg-sky-100 text-sky-700 dark:bg-sky-900/40 dark:text-sky-300",
  },
  unverifiable: {
    label: "Unverifiable",
    title: "Source does not address this data",
    className:
      "bg-orange-100 text-orange-600 dark:bg-orange-900/40 dark:text-orange-400",
  },
};

/** Inline verdict badge (client-safe, no server imports). */
function VerdictBadge({
  verdict,
}: {
  verdict: { verdict: string; confidence: number | null } | null;
}) {
  if (!verdict) return null;
  const config = VERDICT_CONFIG[verdict.verdict];
  if (!config) return null;
  const pct =
    verdict.confidence != null
      ? `${Math.round(verdict.confidence * 100)}%`
      : null;
  const title = pct
    ? `${config.title} (${pct} confidence)`
    : config.title;
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold leading-none ${config.className}`}
      title={title}
    >
      {config.label}
    </span>
  );
}

/**
 * Enriched reason cell that shows source publication name instead of generic "[source]".
 */
function EnrichedReasonCell({
  reason,
  context,
  source,
  sourceName,
}: {
  reason: string | undefined;
  context: string[] | undefined;
  source: string | undefined;
  sourceName: string | undefined;
}) {
  const hasContext = context && context.length > 0;
  const hasMore = hasContext || (reason && reason.length > 100);

  if (!reason && !hasContext) {
    return <span className="text-muted-foreground/40">&mdash;</span>;
  }

  return (
    <div className="flex items-start gap-1">
      <div className="min-w-0 flex-1">
        <span className="line-clamp-2">{reason ?? "\u2014"}</span>
        {source && (
          <a
            href={source}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 text-primary hover:underline text-xs whitespace-nowrap"
          >
            [{sourceName ?? "source"}]
          </a>
        )}
      </div>
      {hasMore && (
        <Popover.Root>
          <Popover.Trigger asChild>
            <button
              className="shrink-0 mt-0.5 w-5 h-5 rounded-md flex items-center justify-center text-muted-foreground/50 hover:text-foreground hover:bg-muted/60 transition-colors"
              aria-label="Show full details"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
              >
                <circle cx="8" cy="8" r="6.5" />
                <path d="M8 7v4M8 5.5v0" strokeLinecap="round" />
              </svg>
            </button>
          </Popover.Trigger>
          <Popover.Portal>
            <Popover.Content
              side="bottom"
              align="end"
              sideOffset={4}
              className="z-50 w-80 rounded-lg border border-border bg-card shadow-lg p-4 text-sm animate-in fade-in-0 zoom-in-95"
            >
              {reason && (
                <p className="text-foreground leading-relaxed">{reason}</p>
              )}
              {source && (
                <a
                  href={source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-block mt-2 text-primary hover:underline text-xs"
                >
                  {sourceName
                    ? `${sourceName} \u2192`
                    : "View source \u2192"}
                </a>
              )}
              {hasContext && (
                <>
                  <div className="mt-3 pt-3 border-t border-border/50">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground/70">
                      Context &amp; Connections
                    </span>
                  </div>
                  <ul className="mt-1.5 space-y-1 text-xs text-muted-foreground list-none pl-0">
                    {context!.map((note, j) => (
                      <li key={j} className="leading-relaxed">
                        <span className="text-muted-foreground/40 mr-1">
                          &rarr;
                        </span>
                        {note}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              <Popover.Arrow className="fill-border" />
            </Popover.Content>
          </Popover.Portal>
        </Popover.Root>
      )}
    </div>
  );
}

export interface StakeholderRow {
  name: string;
  entityId?: string;
  position: string;
  role?: string;
  importance?: "high" | "medium" | "low";
  reason?: string;
  source?: string;
  sourceName?: string;
  context?: string[];
  href: string | null;
  /** Pre-resolved verification verdict (serializable). Resolved server-side. */
  verdict: { verdict: string; confidence: number | null } | null;
}

interface StakeholderTableProps {
  /** Stakeholders already sorted by importance within each position group */
  stakeholders: StakeholderRow[];
  /** Threshold for collapsing minor stakeholders (default: 8) */
  collapseThreshold?: number;
}

/**
 * Client-side stakeholder table with collapsible minor stakeholders.
 *
 * When the total count exceeds collapseThreshold, stakeholders without
 * importance or with "low" importance are hidden behind a "Show N more" toggle.
 */
export function StakeholderTable({
  stakeholders,
  collapseThreshold = 8,
}: StakeholderTableProps) {
  const [showAll, setShowAll] = useState(false);

  // Split into prominent (high/medium) and minor (low/unset)
  const prominent = stakeholders.filter(
    (s) => s.importance === "high" || s.importance === "medium",
  );
  const minor = stakeholders.filter(
    (s) => s.importance !== "high" && s.importance !== "medium",
  );

  const shouldCollapse =
    stakeholders.length > collapseThreshold && minor.length > 0;
  const visible = shouldCollapse && !showAll ? prominent : stakeholders;

  return (
    <div>
      <div className="rounded-xl border border-border overflow-x-auto">
        <table className="w-full text-sm min-w-[500px]">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted">
              <th className="text-left py-1.5 px-3 font-medium w-[180px]">
                Name
              </th>
              <th className="text-left py-1.5 px-3 font-medium w-[70px]">
                Position
              </th>
              <th className="text-left py-1.5 px-3 font-medium">Reason</th>
              <th className="text-left py-1.5 px-3 font-medium w-[110px]">
                Source
              </th>
              <th className="py-1.5 px-1 w-8" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {visible.map((stakeholder, i) => (
              <tr key={i} className="hover:bg-muted/20 align-top">
                <td className="py-1.5 px-3">
                  <span className="inline-flex items-center gap-1.5">
                    {stakeholder.importance && (
                      <span
                        className="inline-block flex-shrink-0"
                        title={`${stakeholder.importance} importance`}
                      >
                        <ImportanceIndicator
                          importance={stakeholder.importance}
                        />
                      </span>
                    )}
                    {stakeholder.href ? (
                      <Link
                        href={stakeholder.href}
                        className="text-primary hover:underline font-medium text-sm"
                      >
                        {stakeholder.name}
                      </Link>
                    ) : (
                      <span className="font-medium text-sm">
                        {stakeholder.name}
                      </span>
                    )}
                    {stakeholder.role && (
                      <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[9px] font-semibold bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300 whitespace-nowrap">
                        {stakeholder.role}
                      </span>
                    )}
                  </span>
                </td>
                <td className="py-1.5 px-3">
                  <span
                    className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${POSITION_COLORS[stakeholder.position] ?? "bg-gray-100 text-gray-600"}`}
                  >
                    {stakeholder.position}
                  </span>
                </td>
                <td className="py-1.5 px-3 text-foreground/70 text-sm">
                  <EnrichedReasonCell
                    reason={stakeholder.reason}
                    context={stakeholder.context}
                    source={stakeholder.source}
                    sourceName={stakeholder.sourceName}
                  />
                </td>
                <td className="py-1.5 px-3">
                  {stakeholder.source ? (
                    <a
                      href={stakeholder.source}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:text-primary/80 text-xs hover:underline truncate block max-w-[100px]"
                      title={stakeholder.source}
                    >
                      {stakeholder.sourceName ?? "Link"}
                    </a>
                  ) : (
                    <span className="text-muted-foreground/30">&mdash;</span>
                  )}
                </td>
                <td className="py-1.5 px-1">
                  <SourceCheckDot
                    status={recordVerdictToStatus(stakeholder.verdict?.verdict)}
                    originalVerdict={stakeholder.verdict?.verdict}
                    size="md"
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shouldCollapse && !showAll && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-3 w-full text-center py-2 px-4 text-sm text-primary hover:text-primary/80 hover:bg-muted/40 rounded-lg border border-border/50 transition-colors"
        >
          Show {minor.length} more stakeholder
          {minor.length === 1 ? "" : "s"}
          <span className="text-muted-foreground/60 ml-1">
            (lower importance)
          </span>
        </button>
      )}
      {shouldCollapse && showAll && (
        <button
          onClick={() => setShowAll(false)}
          className="mt-3 w-full text-center py-2 px-4 text-sm text-muted-foreground hover:text-foreground hover:bg-muted/40 rounded-lg border border-border/50 transition-colors"
        >
          Show fewer
        </button>
      )}
    </div>
  );
}
