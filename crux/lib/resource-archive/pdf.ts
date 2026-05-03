/**
 * PDF Resource Adapter (QUA-942).
 *
 * Single-call helper to "ingest a PDF as a Resource, archive its content, and
 * make page-addressable evidence" — the missing first-class pattern called
 * out in QUA-942. Mirrors `crux/lib/grant-import/snapshot-capture.ts` but for
 * unstructured PDFs that don't fit the `resource_tabular_sources` enum.
 *
 * What it does, given an HTTPS PDF URL or a pre-fetched buffer:
 *   1. Loads the binary (HTTPS fetch with SSRF guard, or accepts a local buffer).
 *   2. Computes a content-integrity hash over the **binary** (not the extracted
 *      text). This is the hash that survives pdf-parse version upgrades.
 *   3. Extracts text + document metadata via `extractPdfMetadata` (pdf-parse).
 *   4. Upserts a `resources` row (`type='paper'`, `resourcePurpose='primary_source'`,
 *      `resourceSubtype='pdf_report'` by default — callers can override).
 *   5. Posts a snapshot to `resource_content_versions` with the binary hash,
 *      extracted text, and PDF metadata in the JSONB `metadata` field.
 *   6. Returns the resource stableId so callers can attach `source_check_evidence`
 *      rows with `evidenceLocator: { kind: 'pdf-page', page: N }`.
 *
 * The binary itself is **not** stored in PG — `resource_content_versions.content`
 * is text. Callers that need a permanent binary (e.g. FLI's wave reports) should
 * commit the file to git under `data/` and pass `localFilename` so the resources
 * row can point back to the canonical archive.
 */

import { createHash } from "crypto";
import { readFile, stat } from "fs/promises";
import { hashId } from "../hash-utils.ts";
import { isPrivateHost } from "../url-utils.ts";
import { extractPdfMetadata, type PdfMetadata } from "../pdf-extractor.ts";
import {
  upsertResource,
  createResourceContentVersion,
} from "../wiki-server/resources.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Cap on PDF download size — 50 MiB is generous for safety reports while
 * still rejecting accidentally-huge files (full-corpus dumps, etc.). */
const MAX_PDF_BYTES = 50 * 1024 * 1024;

/** Cap on extracted text persisted to RCV.content. Picked to fit comfortably
 * inside the 2_000_000-char column limit while leaving room for typical
 * headers/footers per page. */
const MAX_PDF_TEXT_CHARS = 1_000_000;

/** Length of the truncated SHA-256 prefix stored in `content_hash`.
 * Matches the policy used by `resource-ingest.ts` (CONTENT_HASH_PREFIX_LENGTH)
 * and the citation dual-write in `routes/wikibase/citations.ts`, so the
 * `(url, content_hash)` dedup index works across writers. 16 hex chars =
 * 64 bits — enough collision resistance for archive-scale corpora. */
const CONTENT_HASH_PREFIX_LENGTH = 16;

const FETCH_TIMEOUT_MS = 60_000;
const FETCH_USER_AGENT =
  "Mozilla/5.0 (compatible; LongtermWikiPdfArchiver/1.0; +https://www.longtermwiki.com)";

const FETCH_METHOD = "pdf-archive";
const PARSER_VERSION = "pdf-parse@2.4.5/v1";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ArchivePdfResourceOptions {
  /** Canonical HTTPS URL the PDF lives at. Required even when `buffer` is
   *  supplied — used as `resources.url` and the snapshot's `url` field. */
  url: string;
  /** Pre-fetched binary, e.g. from a local file. Skips the network fetch. */
  buffer?: ArrayBuffer | Uint8Array | Buffer;
  /** Local file path. If `buffer` is not given but the file exists, it's read. */
  localFilePath?: string;
  /** Override resource title. Defaults to the PDF's Info.Title or basename. */
  title?: string | null;
  /** Optional summary written to `resources.summary`. */
  summary?: string | null;
  /** Optional publisher entity stableId. */
  publisherEntityId?: string | null;
  /** `resources.resource_purpose`. Defaults to `'primary_source'`. */
  resourcePurpose?: string;
  /** `resources.resource_subtype`. Defaults to `'pdf_report'`. */
  resourceSubtype?: string;
  /** `resources.content_lifecycle`. PDFs are typically immutable. */
  contentLifecycle?: "immutable" | "versioned" | "evergreen" | "ephemeral";
  /** `resources.local_filename` — pointer back to a committed binary copy. */
  localFilename?: string | null;
  /** Tags to write on the resources row. */
  tags?: string[];
  /** Free-form context note (e.g., "FLI Dec 2024 wave report"). */
  contextNote?: string | null;
}

