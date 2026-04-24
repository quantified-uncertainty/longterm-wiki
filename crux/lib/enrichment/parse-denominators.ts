/**
 * Parser for `docs/audits/qua-634-denominator-estimates.md`.
 *
 * The doc isn't machine-generated, so this parser is intentionally tolerant:
 * we'd rather drop one bad row silently than fail the whole seed on a typo.
 * Accepts both ranked (`| rank | slug | type | total | ...`) and unranked
 * (`| slug | type | total | ...`) table shapes; everything else is skipped.
 */

export interface DenominatorTarget {
  entityId: string;
  recordType: string;
  estimatedTotal: number;
  targetPct?: number;
  basis?: string;
  confidence?: 'high' | 'medium' | 'low';
}

/** Matches `anthropic`, `open-philanthropy`, `nist-ai`, etc. Digits optional. */
const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Record types we accept from the doc. The server's targets-upsert schema
 *  validates the string length; we allow-list here to catch typos early. */
const ALLOWED_RECORD_TYPES = new Set([
  'personnel',
  'publications',
  'publication',
  'divisions',
  'grants',
  'funding-rounds',
  'benchmark-results',
  'investments',
]);

/** Normalize a record type to the canonical form used by the server. */
function canonicalizeRecordType(raw: string): string | null {
  const lower = raw.trim().toLowerCase();
  if (ALLOWED_RECORD_TYPES.has(lower)) {
    // "publication" (singular) maps to "publications".
    return lower === 'publication' ? 'publications' : lower;
  }
  return null;
}

function parseIntCol(s: string): number | null {
  const cleaned = s.trim().replace(/[,\s]/g, '');
  if (!/^\d+$/.test(cleaned)) return null;
  const n = parseInt(cleaned, 10);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseConfidence(
  s: string,
): 'high' | 'medium' | 'low' | undefined {
  const lower = s.trim().toLowerCase();
  if (lower === 'high' || lower === 'medium' || lower === 'low') return lower;
  return undefined;
}

/** Split a markdown table row into trimmed cells, dropping the empty
 *  outer columns that come from the leading/trailing `|`. */
function splitRow(line: string): string[] {
  const cells = line.split('|').map((c) => c.trim());
  // Drop the first/last empty slots from `| a | b |` style.
  if (cells.length > 0 && cells[0] === '') cells.shift();
  if (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

/** Is this row a header separator (|---|---|)? */
function isSeparator(cells: string[]): boolean {
  return cells.every((c) => /^:?-+:?$/.test(c));
}

export function parseDenominatorDoc(content: string): DenominatorTarget[] {
  const out: DenominatorTarget[] = [];
  // First appearance of a `${entityId}:${recordType}` pair wins; later
  // duplicates are silently dropped. The doc isn't supposed to have dupes,
  // but multiple tables in different sections (ranked + summary) can
  // accidentally repeat rows, and we prefer deterministic seed over
  // last-write-wins.
  const seen = new Set<string>();

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.startsWith('|')) continue;
    const cells = splitRow(line);
    if (cells.length < 3) continue;
    if (isSeparator(cells)) continue;

    // Expected shape: [rank, slug, recordType, estimatedTotal, confidence?, basis?]
    // Rank column is optional — some tables might omit it, so check both layouts.
    let slug: string;
    let recordTypeRaw: string;
    let estimatedCol: string;
    let confCol: string | undefined;
    let basisCol: string | undefined;

    // Disambiguate rank-first vs slug-first by looking at cells[0]: a number
    // (or empty) means the leading column is rank; otherwise no rank column.
    const firstLooksLikeRank = cells[0] === '' || /^\d+$/.test(cells[0]);
    if (firstLooksLikeRank && cells.length >= 4 && SLUG_RE.test(cells[1])) {
      // With rank: [rank, slug, type, total, conf?, basis?]
      slug = cells[1];
      recordTypeRaw = cells[2];
      estimatedCol = cells[3];
      confCol = cells[4];
      basisCol = cells[5];
    } else if (cells.length >= 3 && SLUG_RE.test(cells[0])) {
      // Without rank: [slug, type, total, conf?, basis?]
      slug = cells[0];
      recordTypeRaw = cells[1];
      estimatedCol = cells[2];
      confCol = cells[3];
      basisCol = cells[4];
    } else {
      continue;
    }

    const recordType = canonicalizeRecordType(recordTypeRaw);
    if (!recordType) continue;

    const estimatedTotal = parseIntCol(estimatedCol);
    if (estimatedTotal === null) continue;

    const key = `${slug}:${recordType}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const confidence = confCol ? parseConfidence(confCol) : undefined;
    const basis = basisCol?.trim() ? basisCol.trim().slice(0, 500) : undefined;

    out.push({
      entityId: slug,
      recordType,
      estimatedTotal,
      ...(confidence ? { confidence } : {}),
      ...(basis ? { basis } : {}),
    });
  }

  return out;
}
