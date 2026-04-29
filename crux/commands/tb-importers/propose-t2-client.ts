/**
 * T2 client for `POST /api/enrichment/propose` — grounded-fetch tier.
 *
 * Separate from the T1 client (`propose-client.ts`) because the shapes
 * diverge meaningfully: T1 proposals are produced from deterministic API
 * responses and validated against an authority allowlist, while T2
 * proposals carry a caller-produced verdict + verbatim quote that the
 * server verifies against inlined source content.
 *
 * Keeping the clients separate avoids a union type that makes T1 review
 * harder to audit and ensures T1 cannot silently emit unchecked T2 payloads.
 */

import { createHash } from "crypto";
import { apiRequest } from "../../lib/wiki-server/client.ts";
import type {
  EnrichmentRecordType,
  ProposeResult,
} from "./types.ts";

/**
 * A T2 proposal. Carries the tier-specific fields the `/propose` gate
 * requires (verdict, quotedText, sourceContent, checkerModel) in addition
 * to the usual record payload.
 *
 * Per the server-side gate in `enrichment.ts::computeSourcingForTier`:
 *   - `verdict` must be `"confirmed"` (strict gate; others rejected)
 *   - `quotedText` must be ≥40 chars and a substring of `sourceContent`
 *   - `checkerModel` is recorded as `evidence.checker_model`
 */
export interface T2EnrichmentProposal {
  /** Target tablebase record type. */
  recordType: EnrichmentRecordType;
  /** Record payload. Shape depends on recordType. `row.id` is minted below. */
  record: Record<string, unknown>;
  /** URL the page was fetched from — evidence URL. */
  sourceUrl: string;
  /**
   * SHA-256 hex of the snapshot fullText. Used to mint a deterministic
   * 10-char `row.id` AND recorded as `sourceContentHash` on evidence.
   */
  responseHash: string;
  /** Full snapshot text for server-side verbatim verification. */
  sourceContent: string;
  /** Verbatim quote supporting the claim (≥40 chars, substring of sourceContent). */
  quotedText: string;
  /** Caller verdict-LLM output. Only "confirmed" passes the gate. */
  verdict: "confirmed" | "contradicted" | "outdated" | "partial" | "unverifiable";
  /** Model that produced the verdict (e.g. "claude-haiku-4-5-20251001"). */
  checkerModel: string;
  /** Verdict confidence 0–1. Defaults server-side to 0.9 when omitted. */
  confidence?: number;
  /** Caller reasoning, appended to evidence.evidence blob. */
  reasoning?: string;
  /** FK resolution hints — same contract as T1 `entityRefs`. */
  entityRefs?: {
    organization?: string;
    person?: string;
    model?: string;
    benchmark?: string;
  };
}

export interface T2ProposeClientOptions {
  /** When true, actually POST to /api/enrichment/propose. Default false. */
  submit?: boolean;
  /** Optional runId to correlate with an `enrichment_runs` row. */
  runId?: string;
}

interface AcceptedProposeResponse {
  status: "accepted";
  tier: "T1" | "T2" | "T3";
  recordId?: string | null;
  verdict?: string | null;
  confidence?: number | null;
  checkerModel?: string | null;
}

/** Shared with T1 client — same 10-char derivation. */
export function deriveRecordId(responseHash: string): string {
  if (!/^[A-Fa-f0-9]{10,}$/.test(responseHash)) {
    throw new Error(
      `responseHash must be hex with ≥10 chars, got "${responseHash.slice(0, 16)}${
        responseHash.length > 16 ? "..." : ""
      }"`,
    );
  }
  return responseHash.slice(0, 10);
}

/**
 * Same FK map as the T1 client. Duplicated here rather than re-exported
 * because the shape is small and the T1 file's internal constant is not
 * meant as a public API.
 */
const ENTITY_REF_FK_MAP: Record<
  EnrichmentRecordType,
  ReadonlyArray<[keyof NonNullable<T2EnrichmentProposal["entityRefs"]>, string]>
> = {
  "funding-rounds": [["organization", "companyId"]],
  personnel: [
    ["organization", "organizationId"],
    ["person", "personId"],
  ],
  "benchmark-results": [
    ["model", "modelId"],
    ["benchmark", "benchmarkId"],
  ],
  publication: [],
  "organization-fact": [],
};

/**
 * Compute SHA-256 hex of a content blob. Use for `responseHash` when you
 * don't already have the snapshot's content_hash (which is the same thing).
 */
export function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Build the `/api/enrichment/propose` request body for a T2 proposal.
 * Exported for tests; the typical path is `submitT2Proposal`.
 */
