/**
 * Content Integrity Checks
 *
 * Pure functions that detect structural corruption, fabrication signals,
 * and content integrity issues in MDX pages. These feed into the
 * hallucination risk score as additional risk factors.
 *
 * Designed to catch issues like:
 *   - Page truncation (orphaned footnote references without definitions)
 *   - Fabricated citations (sequential arxiv IDs)
 *   - Duplicate footnote definitions
 *   - Unsourced footnotes (definitions with no URL)
 */

// ---------------------------------------------------------------------------
// Orphaned footnotes (truncation detection)
// ---------------------------------------------------------------------------

/**
 * Find footnote reference numbers [^N] used inline in the body.
 * Excludes definition lines (lines starting with [^N]:).
 */
export function findFootnoteRefs(body: string): Set<number> {
  const refs = new Set<number>();
  const pattern = /\[\^(\d+)\]/g;
  for (const line of body.split('\n')) {
    if (/^\[\^\d+\]:/.test(line.trim())) continue; // skip definitions
    pattern.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line)) !== null) {
      refs.add(parseInt(match[1], 10));
    }
  }
  return refs;
}

/**
 * Find footnote definition numbers [^N]: at the start of lines.
 */
export function findFootnoteDefs(body: string): Set<number> {
  const defs = new Set<number>();
  const pattern = /^\[\^(\d+)\]:/m;
  for (const line of body.split('\n')) {
    const match = pattern.exec(line.trim());
    if (match) {
      defs.add(parseInt(match[1], 10));
    }
  }
  return defs;
}

/**
 * Detect orphaned footnote references — inline [^N] with no matching [^N]: definition.
 * Strong signal of page truncation (the definitions section was cut off).
 */
export function detectOrphanedFootnotes(body: string): {
  orphanedRefs: number[];
  totalRefs: number;
  totalDefs: number;
  orphanedRatio: number;
} {
  const refs = findFootnoteRefs(body);
  const defs = findFootnoteDefs(body);

  const orphaned: number[] = [];
  for (const ref of refs) {
    if (!defs.has(ref)) orphaned.push(ref);
  }
  orphaned.sort((a, b) => a - b);

  return {
    orphanedRefs: orphaned,
    totalRefs: refs.size,
    totalDefs: defs.size,
    orphanedRatio: refs.size > 0 ? orphaned.length / refs.size : 0,
  };
}

// ---------------------------------------------------------------------------
// Duplicate footnote definitions
// ---------------------------------------------------------------------------

/**
 * Detect duplicate footnote definitions — same [^N]: appearing more than once.
 * Indicates copy-paste or merge errors.
 */
export function detectDuplicateFootnoteDefs(body: string): number[] {
  const seen = new Map<number, number>(); // footnote num → count
  const pattern = /^\[\^(\d+)\]:/m;
  for (const line of body.split('\n')) {
    const match = pattern.exec(line.trim());
    if (match) {
      const num = parseInt(match[1], 10);
      seen.set(num, (seen.get(num) ?? 0) + 1);
    }
  }
  const duplicates: number[] = [];
  for (const [num, count] of seen) {
    if (count > 1) duplicates.push(num);
  }
  return duplicates.sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Suspicious sequential IDs (fabrication detection)
// ---------------------------------------------------------------------------

/**
 * Detect suspicious sequential arxiv IDs that suggest LLM fabrication.
 * Real arxiv IDs are sparse (e.g., 2301.07041, 2305.14314); fabricated ones
 * are often sequential (2506.00001, 2506.00002, ...).
 *
 * Returns the longest run of sequential IDs found, if >= minRunLength.
 */
export function detectSequentialArxivIds(
  body: string,
  minRunLength: number = 3,
): {
  suspicious: boolean;
  longestRun: number;
  sequentialIds: string[];
} {
  // Extract all arxiv-like IDs: YYMM.NNNNN or YYMM.NNNN
  const arxivPattern = /\b(\d{4}\.\d{4,5})\b/g;
  const ids: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = arxivPattern.exec(body)) !== null) {
    ids.push(match[1]);
  }

  if (ids.length < minRunLength) {
    return { suspicious: false, longestRun: 0, sequentialIds: [] };
  }

  // Deduplicate and sort numerically
  const unique = [...new Set(ids)].sort();

  // Find longest run of sequential IDs (same prefix, consecutive numbers)
  let longestRun = 1;
  let currentRun = 1;
  let longestRunStart = 0;
  let currentRunStart = 0;

  for (let i = 1; i < unique.length; i++) {
    const prev = unique[i - 1];
    const curr = unique[i];

    // Check if same YYMM prefix and consecutive serial numbers
    const prevParts = prev.split('.');
    const currParts = curr.split('.');

    if (
      prevParts[0] === currParts[0] &&
      parseInt(currParts[1], 10) === parseInt(prevParts[1], 10) + 1
    ) {
      currentRun++;
      if (currentRun > longestRun) {
        longestRun = currentRun;
        longestRunStart = currentRunStart;
      }
    } else {
      currentRun = 1;
      currentRunStart = i;
    }
  }

  const suspicious = longestRun >= minRunLength;
  const sequentialIds = suspicious
    ? unique.slice(longestRunStart, longestRunStart + longestRun)
    : [];

  return { suspicious, longestRun, sequentialIds };
}

