/**
 * Cross-PR dependency surfacing (QUA-287 Phase 3)
 *
 * Given a detected PR plus the live open-PR list, extract other PRs that this
 * PR appears to depend on or be blocked by. Two sources:
 *
 *   1. GitHub CrossReferencedEvent timeline items — any open PR that references
 *      this PR via `#NNNN` in its body/comments shows up here.
 *   2. `#NNNN` tokens scraped from CI/gate error output and bot-review comment
 *      bodies. These are VALIDATED against the open-PR list — unknown or
 *      closed/merged PR numbers are dropped to avoid surfacing noise (e.g.
 *      incidental mentions of #123 that isn't a PR ref).
 *
 * Pure functions — no I/O. Used by both the lib scanner and the patrol daemon.
 */

import type {
  BlockedOnPr,
  DetectedPr,
  GqlPrNode,
} from './types.ts';

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Matches `#NNNN` tokens where the number is 1-6 digits. We cap at 6 digits to
 * avoid matching arbitrary numeric strings in hashes or file diffs. The leading
 * `#` must be preceded by start-of-string, whitespace, or common punctuation
 * (parens, brackets, etc.) so we don't catch hex like `abc#123`.
 */
const PR_REF_TOKEN_RE = /(?:^|[\s(\[{<,.;!?/\\])#(\d{1,6})\b/g;

/** Extract all `#NNNN` tokens from a string. De-duplicates. */
export function extractPrRefTokens(text: string): number[] {
  if (!text) return [];
  const seen = new Set<number>();
  PR_REF_TOKEN_RE.lastIndex = 0; // ensure clean regex state for global re
  for (const match of text.matchAll(PR_REF_TOKEN_RE)) {
    const n = Number(match[1]);
    if (Number.isFinite(n) && n > 0) seen.add(n);
  }
  return [...seen];
}

/**
 * Validate a list of candidate PR refs against the set of OPEN PR numbers.
 * Returns only the refs that correspond to an open PR, excluding `selfPr`
 * (a PR can't block itself).
 */
export function validatePrRefs(
  candidates: readonly number[],
  openPrNumbers: ReadonlySet<number>,
  selfPr: number,
): number[] {
  const valid: number[] = [];
  const seen = new Set<number>();
  for (const n of candidates) {
    if (n === selfPr) continue;
    if (!openPrNumbers.has(n)) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    valid.push(n);
  }
  return valid;
}

// ── CrossReferencedEvent extraction ──────────────────────────────────────────

/**
 * Extract open-PR refs from a PR node's CrossReferencedEvent timeline items.
 *
 * Only PullRequest sources with `state === 'OPEN'` are returned — closed or
 * merged PRs can't block anything. Issue sources are ignored.
 *
 * The `state` check is defensive: if the field is missing (older API or future
 * schema change) we still fall back to the open-PR-list validation done by the
 * caller, so either path filters out dead refs.
 */
export function extractCrossReferencedPrs(pr: GqlPrNode): number[] {
  const items = pr.timelineItems?.nodes ?? [];
  const seen = new Set<number>();
  for (const item of items) {
    if (item.__typename && item.__typename !== 'CrossReferencedEvent') continue;
    const src = item.source;
    if (!src) continue;
    // Ignore issues — we only want cross-PR dependencies.
    if (src.__typename && src.__typename !== 'PullRequest') continue;
    // If state is present and not OPEN, skip. (Missing state is allowed so the
    // downstream open-PR-list validation is still the source of truth.)
    if (src.state && src.state !== 'OPEN') continue;
    const num = src.number;
    if (typeof num !== 'number' || !Number.isFinite(num) || num <= 0) continue;
    if (num === pr.number) continue;
    seen.add(num);
  }
  return [...seen];
}

// ── Top-level: populate blockedOnPrs on DetectedPr[] ─────────────────────────

/**
 * Post-process detected PRs by populating `blockedOnPrs` for each.
 *
 * Sources scanned:
 *   - `pr.timelineItems` CrossReferencedEvents (reason: "cross-referenced")
 *   - `detected.failingChecks` check names (reason: "failing check")
 *   - `detected.botComments[].body` bodies (reason: "bot comment")
 *
 * All candidate `#NNNN` tokens from text sources are validated against
 * `allOpenPrs` — anything that isn't a live open PR is dropped.
 *
 * Mutates `detected` in place (each entry gets a `blockedOnPrs` field iff
 * there's at least one valid reference). Returns the same array for chaining.
 *
 * The function is intentionally O(n * m) where n = detected PRs and m = refs
 * per PR. Both are tiny (≤50, ≤20) so this is fine.
 */
export function populateBlockedOnPrs(
  detected: DetectedPr[],
  prNodes: readonly GqlPrNode[],
): DetectedPr[] {
  const openPrNumbers = new Set(prNodes.map((p) => p.number));
  const nodeByNumber = new Map<number, GqlPrNode>();
  for (const node of prNodes) nodeByNumber.set(node.number, node);

  for (const pr of detected) {
    const node = nodeByNumber.get(pr.number);
    const refs = new Map<number, string>(); // prNum → reason (first-wins)

    // 1. CrossReferencedEvent timeline items — these are already validated as
    //    "another PR mentions this one" so we trust them, but still filter
    //    through openPrNumbers in case state lags.
    if (node) {
      const crossRefs = extractCrossReferencedPrs(node);
      const validCrossRefs = validatePrRefs(crossRefs, openPrNumbers, pr.number);
      for (const n of validCrossRefs) {
        if (!refs.has(n)) refs.set(n, 'cross-referenced');
      }
    }

    // 2. Scrape `#NNNN` tokens from failing check names. Gate checks sometimes
    //    print tokens like "conflicts with #4188"; validate against open PRs.
    const checkTokens = new Set<number>();
    for (const check of pr.failingChecks ?? []) {
      for (const n of extractPrRefTokens(check)) checkTokens.add(n);
    }
    const validCheckTokens = validatePrRefs([...checkTokens], openPrNumbers, pr.number);
    for (const n of validCheckTokens) {
      if (!refs.has(n)) refs.set(n, 'gate error');
    }

    // 3. Scrape `#NNNN` tokens from bot-review comment bodies. CodeRabbit often
    //    cross-references sibling PRs in its review text.
    const botTokens = new Set<number>();
    for (const bc of pr.botComments ?? []) {
      for (const n of extractPrRefTokens(bc.body ?? '')) botTokens.add(n);
    }
    const validBotTokens = validatePrRefs([...botTokens], openPrNumbers, pr.number);
    for (const n of validBotTokens) {
      if (!refs.has(n)) refs.set(n, 'bot comment');
    }

    if (refs.size > 0) {
      const blockedOnPrs: BlockedOnPr[] = [...refs.entries()]
        .map(([prNum, reason]) => ({ pr: prNum, reason }))
        .sort((a, b) => a.pr - b.pr);
      pr.blockedOnPrs = blockedOnPrs;
    }
  }

  return detected;
}

// ── Dependency-chain utilities (for rendering and priority boosting) ─────────

/**
 * Build an index of "blocks" relationships: for each PR that appears in some
 * other PR's `blockedOnPrs`, count how many other detected PRs depend on it.
 *
 * This is the reverse of `blockedOnPrs`: if PR A lists PR B in `blockedOnPrs`,
 * then B blocks A. Returns a map `prNumber → count-of-PRs-blocked`.
 */
export function computeBlocksCount(detected: readonly DetectedPr[]): Map<number, number> {
  const counts = new Map<number, number>();
  for (const pr of detected) {
    for (const dep of pr.blockedOnPrs ?? []) {
      counts.set(dep.pr, (counts.get(dep.pr) ?? 0) + 1);
    }
  }
  return counts;
}
