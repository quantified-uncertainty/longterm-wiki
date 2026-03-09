"use client";

import { createContext, useContext, useMemo } from "react";
import type { AccuracyVerdict } from "@wiki-server/api-types";

/**
 * A single entry in the reference map, representing either a claim-backed
 * citation or a regular (non-verified) citation.
 *
 * When `type` is "claim", the claim-specific fields are populated from
 * the wiki-server's citation_quotes table (via CitationQuote data).
 *
 * When `type` is "citation", only the basic citation fields are populated
 * from the DB-driven reference data.
 */
export interface RefMapEntry {
  type: "claim" | "citation" | "kb";

  // --- Claim fields (populated when type === "claim") ---
  /** Claim text from the citation verification system */
  claimText?: string;
  /** Accuracy verdict from the citation verification pipeline */
  verdict?: AccuracyVerdict | null;
  /** Accuracy confidence score (0-1) */
  verdictScore?: number | null;
  /** Whether the source quote was verified */
  quoteVerified?: boolean;
  /** URL of the source that was checked */
  sourceUrl?: string | null;
  /** Title of the source */
  sourceTitle?: string | null;
  /** Direct quote from the source supporting/contradicting the claim */
  sourceQuote?: string | null;
  /** Accuracy issues description */
  accuracyIssues?: string | null;
  /** When the accuracy was last checked (ISO date string) */
  checkedAt?: string | null;
  /** Resource ID if the source is a known resource */
  resourceId?: string | null;

  // --- Citation fields (populated when type === "citation") ---
  /** Display title for the citation */
  title?: string | null;
  /** URL of the cited source */
  url?: string | null;
  /** Domain name extracted from URL */
  domain?: string | null;
  /** Note or additional context */
  note?: string | null;

  // --- KB fact fields (populated when type === "kb") ---
  /** KB entity ID (slug) */
  kbEntity?: string;
  /** KB property ID */
  kbProperty?: string;
  /** Formatted display value */
  kbValue?: string;
  /** As-of date */
  kbAsOf?: string;
  /** Source URL */
  kbSource?: string;
  /** Source resource ID */
  kbSourceResource?: string;
  /** Notes */
  kbNotes?: string;
}

interface ReferenceContextValue {
  /** Map from footnote number (1-based) to reference data */
  referenceMap: Map<number, RefMapEntry>;
}

const ReferenceContext = createContext<ReferenceContextValue>({
  referenceMap: new Map(),
});

/**
 * ReferenceProvider -- wraps MDX content with a map from footnote numbers
 * to rich reference data (claim verification + source metadata).
 *
 * The map is built in the wiki page server component from:
 * 1. Citation quotes from the wiki-server (claim verification data)
 * 2. DB-driven reference data (preprocessor map)
 *
 * Client components (FootnoteTooltip) consume this via useReferenceData().
 */
export function ReferenceProvider({
  children,
  referenceMap,
}: {
  children: React.ReactNode;
  referenceMap: Map<number, RefMapEntry>;
}) {
  // Memoize the context value to avoid unnecessary re-renders
  const value = useMemo(() => ({ referenceMap }), [referenceMap]);

  return (
    <ReferenceContext value={value}>
      {children}
    </ReferenceContext>
  );
}

/**
 * Hook to look up reference data for a specific footnote number.
 * Returns undefined if the footnote has no associated reference data.
 */
export function useReferenceData(
  footnoteNumber: number
): RefMapEntry | undefined {
  const ctx = useContext(ReferenceContext);
  return ctx.referenceMap.get(footnoteNumber);
}

/**
 * Hook to get the full reference map. Useful for components that need
 * to iterate over all references (e.g., the footnote definitions section).
 */
export function useAllReferences(): Map<number, RefMapEntry> {
  const ctx = useContext(ReferenceContext);
  return ctx.referenceMap;
}
