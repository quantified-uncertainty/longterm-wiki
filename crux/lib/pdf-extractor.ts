/**
 * PDF text extraction utility.
 *
 * Shared between source-fetcher and page-creator source-fetching
 * to avoid duplicating pdf-parse import and error-handling logic.
 */

/**
 * Extract text from a PDF ArrayBuffer using the pdf-parse library.
 * Returns null on failure (logs a warning).
 *
 * @param buffer - The raw PDF data as an ArrayBuffer
 * @param maxChars - Maximum characters to return (default: 100_000)
 */
export async function extractPdfText(
  buffer: ArrayBuffer,
  maxChars = 100_000,
): Promise<string | null> {
  try {
    const { PDFParse } = await import('pdf-parse');
    const parser = new PDFParse({ data: Buffer.from(buffer) });
    const result = await parser.getText();
    return result.text.slice(0, maxChars) || null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[pdf-extractor] pdf-parse failed: ${msg.slice(0, 200)}`);
    return null;
  }
}
