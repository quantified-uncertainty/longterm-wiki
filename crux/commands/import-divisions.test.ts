import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const { mockFetchInlineSourcing, mockSyncDivisions, mockGetServerUrl } =
  vi.hoisted(() => ({
    mockFetchInlineSourcing: vi.fn(),
    mockSyncDivisions: vi.fn(),
    mockGetServerUrl: vi.fn(() => "https://fake.wiki-server"),
  }));
vi.mock("../lib/wiki-server/inline-sourcing.ts", () => ({
  fetchInlineSourcing: mockFetchInlineSourcing,
}));
vi.mock("../lib/wiki-server/divisions.ts", () => ({
  syncDivisions: mockSyncDivisions,
  deleteDivisionsBatch: vi.fn(),
}));
vi.mock("../lib/wiki-server/client.ts", () => ({
  getServerUrl: mockGetServerUrl,
}));

import { commands as divisionsCommands } from "./import-divisions.ts";
import type { InlineSourcing } from "../lib/wiki-server/inline-sourcing.ts";

/**
 * Returns a Map whose `.get(anyId)` always yields the same sourcing object.
 * Avoids having to enumerate DIVISIONS (imported lazily by the command) just
 * to seed a keyed map.
 */
function universalMap(sourcing: InlineSourcing): Map<string, InlineSourcing> {
  return new Proxy(new Map<string, InlineSourcing>(), {
    get(target, prop) {
      if (prop === "get") return () => sourcing;
      return Reflect.get(target, prop);
    },
  }) as Map<string, InlineSourcing>;
}

describe("import-divisions sync — sourcing attach", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchInlineSourcing.mockResolvedValue(new Map());
    mockSyncDivisions.mockResolvedValue({
      ok: true,
      data: { upserted: 0, verdictsWritten: 0, claimsLinked: 0 },
    });
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  function logged(): string[] {
    return logSpy.mock.calls.map((args: unknown[]) =>
      args.map((a) => String(a)).join(" "),
    );
  }

  it("fetches verdicts and reports 0/N sourced when no verdicts exist", async () => {
    const res = await divisionsCommands.sync([], { "dry-run": true });
    expect(res.exitCode).toBe(0);
    expect(mockFetchInlineSourcing).toHaveBeenCalledWith("division");
    expect(mockSyncDivisions).not.toHaveBeenCalled();
    const summary = logged().find((l) => l.includes("Sourcing:"));
    expect(summary).toMatch(/0\/\d+ records have verdicts/);
    expect(summary).toMatch(/unsourced — server will reject/);
  });

  it("reports attached count when records have verdicts", async () => {
    mockFetchInlineSourcing.mockResolvedValueOnce(
      universalMap({
        verdict: "confirmed",
        confidence: 0.9,
        checkedAt: "2026-04-24T00:00:00.000Z",
      }),
    );
    await divisionsCommands.sync([], { "dry-run": true });

    const summary = logged().find((l) => l.includes("Sourcing:"));
    expect(summary).toMatch(/\d+\/\d+ records have verdicts$/);
    expect(summary).not.toContain("unsourced");
    expect(logged().some((l) => l.includes("[confirmed]"))).toBe(true);
  });

  it("skips the verdict fetch under --force-skip-sourcing", async () => {
    await divisionsCommands.sync([], {
      "dry-run": true,
      "force-skip-sourcing": true,
      reason: "smoke-test",
    });
    expect(mockFetchInlineSourcing).not.toHaveBeenCalled();
    const summary = logged().find((l) => l.includes("Sourcing:"));
    expect(summary).toContain("skipped");
    expect(summary).toContain("smoke-test");
  });

  it("rejects --force-skip-sourcing without --reason", async () => {
    await expect(
      divisionsCommands.sync([], { "force-skip-sourcing": true }),
    ).rejects.toThrow(/reason/);
    expect(mockFetchInlineSourcing).not.toHaveBeenCalled();
    expect(mockSyncDivisions).not.toHaveBeenCalled();
  });

  it("POSTs attached sourcing to syncDivisions on a real sync", async () => {
    mockFetchInlineSourcing.mockResolvedValueOnce(
      universalMap({ verdict: "confirmed" }),
    );
    await divisionsCommands.sync([], {});

    expect(mockSyncDivisions).toHaveBeenCalledOnce();
    const [items] = mockSyncDivisions.mock.calls[0];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) {
      expect(item.sourcing).toEqual({ verdict: "confirmed" });
    }
  });

  it("passes forceSkipSourcing + reason through to the client on a real sync", async () => {
    await divisionsCommands.sync([], {
      "force-skip-sourcing": true,
      reason: "ops backfill",
    });

    expect(mockFetchInlineSourcing).not.toHaveBeenCalled();
    expect(mockSyncDivisions).toHaveBeenCalledOnce();
    const [, opts] = mockSyncDivisions.mock.calls[0];
    expect(opts).toEqual({
      forceSkipSourcing: true,
      forceSkipSourcingReason: "ops backfill",
    });
  });

  it("throws when syncDivisions returns an error", async () => {
    mockSyncDivisions.mockResolvedValueOnce({
      ok: false,
      error: { status: 400 },
      message: "sourcing missing",
    });
    await expect(
      divisionsCommands.sync([], {
        "force-skip-sourcing": true,
        reason: "test",
      }),
    ).rejects.toThrow(/sourcing missing/);
  });
});
