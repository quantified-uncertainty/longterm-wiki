/**
 * Pre-processes MDX content to inject footnote definitions for DB-driven references.
 *
 * Scans for [^cr-XXXX] (claim reference) and [^rc-XXXX] (citation reference) markers.
 * Looks up reference data and generates standard [^N] footnote definitions that
 * remark-gfm can process.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ClaimRefData {
  claimId: number;
  claimText: string;
  sourceUrl?: string;
  sourceTitle?: string;
  verdict?: string;
  verdictScore?: number;
}

export interface CitationData {
  title?: string;
  url?: string;
  note?: string;
  resourceId?: string;
}

export interface ReferenceData {
  /** Keyed by reference_id, e.g. "cr-3d34" */
  claimReferences: Map<string, ClaimRefData>;
  /** Keyed by reference_id, e.g. "rc-4552" */
  citations: Map<string, CitationData>;
}

export type RefKind = "claim" | "citation";

export interface RefMapEntry {
  kind: RefKind;
  originalId: string;
  footnoteNumber: number;
  data: ClaimRefData | CitationData | null;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Regex that matches DB-driven reference *usage sites* in the body text,
 * i.e. `[^cr-XXXX]` or `[^rc-XXXX]`. The reference ID is captured in group 1.
 *
 * NOTE: This intentionally does NOT match the definition form `[^cr-XXXX]: ...`
 * because we never expect those to be authored — we generate them ourselves.
 */
const DB_REF_USAGE_RE = /\[\^(cr-[a-zA-Z0-9]+|rc-[a-zA-Z0-9]+)\]/g;

/**
 * Escape `<` characters that could trigger JSX/HTML parsing in MDX footnote
 * definitions. Database-sourced citation text may contain raw angle brackets
 * (e.g. `<U.S.C.`, `<EntityLink>`) that break MDX compilation.
 */
function sanitizeFootnoteText(text: string): string {
  // Escape `<` followed by a letter (tag start) or `/` (closing tag)
  return text.replace(/<(?=[a-zA-Z/])/g, "\\<");
}

/**
 * Build the footnote definition string for a claim reference.
 */
function buildClaimFootnote(data: ClaimRefData): string {
  const parts: string[] = [];
  if (data.sourceTitle && data.sourceUrl) {
    parts.push(`[${data.sourceTitle}](${data.sourceUrl})`);
  } else if (data.sourceUrl) {
    parts.push(`[Source](${data.sourceUrl})`);
  } else if (data.sourceTitle) {
    parts.push(data.sourceTitle);
  }
  if (data.claimText) {
    // Truncate long claim text to keep footnotes readable
    const text =
      data.claimText.length > 200
        ? data.claimText.slice(0, 197) + "..."
        : data.claimText;
    parts.push(`"${text}"`);
  }
  if (data.verdict) {
    parts.push(`(${data.verdict})`);
  }
  return sanitizeFootnoteText(parts.join(" — ") || "Claim reference");
}

/**
 * Build the footnote definition string for a citation reference.
 *
 * Deduplicates when `note` already starts with `title` text (a common data
 * issue where the LLM-generated note repeats the source title).
 */
function buildCitationFootnote(data: CitationData): string {
  // Deduplicate: if note already starts with the title text, use note alone.
  // Normalize whitespace and compare case-insensitively to catch DB variations.
  const normalizedTitle = data.title?.trim();
  const normalizedNote = data.note?.trimStart();
  const noteOverlapsTitle = Boolean(
    normalizedTitle &&
      normalizedNote &&
      normalizedNote.toLowerCase().startsWith(normalizedTitle.toLowerCase())
  );

  if (data.title && data.url && !noteOverlapsTitle) {
    const link = `[${data.title}](${data.url})`;
    return sanitizeFootnoteText(data.note ? `${link} — ${data.note}` : link);
  }
  if (data.url) {
    // When note overlaps title, use note as the link text instead
    const linkText = noteOverlapsTitle ? normalizedNote! : (data.title || data.url);
    const link = `[${linkText}](${data.url})`;
    return sanitizeFootnoteText(link);
  }
  if (data.title) {
    const text = noteOverlapsTitle
      ? normalizedNote!
      : (data.note ? `${data.title} — ${data.note}` : data.title);
    return sanitizeFootnoteText(text);
  }
  return sanitizeFootnoteText(data.note || "Citation");
}

/**
 * Pre-process MDX content, replacing DB-driven reference markers with standard
 * numbered footnotes and appending footnote definitions.
 *
 * This function is **pure**: it receives content + reference data and returns
 * transformed content. No side effects, no DB calls.
 *
 * @returns The modified content and a map of footnote-number to reference data.
 */
export function preprocessReferences(
  mdxContent: string,
  referenceData: ReferenceData
): { content: string; referenceMap: Map<number, RefMapEntry> } {
  const referenceMap = new Map<number, RefMapEntry>();

  // -----------------------------------------------------------------------
  // 1. Find the highest existing numeric footnote to avoid collisions.
  // A small number of pages may still have orphaned [^N] refs (no defs)
  // left over from before migration. Start numbering after those to
  // prevent duplicate footnote definitions.
  // -----------------------------------------------------------------------
  let maxExisting = 0;
  const legacyUsageRe = /\[\^(\d+)\]/g;
  for (const m of mdxContent.matchAll(legacyUsageRe)) {
    const n = parseInt(m[1], 10);
    if (n > maxExisting) maxExisting = n;
  }

  // -----------------------------------------------------------------------
  // 2. Collect all unique DB-driven reference IDs used in the content
  // -----------------------------------------------------------------------
  const usedRefIds = new Set<string>();
  const dbMatches = mdxContent.matchAll(DB_REF_USAGE_RE);
  for (const m of dbMatches) {
    usedRefIds.add(m[1]);
  }

  // If there are no DB-driven references, return content unchanged.
  if (usedRefIds.size === 0) {
    return { content: mdxContent, referenceMap };
  }

  // -----------------------------------------------------------------------
  // 3. Sort reference IDs for deterministic numbering
  // -----------------------------------------------------------------------
  const sortedRefIds = Array.from(usedRefIds).sort();

  // -----------------------------------------------------------------------
  // 4. Assign sequential numbers starting after maxExisting
  // -----------------------------------------------------------------------
  const idToNumber = new Map<string, number>();
  let nextNumber = maxExisting + 1;
  for (const refId of sortedRefIds) {
    idToNumber.set(refId, nextNumber);
    nextNumber++;
  }

  // -----------------------------------------------------------------------
  // 5. Replace [^cr-XXXX] / [^rc-XXXX] usage sites with [^N]
  // -----------------------------------------------------------------------
  let transformed = mdxContent.replace(DB_REF_USAGE_RE, (_match, refId: string) => {
    const num = idToNumber.get(refId);
    return num !== undefined ? `[^${num}]` : _match;
  });

  // -----------------------------------------------------------------------
  // 6. Build footnote definitions and the referenceMap
  // -----------------------------------------------------------------------
  const footnoteLines: string[] = [];

  for (const refId of sortedRefIds) {
    const num = idToNumber.get(refId)!;
    const isClaim = refId.startsWith("cr-");

    let definitionText: string;
    let kind: RefKind;
    let data: ClaimRefData | CitationData | null = null;

    if (isClaim) {
      kind = "claim";
      const claimData = referenceData.claimReferences.get(refId);
      if (claimData) {
        data = claimData;
        definitionText = buildClaimFootnote(claimData);
      } else {
        definitionText = `Claim reference ${refId} (data unavailable — rebuild with wiki-server access)`;
      }
    } else {
      kind = "citation";
      const citData = referenceData.citations.get(refId);
      if (citData) {
        data = citData;
        definitionText = buildCitationFootnote(citData);
      } else {
        definitionText = `Citation ${refId} (data unavailable — rebuild with wiki-server access)`;
      }
    }

    footnoteLines.push(`[^${num}]: ${definitionText}`);
    referenceMap.set(num, { kind, originalId: refId, footnoteNumber: num, data });
  }

  // -----------------------------------------------------------------------
  // 7. Append footnote definitions at the end of the content
  // -----------------------------------------------------------------------
  // Ensure there's a blank line before footnote definitions
  const trimmed = transformed.trimEnd();
  transformed = trimmed + "\n\n" + footnoteLines.join("\n") + "\n";

  return { content: transformed, referenceMap };
}

/**
 * Convenience: create an empty ReferenceData for pages with no DB references.
 */
export function emptyReferenceData(): ReferenceData {
  return {
    claimReferences: new Map(),
    citations: new Map(),
  };
}
