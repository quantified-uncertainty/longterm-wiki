/**
 * Client for `POST /api/enrichment/propose`.
 *
 * Translates an importer-emitted `EnrichmentProposal` into the
 * `ProposeRequestSchema` shape the endpoint expects, then POSTs it and
 * classifies the response.
 *
 * Translation steps (see `buildProposeRequest`):
 *   - Derive a deterministic 10-char `row.id` from `responseHash[:10]`.
 *   - Merge `entityRefs` into the sync schema's FK column names per
 *     `ENTITY_REF_FK_MAP`. Sync handlers resolve slugs to stableIds
 *     downstream via `resolveEntityFKs`.
 *   - Rename `responseHash` → `sourceContentHash` (the endpoint's name).
 */

import { apiRequest } from "../../lib/wiki-server/client.ts";
import { isT1Authoritative } from "./allowlist.ts";
import type {
  EnrichmentProposal,
  EnrichmentRecordType,
  ProposeResult,
} from "./types.ts";

export interface ProposeClientOptions {
  /** When true, actually POST to /api/enrichment/propose. Default false. */
  submit?: boolean;
  /** When true, skip the client-side T1 allowlist check (for testing). */
  skipAllowlistCheck?: boolean;
  /** Optional runId to correlate this submission with an `enrichment_runs` row. */
  runId?: string;
}

/**
 * Accepted response from `/api/enrichment/propose` — duplicated here rather
 * than imported from wiki-server because crux is a separate package. Rejections
 * always return HTTP 400, so on the success (HTTP 200) path `status` is always
 * `"accepted"`.
 */
interface AcceptedProposeResponse {
  status: "accepted";
  tier: "T1" | "T2" | "T3";
  recordId?: string | null;
  verdict?: string | null;
  confidence?: number | null;
  checkerModel?: string | null;
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
 * Derive a deterministic 10-char record id from a proposal's responseHash.
 *
 * responseHash is a 64-char hex SHA-256. Taking the first 10 chars gives
 * us a deterministic, 10-char-alphanumeric ID that all three sync schemas
 * accept (`id: z.string().length(10)` for funding-rounds/benchmark-results;
 * `/^[A-Za-z0-9_-]{10}$/` for personnel). Collisions are negligible at
 * O(10^6) records (birthday bound ~2^20 entries before 50% collision).
 */
export function deriveRecordId(responseHash: string): string {
  if (!/^[A-Fa-f0-9]{10,}$/.test(responseHash)) {
    throw new Error(
      `responseHash must be hex with ≥10 chars, got "${responseHash.slice(0, 16)}${
        responseHash.length > 16 ? "..." : ""
      }"`
    );
  }
  return responseHash.slice(0, 10);
}

/**
 * Maps each record type to the `(entityRef key → row FK column)` pairs the
 * corresponding sync schema expects. Single source of truth for the FK
 * contract — the docstring on `EnrichmentProposal.entityRefs` in `types.ts`
 * should match this table exactly.
 */
const ENTITY_REF_FK_MAP: Record<
  EnrichmentRecordType,
  ReadonlyArray<[keyof NonNullable<EnrichmentProposal["entityRefs"]>, string]>
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
};

/**
 * Build the `/api/enrichment/propose` request body from a proposal.
 *
 * Exported for tests; the typical path is to go through `submitProposal`.
 */
export function buildProposeRequest(
  p: EnrichmentProposal,
  opts: { runId?: string } = {}
): {
  tier: "T1" | "T2" | "T3";
  recordType: EnrichmentRecordType;
  row: Record<string, unknown>;
  sourceUrl: string;
  sourceContentHash: string;
  runId?: string;
} {
  // One spread, then in-place mutation: FK columns pulled from entityRefs
  // (without overwriting values already in the record), and an id derived
  // from responseHash so the same response always upserts to the same row.
  const row: Record<string, unknown> = { ...p.record };
  if (p.entityRefs) {
    for (const [refKey, rowKey] of ENTITY_REF_FK_MAP[p.recordType]) {
      const refValue = p.entityRefs[refKey];
      if (refValue != null && row[rowKey] == null) {
        row[rowKey] = refValue;
      }
    }
  }
  row.id = deriveRecordId(p.responseHash);
  return {
    tier: p.tier,
    recordType: p.recordType,
    row,
    sourceUrl: p.sourceUrl,
    sourceContentHash: p.responseHash,
    ...(opts.runId ? { runId: opts.runId } : {}),
  };
}

/**
 * Submit a single proposal. Returns the result.
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

  return submitToServer(p, opts);
}

async function submitToServer(
  p: EnrichmentProposal,
  opts: ProposeClientOptions
): Promise<ProposeResult> {
  let body: ReturnType<typeof buildProposeRequest>;
  try {
    body = buildProposeRequest(p, { runId: opts.runId });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { proposal: p, status: "rejected", reason: `client error: ${msg}` };
  }

  const res = await apiRequest<AcceptedProposeResponse>(
    "POST",
    "/api/enrichment/propose",
    body
  );

  if (!res.ok) {
    // Rejections always return HTTP 400 with a `rejectionReason` body;
    // apiRequest collapses that into `res.message`.
    return {
      proposal: p,
      status: res.error === "bad_request" ? "rejected" : "pending",
      reason: `${res.error}: ${res.message}`,
    };
  }

  return {
    proposal: p,
    status: "accepted",
    recordId: res.data.recordId ?? undefined,
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
  const rejections: ProposeResult[] = [];
  let accepted = 0;
  let pending = 0;
  for (const r of results) {
    if (r.status === "accepted") accepted++;
    else if (r.status === "pending") pending++;
    else if (r.status === "rejected") rejections.push(r);
  }
  console.log(
    `[${importerName}] ${results.length} proposals: accepted=${accepted} rejected=${rejections.length} pending=${pending}`
  );
  if (rejections.length > 0) {
    console.log(`[${importerName}] First 5 rejections:`);
    for (const r of rejections.slice(0, 5)) {
      console.log(`  - ${r.proposal.source}: ${r.reason ?? "no reason"}`);
    }
  }
}
