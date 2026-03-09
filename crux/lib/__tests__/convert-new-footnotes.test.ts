import { describe, it, expect, vi, beforeEach } from "vitest";
import { convertNewFootnotes } from "../convert-new-footnotes";

// Mock KB fact lookup
vi.mock("../kb-fact-lookup", () => ({
  buildKBFactSourceMap: vi.fn(),
  findKBFactByUrl: vi.fn(),
}));

// Mock wiki-server client
vi.mock("../wiki-server/client", () => ({
  isServerAvailable: vi.fn().mockResolvedValue(false),
}));

// Mock wiki-server references
vi.mock("../wiki-server/references", () => ({
  createCitationsBatch: vi.fn(),
}));

// Mock resource lookup
vi.mock("../search/resource-lookup", () => ({
  getResourceByUrl: vi.fn().mockReturnValue(null),
}));

import { buildKBFactSourceMap, findKBFactByUrl } from "../kb-fact-lookup";
import type { KBFactMatch } from "../kb-fact-lookup";

const mockBuildKBFactSourceMap = vi.mocked(buildKBFactSourceMap);
const mockFindKBFactByUrl = vi.mocked(findKBFactByUrl);

describe("convertNewFootnotes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockBuildKBFactSourceMap.mockResolvedValue(new Map());
    mockFindKBFactByUrl.mockReturnValue(undefined);
  });

  it("returns unchanged content when no numbered footnotes", async () => {
    const content = "Some text with no footnotes.";
    const result = await convertNewFootnotes(content, "test-page");
    expect(result.content).toBe(content);
    expect(result.convertedCount).toBe(0);
    expect(result.kbMatchCount).toBe(0);
  });

  it("converts numbered footnotes to rc-XXXX when no entityId", async () => {
    const content = `Some text.[^1]

[^1]: [Source](https://example.com/report)
`;
    const result = await convertNewFootnotes(content, "test-page");
    expect(result.convertedCount).toBe(1);
    expect(result.kbMatchCount).toBe(0);
    expect(result.content).toMatch(/\[\^rc-[a-f0-9]+\]/);
    expect(result.content).not.toMatch(/\[\^1\]/);
  });

  it("does not load KB facts when entityId is not provided", async () => {
    const content = `Text.[^1]\n\n[^1]: https://example.com\n`;
    await convertNewFootnotes(content, "test-page");
    expect(mockBuildKBFactSourceMap).not.toHaveBeenCalled();
  });

  it("loads KB facts when entityId is provided", async () => {
    const content = `Text.[^1]\n\n[^1]: https://example.com\n`;
    await convertNewFootnotes(content, "test-page", { entityId: "my-entity" });
    expect(mockBuildKBFactSourceMap).toHaveBeenCalledWith("my-entity");
  });

  it("uses kb-factId when footnote URL matches a KB fact", async () => {
    const kbMap = new Map([
      [
        "example.com/report",
        { factId: "f_abc123", property: "revenue", source: "https://example.com/report" },
      ],
    ]);
    mockBuildKBFactSourceMap.mockResolvedValue(kbMap as Map<string, KBFactMatch>);
    mockFindKBFactByUrl.mockImplementation((map, url) => {
      // Simulate real behavior by doing a lookup
      if (url.includes("example.com/report")) {
        return { factId: "f_abc123", property: "revenue", source: "https://example.com/report" };
      }
      return undefined;
    });

    const content = `Revenue grew.[^1]

[^1]: [Revenue Report](https://example.com/report)
`;
    const result = await convertNewFootnotes(content, "test-page", {
      entityId: "test-entity",
    });

    expect(result.convertedCount).toBe(1);
    expect(result.kbMatchCount).toBe(1);
    expect(result.content).toContain("[^kb-f_abc123]");
    expect(result.content).toContain("[^kb-f_abc123]:");
    expect(result.content).not.toMatch(/\[\^1\]/);
  });

  it("falls back to rc-XXXX when footnote URL does not match KB fact", async () => {
    mockBuildKBFactSourceMap.mockResolvedValue(new Map());

    const content = `Text.[^1]\n\n[^1]: [Source](https://other.com/page)\n`;
    const result = await convertNewFootnotes(content, "test-page", {
      entityId: "test-entity",
    });

    expect(result.convertedCount).toBe(1);
    expect(result.kbMatchCount).toBe(0);
    expect(result.content).toMatch(/\[\^rc-[a-f0-9]+\]/);
  });

  it("handles mix of KB-matched and non-matched footnotes", async () => {
    const kbMap = new Map([
      [
        "example.com/report",
        { factId: "f_match", property: "revenue", source: "https://example.com/report" },
      ],
    ]);
    mockBuildKBFactSourceMap.mockResolvedValue(kbMap as Map<string, KBFactMatch>);
    mockFindKBFactByUrl.mockImplementation((_map, url) => {
      if (url.includes("example.com/report")) {
        return { factId: "f_match", property: "revenue", source: "https://example.com/report" };
      }
      return undefined;
    });

    const content = `KB source.[^1] Other source.[^2]

[^1]: [KB Report](https://example.com/report)
[^2]: [Other](https://other.com/page)
`;
    const result = await convertNewFootnotes(content, "test-page", {
      entityId: "test-entity",
    });

    expect(result.convertedCount).toBe(2);
    expect(result.kbMatchCount).toBe(1);
    expect(result.content).toContain("[^kb-f_match]");
    expect(result.content).toMatch(/\[\^rc-[a-f0-9]+\]/);
  });

  it("skips KB matching for footnotes without URLs", async () => {
    const kbMap = new Map([
      [
        "example.com/report",
        { factId: "f_match", property: "revenue", source: "https://example.com/report" },
      ],
    ]);
    mockBuildKBFactSourceMap.mockResolvedValue(kbMap as Map<string, KBFactMatch>);

    const content = `Text.[^1]\n\n[^1]: Some text without a URL\n`;
    const result = await convertNewFootnotes(content, "test-page", {
      entityId: "test-entity",
    });

    expect(result.kbMatchCount).toBe(0);
    expect(result.content).toMatch(/\[\^rc-[a-f0-9]+\]/);
  });

  it("does not collide with existing kb- refs in content", async () => {
    const kbMap = new Map([
      [
        "example.com/report",
        { factId: "f_existing", property: "revenue", source: "https://example.com/report" },
      ],
    ]);
    mockBuildKBFactSourceMap.mockResolvedValue(kbMap as Map<string, KBFactMatch>);
    mockFindKBFactByUrl.mockImplementation((_map, url) => {
      if (url.includes("example.com/report")) {
        return { factId: "f_existing", property: "revenue", source: "https://example.com/report" };
      }
      return undefined;
    });

    // Content already has [^kb-f_existing] — the new footnote should fall back to rc-XXXX
    const content = `Existing ref.[^kb-f_existing] New ref.[^1]

[^kb-f_existing]: Already here
[^1]: [Report](https://example.com/report)
`;
    const result = await convertNewFootnotes(content, "test-page", {
      entityId: "test-entity",
    });

    expect(result.kbMatchCount).toBe(0);
    expect(result.content).toMatch(/\[\^rc-[a-f0-9]+\]/);
    // Original kb-f_existing should be untouched
    expect(result.content).toContain("[^kb-f_existing]");
  });
});
