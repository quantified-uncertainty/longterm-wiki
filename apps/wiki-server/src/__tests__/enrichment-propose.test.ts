import { describe, it, expect, vi, beforeEach } from "vitest";
import { Hono } from "hono";
import {
  mockDbModule,
  postJson,
  type SqlDispatcher,
} from "./test-utils";

// ── Mock the inner sync routes so we don't drag in the full sync pipeline ──
//
// The sync sub-apps are imported by enrichment.ts at module load, so we
// replace them with tiny stubs that record every POST they receive and return
// a configurable response.  That lets us assert both (a) exactly what the
// propose endpoint forwards to each record-type's sync handler (row +
// sourcing) and (b) how the endpoint translates downstream failures into
// rejection reasons.

interface CapturedInnerCall {
  /** Which record-type's sync stub captured this call. */
  route: "grants" | "personnel" | "funding-rounds" | "benchmark-results";
  path: string;
  body: unknown;
}

const captured: CapturedInnerCall[] = [];
let innerResponseStatus = 200;
let innerResponseBody: Record<string, unknown> = {
  upserted: 1,
  verdictsWritten: 1,
  claimsLinked: 0,
};

function makeStub(route: CapturedInnerCall["route"]) {
  return new Hono().post("/sync", async (c) => {
    const bodyText = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(bodyText);
    } catch {
      body = bodyText;
    }
    captured.push({ route, path: new URL(c.req.url).pathname, body });
    return c.json(innerResponseBody, innerResponseStatus as 200 | 400 | 500);
  });
}

vi.mock("../routes/tablebase/grants.js", () => ({ grantsRoute: makeStub("grants") }));
vi.mock("../routes/tablebase/personnel.js", () => ({ personnelRoute: makeStub("personnel") }));
vi.mock("../routes/tablebase/funding-rounds.js", () => ({ fundingRoundsRoute: makeStub("funding-rounds") }));
vi.mock("../routes/tablebase/benchmark-results.js", () => ({
  benchmarkResultsRoute: makeStub("benchmark-results"),
}));

// ── DB mock — enrichment_runs logging is the only server-side DB call.
// Tests that care about the logRunResult SQL assert on `dbQueries`.
const dbQueries: Array<{ query: string; params: unknown[] }> = [];
const dbDispatcher: SqlDispatcher = (query, params) => {
  dbQueries.push({ query, params });
  return [];
};
vi.mock("../db.js", () => mockDbModule(dbDispatcher));

// Import the route AFTER mocks are registered.
const { enrichmentRoute } = await import("../routes/enrichment/enrichment.js");
const { computeSourcingForTier } = await import("../routes/enrichment/enrichment.js");
const { checkT1Authority } = await import("../routes/enrichment/t1-allowlist.js");
const { isHomepageUrl } = await import("../routes/enrichment/homepage-detector.js");

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/enrichment", enrichmentRoute);
  return app;
}

function resetState() {
  captured.length = 0;
  dbQueries.length = 0;
  innerResponseStatus = 200;
  innerResponseBody = { upserted: 1, verdictsWritten: 1, claimsLinked: 0 };
}

// A valid grant row shape acceptable to the real sync schema.
const VALID_GRANT_ROW = {
  id: "grt1234567", // 10 chars
  organizationId: "ea-funds",
  name: "Example Grant to Anthropic 2024",
  amount: 50000,
  currency: "USD",
  date: "2024-06-15",
};

// A ~500-char chunk of source content we can slice verbatim quotes from.
const LONG_SOURCE_CONTENT =
  "Anthropic received a $50,000 grant from the EA Animal Welfare Fund in June 2024 to support research into AI model safety evaluations and alignment techniques. The grant will fund additional personnel and compute resources over a six-month period, with public progress reports due at the halfway mark.";
const VERBATIM_QUOTE_50 =
  "Anthropic received a $50,000 grant from the EA Animal"; // 50 chars, verbatim substring

// ─────────────────────────────────────────────────────────────────────
// T1 allowlist — pure logic tests
// ─────────────────────────────────────────────────────────────────────

