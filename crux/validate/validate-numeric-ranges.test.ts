import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateRecord,
  fetchAllRecords,
  runCheck,
  TABLE_CONFIGS,
  type RangeFieldPair,
  type RangeViolation,
  type TableConfig,
} from "./validate-numeric-ranges.ts";

// ---------------------------------------------------------------------------
// validateRecord — pure logic, no network
// ---------------------------------------------------------------------------

describe("validateRecord", () => {
  const amountPairs: RangeFieldPair[] = [
    { lowField: "amountLow", highField: "amountHigh", label: "amount" },
  ];

  const multiPairs: RangeFieldPair[] = [
    { lowField: "raisedLow", highField: "raisedHigh", label: "raised" },
    { lowField: "valuationLow", highField: "valuationHigh", label: "valuation" },
  ];

  it("returns empty array when low <= high", () => {
    const record = { id: "rec1", amountLow: 100, amountHigh: 200 };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toEqual([]);
  });

  it("returns empty array when low equals high", () => {
    const record = { id: "rec1", amountLow: 100, amountHigh: 100 };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toEqual([]);
  });

  it("detects violation when low > high", () => {
    const record = { id: "rec1", amountLow: 300, amountHigh: 100 };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toEqual({
      table: "investments",
      recordId: "rec1",
      fieldPair: "amountLow/amountHigh",
      low: 300,
      high: 100,
    });
  });

  it("skips null low value", () => {
    const record = { id: "rec1", amountLow: null, amountHigh: 100 };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toEqual([]);
  });

  it("skips null high value", () => {
    const record = { id: "rec1", amountLow: 100, amountHigh: null };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toEqual([]);
  });

  it("skips when both values are null", () => {
    const record = { id: "rec1", amountLow: null, amountHigh: null };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toEqual([]);
  });

  it("skips undefined values (missing fields)", () => {
    const record = { id: "rec1" };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toEqual([]);
  });

  it("handles multiple range pairs — violation in only one pair", () => {
    const record = {
      id: "fr1",
      raisedLow: 100,
      raisedHigh: 200,
      valuationLow: 500,
      valuationHigh: 300, // violation
    };
    const violations = validateRecord(record, "funding_rounds", multiPairs);
    expect(violations).toHaveLength(1);
    expect(violations[0].fieldPair).toBe("valuationLow/valuationHigh");
    expect(violations[0].low).toBe(500);
    expect(violations[0].high).toBe(300);
  });

  it("handles multiple range pairs — violations in both pairs", () => {
    const record = {
      id: "fr1",
      raisedLow: 200,
      raisedHigh: 100, // violation
      valuationLow: 500,
      valuationHigh: 300, // violation
    };
    const violations = validateRecord(record, "funding_rounds", multiPairs);
    expect(violations).toHaveLength(2);
  });

  it("handles string numeric values from API (Drizzle returns numeric as string)", () => {
    // The API formatRow converts to Number, but guard against edge cases
    const record = { id: "rec1", amountLow: "300", amountHigh: "100" };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toHaveLength(1);
    expect(violations[0].low).toBe(300);
    expect(violations[0].high).toBe(100);
  });

  it("skips NaN values gracefully", () => {
    const record = { id: "rec1", amountLow: "not-a-number", amountHigh: 100 };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toEqual([]);
  });

  it("uses 'unknown' when record has no id field", () => {
    const record = { amountLow: 300, amountHigh: 100 };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toHaveLength(1);
    expect(violations[0].recordId).toBe("unknown");
  });

  it("handles zero values correctly — 0 <= 0 is valid", () => {
    const record = { id: "rec1", amountLow: 0, amountHigh: 0 };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toEqual([]);
  });

  it("handles negative values — -10 <= -5 is valid", () => {
    const record = { id: "rec1", amountLow: -10, amountHigh: -5 };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toEqual([]);
  });

  it("detects violation with negative values — -5 > -10", () => {
    const record = { id: "rec1", amountLow: -5, amountHigh: -10 };
    const violations = validateRecord(record, "investments", amountPairs);
    expect(violations).toHaveLength(1);
  });

  it("handles very small floating point values", () => {
    // Typical for stake percentages like 0.07 and 0.15
    const stakePairs: RangeFieldPair[] = [
      { lowField: "stakeLow", highField: "stakeHigh", label: "stake" },
    ];
    const record = { id: "rec1", stakeLow: 0.07, stakeHigh: 0.15 };
    const violations = validateRecord(record, "investments", stakePairs);
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// fetchAllRecords — network, mocked
// ---------------------------------------------------------------------------

describe("fetchAllRecords", () => {
  const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

  const testConfig: TableConfig = {
    endpoint: "/api/investments/all",
    tableName: "investments",
    recordsKey: "investments",
    rangePairs: [
      { lowField: "amountLow", highField: "amountHigh", label: "amount" },
    ],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3000";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
  });

  afterEach(() => {
    if (origUrl !== undefined)
      process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined)
      process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it("fetches all records in a single page", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          investments: [
            { id: "inv1", amountLow: 100, amountHigh: 200 },
            { id: "inv2", amountLow: 50, amountHigh: 150 },
          ],
          total: 2,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await fetchAllRecords(testConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(2);
    }
  });

  it("returns error on network failure", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new Error("Connection refused"),
    );

    const result = await fetchAllRecords(testConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Connection refused");
    }
  });

  it("returns error on unexpected response shape", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({ data: [] }), // missing "investments" key
        { status: 200 },
      ),
    );

    const result = await fetchAllRecords(testConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain('missing "investments" array');
    }
  });

  it("paginates through multiple pages", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Page 1
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          investments: Array.from({ length: 200 }, (_, i) => ({
            id: `inv${i}`,
            amountLow: 100,
            amountHigh: 200,
          })),
          total: 300,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Page 2
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          investments: Array.from({ length: 100 }, (_, i) => ({
            id: `inv${200 + i}`,
            amountLow: 100,
            amountHigh: 200,
          })),
          total: 300,
          limit: 200,
          offset: 200,
        }),
        { status: 200 },
      ),
    );

    const result = await fetchAllRecords(testConfig);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.records).toHaveLength(300);
    }
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("returns error when pagination cap is hit before all records are fetched", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Mock MAX_PAGES (100) consecutive pages of 200 records each, all reporting
    // total=20001 so offset never reaches total before the cap fires.
    for (let i = 0; i < 100; i++) {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            investments: Array.from({ length: 200 }, (_, j) => ({
              id: `inv${i * 200 + j}`,
              amountLow: 1,
              amountHigh: 2,
            })),
            total: 20001,
            limit: 200,
            offset: i * 200,
          }),
          { status: 200 },
        ),
      );
    }

    const result = await fetchAllRecords(testConfig);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("Pagination safety limit reached");
      expect(result.message).toContain("investments");
      expect(result.message).toContain("MAX_PAGES=100");
    }
    expect(fetchSpy).toHaveBeenCalledTimes(100);
  });
});

