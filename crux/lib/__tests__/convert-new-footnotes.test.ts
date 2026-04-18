import { describe, it, expect, vi, beforeEach } from "vitest";
import { convertNewFootnotes, createDbEntriesForRcFootnotes } from "../convert-new-footnotes";

// Mock KB fact lookup
vi.mock("../factbase-fact-lookup", () => ({
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

import { buildKBFactSourceMap, findKBFactByUrl } from "../factbase-fact-lookup";
import type { KBFactMatch } from "../factbase-fact-lookup";
import { isServerAvailable } from "../wiki-server/client";
import { createCitationsBatch } from "../wiki-server/references";
import { getResourceByUrl } from "../search/resource-lookup";

const mockBuildKBFactSourceMap = vi.mocked(buildKBFactSourceMap);
const mockFindKBFactByUrl = vi.mocked(findKBFactByUrl);
const mockIsServerAvailable = vi.mocked(isServerAvailable);
const mockCreateCitationsBatch = vi.mocked(createCitationsBatch);
const mockGetResourceByUrl = vi.mocked(getResourceByUrl);

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

  // --- QUA-569 Phase B.6 ---------------------------------------------------
  // page_citations.resource_id FKs resources.stable_id, so footnote→DB inserts
  // must write the sid_<10> form, never the legacy hex16 resource.id.
  describe("QUA-569 resourceId writes stable_id form", () => {
    beforeEach(() => {
      vi.clearAllMocks();
      mockBuildKBFactSourceMap.mockResolvedValue(new Map());
      mockFindKBFactByUrl.mockReturnValue(undefined);
      mockIsServerAvailable.mockResolvedValue(true);
      mockCreateCitationsBatch.mockResolvedValue({ ok: true, data: { inserted: 1 } as never });
    });

    it("writes resource.stable_id (not resource.id) on the citation insert", async () => {
      mockGetResourceByUrl.mockReturnValue({
        id: "deadbeef12345678", // legacy hex16 — must NOT be used
        stable_id: "sid_AbCdEfGhIj",
        url: "https://example.com/report",
        title: "Report",
        type: "paper",
      });

      const content = `Text.[^1]\n\n[^1]: [Report](https://example.com/report)\n`;
      await convertNewFootnotes(content, "test-page", { createDbEntries: true });

      expect(mockCreateCitationsBatch).toHaveBeenCalledTimes(1);
      const batch = mockCreateCitationsBatch.mock.calls[0][0];
      expect(batch).toHaveLength(1);
      expect(batch[0].resourceId).toBe("sid_AbCdEfGhIj");
      expect(batch[0].resourceId).not.toBe("deadbeef12345678");
    });

    it("leaves resourceId undefined when resource lookup misses", async () => {
      mockGetResourceByUrl.mockReturnValue(null);

      const content = `Text.[^1]\n\n[^1]: [Unknown](https://unknown.example/page)\n`;
      await convertNewFootnotes(content, "test-page", { createDbEntries: true });

      expect(mockCreateCitationsBatch).toHaveBeenCalledTimes(1);
      const batch = mockCreateCitationsBatch.mock.calls[0][0];
      expect(batch[0].resourceId).toBeUndefined();
    });

    it("leaves resourceId undefined when resource has no stable_id (legacy-only)", async () => {
      // Defensive: a Resource without stable_id should skip the resourceId
      // rather than fall back to hex16 — that would re-introduce the FK violation
      // the migration was written to prevent.
      mockGetResourceByUrl.mockReturnValue({
        id: "deadbeef12345678",
        // stable_id intentionally omitted
        url: "https://example.com/legacy",
        title: "Legacy",
        type: "paper",
      });

      const content = `Text.[^1]\n\n[^1]: [Legacy](https://example.com/legacy)\n`;
      await convertNewFootnotes(content, "test-page", { createDbEntries: true });

      expect(mockCreateCitationsBatch).toHaveBeenCalledTimes(1);
      const batch = mockCreateCitationsBatch.mock.calls[0][0];
      expect(batch[0].resourceId).toBeUndefined();
    });

    it("createDbEntriesForRcFootnotes also writes stable_id form", async () => {
      mockGetResourceByUrl.mockReturnValue({
        id: "deadbeef12345678",
        stable_id: "sid_XyZ1234567",
        url: "https://example.com/report",
        title: "Report",
        type: "paper",
      });

      const content = `Some text [^rc-abc123]\n\n[^rc-abc123]: [Report](https://example.com/report)\n`;
      const created = await createDbEntriesForRcFootnotes(content, "test-page");

      expect(created).toBe(1);
      expect(mockCreateCitationsBatch).toHaveBeenCalledTimes(1);
      const batch = mockCreateCitationsBatch.mock.calls[0][0];
      expect(batch[0].resourceId).toBe("sid_XyZ1234567");
    });
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
