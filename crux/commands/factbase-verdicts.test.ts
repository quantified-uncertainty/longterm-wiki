/**
 * Tests for `crux fb verdicts prune-orphans` (QUA-930).
 *
 * The command is a thin wrapper around `cleanupOrphanVerdicts` with
 * `recordType: 'fact'` baked in. We mock the wiki-server client and
 * assert call shape, exit codes, and output formatting.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the sourcing-client BEFORE importing the command (vi.mock is hoisted).
vi.mock("../lib/wiki-server/sourcing-client.ts", () => ({
  cleanupOrphanVerdicts: vi.fn(),
}));

import { commands } from "./factbase-verdicts.ts";
import { cleanupOrphanVerdicts } from "../lib/wiki-server/sourcing-client.ts";

const mockCleanup = vi.mocked(cleanupOrphanVerdicts);

beforeEach(() => {
  mockCleanup.mockReset();
});

describe("crux fb verdicts prune-orphans", () => {
  it("defaults to dryRun=true and recordType=fact", async () => {
    mockCleanup.mockResolvedValue({
      ok: true,
      data: {
        dryRun: true,
        deleted: { verdicts: 0, evidence: 0, suggestions: 0 },
        byType: {},
      },
    });

    const result = await commands.default(["prune-orphans"], {});
    expect(result.exitCode).toBe(0);

    expect(mockCleanup).toHaveBeenCalledWith({
      dryRun: true,
      recordType: "fact",
    });
  });

  it("--apply switches to dryRun=false", async () => {
    mockCleanup.mockResolvedValue({
      ok: true,
      data: {
        dryRun: false,
        deleted: { verdicts: 5, evidence: 7, suggestions: 0 },
        byType: { fact: { verdicts: 5, evidence: 7, suggestions: 0 } },
      },
    });

    await commands.default(["prune-orphans"], { apply: true });

    expect(mockCleanup).toHaveBeenCalledWith({
      dryRun: false,
      recordType: "fact",
    });
  });

  it("rejects --apply and --dry-run together with exit code 2", async () => {
    const result = await commands.default(["prune-orphans"], {
      apply: true,
      "dry-run": true,
    });
    expect(result.exitCode).toBe(2);
    expect(result.output).toMatch(/mutually exclusive/);
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it("--ci returns the raw JSON body", async () => {
    const data = {
      dryRun: true,
      deleted: { verdicts: 1092, evidence: 1276, suggestions: 0 },
      byType: { fact: { verdicts: 1092, evidence: 1276, suggestions: 0 } },
    };
    mockCleanup.mockResolvedValue({ ok: true, data });

    const result = await commands.default(["prune-orphans"], { ci: true });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.output)).toEqual(data);
  });

  it("formats the human-readable output with fact counts only", async () => {
    mockCleanup.mockResolvedValue({
      ok: true,
      data: {
        dryRun: true,
        deleted: { verdicts: 100, evidence: 200, suggestions: 3 },
        byType: { fact: { verdicts: 100, evidence: 200, suggestions: 3 } },
      },
    });

    const result = await commands.default(["prune-orphans"], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/Verdicts:\s+100/);
    expect(result.output).toMatch(/Evidence:\s+200/);
    expect(result.output).toMatch(/Suggestions:\s+3/);
    expect(result.output).toMatch(/dry run/i);
  });

  it("reports nothing-to-do when result is empty", async () => {
    mockCleanup.mockResolvedValue({
      ok: true,
      data: {
        dryRun: true,
        deleted: { verdicts: 0, evidence: 0, suggestions: 0 },
        byType: {},
      },
    });

    const result = await commands.default(["prune-orphans"], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/No orphan fact verdicts found/);
  });

  it("warns when the server returns non-fact rows in byType (sanity guard)", async () => {
    // We asked for --type=fact but server reported personnel rows too. The
    // byType breakdown is hand-aggregated; this guard makes a future server
    // bug visible.
    mockCleanup.mockResolvedValue({
      ok: true,
      data: {
        dryRun: false,
        deleted: { verdicts: 5, evidence: 0, suggestions: 0 },
        byType: { fact: { verdicts: 3, evidence: 0, suggestions: 0 } },
        // Note: deleted.verdicts=5 but byType.fact.verdicts=3 → 2 are unattributed
      },
    });

    const result = await commands.default(["prune-orphans"], { apply: true });
    expect(result.output).toMatch(/Warning: server returned non-fact rows/);
  });

  it("returns exit 1 with the upstream error message on a failed call", async () => {
    mockCleanup.mockResolvedValue({
      ok: false,
      error: "unavailable",
      message: "ECONNREFUSED",
    });

    const result = await commands.default(["prune-orphans"], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/ECONNREFUSED/);
  });

  it("prints help when called with no subcommand", async () => {
    const result = await commands.default([], {});
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/prune-orphans/);
    expect(mockCleanup).not.toHaveBeenCalled();
  });

  it("returns exit 1 for unknown subcommands", async () => {
    const result = await commands.default(["bogus"], {});
    expect(result.exitCode).toBe(1);
    expect(result.output).toMatch(/Unknown verdicts subcommand/);
    expect(mockCleanup).not.toHaveBeenCalled();
  });
});