describe("checkT1Authority", () => {
  it("matches EA Funds URL for grants", () => {
    const res = checkT1Authority(
      "https://funds.effectivealtruism.org/grants",
      "grants",
      null,
    );
    expect(res.matched).toBe(true);
    if (res.matched) {
      expect(res.source.id).toBe("ea-funds");
    }
  });

  it("does NOT match EA Funds URL for personnel", () => {
    const res = checkT1Authority(
      "https://funds.effectivealtruism.org/grants",
      "personnel",
      null,
    );
    expect(res.matched).toBe(false);
  });

  it("does NOT match an unrelated URL for grants", () => {
    const res = checkT1Authority(
      "https://example.com/grants",
      "grants",
      null,
    );
    expect(res.matched).toBe(false);
  });

  it("matches OpenAlex for personnel but not grants", () => {
    const pers = checkT1Authority(
      "https://api.openalex.org/works/W12345",
      "personnel",
      null,
    );
    expect(pers.matched).toBe(true);
    if (pers.matched) expect(pers.source.id).toBe("openalex");

    const grant = checkT1Authority(
      "https://api.openalex.org/works/W12345",
      "grants",
      null,
    );
    expect(grant.matched).toBe(false);
  });

  it("matches Wikidata URL for personnel", () => {
    const res = checkT1Authority(
      "https://www.wikidata.org/wiki/Q42",
      "personnel",
      null,
    );
    expect(res.matched).toBe(true);
  });

  it("rejects an empty sourceUrl", () => {
    const res = checkT1Authority("", "grants", null);
    expect(res.matched).toBe(false);
  });

  it("matches github.com user-profile URLs for personnel", () => {
    const res = checkT1Authority(
      "https://github.com/octocat",
      "personnel",
      null,
    );
    expect(res.matched).toBe(true);
    if (res.matched) expect(res.source.id).toBe("github-user");
  });

  it("rejects github.com reserved paths as personnel authority", () => {
    for (const reserved of [
      "https://github.com/settings",
      "https://github.com/marketplace",
      "https://github.com/orgs",
      "https://github.com/about",
      "https://github.com/pulls",
      "https://github.com/issues",
      "https://github.com/search",
      "https://github.com/explore",
      "https://github.com/notifications",
      "https://github.com/login",
      "https://github.com/features",
      "https://github.com/pricing",
    ]) {
      const res = checkT1Authority(reserved, "personnel", null);
      expect(res.matched).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
// Homepage detector — pure logic tests
// ─────────────────────────────────────────────────────────────────────

describe("isHomepageUrl", () => {
  it.each([
    ["https://example.com/", true],
    ["https://example.com", true],
    ["https://example.com/home", true],
    ["https://example.com/about", true],
    ["https://example.com/about-us", true],
    ["https://example.com/about/team", false], // sub-path under about is OK
    ["https://example.com/contact", true],
    ["https://example.com/blog/post-123", false],
    ["https://example.com/research/ai-safety-paper", false],
    ["not-a-url", false],
  ])("%s → %s", (url, expected) => {
    expect(isHomepageUrl(url)).toBe(expected);
  });
});

// ─────────────────────────────────────────────────────────────────────
// computeSourcingForTier — pure function, no IO
// ─────────────────────────────────────────────────────────────────────

describe("computeSourcingForTier (T1)", () => {
  it("accepts a matching T1 source and produces confirmed verdict", () => {
    const res = computeSourcingForTier(
      {
        tier: "T1",
        recordType: "grants",
        row: VALID_GRANT_ROW,
        sourceUrl: "https://funds.effectivealtruism.org/grants/123",
        sourceContentHash: "abc123",
      },
      null,
    );
    expect(res.accepted).toBe(true);
    if (res.accepted) {
      expect(res.sourcing.verdict).toBe("confirmed");
      expect(res.sourcing.confidence).toBe(1);
      expect(res.sourcing.checkedBy).toBe("t1-ea-funds");
      expect(res.sourcing.evidence).toContain("abc123");
    }
  });

  it("rejects a T1 request whose source is not on the allowlist", () => {
    const res = computeSourcingForTier(
      {
        tier: "T1",
        recordType: "grants",
        row: VALID_GRANT_ROW,
        sourceUrl: "https://blog.example.com/i-know-about-grants",
      },
      null,
    );
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.rejectionReason).toMatch(/No T1 authority matches/);
    }
  });
});

describe("computeSourcingForTier (T2)", () => {
  const baseReq = {
    tier: "T2" as const,
    recordType: "grants" as const,
    row: VALID_GRANT_ROW,
    sourceUrl: "https://anthropic.com/news/ea-funds-grant",
  };

  it("accepts with confirmed verdict + long verbatim quote", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
        verdict: "confirmed",
        quotedText: VERBATIM_QUOTE_50,
        checkerModel: "claude-haiku-4-5-20251001",
        sourceContent: LONG_SOURCE_CONTENT,
        confidence: 0.95,
      },
      null,
    );
    expect(res.accepted).toBe(true);
    if (res.accepted) {
      expect(res.sourcing.verdict).toBe("confirmed");
      expect(res.sourcing.evidence).toContain(VERBATIM_QUOTE_50);
      expect(res.sourcing.confidence).toBe(0.95);
      expect(res.sourcing.checkedBy).toBe("claude-haiku-4-5-20251001");
    }
  });

  it("rejects verdict=partial (strict gate — only confirmed)", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
        verdict: "partial",
        quotedText: VERBATIM_QUOTE_50,
        checkerModel: "claude-haiku-4-5-20251001",
      },
      null,
    );
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.rejectionReason).toContain("partial");
      expect(res.rejectionReason).toMatch(/only "confirmed"/);
    }
  });

  it("rejects verdict=contradicted", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
        verdict: "contradicted",
        quotedText: VERBATIM_QUOTE_50,
        checkerModel: "claude-haiku-4-5-20251001",
      },
      null,
    );
    expect(res.accepted).toBe(false);
  });

  it("rejects quotedText shorter than MIN_QUOTE_CHARS", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
        verdict: "confirmed",
        quotedText: "short quote",
        checkerModel: "claude-haiku-4-5-20251001",
      },
      null,
    );
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.rejectionReason).toMatch(/quotedText too short/);
    }
  });

  it("rejects when quotedText is not a verbatim substring of sourceContent", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
        verdict: "confirmed",
        quotedText:
          "This quote is long enough but does not appear anywhere in the provided source content at all.",
        checkerModel: "claude-haiku-4-5-20251001",
        sourceContent: LONG_SOURCE_CONTENT,
      },
      null,
    );
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.rejectionReason).toMatch(/verbatim substring/);
    }
  });

  it("skips the verbatim check when sourceContent is omitted (trust-caller mode)", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
        verdict: "confirmed",
        quotedText:
          "A sufficiently long quote that the caller claims is verbatim even though we cannot check.",
        checkerModel: "claude-haiku-4-5-20251001",
      },
      null,
    );
    expect(res.accepted).toBe(true);
  });

  it("rejects when verdict/quotedText/checkerModel are missing", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
      },
      null,
    );
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.rejectionReason).toMatch(/required field/);
      expect(res.rejectionReason).toMatch(/verdict/);
      expect(res.rejectionReason).toMatch(/quotedText/);
      expect(res.rejectionReason).toMatch(/checkerModel/);
    }
  });

  it("tolerates whitespace differences between quote and source", () => {
    const spacedQuote = "Anthropic  received   a  $50,000 grant  from  the EA  Animal";
    const res = computeSourcingForTier(
      {
        ...baseReq,
        verdict: "confirmed",
        quotedText: spacedQuote,
        checkerModel: "claude-haiku-4-5-20251001",
        sourceContent: LONG_SOURCE_CONTENT,
      },
      null,
    );
    expect(res.accepted).toBe(true);
  });
});