// ---------------------------------------------------------------------------
// Unsourced footnotes (no URL in definition)
// ---------------------------------------------------------------------------

/**
 * Count footnote definitions that contain no URL.
 * A footnote definition without a URL is likely fabricated or at minimum
 * unverifiable. Real citations should link to a source.
 */
export function detectUnsourcedFootnotes(body: string): {
  unsourced: number;
  totalDefs: number;
  unsourcedRatio: number;
} {
  const urlPattern = /https?:\/\/\S+/;
  let totalDefs = 0;
  let unsourced = 0;

  // Footnote definitions can span multiple lines (continuation lines are indented)
  const lines = body.split('\n');
  let currentDefContent = '';
  let inDef = false;

  for (const line of lines) {
    const defMatch = /^\[\^\d+\]:/.test(line.trim());

    if (defMatch) {
      // Flush previous definition
      if (inDef) {
        totalDefs++;
        if (!urlPattern.test(currentDefContent)) unsourced++;
      }
      currentDefContent = line;
      inDef = true;
    } else if (inDef && /^\s+\S/.test(line)) {
      // Continuation line (indented)
      currentDefContent += ' ' + line;
    } else {
      // End of footnote block
      if (inDef) {
        totalDefs++;
        if (!urlPattern.test(currentDefContent)) unsourced++;
      }
      inDef = false;
      currentDefContent = '';
    }
  }

  // Flush final definition
  if (inDef) {
    totalDefs++;
    if (!urlPattern.test(currentDefContent)) unsourced++;
  }

  return {
    unsourced,
    totalDefs,
    unsourcedRatio: totalDefs > 0 ? unsourced / totalDefs : 0,
  };
}

// ---------------------------------------------------------------------------
// Composite integrity assessment
// ---------------------------------------------------------------------------

export interface IntegrityResult {
  orphanedFootnotes: ReturnType<typeof detectOrphanedFootnotes>;
  duplicateFootnoteDefs: number[];
  sequentialArxivIds: ReturnType<typeof detectSequentialArxivIds>;
  unsourcedFootnotes: ReturnType<typeof detectUnsourcedFootnotes>;
}

/**
 * Run all content integrity checks on a page body.
 * Returns a structured result suitable for feeding into risk scoring.
 */
export function assessContentIntegrity(body: string): IntegrityResult {
  return {
    orphanedFootnotes: detectOrphanedFootnotes(body),
    duplicateFootnoteDefs: detectDuplicateFootnoteDefs(body),
    sequentialArxivIds: detectSequentialArxivIds(body),
    unsourcedFootnotes: detectUnsourcedFootnotes(body),
  };
}

/**
 * Compute risk score contribution from content integrity signals.
 * Returns individual factor contributions for transparency in the risk report.
 */
export function computeIntegrityRisk(integrity: IntegrityResult): {
  score: number;
  factors: string[];
} {
  let score = 0;
  const factors: string[] = [];

  // Orphaned footnotes — strong truncation signal
  const { orphanedRatio, orphanedRefs } = integrity.orphanedFootnotes;
  if (orphanedRefs.length > 0) {
    if (orphanedRatio > 0.5) {
      // Majority of footnotes are orphaned — page is severely truncated
      score += 30;
      factors.push('severe-truncation');
    } else {
      // Some orphaned footnotes — partial truncation or editing issues
      score += 15;
      factors.push('orphaned-footnotes');
    }
  }

  // Sequential arxiv IDs — fabrication signal
  if (integrity.sequentialArxivIds.suspicious) {
    score += 25;
    factors.push('suspicious-sequential-ids');
  }

  // Duplicate footnote definitions — editing/merge error
  if (integrity.duplicateFootnoteDefs.length > 0) {
    score += 10;
    factors.push('duplicate-footnote-defs');
  }

  // Unsourced footnotes — unverifiable claims
  const { unsourcedRatio, unsourced } = integrity.unsourcedFootnotes;
  if (unsourced > 0) {
    if (unsourcedRatio > 0.5) {
      score += 10;
      factors.push('mostly-unsourced-footnotes');
    } else {
      score += 5;
      factors.push('some-unsourced-footnotes');
    }
  }

  return { score, factors };
}
