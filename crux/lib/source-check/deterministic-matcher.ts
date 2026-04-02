/**
 * Deterministic Matcher — verify structured records against source snapshots
 * by row-matching instead of LLM reading comprehension.
 *
 * For tabular data (CSVs, HTML tables, API responses), this is more reliable
 * than LLM verification and costs nothing.
 *
 * Part of Phase 3: Data Source Resources (Discussion #3567).
 */

import type { DataSourceManifest } from '../grant-import/manifests/types.ts';
import { parseCSVContent, parseHTMLTable, parseJSONArray, applyColumnMapping } from './source-parsers.ts';
import { nameMatches, amountMatches, dateMatches } from './fuzzy-match.ts';

export interface DeterministicMatchResult {
  matched: boolean;
  matchedRow: Record<string, unknown> | null;
  confidence: number;
  reasoning: string;
  fieldsMatched: string[];
  fieldsMismatched: string[];
}

/**
 * Parse raw snapshot content according to its format.
 */
function parseSnapshotContent(
  rawContent: string,
  format: DataSourceManifest['format'],
): Record<string, unknown>[] {
  switch (format) {
    case 'csv':
      return parseCSVContent(rawContent);
    case 'html_table':
      return parseHTMLTable(rawContent);
    case 'json_api':
      return parseJSONArray(rawContent);
    case 'spreadsheet':
      // Spreadsheets are converted to CSV before storage
      return parseCSVContent(rawContent);
    default:
      return [];
  }
}

/**
 * Parse a numeric value from a string, stripping currency symbols, commas,
 * footnote markers (‡†*), and compound amounts (takes first value only).
 */
