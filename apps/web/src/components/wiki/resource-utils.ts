/** Shared constants and helpers for resource rendering components */

import { normalizeUrlForDedup } from "@longterm-wiki/url-utils";
import {
  CITATION_VERDICT_KEYS,
  type CitationVerdictKey,
  CITATION_VERDICT_STYLES,
  CITATION_VERDICT_COLORS,
  CITATION_VERDICT_SEVERITY,
} from "@/components/shared/verdict-styles";

/**
 * Re-export the canonical dedup-mode normalizer under the historical
 * `normalizeUrl` name expected by ReferenceCitationDot/Details.
 */
export { normalizeUrlForDedup as normalizeUrl };

// Re-export citation verdict constants under their original names for backward compatibility
export const VERDICT_KEYS = CITATION_VERDICT_KEYS;
export type VerdictKey = CitationVerdictKey;
export const VERDICT_SEVERITY = CITATION_VERDICT_SEVERITY;
export const VERDICT_COLORS = CITATION_VERDICT_COLORS;
export const VERDICT_STYLES = CITATION_VERDICT_STYLES;

/** Maximum claims to display before showing "+N more" */
export const MAX_CLAIMS_SHOWN = 8;

/** Format a list of author names for display in reference entries */
export function formatAuthors(authors: string[]): string {
  if (authors.length === 0) return "";
  if (authors.length === 1) return authors[0];
  if (authors.length === 2) return `${authors[0]} & ${authors[1]}`;
  if (authors.length <= 4)
    return authors.slice(0, -1).join(", ") + " & " + authors[authors.length - 1];
  return `${authors[0]} et al.`;
}

/** Extract the display domain from a URL (strips www.) */
export function getDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Check if a URL uses a safe protocol (http or https) */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export const typeIcons: Record<string, string> = {
  paper: "\ud83d\udcc4",
  book: "\ud83d\udcda",
  blog: "\u270f\ufe0f",
  report: "\ud83d\udccb",
  talk: "\ud83c\udf99\ufe0f",
  podcast: "\ud83c\udfa7",
  government: "\ud83c\udfdb\ufe0f",
  reference: "\ud83d\udcd6",
  web: "\ud83d\udd17",
};

export function getResourceTypeIcon(type: string): string {
  return typeIcons[type] || "\ud83d\udd17";
}
