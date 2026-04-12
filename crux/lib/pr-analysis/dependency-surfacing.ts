/**
 * PR Analysis — Cross-PR dependency surfacing (QUA-287 Phase 3).
 *
 * Extracts outgoing PR dependencies for each detected PR:
 *   1. `timelineItems(CROSS_REFERENCED_EVENT)` — structural: when PR A appears
 *      as the `source` of a cross-ref event on PR B, A → B (A mentions B).
 *   2. `#NNNN` tokens in the PR body — textual signal of dependency.
 *   3. `#NNNN` tokens in failing-check context strings — "gate error"
 *      signal (e.g. a CI message like "waiting on #4186 to merge").
 *
 * Refs are validated against the set of currently-open PR numbers to drop
 * issue references, merged PRs, and noise tokens like "#1 priority".
 *
 * A second pass computes `blocksOthers` for each PR — how many OTHER open
 * PRs list this PR in their `blockedOnPrs`. This enables scoring to boost
 * stuck PRs blocking multiple dependents.
 */

import type {
  DetectedPr,
  GqlPrNode,
  PrDependencyReason,
} from './types.ts';

/**
 * Regex matching `#NNNN` issue/PR references in free text.
 * Captures the number in group 1. Uses a negative lookbehind for alphanumeric
 * characters to avoid matching things like `v#123` or `abc#123`.
 */
const PR_REF_RE = /(?:^|[^\w])#(\d+)\b/g;

/**
 * Extract PR numbers referenced in a block of text.
 * Returns unique numbers in the order they first appear.
 */
export function extractPrRefsFromText(text: string | null | undefined): number[] {
  if (!text) return [];
  const found: number[] = [];
  const seen = new Set<number>();
  for (const match of text.matchAll(PR_REF_RE)) {
    const n = Number(match[1]);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (seen.has(n)) continue;
    seen.add(n);
    found.push(n);
  }
  return found;
}

/**
 * Extract outgoing PR refs for a single PR.
 *
 * @param pr         The raw GraphQL PR node.
 * @param openPrs    Set of PR numbers present in the current scan (validation filter).
 * @param failingChecks  Optional failing-check context strings (e.g. `['ci/gate: #4186 pending']`).
 * @returns          Deduped list of refs with the most structural reason kept first.
 */
export function extractPrReferences(
  pr: GqlPrNode,
  openPrs: Set<number>,
  failingChecks?: string[],
): Array<{ pr: number; reason: PrDependencyReason }> {
  const result: Array<{ pr: number; reason: PrDependencyReason }> = [];
  const seen = new Set<number>();

  const tryAdd = (num: number, reason: PrDependencyReason): void => {
    if (!Number.isFinite(num) || num <= 0) return;
    if (num === pr.number) return; // self-ref
    if (!openPrs.has(num)) return; // validation: must be an open PR in current scan
    if (seen.has(num)) return;
    seen.add(num);
    result.push({ pr: num, reason });
  };

  // 1. Structural: timelineItems source PRs.
  //    NOTE: a CrossReferencedEvent on PR A with source=B means B → A (B mentions A).
  //    So from A's perspective, these are INCOMING refs, not A's outgoing dependencies.
  //    The applyDependencySurfacing() caller handles the inversion across the full
  //    PR set. extractPrReferences() only returns OUTGOING dependencies derived from
  //    A's own body + failing checks.

  // 2. Body: `#NNNN` tokens.
  for (const n of extractPrRefsFromText(pr.body)) tryAdd(n, 'body-reference');

  // 3. Failing-check contexts: `#NNNN` tokens.
  for (const text of failingChecks ?? []) {
    for (const n of extractPrRefsFromText(text)) tryAdd(n, 'gate-error');
  }

  return result;
}

/**
 * Populate `blockedOnPrs` and `blocksOthers` on every detected PR.
 *
 * Mutates `detected` in place. Safe to call with an empty list.
 *
 * Two passes:
 *   1. Outgoing: extractPrReferences (body + failing-checks) for each detected PR.
 *   2. Structural inversion: for each raw PR node Y, read Y.timelineItems; for
 *      each CrossReferencedEvent with source = X (open PR), X → Y. Append Y to
 *      X.blockedOnPrs with reason 'timeline-reference' (dedup by PR number, so
 *      if Y was already added via body/gate-error, that reason wins).
 *   3. Aggregation: compute `blocksOthers[A] = count of detected PRs listing A in blockedOnPrs`.
 */
export function applyDependencySurfacing(
  detected: DetectedPr[],
  rawNodes: GqlPrNode[],
): void {
  if (detected.length === 0) return;

  const detectedByNumber = new Map<number, DetectedPr>();
  for (const d of detected) detectedByNumber.set(d.number, d);

  // Validate against the full open-PR set, not just `detected` — a PR filtered
  // out of `detected` (e.g. draft, bot-authored) can still be a legitimate
  // dependency target. We still only *attach* blockedOnPrs to detected PRs.
  const openPrs = new Set<number>(rawNodes.map((n) => n.number));

  const nodeByNumber = new Map<number, GqlPrNode>();
  for (const n of rawNodes) nodeByNumber.set(n.number, n);

  // Pass 1: outgoing refs from body + failing-check messages.
  for (const pr of detected) {
    const node = nodeByNumber.get(pr.number);
    if (!node) continue;
    const refs = extractPrReferences(node, openPrs, pr.failingChecks);
    if (refs.length > 0) {
      pr.blockedOnPrs = refs;
    }
  }

  // Pass 2: invert timelineItems to pick up structural outgoing refs.
  // On PR Y, CrossReferencedEvent.source = X means X → Y.
  for (const yNode of rawNodes) {
    const events = yNode.timelineItems?.nodes ?? [];
    for (const ev of events) {
      if (ev.__typename !== 'CrossReferencedEvent') continue;
      const source = ev.source;
      if (!source || source.__typename !== 'PullRequest') continue;
      const xNum = source.number;
      if (typeof xNum !== 'number' || xNum === yNode.number) continue;
      // Only surface on detected PRs (the ones that will be scored/rendered).
      const xPr = detectedByNumber.get(xNum);
      if (!xPr) continue;
      // Skip if Y isn't in the current open set or is the same PR.
      if (!openPrs.has(yNode.number)) continue;
      // Dedup against body/gate-error reasons (those win — more actionable).
      const existing = xPr.blockedOnPrs ??= [];
      if (existing.some((r) => r.pr === yNode.number)) continue;
      existing.push({ pr: yNode.number, reason: 'timeline-reference' });
    }
  }

  // Pass 3: aggregate blocksOthers.
  const blocksCount = new Map<number, number>();
  for (const pr of detected) {
    for (const ref of pr.blockedOnPrs ?? []) {
      blocksCount.set(ref.pr, (blocksCount.get(ref.pr) ?? 0) + 1);
    }
  }
  for (const pr of detected) {
    const count = blocksCount.get(pr.number) ?? 0;
    if (count > 0) pr.blocksOthers = count;
  }
}