export interface ArchivePdfResourceResult {
  /** Canonical resource id used as a foreign key on `source_check_evidence`. */
  resourceStableId: string;
  /** Truncated SHA-256 of the binary (16 hex chars), matching the
   *  CONTENT_HASH_PREFIX_LENGTH policy used by `resource-ingest.ts` and the
   *  citation dual-write so `(url, content_hash)` dedup works across writers. */
  contentHash: string;
  /** Extracted text length (chars). */
  contentLength: number;
  /** Page count from the PDF Info dictionary. 0 if metadata extraction failed. */
  pageCount: number;
  /** Binary size in bytes. */
  byteSize: number;
  /** True if a snapshot for (url, contentHash) already existed. */
  fromCache: boolean;
  /** PDF Info-dictionary metadata, when available. */
  pdfMetadata: PdfMetadata | null;
  /** RCV row id, for cross-linking from evidence reads. */
  contentVersionId: number | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toArrayBuffer(input: ArrayBuffer | Uint8Array | Buffer): ArrayBuffer {
  if (input instanceof ArrayBuffer) return input;
  // Buffer / Uint8Array — copy into a fresh ArrayBuffer so we own the bytes
  // and don't keep a SharedArrayBuffer reference alive in tests.
  return input.buffer.slice(
    input.byteOffset,
    input.byteOffset + input.byteLength,
  ) as ArrayBuffer;
}

function hashBinary(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex").slice(0, CONTENT_HASH_PREFIX_LENGTH);
}

function basenameFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const last = u.pathname.split("/").filter(Boolean).pop() ?? "";
    return decodeURIComponent(last);
  } catch {
    return "";
  }
}

async function fetchPdf(url: string): Promise<ArrayBuffer> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Malformed URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Unsupported protocol: ${parsed.protocol} (HTTPS only)`);
  }
  if (isPrivateHost(parsed.hostname.toLowerCase())) {
    throw new Error(`Private host blocked (SSRF protection): ${parsed.hostname}`);
  }

  const response = await fetch(url, {
    headers: {
      "User-Agent": FETCH_USER_AGENT,
      Accept: "application/pdf,*/*;q=0.5",
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} fetching ${url}`);
  }
  const ct = response.headers.get("content-type") ?? "";
  if (!ct.includes("application/pdf") && !ct.includes("octet-stream")) {
    throw new Error(`Expected application/pdf, got ${ct} for ${url}`);
  }

  // Buffer the response so we can enforce the size cap before extraction.
  const buf = await response.arrayBuffer();
  if (buf.byteLength > MAX_PDF_BYTES) {
    throw new Error(
      `PDF too large: ${buf.byteLength} bytes (limit ${MAX_PDF_BYTES})`,
    );
  }
  return buf;
}

