/**
 * Client for `POST /api/enrichment/propose` (QUA-632 / QUA-665).
 *
 * Translates an importer-emitted `EnrichmentProposal` into the
 * `ProposeRequestSchema` shape the endpoint expects, then POSTs it and
 * classifies the response.
 *
 * Translation responsibilities (the importer's job ends at
 * `{record, entityRefs, sourceUrl, responseHash}`):
 *   - Mint a deterministic 10-char `row.id` from the responseHash so repeat
 *     submissions upsert the same record.
 *   - Merge `entityRefs.{organization,person,model,benchmark}` into the row as
 *     the FK column names the sync schema expects (`companyId`, `personId`,
 *     `organizationId`, `modelId`, `benchmarkId`). Sync handlers accept
 *     slugs here and resolve them to stableIds via `resolveEntityFKs`.
 *   - Rename `responseHash` → `sourceContentHash` (the endpoint's name).
 *   - Preserve the wire-format `tier` and `recordType`.
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
 * Server-side `POST /api/enrichment/propose` response shape. Duplicated here
 * rather than imported from wiki-server because crux is a separate package
 * that doesn't depend on `apps/wiki-server/*`. The matching server-side type
 * is inferred by Hono RPC from `enrichment.ts` — if the two drift, the
 * endpoint integration test (enrichment-propose.test.ts) will fail.
 */
interface ProposeEndpointResponse {
  status: "accepted" | "rejected";
  tier: "T1" | "T2" | "T3";
  recordId?: string | null;
  verdict?: string | null;
  confidence?: number | null;
  checkerModel?: string | null;
  innerStatus?: number;
  rejectionReason?: string;
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
 * Map `entityRefs.{organization,person,model,benchmark}` into the sync-schema
 * FK column names the target record type expects. Unmapped entityRefs are
 * dropped silently — the sync handler will reject missing required FKs via
 * its own schema validation, which produces a clearer error message than
 * any client-side check would.
 */
function mergeEntityRefs(
  recordType: EnrichmentRecordType,
  record: Record<string, unknown>,
  entityRefs: EnrichmentProposal["entityRefs"] | undefined
): Record<string, unknown> {
  if (!entityRefs) return record;
  const row = { ...record };
  if (recordType === "funding-rounds") {
    if (entityRefs.organization != null && row.companyId == null) {
      row.companyId = entityRefs.organization;
    }
  } else if (recordType === "personnel") {
    if (entityRefs.organization != null && row.organizationId == null) {
      row.organizationId = entityRefs.organization;
    }
    if (entityRefs.person != null && row.personId == null) {
      row.personId = entityRefs.person;
    }
  } else if (recordType === "benchmark-results") {
    if (entityRefs.model != null && row.modelId == null) {
      row.modelId = entityRefs.model;
    }
    if (entityRefs.benchmark != null && row.benchmarkId == null) {
      row.benchmarkId = entityRefs.benchmark;
    }
  }
  return row;
}

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
  const id = deriveRecordId(p.responseHash);
  const withFks = mergeEntityRefs(p.recordType, p.record, p.entityRefs);
  // Strip null personDisplayName (github-contributors emits null on purpose
  // to fail-safe the display-name validator) so Zod's `.nullable()` optional
  // keeps the null; any explicit id in the record is overwritten with the
  // deterministic derived id so the same responseHash always upserts.
  const row: Record<string, unknown> = { ...withFks, id };
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

  const res = await apiRequest<ProposeEndpointResponse>(
    "POST",
    "/api/enrichment/propose",
    body
  );

  if (!res.ok) {
    // Bad-request responses still return a JSON body with `rejectionReason`
    // on the server side; apiRequest drops that body into `res.message`.
    return {
      proposal: p,
      status: res.error === "bad_request" ? "rejected" : "pending",
      reason: `${res.error}: ${res.message}`,
    };
  }

  if (res.data.status === "accepted") {
    return {
      proposal: p,
      status: "accepted",
      recordId: res.data.recordId ?? undefined,
    };
  }

  return {
    proposal: p,
    status: "rejected",
    reason: res.data.rejectionReason ?? "server rejected without a reason",
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
