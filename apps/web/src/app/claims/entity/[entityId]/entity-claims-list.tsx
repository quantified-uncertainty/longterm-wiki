"use client";

import { useState } from "react";
import Link from "next/link";
import {
  CheckCircle2,
  AlertTriangle,
  Clock,
  ChevronDown,
  ChevronRight,
  FileText,
  Hash,
} from "lucide-react";
import { cn } from "@lib/utils";
import { renderInlineMarkdown } from "@/lib/inline-markdown";
import type { ClaimRow } from "@wiki-server/api-response-types";

type ClaimSource = NonNullable<ClaimRow['sources']>[number];

import { VerdictBadge } from "../../components/verdict-badge";
import { CategoryBadge } from "../../components/category-badge";
import { CLAIM_VERDICT_CONFIG } from "../../components/verdict-config";

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  } catch {
    return iso;
  }
}

interface SectionGroup {
  section: string;
  claims: ClaimRow[];
}

function groupClaimsBySection(claims: ClaimRow[]): SectionGroup[] {
  const map = new Map<string, ClaimRow[]>();
  for (const claim of claims) {
    const section = claim.section || "General";
    if (!map.has(section)) map.set(section, []);
    map.get(section)!.push(claim);
  }
  return Array.from(map.entries()).map(([section, claims]) => ({
    section,
    claims,
  }));
}

/** Number of section groups visible before "Show more" */
const INITIAL_VISIBLE = 5;

function ClaimCard({ claim }: { claim: ClaimRow }) {
  const verdict = claim.claimVerdict
    ? CLAIM_VERDICT_CONFIG[claim.claimVerdict]
    : null;
  const Icon = verdict?.icon;

  // Get the best available source quote
  let sourceQuote: string | null = null;
  if (claim.sources && claim.sources.length > 0) {
    const primary = claim.sources.find((s: ClaimSource) => s.isPrimary);
    sourceQuote =
      (primary || claim.sources[0]).sourceQuote || claim.sourceQuote || null;
  } else {
    sourceQuote = claim.sourceQuote || null;
  }

  const hasSources = claim.sources && claim.sources.length > 0;

  return (
    <div className={cn("px-4 py-2.5", verdict?.bg)}>
      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <p className="text-sm text-foreground leading-snug mb-1">
            {renderInlineMarkdown(claim.claimText)}
          </p>

          {sourceQuote && (
            <blockquote className="text-xs text-muted-foreground border-l-2 border-border pl-2.5 mb-1.5 italic leading-snug line-clamp-2">
              &ldquo;{sourceQuote}&rdquo;
            </blockquote>
          )}

          <div className="flex items-center flex-wrap gap-2 text-xs">
            {verdict && Icon && (
              <span
                className={cn(
                  "inline-flex items-center gap-1",
                  verdict.color
                )}
              >
                <Icon className="w-3 h-3" />
                {verdict.label}
              </span>
            )}
            {claim.claimVerdictScore != null && (
              <span className="text-muted-foreground tabular-nums">
                {Math.round(claim.claimVerdictScore * 100)}%
              </span>
            )}
            {claim.claimVerdictIssues && (
              <span className="text-amber-600 dark:text-amber-400 line-clamp-1">
                {claim.claimVerdictIssues}
              </span>
            )}
            {claim.claimCategory && (
              <CategoryBadge category={claim.claimCategory} />
            )}
            {hasSources && (
              <span className="inline-flex items-center gap-0.5 text-blue-600">
                <FileText className="w-3 h-3" />
                {claim.sources!.length} source
                {claim.sources!.length !== 1 ? "s" : ""}
              </span>
            )}
            {claim.claimVerifiedAt && (
              <span className="text-muted-foreground/60 ml-auto flex items-center gap-1">
                <Clock className="w-3 h-3" />
                {formatDate(claim.claimVerifiedAt)}
              </span>
            )}
          </div>
        </div>

        <Link
          href={`/claims/claim/${claim.id}`}
          className="text-[10px] text-muted-foreground hover:text-blue-600 shrink-0 mt-0.5"
          title="View claim detail"
        >
          <Hash className="w-3 h-3 inline" />
          {claim.id}
        </Link>
      </div>
    </div>
  );
}

export function EntityClaimsList({ claims }: { claims: ClaimRow[] }) {
  const [showAll, setShowAll] = useState(false);
  const [collapsedSections, setCollapsedSections] = useState<Set<string>>(
    new Set()
  );

  const groups = groupClaimsBySection(claims);
  const visibleGroups =
    showAll || groups.length <= INITIAL_VISIBLE
      ? groups
      : groups.slice(0, INITIAL_VISIBLE);
  const hiddenCount = groups.length - INITIAL_VISIBLE;

  const toggleSection = (section: string) => {
    setCollapsedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  // Summary stats for header
  const verdictCounts: Record<string, number> = {};
  for (const claim of claims) {
    const v = claim.claimVerdict ?? "unchecked";
    verdictCounts[v] = (verdictCounts[v] || 0) + 1;
  }

  return (
    <div>
      {/* Summary badges */}
      <div className="flex flex-wrap gap-2 text-xs text-muted-foreground mb-4">
        <span>
          {claims.length} claim{claims.length !== 1 ? "s" : ""} across{" "}
          {groups.length} section{groups.length !== 1 ? "s" : ""}
        </span>
        {verdictCounts.verified && verdictCounts.verified > 0 && (
          <span className="inline-flex items-center gap-1 text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="w-3 h-3" />
            {verdictCounts.verified} verified
          </span>
        )}
        {((verdictCounts.disputed ?? 0) > 0 ||
          (verdictCounts.unsupported ?? 0) > 0) && (
          <span className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-3 h-3" />
            {(verdictCounts.disputed ?? 0) + (verdictCounts.unsupported ?? 0)}{" "}
            flagged
          </span>
        )}
      </div>

      {/* Section groups */}
      <div className="space-y-3">
        {visibleGroups.map((group) => {
          const isCollapsed = collapsedSections.has(group.section);
          return (
            <div
              key={group.section}
              className="border border-border rounded-lg overflow-hidden"
            >
              <button
                onClick={() => toggleSection(group.section)}
                className="flex items-center gap-2 w-full text-left px-4 py-2 bg-muted/50 border-b border-border hover:bg-muted/70 transition-colors"
              >
                {isCollapsed ? (
                  <ChevronRight className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                ) : (
                  <ChevronDown className="w-3.5 h-3.5 text-muted-foreground shrink-0" />
                )}
                <span className="text-sm font-medium text-accent-foreground">
                  {group.section}
                </span>
                <span className="text-xs text-muted-foreground">
                  {group.claims.length} claim
                  {group.claims.length !== 1 ? "s" : ""}
                </span>
              </button>

              {!isCollapsed && (
                <div className="divide-y divide-border">
                  {group.claims.map((claim) => (
                    <ClaimCard key={claim.id} claim={claim} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Show more / less toggle */}
      {groups.length > INITIAL_VISIBLE && (
        <button
          onClick={() => setShowAll(!showAll)}
          className="text-xs text-muted-foreground hover:text-foreground transition-colors mt-3"
        >
          {showAll
            ? "Show fewer sections"
            : `Show ${hiddenCount} more section${hiddenCount !== 1 ? "s" : ""}...`}
        </button>
      )}
    </div>
  );
}
