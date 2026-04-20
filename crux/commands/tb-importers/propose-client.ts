/**
 * Client for `POST /api/enrichment/propose` (QUA-632).
 *
 * QUA-632 is in flight in another session — until that endpoint lands, this
 * client is a stub. `submitProposal()` validates the proposal against the T1
 * allowlist and either:
 *   - dry-run mode (default): logs the proposal as JSON, returns `pending`
 *   - --submit mode: would POST to the endpoint when it exists; today returns
 *     `pending` with a "endpoint not yet built (QUA-632)" reason
 *
 * The wire format (`EnrichmentProposal` from ./types.ts) is the contract.
 * When QUA-632 lands, only the `submitToServer()` body needs to change.
 */

import { isT1Authoritative } from "./allowlist.ts";
import type { EnrichmentProposal, ProposeResult } from "./types.ts";

export interface ProposeClientOptions {
  /** When true, attempt to POST to /api/enrichment/propose. Default false. */
  submit?: boolean;
  /** When true, skip the T1 allowlist check (for testing). */
  skipAllowlistCheck?: boolean;
}

/**
 * Validate one proposal locally before it's POSTed.
 * Returns null on success, or a string reason on failure.
 */
export function validateProposal(p: EnrichmentProposal): string | null {
  if (p.tier !== "T1") {
    return `T1 importers must emit tier=T1, got tier=${p.tier}`;
  }
  if (!p.source || !p.sourceUrl || !p.responseHash) {
    return "proposal missing required source/sourceUrl/responseHash";
  }
  if (!isT1Authoritative(p.source, p.recordType)) {
    return `(source=${p.source}, recordType=${p.recordType}) not on T1 authority allowlist`;
  }
  return null;
}

/**
 * Submit a single proposal. Returns the result.
 *
 * Today (pre-QUA-632) this never reaches the network — see top-of-file note.
 */
export async function submitProposal(
  p: EnrichmentProposal,
  opts: ProposeClientOptions = {}
): Promise<ProposeResult> {
  if (!opts.skipAllowlistCheck) {
    const failure = validateProposal(p);
    if (failure) {
      return { proposal: p, status: "rejected", reason: failure };
    }
  }

  if (!opts.submit) {
    return { proposal: p, status: "pending", reason: "dry-run" };
  }

  return submitToServer(p);
}

/**
 * The actual network call. Stub until QUA-632 ships.
 *
 * When QUA-632 lands, replace the body with:
 *   const res = await apiRequest<ProposeResult>("/api/enrichment/propose", { method: "POST", body: p });
 *   return res;
 */
async function submitToServer(p: EnrichmentProposal): Promise<ProposeResult> {
  return {
    proposal: p,
    status: "pending",
    reason: "endpoint /api/enrichment/propose not yet built (blocked on QUA-632)",
  };
}

/**
 * Submit many proposals sequentially. Returns one result per input.
 * Sequential because we want stable ordering + cheap rate-limiting.
 */
export async function submitBatch(
  proposals: readonly EnrichmentProposal[],
  opts: ProposeClientOptions = {}
): Promise<ProposeResult[]> {
  const out: ProposeResult[] = [];
  for (const p of proposals) {
    out.push(await submitProposal(p, opts));
  }
  return out;
}

/**
 * Summarize a batch result for stdout. Side-effecting on purpose.
 */
export function printBatchSummary(
  results: readonly ProposeResult[],
  importerName: string
): void {
  const accepted = results.filter((r) => r.status === "accepted").length;
  const rejected = results.filter((r) => r.status === "rejected").length;
  const pending = results.filter((r) => r.status === "pending").length;
  console.log(
    `[${importerName}] ${results.length} proposals: accepted=${accepted} rejected=${rejected} pending=${pending}`
  );
  if (rejected > 0) {
    console.log(`[${importerName}] First 5 rejections:`);
    results
      .filter((r) => r.status === "rejected")
      .slice(0, 5)
      .forEach((r) =>
        console.log(`  - ${r.proposal.source}: ${r.reason ?? "no reason"}`)
      );
  }
}