// ---------------------------------------------------------------------------
// runCheck — integration (mocked network)
// ---------------------------------------------------------------------------

describe("runCheck", () => {
  const origUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const origKey = process.env.LONGTERMWIKI_SERVER_API_KEY;

  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.LONGTERMWIKI_SERVER_URL = "http://localhost:3000";
    process.env.LONGTERMWIKI_SERVER_API_KEY = "test-key";
  });

  afterEach(() => {
    if (origUrl !== undefined)
      process.env.LONGTERMWIKI_SERVER_URL = origUrl;
    else delete process.env.LONGTERMWIKI_SERVER_URL;
    if (origKey !== undefined)
      process.env.LONGTERMWIKI_SERVER_API_KEY = origKey;
    else delete process.env.LONGTERMWIKI_SERVER_API_KEY;
  });

  it("passes when server URL is not configured (fail-open)", async () => {
    delete process.env.LONGTERMWIKI_SERVER_URL;

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(true);
    expect(result.warnings).toBe(1);
  });

  it("passes when server is unreachable (fail-open)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Connection refused"),
    );

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(true);
    expect(result.warnings).toBe(1);
  });

  it("passes when all records have valid ranges", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Funding rounds
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fundingRounds: [
            { id: "fr1", raisedLow: 100, raisedHigh: 200, valuationLow: 1000, valuationHigh: 2000 },
          ],
          total: 1,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Investments
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          investments: [
            { id: "inv1", amountLow: 50, amountHigh: 100, stakeLow: 0.05, stakeHigh: 0.10 },
          ],
          total: 1,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Equity positions
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          equityPositions: [
            { id: "ep1", stakeLow: 0.01, stakeHigh: 0.03 },
          ],
          total: 1,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(true);
    expect(result.errors).toBe(0);
  });

  it("fails when a range violation is found", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Funding rounds — violation: raisedLow > raisedHigh
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fundingRounds: [
            { id: "fr1", raisedLow: 500, raisedHigh: 100, valuationLow: null, valuationHigh: null },
          ],
          total: 1,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Investments — clean
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          investments: [],
          total: 0,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Equity positions — clean
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          equityPositions: [],
          total: 0,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(false);
    expect(result.errors).toBe(1);
  });

  it("reports multiple violations across tables", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    // Funding rounds — 1 violation
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          fundingRounds: [
            { id: "fr1", raisedLow: 500, raisedHigh: 100, valuationLow: null, valuationHigh: null },
          ],
          total: 1,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Investments — 2 violations (both amount and stake)
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          investments: [
            { id: "inv1", amountLow: 300, amountHigh: 100, stakeLow: 0.15, stakeHigh: 0.05 },
          ],
          total: 1,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    // Equity positions — clean
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          equityPositions: [],
          total: 0,
          limit: 200,
          offset: 0,
        }),
        { status: 200 },
      ),
    );

    const result = await runCheck({ ci: true });
    expect(result.passed).toBe(false);
    expect(result.errors).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// TABLE_CONFIGS — structural checks