export function parseAmount(val: unknown): number | null {
  if (typeof val === 'number') return val;
  if (typeof val !== 'string') return null;
  // Strip compound amounts — take first value only
  let s = val.split(/\s*[+]\s*/)[0];
  // Strip footnote markers
  s = s.replace(/[‡†*]/g, '');
  // Strip currency symbols, commas, and whitespace
  const cleaned = s.replace(/[$£€¥,\s]/g, '');
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

/**
 * Compare a single field between the record and a source row.
 * Returns true if the values match according to the field type.
 */
function fieldMatches(
  fieldName: string,
  recordValue: unknown,
  sourceValue: unknown,
  fuzzyFields: string[],
  exactFields: string[],
): boolean {
  if (recordValue == null && sourceValue == null) return true;
  if (recordValue == null || sourceValue == null) return false;

  // Amount fields — numeric comparison with tolerance
  if (fieldName === 'amount' || fieldName === 'raised' || fieldName === 'valuation') {
    const recNum = parseAmount(recordValue);
    const srcNum = parseAmount(sourceValue);
    return amountMatches(recNum, srcNum);
  }

  // Date fields — hierarchical comparison
  if (fieldName === 'date' || fieldName === 'startDate' || fieldName === 'endDate') {
    return dateMatches(String(recordValue), String(sourceValue));
  }

  // Name fields — fuzzy or exact depending on config
  const recStr = String(recordValue);
  const srcStr = String(sourceValue);

  if (exactFields.includes(fieldName)) {
    return recStr.toLowerCase().trim() === srcStr.toLowerCase().trim();
  }

  if (fuzzyFields.includes(fieldName)) {
    return nameMatches(recStr, srcStr);
  }

  // Default: case-insensitive exact match
  return recStr.toLowerCase().trim() === srcStr.toLowerCase().trim();
}

/**
 * Match a structured record against parsed source rows using the manifest's
 * verification config.
 *
 * @param record - The grant/personnel record fields (e.g., { grantee: "MIT", amount: 50000 })
 * @param snapshotContent - Raw CSV/HTML/JSON text from a source snapshot
 * @param manifest - Schema, column mapping, and verification config
 */
export function matchRecordAgainstSnapshot(
  record: Record<string, unknown>,
  snapshotContent: string,
  manifest: DataSourceManifest,
): DeterministicMatchResult {
  // Parse the raw content
  const rawRows = parseSnapshotContent(snapshotContent, manifest.format);
  if (rawRows.length === 0) {
    return {
      matched: false,
      matchedRow: null,
      confidence: 0,
      reasoning: `Could not parse source content (format: ${manifest.format}, 0 rows extracted)`,
      fieldsMatched: [],
      fieldsMismatched: [],
    };
  }

  // Build column mapping from manifest fields
  const columnMapping: Record<string, string> = {};
  for (const field of manifest.schema.fields) {
    if (field.internalField) {
      columnMapping[field.sourceName] = field.internalField;
    }
  }

  // Apply column mapping to normalize source column names
  const mappedRows = Object.keys(columnMapping).length > 0
    ? applyColumnMapping(rawRows, columnMapping)
    : rawRows;

  const { matchFields, fuzzyFields = [], exactFields = [] } = manifest.verification;

  // Require at least 2 non-null fields for meaningful matching
  const nonNullFields = matchFields.filter(f => record[f] != null).length;
  if (nonNullFields < 2) {
    return {
      matched: false,
      matchedRow: null,
      confidence: 0.1,
      reasoning: `Insufficient data for deterministic matching: only ${nonNullFields} of ${matchFields.length} match fields are non-null`,
      fieldsMatched: [],
      fieldsMismatched: [],
    };
  }

  // Score each row against the record
  let bestMatch: { row: Record<string, unknown>; score: number; matched: string[]; mismatched: string[] } | null = null;

  for (const sourceRow of mappedRows) {
    let matchedFields: string[] = [];
    let mismatchedFields: string[] = [];

    for (const field of matchFields) {
      const recordVal = record[field];
      const sourceVal = sourceRow[field];

      if (fieldMatches(field, recordVal, sourceVal, fuzzyFields, exactFields)) {
        matchedFields.push(field);
      } else if (recordVal != null && sourceVal != null) {
        mismatchedFields.push(field);
      }
      // If one is null and the other isn't, don't count as mismatch (just not matched)
    }

    // Use ALL configured fields as denominator so null record fields count against the score
    const totalFields = matchFields.length;
    const score = totalFields > 0 ? matchedFields.length / totalFields : 0;

    if (!bestMatch || score > bestMatch.score || (score === bestMatch.score && mismatchedFields.length < bestMatch.mismatched.length)) {
      bestMatch = { row: sourceRow, score, matched: matchedFields, mismatched: mismatchedFields };
    }
  }

  if (!bestMatch || bestMatch.score === 0) {
    return {
      matched: false,
      matchedRow: null,
      confidence: 0.1,
      reasoning: `Record not found in source snapshot (${rawRows.length} rows searched, matched on: ${matchFields.join(', ')})`,
      fieldsMatched: [],
      fieldsMismatched: matchFields,
    };
  }

  // Determine verdict based on match quality
  const confidence = bestMatch.score;

  if (confidence >= 0.9 && bestMatch.mismatched.length === 0) {
    return {
      matched: true,
      matchedRow: bestMatch.row,
      confidence: Math.min(0.95, confidence),
      reasoning: `Deterministic match: ${bestMatch.matched.join(', ')} matched in source snapshot (${rawRows.length} rows)`,
      fieldsMatched: bestMatch.matched,
      fieldsMismatched: bestMatch.mismatched,
    };
  }

  if (confidence >= 0.5) {
    return {
      matched: true,
      matchedRow: bestMatch.row,
      confidence: Math.min(0.8, confidence),
      reasoning: `Partial deterministic match: ${bestMatch.matched.join(', ')} matched but ${bestMatch.mismatched.join(', ')} did not (${rawRows.length} rows)`,
      fieldsMatched: bestMatch.matched,
      fieldsMismatched: bestMatch.mismatched,
    };
  }

  return {
    matched: false,
    matchedRow: bestMatch.row,
    confidence: confidence * 0.5,
    reasoning: `Low-confidence match: only ${bestMatch.matched.join(', ')} matched, ${bestMatch.mismatched.join(', ')} mismatched (${rawRows.length} rows)`,
    fieldsMatched: bestMatch.matched,
    fieldsMismatched: bestMatch.mismatched,
  };
}
