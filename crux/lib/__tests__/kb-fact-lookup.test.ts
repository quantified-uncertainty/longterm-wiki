import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildKBFactSourceMap, findKBFactByUrl } from "../kb-fact-lookup";

// Mock fs.readFile to avoid reading real YAML files
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
}));

import { readFile } from "node:fs/promises";

const mockReadFile = vi.mocked(readFile);

describe("buildKBFactSourceMap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns empty map when YAML file does not exist", async () => {
    const err = new Error("ENOENT") as NodeJS.ErrnoException;
    err.code = "ENOENT";
    mockReadFile.mockRejectedValue(err);

    const map = await buildKBFactSourceMap("nonexistent-entity");
    expect(map.size).toBe(0);
  });

  it("returns empty map when YAML has no facts", async () => {
    mockReadFile.mockResolvedValue(`
thing:
  id: test-entity
  stableId: abc123
  type: organization
  name: Test Entity
`);

    const map = await buildKBFactSourceMap("test-entity");
    expect(map.size).toBe(0);
  });

  it("builds source map from facts with source URLs", async () => {
    mockReadFile.mockResolvedValue(`
thing:
  id: test-org
  stableId: abc123
  type: organization
  name: Test Org

facts:
  - id: f_abc123
    property: revenue
    value: 100000000
    source: https://example.com/revenue-report
  - id: f_def456
    property: headcount
    value: 500
    source: https://other.com/headcount
  - id: f_no_source
    property: founded
    value: 2020
`);

    const map = await buildKBFactSourceMap("test-org");
    expect(map.size).toBe(2);
    expect(map.get("example.com/revenue-report")).toEqual({
      factId: "f_abc123",
      property: "revenue",
      source: "https://example.com/revenue-report",
    });
    expect(map.get("other.com/headcount")).toEqual({
      factId: "f_def456",
      property: "headcount",
      source: "https://other.com/headcount",
    });
  });

  it("first fact wins when multiple facts share the same source URL", async () => {
    mockReadFile.mockResolvedValue(`
thing:
  id: test-org
  stableId: abc123
  type: organization
  name: Test Org

facts:
  - id: f_first
    property: revenue
    value: 100000000
    source: https://example.com/report
  - id: f_second
    property: headcount
    value: 500
    source: https://example.com/report
`);

    const map = await buildKBFactSourceMap("test-org");
    expect(map.size).toBe(1);
    expect(map.get("example.com/report")?.factId).toBe("f_first");
  });

  it("logs warning on non-ENOENT errors", async () => {
    const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const err = new Error("Permission denied") as NodeJS.ErrnoException;
    err.code = "EACCES";
    mockReadFile.mockRejectedValue(err);

    const map = await buildKBFactSourceMap("test-entity");
    expect(map.size).toBe(0);
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("[kb-fact-lookup]"),
    );
    consoleSpy.mockRestore();
  });
});

describe("findKBFactByUrl", () => {
  it("finds a matching fact by normalized URL", () => {
    const map = new Map([
      [
        "example.com/report",
        { factId: "f_abc", property: "revenue", source: "https://example.com/report" },
      ],
    ]);

    // Match with different protocol
    const match = findKBFactByUrl(map, "http://example.com/report");
    expect(match?.factId).toBe("f_abc");
  });

  it("matches URLs with www prefix differences", () => {
    const map = new Map([
      [
        "example.com/page",
        { factId: "f_abc", property: "revenue", source: "https://www.example.com/page" },
      ],
    ]);

    const match = findKBFactByUrl(map, "https://example.com/page");
    expect(match?.factId).toBe("f_abc");
  });

  it("matches URLs with trailing slash differences", () => {
    const map = new Map([
      [
        "example.com/page",
        { factId: "f_abc", property: "revenue", source: "https://example.com/page/" },
      ],
    ]);

    const match = findKBFactByUrl(map, "https://example.com/page");
    expect(match?.factId).toBe("f_abc");
  });

  it("returns undefined when no match", () => {
    const map = new Map([
      [
        "example.com/report",
        { factId: "f_abc", property: "revenue", source: "https://example.com/report" },
      ],
    ]);

    const match = findKBFactByUrl(map, "https://other.com/page");
    expect(match).toBeUndefined();
  });
});