export function buildT2ProposeRequest(
  p: T2EnrichmentProposal,
  opts: { runId?: string } = {},
): {
  tier: "T2";
  recordType: EnrichmentRecordType;
  row: Record<string, unknown>;
  sourceUrl: string;
  sourceContentHash: string;
  sourceContent: string;
  verdict: string;
  quotedText: string;
  checkerModel: string;
  confidence?: number;
  reasoning?: string;
  runId?: string;
} {
  const row: Record<string, unknown> = { ...p.record };
  const fkMap = ENTITY_REF_FK_MAP[p.recordType];
  if (p.entityRefs && fkMap.length > 0) {
    for (const [refKey, rowKey] of fkMap) {
      const refValue = p.entityRefs[refKey];
      if (refValue != null && row[rowKey] == null) {
        row[rowKey] = refValue;
      }
    }
  }
  row.id = deriveRecordId(p.responseHash);
  return {
    tier: "T2",
    recordType: p.recordType,
    row,
    sourceUrl: p.sourceUrl,
    sourceContentHash: p.responseHash,
    sourceContent: p.sourceContent,
    verdict: p.verdict,
    quotedText: p.quotedText,
    checkerModel: p.checkerModel,
    ...(p.confidence != null ? { confidence: p.confidence } : {}),
    ...(p.reasoning != null ? { reasoning: p.reasoning } : {}),
    ...(opts.runId ? { runId: opts.runId } : {}),
  };
}

/** Validate a T2 proposal locally. Returns null on success, reason on failure. */
export function validateT2Proposal(p: T2EnrichmentProposal): string | null {
  if (!p.sourceUrl || !p.responseHash || !p.sourceContent) {
    return "missing required sourceUrl/responseHash/sourceContent";
  }
  if (!p.verdict || !p.quotedText || !p.checkerModel) {
    return "missing required verdict/quotedText/checkerModel";
  }
  if (p.quotedText.length < 40) {
    return `quotedText too short (${p.quotedText.length} chars, min 40)`;
  }
  // Local verbatim check — whitespace-tolerant, case-insensitive — so we
  // catch paraphrase before spending the server round trip.
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (!norm(p.sourceContent).includes(norm(p.quotedText))) {
    return "quotedText is not a verbatim substring of sourceContent";
  }
  return null;
}

/** Submit a single T2 proposal. */
export async function submitT2Proposal(
  p: T2EnrichmentProposal,
  opts: T2ProposeClientOptions = {},
): Promise<ProposeResult> {
  const failure = validateT2Proposal(p);
  if (failure) {
    return {
      proposal: {
        tier: "T2",
        source: `t2:${p.recordType}`,
        sourceUrl: p.sourceUrl,
        responseHash: p.responseHash,
        recordType: p.recordType,
        record: p.record,
        entityRefs: p.entityRefs,
      },
      status: "rejected",
      reason: failure,
    };
  }

  if (!opts.submit) {
    return {
      proposal: {
        tier: "T2",
        source: `t2:${p.recordType}`,
        sourceUrl: p.sourceUrl,
        responseHash: p.responseHash,
        recordType: p.recordType,
        record: p.record,
        entityRefs: p.entityRefs,
      },
      status: "pending",
      reason: "dry-run",
    };
  }

  let body: ReturnType<typeof buildT2ProposeRequest>;
  try {
    body = buildT2ProposeRequest(p, { runId: opts.runId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      proposal: {
        tier: "T2",
        source: `t2:${p.recordType}`,
        sourceUrl: p.sourceUrl,
        responseHash: p.responseHash,
        recordType: p.recordType,
        record: p.record,
        entityRefs: p.entityRefs,
      },
      status: "rejected",
      reason: `client error: ${msg}`,
    };
  }

  // typed-client-ok: QUA-770 baseline — tb-importer client script, follow-up migration to typed client tracked
  const res = await apiRequest<AcceptedProposeResponse>(
    "POST",
    "/api/enrichment/propose",
    body,
  );

  const proposalShim = {
    tier: "T2" as const,
    source: `t2:${p.recordType}`,
    sourceUrl: p.sourceUrl,
    responseHash: p.responseHash,
    recordType: p.recordType,
    record: p.record,
    entityRefs: p.entityRefs,
  };

  if (!res.ok) {
    return {
      proposal: proposalShim,
      status: res.error === "bad_request" ? "rejected" : "pending",
      reason: `${res.error}: ${res.message}`,
    };
  }

  return {
    proposal: proposalShim,
    status: "accepted",
    recordId: res.data.recordId ?? undefined,
  };
}

/** Submit many T2 proposals sequentially. */
export async function submitT2Batch(
  proposals: readonly T2EnrichmentProposal[],
  opts: T2ProposeClientOptions = {},
): Promise<ProposeResult[]> {
  const out: ProposeResult[] = [];
  for (const p of proposals) {
    out.push(await submitT2Proposal(p, opts));
  }
  return out;
}