async function loadBinary(opts: ArchivePdfResourceOptions): Promise<ArrayBuffer> {
  if (opts.buffer) {
    const ab = toArrayBuffer(opts.buffer);
    if (ab.byteLength > MAX_PDF_BYTES) {
      throw new Error(
        `PDF too large: ${ab.byteLength} bytes (limit ${MAX_PDF_BYTES})`,
      );
    }
    return ab;
  }
  if (opts.localFilePath) {
    // stat() throws ENOENT if the file is missing — fall through to URL fetch.
    const fileStat = await stat(opts.localFilePath).catch(() => null);
    if (fileStat) {
      if (fileStat.size > MAX_PDF_BYTES) {
        throw new Error(
          `Local PDF too large: ${fileStat.size} bytes (limit ${MAX_PDF_BYTES})`,
        );
      }
      return toArrayBuffer(await readFile(opts.localFilePath));
    }
  }
  return fetchPdf(opts.url);
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

export async function archivePdfResource(
  opts: ArchivePdfResourceOptions,
): Promise<ArchivePdfResourceResult> {
  if (!opts.url) {
    throw new Error("archivePdfResource: url is required");
  }

  const binary = await loadBinary(opts);
  const bytes = new Uint8Array(binary);
  const contentHash = hashBinary(bytes);

  // Extract text + metadata. Failure is tolerated: we still archive the binary
  // hash + size so future re-verification works, but we mark the snapshot as
  // text-empty so consumers can decide whether to retry extraction later.
  const meta = await extractPdfMetadata(binary, MAX_PDF_TEXT_CHARS);
  const text = meta?.text ?? "";

  const baseTitle =
    opts.title?.trim() ||
    meta?.title?.trim() ||
    basenameFromUrl(opts.url) ||
    null;

  // Capture one timestamp so resources.fetched_at and the snapshot's fetchedAt
  // agree exactly (otherwise they drift by milliseconds, breaking "snapshot
  // timestamp == resource timestamp" reasoning for consumers).
  const fetchedAt = new Date().toISOString();

  // Upsert the resource row, keying by `id = hashId(url)`. The server will
  // ON CONFLICT-resolve to the existing row when one exists for this URL, and
  // its COALESCE policy preserves any previously-set fields the caller didn't
  // pass. The .returning() clause hands back the canonical stableId
  // regardless of insert vs update, so we don't need a separate lookup.
  const legacyId = hashId(opts.url);
  const upserted = await upsertResource({
    id: legacyId,
    url: opts.url,
    title: baseTitle,
    type: "paper",
    summary: opts.summary ?? null,
    contentHash, // resources.content_hash mirrors the latest snapshot hash
    fetchedAt,
    publisherEntityId: opts.publisherEntityId ?? null,
    publishedDate: meta?.creationDate
      ? meta.creationDate.slice(0, 10)
      : null,
    authors: meta?.author ? [meta.author] : null,
    resourcePurpose: opts.resourcePurpose ?? "primary_source",
    resourceSubtype: opts.resourceSubtype ?? "pdf_report",
    contentLifecycle: opts.contentLifecycle ?? "immutable",
    localFilename: opts.localFilename ?? null,
    tags: opts.tags ?? null,
    contextNote: opts.contextNote ?? null,
    typeMetadata: {
      pdf: {
        pageCount: meta?.pageCount ?? 0,
        byteSize: bytes.byteLength,
        producer: meta?.producer ?? null,
        creator: meta?.creator ?? null,
      },
    },
  });
  if (!upserted.ok) {
    throw new Error(
      `archivePdfResource: failed to upsert resource — ${upserted.error}: ${upserted.message ?? ""}`,
    );
  }
  const stableId = upserted.data.stableId;
  if (!stableId) {
    throw new Error(
      `archivePdfResource: upsert returned no stableId for ${opts.url}`,
    );
  }

  // Snapshot the content. Dedups on (url, contentHash); calling with the same
  // bytes is a no-op so callers can retry safely.
  const versionResult = await createResourceContentVersion(stableId, {
    url: opts.url,
    contentHash,
    fetchedAt,
    content: text || null,
    contentLength: bytes.byteLength,
    httpStatus: 200,
    contentType: "application/pdf",
    fetchMethod: FETCH_METHOD,
    metadata: {
      pageCount: meta?.pageCount ?? 0,
      textCharCount: text.length,
      byteSize: bytes.byteLength,
      extractor: "pdf-parse",
      parserVersion: PARSER_VERSION,
      pdfInfo: meta
        ? {
            title: meta.title,
            author: meta.author,
            subject: meta.subject,
            creator: meta.creator,
            producer: meta.producer,
            creationDate: meta.creationDate,
            modDate: meta.modDate,
          }
        : null,
    },
  });
  if (!versionResult.ok) {
    throw new Error(
      `archivePdfResource: failed to write content version — ${versionResult.error}: ${versionResult.message ?? ""}`,
    );
  }

  // The endpoint returns either {id, deduplicated:false} (new row, 201) or
  // {id, deduplicated:true} (existing row, 200). Both are typed via union.
  const versionData = versionResult.data as {
    id: number | null;
    deduplicated: boolean;
  };

  return {
    resourceStableId: stableId,
    contentHash,
    contentLength: text.length,
    pageCount: meta?.pageCount ?? 0,
    byteSize: bytes.byteLength,
    fromCache: versionData.deduplicated === true,
    pdfMetadata: meta,
    contentVersionId: versionData.id ?? null,
  };
}
