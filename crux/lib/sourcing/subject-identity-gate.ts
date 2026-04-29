/**
 * Subject-Identity Gate — QUA-724
 *
 * Drops candidate source URLs whose primary subject (Wikidata QID) does not
 * match the parent entity's QID, before they reach `source_check_evidence` /
 * `url_suggestions` storage. Sits in the propose-fact pipeline at step 4 (the
 * RFC layout in QUA-722) — after URL-quality, before the LLM verify step.
 *
 * ## Why this exists
 *
 * QUA-650's retro-scan caught 76 system-wide verdicts whose source was about
 * a materially different entity than the claim's subject (e.g. "Microsoft AI"
 * confirming a fact about "Microsoft", or an xAI press release attached to
 * an Anthropic funding-round). Every one of those was a paid LLM check that
 * could have been short-circuited at suggest-time with a deterministic QID
 * comparison.
 *
 * ## Fail-open contract
 *
 * The gate **never drops a candidate** unless both QIDs are known and they
 * disagree. Specifically:
 *
 *   - If the entity has no Wikidata QID → all candidates pass.
 *   - If the candidate URL has no extractable QID and no HTML is supplied →
 *     pass.
 *   - If the candidate's HTML doesn't reference Wikidata → pass.
 *
 * This is the same fail-open posture that QUA-650 / QUA-426 / `relevance-gate`
 * use: false-positives (drop a legitimate candidate) are worse than
 * false-negatives (fail to catch a mismatched candidate) because the
 * downstream LLM verify step also catches mismatches as a backstop.
 */

import { extractQid, extractQidFromHtml } from './wikidata-matcher.ts';

/** A candidate URL the gate inspects. Caller may pre-fetch HTML and pass it
 *  in for a stricter subject check; otherwise only the URL itself is used. */
export interface SubjectIdentityCandidate {
  url: string;
  /** Optional pre-fetched HTML body. The gate scans it for a Wikidata
   *  reference and uses that as the candidate's QID. Many news pages link
   *  to the canonical Wikidata entry via `<link rel>` or schema.org
   *  `sameAs`, so this catches non-Wikidata candidate URLs at the cost
   *  of one network fetch per candidate. */
  html?: string;
}

export interface SubjectIdentityGateInput<C extends SubjectIdentityCandidate> {
  /** The parent entity's Wikidata QID (e.g. "Q108542504"). Pass `null` to
   *  disable the gate (all candidates pass — fail-open). */
  entityQid: string | null;
  candidates: C[];
}

export interface SubjectIdentityDrop<C extends SubjectIdentityCandidate> {
  candidate: C;
  /** Stable machine-readable code: "subject-mismatch". */
  reason: 'subject-mismatch';
  /** Wikidata QID extracted from the candidate URL or HTML. */
  candidateQid: string;
  /** Wikidata QID of the parent entity that the candidate disagreed with. */
  entityQid: string;
  /** Human-readable detail (`<candidateQid> != <entityQid>`). Kept alongside
   *  the structured QIDs above for log lines that want a single string. */
  detail: string;
}

export interface SubjectIdentityGateResult<C extends SubjectIdentityCandidate> {
  kept: C[];
  dropped: SubjectIdentityDrop<C>[];
}

/**
 * Apply the subject-identity gate to a list of candidates.
 *
 * For each candidate:
 *   1. Extract a QID from the candidate URL (cheap, sync).
 *   2. If no URL-QID and `html` was supplied, extract from HTML.
 *   3. If a candidate QID was found AND it differs from `entityQid`, drop
 *      with `reason='subject-mismatch'`. Otherwise keep.
 *
 * Order is preserved among kept candidates.
 */
export function subjectIdentityGate<C extends SubjectIdentityCandidate>(
  input: SubjectIdentityGateInput<C>,
): SubjectIdentityGateResult<C> {
  const { entityQid, candidates } = input;

  // Fail-open: no entity QID → cannot judge identity.
  if (!entityQid) {
    return { kept: [...candidates], dropped: [] };
  }

  const kept: C[] = [];
  const dropped: SubjectIdentityDrop<C>[] = [];

  for (const candidate of candidates) {
    const candidateQid =
      extractQid(candidate.url) ??
      (candidate.html ? extractQidFromHtml(candidate.html) : null);

    if (!candidateQid) {
      // Fail-open: can't determine subject → keep.
      kept.push(candidate);
      continue;
    }

    if (candidateQid === entityQid) {
      kept.push(candidate);
      continue;
    }

    dropped.push({
      candidate,
      reason: 'subject-mismatch',
      candidateQid,
      entityQid,
      detail: `${candidateQid} != ${entityQid}`,
    });
  }

  return { kept, dropped };
}
