/**
 * Tests for the PDF resource adapter (QUA-942).
 *
 * Covers the unit shape of `archivePdfResource()` — the wiki-server endpoint
 * itself has its own integration test in apps/wiki-server. Here we mock the
 * client and verify:
 *
 *  - Reads from a local buffer when given (no network)
 *  - Computes a SHA-256 hash over the binary
 *  - Calls upsertResource with sane defaults (purpose, subtype, lifecycle)
 *  - Posts a content version with PDF metadata in the JSONB blob
 *  - Reuses an existing resource (no churn on legacyId) when one already exists
 *  - Surfaces dedup correctly via fromCache
 *  - Rejects non-HTTPS URLs and oversized payloads
 *  - Tolerates missing PDF metadata (extractor failure) without losing the
 *    binary archive
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

// ---------------------------------------------------------------------------
// Mocks — replace the wiki-server client and pdf-extractor before importing
// ---------------------------------------------------------------------------

const mockUpsertResource = vi.fn();
const mockCreateContentVersion = vi.fn();

vi.mock("../wiki-server/resources.ts", () => ({
  upsertResource: (...args: unknown[]) => mockUpsertResource(...args),
  createResourceContentVersion: (...args: unknown[]) => mockCreateContentVersion(...args),
}));

const mockExtractPdfMetadata = vi.fn();

vi.mock("../pdf-extractor.ts", () => ({
  extractPdfMetadata: (...args: unknown[]) => mockExtractPdfMetadata(...args),
  // Keep a no-op text extractor so source-fetcher imports don't break.
  extractPdfText: vi.fn().mockResolvedValue(null),
}));

vi.mock("../url-utils.ts", () => ({
  isPrivateHost: (host: string) =>
    host === "localhost" || host === "127.0.0.1" || host.startsWith("10."),
}));

import { archivePdfResource } from "./pdf.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytes(content: string): Uint8Array {
  return new TextEncoder().encode(content);
}

function truncSha256(content: string): string {
  // 16-char SHA-256 prefix matches CONTENT_HASH_PREFIX_LENGTH in the adapter
  // and the codebase-wide policy enforced by resource-ingest.ts.
  return createHash("sha256").update(bytes(content)).digest("hex").slice(0, 16);
}

const SAMPLE_URL =
  "https://futureoflife.org/wp-content/uploads/2024/12/AI-Safety-Index-2024-Full-Report-27-May-25.pdf";
const SAMPLE_BYTES = bytes("%PDF-1.4 fake PDF content for tests");
const SAMPLE_HASH = truncSha256("%PDF-1.4 fake PDF content for tests");

beforeEach(() => {
  mockUpsertResource.mockReset();
  mockCreateContentVersion.mockReset();
  mockExtractPdfMetadata.mockReset();

  // Sensible defaults — upsert returns the canonical stableId (the adapter
  // reads it from the response, no second lookup).
  mockUpsertResource.mockResolvedValue({
    ok: true,
    data: { id: "abc1234567890def", url: SAMPLE_URL, stableId: "sid_TestStable1" },
  });
  mockCreateContentVersion.mockResolvedValue({
    ok: true,
    data: { id: 42, deduplicated: false, resourceId: "sid_TestStable1" },
  });
  mockExtractPdfMetadata.mockResolvedValue({
    text: "Page 1 text\n\nPage 2 text",
    pageCount: 60,
    title: "AI Safety Index 2024 Full Report",
    author: "Future of Life Institute",
    subject: null,
    creator: "LaTeX",
    producer: "pdfTeX",
    creationDate: "2024-12-11T00:00:00.000Z",
    modDate: null,
  });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("archivePdfResource", () => {
  it("uses the supplied buffer (no network) and hashes the binary", async () => {
    const result = await archivePdfResource({
      url: SAMPLE_URL,
      buffer: SAMPLE_BYTES,
    });

    expect(result.contentHash).toBe(SAMPLE_HASH);
    expect(result.byteSize).toBe(SAMPLE_BYTES.byteLength);
    expect(result.pageCount).toBe(60);
    expect(result.resourceStableId).toBe("sid_TestStable1");
    expect(result.fromCache).toBe(false);
  });

  it("calls upsertResource with PDF defaults (purpose, subtype, lifecycle)", async () => {
    await archivePdfResource({ url: SAMPLE_URL, buffer: SAMPLE_BYTES });

    expect(mockUpsertResource).toHaveBeenCalledTimes(1);
    const call = mockUpsertResource.mock.calls[0][0];
    expect(call.url).toBe(SAMPLE_URL);
    expect(call.type).toBe("paper");
    expect(call.resourcePurpose).toBe("primary_source");
    expect(call.resourceSubtype).toBe("pdf_report");
    expect(call.contentLifecycle).toBe("immutable");
    expect(call.contentHash).toBe(SAMPLE_HASH);
    expect(call.title).toBe("AI Safety Index 2024 Full Report");
    expect(call.publishedDate).toBeNull();
    expect(call.typeMetadata?.pdf?.pageCount).toBe(60);
    expect(call.typeMetadata?.pdf?.byteSize).toBe(SAMPLE_BYTES.byteLength);
  });

  it("snapshots the binary into resource_content_versions", async () => {
    await archivePdfResource({
      url: SAMPLE_URL,
      buffer: SAMPLE_BYTES,
      contextNote: "FLI Dec 2024",
    });

    expect(mockCreateContentVersion).toHaveBeenCalledTimes(1);
    const [stableId, payload] = mockCreateContentVersion.mock.calls[0];
    expect(stableId).toBe("sid_TestStable1");
    expect(payload.url).toBe(SAMPLE_URL);
    expect(payload.contentHash).toBe(SAMPLE_HASH);
    expect(payload.contentType).toBe("application/pdf");
    expect(payload.fetchMethod).toBe("pdf-archive");
    expect(payload.content).toContain("Page 1 text");
    expect(payload.metadata?.pageCount).toBe(60);
    expect(payload.metadata?.extractor).toBe("pdf-parse");
    expect(payload.metadata?.parserVersion).toMatch(/^pdf-parse@/);
  });

  it("produces 16-char SHA-256 prefix matching CONTENT_HASH_PREFIX_LENGTH policy", async () => {
    // Codebase-wide policy: resource_content_versions.content_hash uses the
    // first 16 hex chars of SHA-256. Aligning across writers is what makes
    // the (url, content_hash) dedup index actually deduplicate. See
    // resource-ingest.ts and citations.ts dual-write for the canonical sites.
    const result = await archivePdfResource({
      url: SAMPLE_URL,
      buffer: SAMPLE_BYTES,
    });
    expect(result.contentHash).toHaveLength(16);
    expect(result.contentHash).toMatch(/^[0-9a-f]{16}$/);
    expect(result.contentHash).toBe(truncSha256("%PDF-1.4 fake PDF content for tests"));
  });

  it("surfaces dedup when the snapshot endpoint reports no-op", async () => {
    mockCreateContentVersion.mockResolvedValueOnce({
      ok: true,
      data: { id: 1, deduplicated: true, resourceId: "sid_TestStable1" },
    });

    const result = await archivePdfResource({
      url: SAMPLE_URL,
      buffer: SAMPLE_BYTES,
    });
    expect(result.fromCache).toBe(true);
  });

  it("reuses an existing resource via the upsert ON CONFLICT path (no extra lookups)", async () => {
    // Existing row's stableId is preserved by the server's COALESCE rule.
    // The adapter no longer pre-/post-looks up — the upsert response carries it.
    mockUpsertResource.mockResolvedValueOnce({
      ok: true,
      data: { id: "abc1234567890def", url: SAMPLE_URL, stableId: "sid_existing" },
    });

    const result = await archivePdfResource({
      url: SAMPLE_URL,
      buffer: SAMPLE_BYTES,
    });

    expect(result.resourceStableId).toBe("sid_existing");
    // Upsert is called with id derived from hashId(url) — stable across retries
    expect(mockUpsertResource.mock.calls[0][0].id).toMatch(/^[0-9a-f]{16}$/);
  });

  it("throws if upsert response is missing stableId (server invariant violation)", async () => {
    mockUpsertResource.mockResolvedValueOnce({
      ok: true,
      data: { id: "abc1234567890def", url: SAMPLE_URL, stableId: null },
    });

    await expect(
      archivePdfResource({ url: SAMPLE_URL, buffer: SAMPLE_BYTES }),
    ).rejects.toThrow(/upsert returned no stableId/);
  });

  it("rejects non-HTTPS URLs", async () => {
    await expect(
      archivePdfResource({ url: "http://insecure.example.com/x.pdf" }),
    ).rejects.toThrow(/HTTPS/);
  });

  it("rejects malformed URLs", async () => {
    await expect(
      archivePdfResource({ url: "not a url at all" }),
    ).rejects.toThrow(/Malformed URL/);
  });

  it("rejects private hosts (SSRF guard)", async () => {
    await expect(
      archivePdfResource({ url: "https://localhost/secret.pdf" }),
    ).rejects.toThrow(/Private host blocked/);
  });

  it("falls back to text-only when extractPdfMetadata returns null", async () => {
    mockExtractPdfMetadata.mockResolvedValueOnce(null);

    const result = await archivePdfResource({
      url: SAMPLE_URL,
      buffer: SAMPLE_BYTES,
    });

    expect(result.contentHash).toBe(SAMPLE_HASH);
    expect(result.pageCount).toBe(0);
    expect(result.contentLength).toBe(0);
    expect(result.pdfMetadata).toBeNull();
    // We still archived the binary even though text extraction failed
    expect(mockCreateContentVersion).toHaveBeenCalledTimes(1);
    const payload = mockCreateContentVersion.mock.calls[0][1];
    expect(payload.contentHash).toBe(SAMPLE_HASH);
    expect(payload.metadata?.pdfInfo).toBeNull();
  });

  it("propagates upsert failures (does not silently archive against missing resource)", async () => {
    mockUpsertResource.mockResolvedValueOnce({
      ok: false,
      error: "validation",
      message: "title too long",
    });

    await expect(
      archivePdfResource({ url: SAMPLE_URL, buffer: SAMPLE_BYTES }),
    ).rejects.toThrow(/failed to upsert resource/);
  });

  it("propagates content-version write failures", async () => {
    mockCreateContentVersion.mockResolvedValueOnce({
      ok: false,
      error: "server",
      message: "boom",
    });

    await expect(
      archivePdfResource({ url: SAMPLE_URL, buffer: SAMPLE_BYTES }),
    ).rejects.toThrow(/failed to write content version/);
  });

  it("uses URL basename as fallback title when both override and PDF Info are absent", async () => {
    mockExtractPdfMetadata.mockResolvedValueOnce({
      text: "",
      pageCount: 1,
      title: null,
      author: null,
      subject: null,
      creator: null,
      producer: null,
      creationDate: null,
      modDate: null,
    });

    await archivePdfResource({
      url: "https://example.com/path/to/My-Report%202024.pdf",
      buffer: SAMPLE_BYTES,
    });

    const call = mockUpsertResource.mock.calls[0][0];
    expect(call.title).toBe("My-Report 2024.pdf");
  });

  it("rejects oversized buffers without calling the network", async () => {
    const huge = new Uint8Array(60 * 1024 * 1024); // 60 MiB > 50 MiB cap
    await expect(
      archivePdfResource({ url: SAMPLE_URL, buffer: huge }),
    ).rejects.toThrow(/PDF too large/);
    expect(mockUpsertResource).not.toHaveBeenCalled();
  });
});