describe("computeSourcingForTier (T3)", () => {
  const baseReq = {
    tier: "T3" as const,
    recordType: "grants" as const,
    row: VALID_GRANT_ROW,
    verdict: "confirmed" as const,
    quotedText: VERBATIM_QUOTE_50,
    checkerModel: "claude-haiku-4-5-20251001",
    sourceContent: LONG_SOURCE_CONTENT,
  };

  it("rejects homepage URLs", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
        sourceUrl: "https://example.com/",
      },
      null,
    );
    expect(res.accepted).toBe(false);
    if (!res.accepted) {
      expect(res.rejectionReason).toMatch(/homepage/);
    }
  });

  it("rejects shallow /about URLs", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
        sourceUrl: "https://example.com/about",
      },
      null,
    );
    expect(res.accepted).toBe(false);
  });

  it("accepts a specific sub-page URL", () => {
    const res = computeSourcingForTier(
      {
        ...baseReq,
        sourceUrl: "https://example.com/blog/ea-funds-grant-announcement",
      },
      null,
    );
    expect(res.accepted).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Endpoint integration tests (with mocked inner grants route)
// ─────────────────────────────────────────────────────────────────────

describe("POST /api/enrichment/propose", () => {
  beforeEach(() => {
    resetState();
  });

  it("accepts a valid T1 request and forwards the row with sourcing to the grants sync", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://funds.effectivealtruism.org/grants/anthropic-2024",
      sourceContentHash: "sha256:abc",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(body.tier).toBe("T1");
    expect(body.verdict).toBe("confirmed");
    expect(body.recordId).toBe("grt1234567");

    // The inner route should have been called exactly once with our row + sourcing.
    expect(captured).toHaveLength(1);
    expect(captured[0].path).toBe("/sync");
    const innerBody = captured[0].body as {
      items: Array<Record<string, unknown> & {
        sourcing: { verdict: string; checkedBy: string };
      }>;
    };
    expect(innerBody.items).toHaveLength(1);
    expect(innerBody.items[0].id).toBe("grt1234567");
    expect(innerBody.items[0].source).toBe(
      "https://funds.effectivealtruism.org/grants/anthropic-2024",
    );
    expect(innerBody.items[0].sourcing.verdict).toBe("confirmed");
    expect(innerBody.items[0].sourcing.checkedBy).toBe("t1-ea-funds");
  });

  it("rejects a T1 request whose source is not on the allowlist (no inner call made)", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://random.example.com/some-page",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("rejected");
    expect(body.rejectionReason).toMatch(/No T1 authority matches/);
    expect(captured).toHaveLength(0);
  });

  it("accepts a T2 request when verdict=confirmed + verbatim quote", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T2",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://anthropic.com/news/ea-grant-2024",
      verdict: "confirmed",
      confidence: 0.92,
      quotedText: VERBATIM_QUOTE_50,
      reasoning: "Quote confirms the grant amount and recipient.",
      sourceContent: LONG_SOURCE_CONTENT,
      checkerModel: "claude-haiku-4-5-20251001",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(body.verdict).toBe("confirmed");
    expect(body.confidence).toBe(0.92);
    expect(captured).toHaveLength(1);
  });

  it("rejects T2 verdict=partial at the strict gate", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T2",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://anthropic.com/news/ea-grant-2024",
      verdict: "partial",
      quotedText: VERBATIM_QUOTE_50,
      checkerModel: "claude-haiku-4-5-20251001",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.rejectionReason).toContain("partial");
    expect(captured).toHaveLength(0);
  });

  it("rejects T3 homepage URLs even with valid verdict + quote", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T3",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://example.com/",
      verdict: "confirmed",
      quotedText: VERBATIM_QUOTE_50,
      sourceContent: LONG_SOURCE_CONTENT,
      checkerModel: "claude-haiku-4-5-20251001",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.rejectionReason).toMatch(/homepage/);
    expect(captured).toHaveLength(0);
  });

  it("returns 400 when the downstream sync handler fails", async () => {
    innerResponseStatus = 400;
    innerResponseBody = {
      error: "validation_error",
      message: "organizationId not found in entities",
    };

    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://funds.effectivealtruism.org/grants/abc",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.status).toBe("rejected");
    expect(body.rejectionReason).toMatch(/organizationId not found in entities/);
    expect(body.innerStatus).toBe(400);
    expect(captured).toHaveLength(1); // gate passed, forwarded once, downstream rejected
  });

  it("rejects a request with unknown recordType (schema check)", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      // "publications" is a future record type named in the T1 allowlist
      // (openalex) but not yet wired into RECORD_TYPE_ROUTES — the Zod
      // SUPPORTED_RECORD_TYPES enum rejects it before any routing happens.
      recordType: "publications",
      row: { id: "x" },
      sourceUrl: "https://api.openalex.org/works/W1",
    });
    expect(res.status).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it("rejects a malformed request body", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T4", // invalid tier
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://funds.effectivealtruism.org/x",
    });
    expect(res.status).toBe(400);
    expect(captured).toHaveLength(0);
  });

  // Phase 1 does not support per-field verdicts — writeInlineVerdicts hardcodes
  // `field_name = NULL`.  Accepting a non-null `fieldName` would gate T1
  // field-restriction correctly but then write a row-level verdict anyway.
  it("rejects non-null fieldName (Phase 1 per-field verdicts not supported)", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://funds.effectivealtruism.org/grants/abc",
      fieldName: "amount",
    });
    expect(res.status).toBe(400);
    expect(captured).toHaveLength(0);
  });

  it("accepts an explicit null fieldName (whole-record verdict)", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://funds.effectivealtruism.org/grants/abc",
      fieldName: null,
    });
    expect(res.status).toBe(200);
  });

  // Covers that the `runId` path actually hits the DB — the SQL shape is how
  // the dashboard builds per-run roll-ups.  A regression that drops the UPSERT
  // would silently under-count in /internal/* dashboards.
  it("writes the enrichment_runs UPSERT when runId is supplied", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://funds.effectivealtruism.org/grants/abc",
      runId: "anthropic-personnel-t1-2026-04-20",
    });
    expect(res.status).toBe(200);

    const runQueries = dbQueries.filter((q) =>
      q.query.includes("enrichment_runs"),
    );
    expect(runQueries.length).toBe(1);
    expect(runQueries[0].query).toContain("INSERT INTO enrichment_runs");
    expect(runQueries[0].query).toContain("ON CONFLICT (id) DO UPDATE");
    expect(runQueries[0].query).toContain("verdict_confirmed");
    expect(runQueries[0].query).toContain("verdict_outdated");
    // The runId is passed as a bound param (index 0 in the SQL).
    expect(runQueries[0].params).toContain("anthropic-personnel-t1-2026-04-20");
  });

  it("skips enrichment_runs UPSERT when runId is omitted", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://funds.effectivealtruism.org/grants/abc",
    });
    expect(res.status).toBe(200);
    const runQueries = dbQueries.filter((q) =>
      q.query.includes("enrichment_runs"),
    );
    expect(runQueries.length).toBe(0);
  });

  it("still increments enrichment_runs counters on tier-gate rejection", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "grants",
      row: VALID_GRANT_ROW,
      sourceUrl: "https://random.example.com/not-allowlisted",
      runId: "run-that-should-count-rejections",
    });
    expect(res.status).toBe(400);
    const runQueries = dbQueries.filter((q) =>
      q.query.includes("enrichment_runs"),
    );
    expect(runQueries.length).toBe(1);
  });

  // ── QUA-665: Phase 1.5 — new record types wired in ──────────────────────

  it("routes funding-rounds T1 requests to the funding-rounds sync subapp", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "funding-rounds",
      row: {
        id: "fr01234567",
        companyId: "anthropic",
        name: "Form D filing 2024-05-30",
      },
      sourceUrl:
        "https://www.sec.gov/Archives/edgar/data/1828101/000182810124000001/primary_doc.xml",
      sourceContentHash: "sha256:abc",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("accepted");
    expect(body.recordId).toBe("fr01234567");

    expect(captured).toHaveLength(1);
    expect(captured[0].route).toBe("funding-rounds");
    const innerBody = captured[0].body as { items: Array<{
      id: string; companyId: string; source: string;
      sourcing: { verdict: string; checkedBy: string };
    }> };
    expect(innerBody.items[0].companyId).toBe("anthropic");
    // funding-rounds uses `source` for the URL (not `sourceUrl`).
    expect(innerBody.items[0].source).toBe(
      "https://www.sec.gov/Archives/edgar/data/1828101/000182810124000001/primary_doc.xml",
    );
    expect(innerBody.items[0].sourcing.checkedBy).toBe("t1-sec-edgar");
  });

  it("routes personnel T1 requests to the personnel sync subapp", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "personnel",
      row: {
        id: "per0123456",
        personId: "alice",
        organizationId: "anthropic",
        role: "contributor",
        roleType: "career",
      },
      sourceUrl: "https://github.com/alice",
      sourceContentHash: "sha256:def",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("accepted");

    expect(captured).toHaveLength(1);
    expect(captured[0].route).toBe("personnel");
    const innerBody = captured[0].body as { items: Array<{
      id: string; personId: string; organizationId: string;
      source: string; sourcing: { verdict: string; checkedBy: string };
    }> };
    expect(innerBody.items[0].personId).toBe("alice");
    expect(innerBody.items[0].organizationId).toBe("anthropic");
    expect(innerBody.items[0].sourcing.checkedBy).toBe("t1-github-user");
  });

  it("routes benchmark-results T1 requests to the benchmark-results sync subapp", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "benchmark-results",
      row: {
        id: "br01234567",
        benchmarkId: "ifeval",
        modelId: "claude-3-5-sonnet",
        score: 75.2,
        unit: "%",
      },
      sourceUrl:
        "https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard?row=claude-3-5-sonnet",
      sourceContentHash: "sha256:xyz",
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("accepted");

    expect(captured).toHaveLength(1);
    expect(captured[0].route).toBe("benchmark-results");
    const innerBody = captured[0].body as { items: Array<{
      id: string; benchmarkId: string; modelId: string; score: number;
      sourceUrl: string; source?: unknown;
      sourcing: { verdict: string; checkedBy: string };
    }> };
    // benchmark-results uses `sourceUrl` (not `source`) for the URL field.
    expect(innerBody.items[0].sourceUrl).toContain(
      "huggingface.co/spaces/open-llm-leaderboard",
    );
    // The opposite field is scrubbed so callers can't smuggle a divergent URL.
    expect(innerBody.items[0].source).toBeUndefined();
    expect(innerBody.items[0].sourcing.checkedBy).toBe("t1-hf-leaderboard");
  });

  it("rejects a funding-rounds T1 request when the source is not on the allowlist", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "funding-rounds",
      row: {
        id: "fr01234567",
        companyId: "anthropic",
        name: "x",
      },
      sourceUrl: "https://crunchbase.com/company/anthropic",
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.rejectionReason).toMatch(/No T1 authority matches/);
    expect(captured).toHaveLength(0);
  });

  it("overwrites a caller-supplied 'source' with the gate-validated sourceUrl even on non-grants routes", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "funding-rounds",
      row: {
        id: "fr01234567",
        companyId: "anthropic",
        name: "x",
        // Caller tries to smuggle a different source URL in the row.
        source: "https://attacker.example.com/fake-form-d",
      },
      sourceUrl:
        "https://www.sec.gov/Archives/edgar/data/1/abc/primary_doc.xml",
    });
    expect(res.status).toBe(200);
    expect(captured).toHaveLength(1);
    const innerBody = captured[0].body as { items: Array<{ source: string }> };
    // The gate-validated URL wins; the smuggled one is dropped.
    expect(innerBody.items[0].source).toBe(
      "https://www.sec.gov/Archives/edgar/data/1/abc/primary_doc.xml",
    );
  });

  it("scrubs a smuggled 'sourceUrl' from a funding-rounds row (opposite-field smuggle)", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "funding-rounds",
      row: {
        id: "fr01234567",
        companyId: "anthropic",
        name: "x",
        // funding-rounds uses `source`; a caller smuggling `sourceUrl` into
        // the row is dropped so it can't round-trip through an unused column.
        sourceUrl: "https://attacker.example.com/smuggled",
      },
      sourceUrl:
        "https://www.sec.gov/Archives/edgar/data/1/abc/primary_doc.xml",
    });
    expect(res.status).toBe(200);
    const innerBody = captured[0].body as {
      items: Array<{ source: string; sourceUrl?: unknown }>;
    };
    expect(innerBody.items[0].sourceUrl).toBeUndefined();
    expect(innerBody.items[0].source).toBe(
      "https://www.sec.gov/Archives/edgar/data/1/abc/primary_doc.xml",
    );
  });

  it("scrubs a smuggled 'source' from a benchmark-results row (opposite-field smuggle)", async () => {
    const app = buildApp();
    const res = await postJson(app, "/api/enrichment/propose", {
      tier: "T1",
      recordType: "benchmark-results",
      row: {
        id: "br01234567",
        benchmarkId: "ifeval",
        modelId: "claude-3-5-sonnet",
        score: 75.2,
        // benchmark-results uses `sourceUrl`; smuggled `source` is dropped.
        source: "https://attacker.example.com/smuggled",
      },
      sourceUrl:
        "https://huggingface.co/spaces/open-llm-leaderboard/open_llm_leaderboard?row=x",
    });
    expect(res.status).toBe(200);
    const innerBody = captured[0].body as {
      items: Array<{ sourceUrl: string; source?: unknown }>;
    };
    expect(innerBody.items[0].source).toBeUndefined();
    expect(innerBody.items[0].sourceUrl).toContain(
      "huggingface.co/spaces/open-llm-leaderboard",
    );
  });
});
