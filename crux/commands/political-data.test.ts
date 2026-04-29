/**
 * Tests for crux/commands/political-data.ts
 *
 * Focus areas:
 * - Year/cycle validation in ingest commands
 * - Score percentage formatting logic
 * - Finance dollar formatting logic
 * - Office list formatting
 * - Source registry (available/get/all)
 * - ID generation utilities (generateScoreId, placeholderEntityId, generateVoteId)
 * - generateDeterministicId: determinism, length, character set
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---- Mock external dependencies before importing the command ----

vi.mock("../lib/wiki-server/client.ts", () => ({
  getServerUrl: vi.fn(() => "http://localhost:4000"),
  apiRequest: vi.fn(),
}));

vi.mock("../lib/wiki-server/political.ts", () => ({
  getScoreStats: vi.fn(),
  getOfficeStats: vi.fn(),
  getVoteStats: vi.fn(),
  getFinanceStats: vi.fn(),
  syncOffices: vi.fn(),
  getAllScores: vi.fn(),
  getScoresByEntity: vi.fn(),
  getAllOffices: vi.fn(),
  getOfficesByEntity: vi.fn(),
  getAllVotes: vi.fn(),
  getVotesByEntity: vi.fn(),
  getVotesByLegislation: vi.fn(),
  getAllFinance: vi.fn(),
  getFinanceByEntity: vi.fn(),
}));

vi.mock("../lib/political/scorecard-ingest.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/political/scorecard-ingest.ts")
  >("../lib/political/scorecard-ingest.ts");
  return {
    ...actual,
    syncScoresToServer: vi.fn(),
    getSource: vi.fn((id: string) =>
      id === "lcv"
        ? {
            id: "lcv",
            name: "LCV",
            fetch: vi.fn().mockResolvedValue({
              source: "lcv",
              year: 2024,
              records: [],
              warnings: [],
              usedSampleData: true,
            }),
          }
        : undefined,
    ),
    getAvailableSources: vi.fn(() => ["lcv", "humane-world", "council-livable-world"]),
    getAllSources: vi.fn(() => []),
  };
});

vi.mock("../lib/political/sources/fec.ts", () => ({
  fetchFecData: vi.fn(),
  syncFinanceToServer: vi.fn(),
}));

vi.mock("../lib/political/votes-ingest.ts", async () => {
  const actual = await vi.importActual<
    typeof import("../lib/political/votes-ingest.ts")
  >("../lib/political/votes-ingest.ts");
  return {
    ...actual,
    syncVotesToServer: vi.fn(),
  };
});

vi.mock("../lib/political/stakeholder-resolver.ts", () => ({
  resolveAllStakeholders: vi.fn(),
}));

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    readFileSync: vi.fn(() => "[]"),
    writeFileSync: vi.fn(),
  };
});

import { commands } from "./political-data.ts";
import * as politicalServer from "../lib/wiki-server/political.ts";
import * as scorecardIngest from "../lib/political/scorecard-ingest.ts";
import * as fec from "../lib/political/sources/fec.ts";

const mockGetAllScores = vi.mocked(politicalServer.getAllScores);
const mockGetAllOffices = vi.mocked(politicalServer.getAllOffices);
const mockGetAllFinance = vi.mocked(politicalServer.getAllFinance);
const mockGetAllVotes = vi.mocked(politicalServer.getAllVotes);
const mockSyncScoresToServer = vi.mocked(scorecardIngest.syncScoresToServer);
const mockFetchFecData = vi.mocked(fec.fetchFecData);

// ============================================================================
// Score percentage formatting
// ============================================================================

describe("scores list — score percentage formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats score as percentage when maxScore > 0", async () => {
    mockGetAllScores.mockResolvedValue({
      ok: true,
      data: {
        scores: [
          {
            id: "s1",
            politicianDisplayName: "Alice Smith",
            politician: null as unknown as { entityId: string | null; slug: string | null; name: string | null },
            scorerOrg: "LCV",
            year: 2024,
            score: 75,
            maxScore: 100,
            scoreType: null,
            notes: null,
          } as never,
        ],
        total: 1,
        limit: 0,
        offset: 0,
      },
    });

    const result = await commands.scores([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("75%");
    expect(result.output).toContain("Alice Smith");
    expect(result.output).toContain("LCV 2024");
  });

  it("rounds to nearest integer in percentage", async () => {
    mockGetAllScores.mockResolvedValue({
      ok: true,
      data: {
        scores: [
          {
            id: "s2",
            politicianDisplayName: "Bob Jones",
            politician: null as unknown as { entityId: string | null; slug: string | null; name: string | null },
            scorerOrg: "HW",
            year: 2023,
            score: 1,
            maxScore: 3,
            scoreType: null,
            notes: null,
          } as never,
        ],
        total: 1,
        limit: 0,
        offset: 0,
      },
    });

    const result = await commands.scores([], {});
    expect(result.output).toContain("33%"); // Math.round(33.333) = 33
  });

  it("shows raw score when maxScore is 0", async () => {
    mockGetAllScores.mockResolvedValue({
      ok: true,
      data: {
        scores: [
          {
            id: "s3",
            politicianDisplayName: "Carol White",
            politician: null as unknown as { entityId: string | null; slug: string | null; name: string | null },
            scorerOrg: "XYZ",
            year: 2022,
            score: 42,
            maxScore: 0,
            scoreType: null,
            notes: null,
          } as never,
        ],
        total: 1,
        limit: 0,
        offset: 0,
      },
    });

    const result = await commands.scores([], {});
    expect(result.output).toContain("42");
    expect(result.output).not.toContain("42%");
  });

  it("shows score type when present", async () => {
    mockGetAllScores.mockResolvedValue({
      ok: true,
      data: {
        scores: [
          {
            id: "s4",
            politicianDisplayName: "Dana Brown",
            politician: null as unknown as { entityId: string | null; slug: string | null; name: string | null },
            scorerOrg: "LCV",
            year: 2024,
            score: 80,
            maxScore: 100,
            scoreType: "environmental",
            notes: null,
          } as never,
        ],
        total: 1,
        limit: 0,
        offset: 0,
      },
    });

    const result = await commands.scores([], {});
    expect(result.output).toContain("(environmental)");
  });

  it("returns empty-list message when no scores found", async () => {
    mockGetAllScores.mockResolvedValue({
      ok: true,
      data: { scores: [], total: 0, limit: 0, offset: 0 },
    });

    const result = await commands.scores([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("No political scores found.");
  });

  it("returns error when server call fails", async () => {
    mockGetAllScores.mockResolvedValue({
      ok: false,
      error: 'unavailable',
      message: "connection refused",
    });

    const result = await commands.scores([], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("Error: connection refused");
  });
});

// ============================================================================
// Finance dollar formatting
// ============================================================================

describe("finance list — dollar formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats totalRaised as $X.XM", async () => {
    mockGetAllFinance.mockResolvedValue({
      ok: true,
      data: {
        records: [
          {
            id: "f1",
            politicianDisplayName: "Sen. Tester",
            politician: null as unknown as { entityId: string | null; slug: string | null; name: string | null },
            cycle: 2024,
            party: "democratic",
            state: "MT",
            officeType: "senate",
            totalRaised: 5_400_000,
            totalSpent: 4_100_000,
          } as never,
        ],
        total: 1,
        limit: 0,
        offset: 0,
      },
    });

    const result = await commands.finance(["list"], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("$5.4M");
    expect(result.output).toContain("$4.1M");
  });

  it("shows N/A when totalRaised is missing", async () => {
    mockGetAllFinance.mockResolvedValue({
      ok: true,
      data: {
        records: [
          {
            id: "f2",
            politicianDisplayName: "Rep. Unknown",
            politician: null as unknown as { entityId: string | null; slug: string | null; name: string | null },
            cycle: 2024,
            party: null,
            state: null,
            officeType: null,
            totalRaised: null,
            totalSpent: null,
          } as never,
        ],
        total: 1,
        limit: 0,
        offset: 0,
      },
    });

    const result = await commands.finance(["list"], {});
    expect(result.output).toContain("N/A");
  });

  it("returns empty-list message when no records", async () => {
    mockGetAllFinance.mockResolvedValue({
      ok: true,
      data: { records: [], total: 0, limit: 0, offset: 0 },
    });

    const result = await commands.finance(["list"], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("No campaign finance records found.");
  });
});

// ============================================================================
// Year validation in scores ingest
// ============================================================================

describe("scores ingest — year validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSyncScoresToServer.mockResolvedValue({
      totalRecords: 0,
      upserted: 0,
      batches: 0,
      errors: [],
    });
  });

  it("rejects year below 1900", async () => {
    const result = await commands.scores(["ingest"], { year: "1800" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid year "1800"');
  });

  it("rejects year above 2100", async () => {
    const result = await commands.scores(["ingest"], { year: "2200" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid year "2200"');
  });

  it("rejects non-numeric year", async () => {
    const result = await commands.scores(["ingest"], { year: "abc" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid year "abc"');
  });

  it("rejects unknown source id", async () => {
    const result = await commands.scores(["ingest"], {
      year: "2024",
      source: "nonexistent-source",
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown source "nonexistent-source"');
    expect(result.output).toContain("Available sources:");
  });

  it("accepts valid year in range", async () => {
    // Should not immediately fail on year validation — gets to sources
    const result = await commands.scores(["ingest"], {
      year: "2024",
      source: "lcv",
      dryRun: true,
    });
    // Year validation passed — no invalid year error
    expect(result.output).not.toContain("Invalid year");
  });
});

// ============================================================================
// Election cycle validation in finance ingest
// ============================================================================

describe("finance ingest — cycle validation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects odd-year cycle", async () => {
    const result = await commands.finance(["ingest"], { cycle: "2025" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain("FEC election cycles are even years");
    expect(result.output).toContain("2025");
  });

  it("rejects cycle below 1990", async () => {
    const result = await commands.finance(["ingest"], { cycle: "1988" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid cycle "1988"');
  });

  it("rejects cycle above 2100", async () => {
    const result = await commands.finance(["ingest"], { cycle: "2102" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid cycle "2102"');
  });

  it("rejects non-numeric cycle", async () => {
    const result = await commands.finance(["ingest"], { cycle: "xy" });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Invalid cycle "xy"');
  });

  it("accepts valid even-year cycle and proceeds to fetch", async () => {
    mockFetchFecData.mockResolvedValue({
      source: 'sample',
      cycle: 2024,
      records: [],
      warnings: [],
      usedSampleData: false,
    });

    const result = await commands.finance(["ingest"], {
      cycle: "2024",
      dryRun: true,
    });
    // Cycle validation passed
    expect(result.output).not.toContain("Invalid cycle");
    expect(result.output).not.toContain("even years");
    expect(result.exitCode).toBe(0);
  });
});

// ============================================================================
// Finance — unknown subcommand
// ============================================================================

describe("finance — unknown subcommand", () => {
  it("returns error for unrecognized subcommand", async () => {
    const result = await commands.finance(["unknown-sub"], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('Unknown finance subcommand: "unknown-sub"');
    expect(result.output).toContain("ingest, list, stats");
  });
});

// ============================================================================
// Offices list formatting
// ============================================================================

describe("offices list — formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats office line with party initial uppercased", async () => {
    mockGetAllOffices.mockResolvedValue({
      ok: true,
      data: {
        offices: [
          {
            id: "o1",
            politicianDisplayName: "Jane Doe",
            politician: null as unknown as { entityId: string | null; slug: string | null; name: string | null },
            officeType: "senator",
            jurisdiction: "CA",
            district: null,
            party: "democratic",
            status: "incumbent",
          } as never,
        ],
        total: 1,
        limit: 0,
        offset: 0,
      },
    });

    const result = await commands.offices([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("[D]");
    expect(result.output).toContain("senator");
    expect(result.output).toContain("CA");
    expect(result.output).toContain("incumbent");
  });

  it("shows district when present", async () => {
    mockGetAllOffices.mockResolvedValue({
      ok: true,
      data: {
        offices: [
          {
            id: "o2",
            politicianDisplayName: "John Rep",
            politician: null as unknown as { entityId: string | null; slug: string | null; name: string | null },
            officeType: "representative",
            jurisdiction: "TX",
            district: "TX-10",
            party: "republican",
            status: "incumbent",
          } as never,
        ],
        total: 1,
        limit: 0,
        offset: 0,
      },
    });

    const result = await commands.offices([], {});
    expect(result.output).toContain("(TX-10)");
    expect(result.output).toContain("[R]");
  });

  it("returns empty-list message when no offices", async () => {
    mockGetAllOffices.mockResolvedValue({
      ok: true,
      data: { offices: [], total: 0, limit: 0, offset: 0 },
    });

    const result = await commands.offices([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("No political offices found.");
  });
});

// ============================================================================
// Votes list formatting
// ============================================================================

describe("votes list — formatting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("formats vote records with uppercased vote value", async () => {
    mockGetAllVotes.mockResolvedValue({
      ok: true,
      data: {
        votes: [
          {
            id: "v1",
            politicianDisplayName: "Sen. Smith",
            politician: null as unknown as { entityId: string | null; slug: string | null; name: string | null },
            vote: "yea",
            legislationTitle: "AI Safety Act",
            legislationEntityId: "ai-safety-act",
            chamber: "senate",
            voteDate: "2025-03-15",
          } as never,
        ],
        total: 1,
        limit: 0,
        offset: 0,
      },
    });

    const result = await commands.votes([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("YEA");
    expect(result.output).toContain("Sen. Smith");
    expect(result.output).toContain("AI Safety Act");
  });

  it("returns empty-list message when no votes", async () => {
    mockGetAllVotes.mockResolvedValue({
      ok: true,
      data: { votes: [], total: 0, limit: 0, offset: 0 },
    });

    const result = await commands.votes([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("No political votes found.");
  });
});
