import { describe, it, expect, vi } from "vitest";
import { matchGrantee, MANUAL_GRANTEE_OVERRIDES, buildEntityMatcher } from "../entity-matcher.ts";
import type { EntityMatcher } from "../types.ts";
import * as fs from "fs";

function makeMockMatcher(map: Record<string, string>): EntityMatcher {
  const nameMap = new Map(
    Object.entries(map).map(([name, stableId]) => [
      name.toLowerCase(),
      { stableId, slug: name, name },
    ])
  );
  return {
    allNames: nameMap,
    match: (name: string) => nameMap.get(name.toLowerCase().trim()) || null,
  };
}

describe("matchGrantee", () => {
  const matcher = makeMockMatcher({
    miri: "abc123",
    anthropic: "def456",
    arc: "ghi789",
    "center-for-ai-safety": "jkl012",
    cset: "mno345",
    elicit: "pqr678",
  });

  it("matches via manual override", () => {
    // "Machine Intelligence Research Institute" → "miri" → "abc123"
    expect(matchGrantee("Machine Intelligence Research Institute", matcher)).toBe("abc123");
  });

  it("matches via override acronym", () => {
    expect(matchGrantee("MIRI", matcher)).toBe("abc123");
  });

  it("returns null for unknown name", () => {
    expect(matchGrantee("Totally Unknown Org", matcher)).toBeNull();
  });

  it("matches directly when no override exists", () => {
    expect(matchGrantee("Anthropic", matcher)).toBe("def456");
  });

  it("prefers override over direct match when both exist", () => {
    // "ARC" override maps to "arc" slug which resolves to ghi789
    expect(matchGrantee("ARC", matcher)).toBe("ghi789");
  });

  it("accepts extra overrides", () => {
    const result = matchGrantee("Custom Org", matcher, { "Custom Org": "miri" });
    expect(result).toBe("abc123");
  });

  it("extra overrides take precedence over built-in", () => {
    const result = matchGrantee("MIRI", matcher, { MIRI: "cset" });
    expect(result).toBe("mno345");
  });

  it("includes FTX-specific overrides", () => {
    expect(MANUAL_GRANTEE_OVERRIDES["Ought"]).toBe("elicit");
    expect(MANUAL_GRANTEE_OVERRIDES["Quantified Uncertainty Research Institute"]).toBe("quri");
  });
});

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof fs>("fs");
  return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

describe("buildEntityMatcher — missing files", () => {
  it("handles missing kb-data.json gracefully", () => {
    const readMock = vi.mocked(fs.readFileSync);
    readMock.mockImplementation((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const pathStr = String(path);
      if (pathStr.includes("kb-data.json")) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      if (pathStr.includes("database.json")) {
        return JSON.stringify({ typedEntities: [] });
      }
      throw new Error(`Unexpected read: ${pathStr}`);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matcher = buildEntityMatcher();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("kb-data.json not found")
    );
    // Matcher still works, just empty
    expect(matcher.match("Nonexistent Org")).toBeNull();
    expect(matcher.allNames.size).toBe(0);

    warnSpy.mockRestore();
    readMock.mockRestore();
  });

  it("handles missing database.json gracefully", () => {
    const readMock = vi.mocked(fs.readFileSync);
    readMock.mockImplementation((path: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      const pathStr = String(path);
      if (pathStr.includes("kb-data.json")) {
        return JSON.stringify({ slugToEntityId: {}, entities: {} });
      }
      if (pathStr.includes("database.json")) {
        const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        throw err;
      }
      throw new Error(`Unexpected read: ${pathStr}`);
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matcher = buildEntityMatcher();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("database.json not found")
    );
    expect(matcher.match("Nonexistent Org")).toBeNull();

    warnSpy.mockRestore();
    readMock.mockRestore();
  });

  it("handles both files missing gracefully", () => {
    const readMock = vi.mocked(fs.readFileSync);
    readMock.mockImplementation((path: fs.PathOrFileDescriptor) => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const matcher = buildEntityMatcher();

    expect(warnSpy).toHaveBeenCalledTimes(2);
    expect(matcher.allNames.size).toBe(0);
    expect(matcher.match("anything")).toBeNull();

    warnSpy.mockRestore();
    readMock.mockRestore();
  });

  it("re-throws non-ENOENT errors", () => {
    const readMock = vi.mocked(fs.readFileSync);
    readMock.mockImplementation(() => {
      throw new Error("EACCES: permission denied");
    });

    expect(() => buildEntityMatcher()).toThrow("EACCES: permission denied");

    readMock.mockRestore();
  });
});
