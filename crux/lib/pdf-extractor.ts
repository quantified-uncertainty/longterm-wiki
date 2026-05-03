/**
 * PDF text extraction utility.
 *
 * Shared between source-fetcher, page-creator source-fetching, and the
 * resource-archive PDF adapter (QUA-942) to avoid duplicating pdf-parse
 * import and error-handling logic.
 */

export interface PdfMetadata {
  /** Full extracted text, truncated to `maxChars`. */
  text: string;
  /** Total physical page count. */
  pageCount: number;
  /** PDF document title from the Info dictionary, when present. */
  title: string | null;
  /** Document author(s), when present. */
  author: string | null;
  /** Free-form subject/description, when present. */
  subject: string | null;
  /** Creator software (e.g. "Adobe InDesign"). Diagnostic only. */
  creator: string | null;
  /** Producer software. Diagnostic only. */
  producer: string | null;
  /** Creation date as ISO-8601 string, when parseable. */
  creationDate: string | null;
  /** Modification date as ISO-8601 string, when parseable. */
  modDate: string | null;
}

/**
 * Lazy-load pdf-parse and return a parser bound to the supplied buffer.
 * Returns null on import or constructor failure (logged once per call).
 */
async function loadParser(buffer: ArrayBuffer): Promise<unknown | null> {
  try {
    const { PDFParse } = await import('pdf-parse');
    return new PDFParse({ data: Buffer.from(buffer) });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pdf-extractor] pdf-parse load failed: ${msg.slice(0, 200)}`);
    return null;
  }
}

/**
 * Extract text from a PDF ArrayBuffer using the pdf-parse library.
 * Returns null on failure (logs a warning).
 *
 * Text-only path: skips `getInfo()` so the source-fetcher hot path stays at
 * a single parse pass. Use `extractPdfMetadata` when document metadata
 * (page count, Info dictionary, dates) is also needed.
 *
 * @param buffer - The raw PDF data as an ArrayBuffer
 * @param maxChars - Maximum characters to return (default: 100_000)
 */
export async function extractPdfText(
  buffer: ArrayBuffer,
  maxChars = 100_000,
): Promise<string | null> {
  const parser = await loadParser(buffer);
  if (!parser) return null;
  try {
    const result = await (parser as { getText: () => Promise<{ text: string }> }).getText();
    return result.text.slice(0, maxChars) || null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pdf-extractor] pdf-parse failed: ${msg.slice(0, 200)}`);
    return null;
  }
}

function readInfoString(info: unknown, key: string): string | null {
  if (!info || typeof info !== 'object') return null;
  const value = (info as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.length === 0) return null;
  return value.slice(0, 1000);
}

function dateToIso(value: unknown): string | null {
  if (value instanceof Date && !isNaN(value.valueOf())) return value.toISOString();
  return null;
}

/**
 * Extract text plus document-level metadata from a PDF buffer.
 *
 * Returns null when text extraction fails entirely. When metadata extraction
 * fails but text extraction succeeds, returns text-only with default metadata
 * (pageCount=0, all string fields null) so callers can still archive the PDF
 * without losing the text payload.
 *
 * @param buffer - The raw PDF data
 * @param maxChars - Maximum characters of text to return (default: 1_000_000)
 */
export async function extractPdfMetadata(
  buffer: ArrayBuffer,
  maxChars = 1_000_000,
): Promise<PdfMetadata | null> {
  const parser = await loadParser(buffer);
  if (!parser) return null;

  // Cast once to a minimal shape we depend on; the full type is in pdf-parse.
  const p = parser as {
    getText: () => Promise<{ text: string }>;
    getInfo: () => Promise<{
      total: number;
      info?: Record<string, unknown>;
      getDateNode: () => Record<string, Date | null | undefined>;
    }>;
  };

  let text = '';
  try {
    const textResult = await p.getText();
    text = (textResult.text ?? '').slice(0, maxChars);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pdf-extractor] getText failed: ${msg.slice(0, 200)}`);
    return null;
  }

  let info:
    | { total: number; info?: Record<string, unknown>; getDateNode: () => Record<string, Date | null | undefined> }
    | null = null;
  try {
    info = await p.getInfo();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pdf-extractor] getInfo failed (continuing with text-only): ${msg.slice(0, 200)}`);
  }

  // pdf-parse can throw inside `getDateNode()` itself when XMP date parsing
  // hits a malformed date string. Wrap defensively so a partial PDF doesn't
  // sink the whole extract — we still want text + pageCount + Info-dict text.
  let dates: Record<string, Date | null | undefined> | null = null;
  try {
    dates = info?.getDateNode() ?? null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pdf-extractor] getDateNode failed (dropping dates): ${msg.slice(0, 200)}`);
  }

  return {
    text,
    pageCount: info?.total ?? 0,
    title: readInfoString(info?.info, 'Title'),
    author: readInfoString(info?.info, 'Author'),
    subject: readInfoString(info?.info, 'Subject'),
    creator: readInfoString(info?.info, 'Creator'),
    producer: readInfoString(info?.info, 'Producer'),
    creationDate: dateToIso(dates?.CreationDate ?? dates?.XmpCreateDate ?? null),
    modDate: dateToIso(dates?.ModDate ?? dates?.XmpModifyDate ?? null),
  };
}
