/**
 * Tests for the pdf-extractor utility (text + metadata).
 *
 * Goal: contract-test the shape returned to callers (especially the QUA-942
 * resource adapter), without dragging in real PDF binaries. We mock pdf-parse.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetText = vi.fn();
const mockGetInfo = vi.fn();
const mockGetDateNode = vi.fn();

class FakePDFParse {
  // The constructor matters only as long as it doesn't throw — we don't
  // exercise its real behavior here.
  constructor(_opts: unknown) {}
  getText() {
    return mockGetText();
  }
  getInfo() {
    return mockGetInfo();
  }
}

vi.mock("pdf-parse", () => ({
  PDFParse: FakePDFParse,
}));

import { extractPdfMetadata, extractPdfText } from "../pdf-extractor.ts";

beforeEach(() => {
  mockGetText.mockReset();
  mockGetInfo.mockReset();
  mockGetDateNode.mockReset();
  mockGetDateNode.mockReturnValue({});
});

const SAMPLE_BUFFER = new TextEncoder().encode("%PDF-1.4 fake content").buffer;

describe("extractPdfText", () => {
  it("returns extracted text up to maxChars", async () => {
    mockGetText.mockResolvedValue({ text: "Hello world".repeat(10) });
    const out = await extractPdfText(SAMPLE_BUFFER, 30);
    expect(out).toHaveLength(30);
  });

  it("returns null on extractor failure", async () => {
    mockGetText.mockRejectedValue(new Error("oops"));
    const out = await extractPdfText(SAMPLE_BUFFER);
    expect(out).toBeNull();
  });

  it("returns null on empty extracted text", async () => {
    mockGetText.mockResolvedValue({ text: "" });
    const out = await extractPdfText(SAMPLE_BUFFER);
    expect(out).toBeNull();
  });
});

describe("extractPdfMetadata (QUA-942)", () => {
  it("returns text + page count + Info-dictionary fields", async () => {
    mockGetText.mockResolvedValue({ text: "page 1\n\npage 2" });
    mockGetInfo.mockResolvedValue({
      total: 60,
      info: {
        Title: "Sample Report",
        Author: "Test Author",
        Subject: "Subject Line",
        Creator: "LaTeX",
        Producer: "pdfTeX",
      },
      getDateNode: () => ({
        CreationDate: new Date("2024-12-11T00:00:00Z"),
        ModDate: null,
      }),
    });

    const out = await extractPdfMetadata(SAMPLE_BUFFER);
    expect(out).not.toBeNull();
    expect(out!.pageCount).toBe(60);
    expect(out!.title).toBe("Sample Report");
    expect(out!.author).toBe("Test Author");
    expect(out!.creator).toBe("LaTeX");
    expect(out!.producer).toBe("pdfTeX");
    expect(out!.creationDate).toBe("2024-12-11T00:00:00.000Z");
    expect(out!.text).toBe("page 1\n\npage 2");
  });

  it("falls back to text-only when getInfo fails", async () => {
    mockGetText.mockResolvedValue({ text: "body text" });
    mockGetInfo.mockRejectedValue(new Error("info parse failed"));

    const out = await extractPdfMetadata(SAMPLE_BUFFER);
    expect(out).not.toBeNull();
    expect(out!.text).toBe("body text");
    expect(out!.pageCount).toBe(0);
    expect(out!.title).toBeNull();
    expect(out!.author).toBeNull();
    expect(out!.creationDate).toBeNull();
  });

  it("returns null when getText fails (no point archiving an empty record)", async () => {
    mockGetText.mockRejectedValue(new Error("text parse failed"));
    mockGetInfo.mockResolvedValue({
      total: 1,
      info: {},
      getDateNode: () => ({}),
    });

    const out = await extractPdfMetadata(SAMPLE_BUFFER);
    expect(out).toBeNull();
  });

  it("ignores Info fields that are not strings", async () => {
    mockGetText.mockResolvedValue({ text: "x" });
    mockGetInfo.mockResolvedValue({
      total: 1,
      info: { Title: 12345 as unknown as string, Author: "" },
      getDateNode: () => ({}),
    });

    const out = await extractPdfMetadata(SAMPLE_BUFFER);
    expect(out!.title).toBeNull();
    expect(out!.author).toBeNull();
  });

  it("respects maxChars when truncating extracted text", async () => {
    mockGetText.mockResolvedValue({ text: "x".repeat(2_000_000) });
    mockGetInfo.mockResolvedValue({
      total: 100,
      info: {},
      getDateNode: () => ({}),
    });

    const out = await extractPdfMetadata(SAMPLE_BUFFER, 5000);
    expect(out!.text).toHaveLength(5000);
  });

  it("prefers CreationDate, falls back to XmpCreateDate", async () => {
    mockGetText.mockResolvedValue({ text: "x" });
    mockGetInfo.mockResolvedValue({
      total: 1,
      info: {},
      getDateNode: () => ({
        CreationDate: null,
        XmpCreateDate: new Date("2023-06-15T10:00:00Z"),
      }),
    });

    const out = await extractPdfMetadata(SAMPLE_BUFFER);
    expect(out!.creationDate).toBe("2023-06-15T10:00:00.000Z");
  });
});
