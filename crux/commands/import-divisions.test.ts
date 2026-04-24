/**
 * Tests for import-divisions cmdSync — QUA-677.
 *
 * Covers the sourcing-attach wiring: the command must fetch verdicts from PG,
 * map them onto the right divisions, and honor --force-skip-sourcing by not
 * fetching at all. The helper itself is tested in
 * crux/lib/wiki-server/inline-sourcing.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

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

/** Capture console.log so we can assert on output. */
function captureConsole() {
  const originalLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(" "));
  };
  return {
    lines,
    restore: () => {
      console.log = originalLog;
    },
  };
}

describe("import-divisions sync — sourcing attach (QUA-677)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchInlineSourcing.mockResolvedValue(new Map());
    mockSyncDivisions.mockResolvedValue({
      ok: true,
      data: { upserted: 0, verdictsWritten: 0, claimsLinked: 0 },
    });
  });

  it("fetches verdicts and attaches sourcing to matched divisions (dry-run)", async () => {
    // Use a recordId that exists in DIVISIONS — pick the first one. We can't
    // import DIVISIONS directly without also importing the command side-effect,
    // so instead set up a fetch that matches every item (wildcard by default
    // verdict), and verify attach count equals total via the log line.
    mockFetchInlineSourcing.mockResolvedValueOnce(
      new Map([
        // Return entries for common ids; unmatched items will be reported unsourced.
        // We purposely return an empty map to assert the 0/N log line, then a
        // separate test exercises a non-empty map via a spy.
      ]),
    );
    const cap = captureConsole();
    try {
      const res = await divisionsCommands.sync([], { "dry-run": true });
      expect(res.exitCode).toBe(0);
    } finally {
      cap.restore();
    }

    expect(mockFetchInlineSourcing).toHaveBeenCalledWith("division");
    expect(mockSyncDivisions).not.toHaveBeenCalled(); // dry-run
    const summary = cap.lines.find((l) => l.includes("Sourcing:"));
    expect(summary).toBeDefined();
    expect(summary).toMatch(/0\/\d+ records have verdicts/);
    expect(summary).toMatch(/unsourced — server will reject/);
  });

  it("reports attached count when some records have verdicts", async () => {
    // Capture the actual first id by running once with an empty map,
    // parsing the dry-run line, then re-running with a matching map.
    // Simpler: stub fetch to return a map that matches ANY input id via a
    // Proxy, and count attaches.
    const universalMap = new Proxy(new Map<string, unknown>(), {
      get(target, prop) {
        if (prop === "get") {
          return (_key: string) => ({
            verdict: "confirmed",
            confidence: 0.9,
            checkedAt: "2026-04-24T00:00:00.000Z",
          });
        }
        return Reflect.get(target, prop);
      },
    });
    mockFetchInlineSourcing.mockResolvedValueOnce(universalMap);

    const cap = captureConsole();
    try {
      await divisionsCommands.sync([], { "dry-run": true });
    } finally {
      cap.restore();
    }
    const summary = cap.lines.find((l) => l.includes("Sourcing:"));
    expect(summary).toBeDefined();
    // All records attached — no "unsourced" warning suffix.
    expect(summary).toMatch(/\d+\/\d+ records have verdicts$/);
    expect(summary).not.toContain("unsourced");

    // Dry-run printed per-item badges with the verdict name.
    const itemLines = cap.lines.filter((l) => l.includes("[confirmed]"));
    expect(itemLines.length).toBeGreaterThan(0);
  });

  it("skips the verdict fetch under --force-skip-sourcing", async () => {
    const cap = captureConsole();
    try {
      await divisionsCommands.sync([], {
        "dry-run": true,
        "force-skip-sourcing": true,
        reason: "smoke-test",
      });
    } finally {
      cap.restore();
    }
    expect(mockFetchInlineSourcing).not.toHaveBeenCalled();
    const summary = cap.lines.find((l) => l.includes("Sourcing:"));
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
      new Proxy(new Map(), {
        get(target, prop) {
          if (prop === "get") {
            return () => ({ verdict: "confirmed" });
          }
          return Reflect.get(target, prop);
        },
      }),
    );

    const cap = captureConsole();
    try {
      await divisionsCommands.sync([], {});
    } finally {
      cap.restore();
    }

    expect(mockSyncDivisions).toHaveBeenCalledOnce();
    const [items] = mockSyncDivisions.mock.calls[0];
    expect(Array.isArray(items)).toBe(true);
    expect(items.length).toBeGreaterThan(0);
    // Every item carries the inline sourcing payload.
    for (const item of items) {
      expect(item.sourcing).toEqual({ verdict: "confirmed" });
    }
  });

  it("passes forceSkipSourcing + reason through to the client on a real sync", async () => {
    const cap = captureConsole();
    try {
      await divisionsCommands.sync([], {
        "force-skip-sourcing": true,
        reason: "ops backfill",
      });
    } finally {
      cap.restore();
    }

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
    const cap = captureConsole();
    try {
      await expect(
        divisionsCommands.sync([], {
          "force-skip-sourcing": true,
          reason: "test",
        }),
      ).rejects.toThrow(/sourcing missing/);
    } finally {
      cap.restore();
    }
  });
});