// ---------------------------------------------------------------------------

describe("TABLE_CONFIGS", () => {
  it("has entries for all three financial tables", () => {
    const tableNames = TABLE_CONFIGS.map((c) => c.tableName);
    expect(tableNames).toContain("funding_rounds");
    expect(tableNames).toContain("investments");
    expect(tableNames).toContain("equity_positions");
  });

  it("funding_rounds has raised and valuation range pairs", () => {
    const config = TABLE_CONFIGS.find((c) => c.tableName === "funding_rounds");
    expect(config).toBeDefined();
    const labels = config!.rangePairs.map((p) => p.label);
    expect(labels).toContain("raised");
    expect(labels).toContain("valuation");
  });

  it("investments has amount and stake range pairs", () => {
    const config = TABLE_CONFIGS.find((c) => c.tableName === "investments");
    expect(config).toBeDefined();
    const labels = config!.rangePairs.map((p) => p.label);
    expect(labels).toContain("amount");
    expect(labels).toContain("stake");
  });

  it("equity_positions has stake range pair", () => {
    const config = TABLE_CONFIGS.find((c) => c.tableName === "equity_positions");
    expect(config).toBeDefined();
    const labels = config!.rangePairs.map((p) => p.label);
    expect(labels).toContain("stake");
  });

  it("all configs have valid endpoint paths starting with /api/", () => {
    for (const config of TABLE_CONFIGS) {
      expect(config.endpoint).toMatch(/^\/api\//);
    }
  });

  it("all range pairs have matching Low/High field suffixes", () => {
    for (const config of TABLE_CONFIGS) {
      for (const pair of config.rangePairs) {
        expect(pair.lowField).toMatch(/Low$/);
        expect(pair.highField).toMatch(/High$/);
      }
    }
  });
});
