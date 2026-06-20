/**
 * Source Content Parsers — parse CSV, HTML table, and JSON content into
 * arrays of row objects for deterministic matching.
 *
 * Reuses existing CSV utilities from the grant import pipeline.
 *
 * Part of Phase 3: Data Source Resources (Discussion #3567).
 */

import { parseCSVLine, reassembleCSVRows } from '../grant-import/csv.ts';
import { decodeHtmlEntities } from '../html-utils.ts';

/**
 * Parse CSV content into an array of row objects, using the header row for keys.
 *
 * Note: reassembleCSVRows() skips the header line, so we extract the header
 * from the raw text separately, then use reassembleCSVRows for data rows.
 */
export function parseCSVContent(raw: string): Record<string, string>[] {
  const lines = raw.split('\n');
  if (lines.length === 0) return [];

  // Extract header from first line
  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  if (headers.length === 0) return [];

  // reassembleCSVRows handles multi-line quoted fields but skips the header
  const dataRows = reassembleCSVRows(raw);
  const result: Record<string, string>[] = [];

  for (const rowStr of dataRows) {
    const fields = parseCSVLine(rowStr);
    if (fields.length === 0) continue;

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length; j++) {
      if (headers[j]) {
        row[headers[j]] = (fields[j] ?? '').trim();
      }
    }
    result.push(row);
  }

  return result;
}

/**
 * Parse an HTML table into an array of row objects.
 * Extracts the first <table> with recognizable headers, or the largest table.
 */
export function parseHTMLTable(raw: string): Record<string, string>[] {
  // Find all tables
  const tableRegex = /<table[^>]*>([\s\S]*?)<\/table>/gi;
  let bestRows: Record<string, string>[] = [];

  let match;
  while ((match = tableRegex.exec(raw)) !== null) {
    const tableHtml = match[1];
    const parsed = parseOneHTMLTable(tableHtml);
    if (parsed.length > bestRows.length) {
      bestRows = parsed;
    }
  }

  return bestRows;
}

function parseOneHTMLTable(tableHtml: string): Record<string, string>[] {
  // Extract header cells from <thead> or first <tr>
  const stripTags = (html: string) => {
    // Strip tags to a fixed point so spliced-together angle brackets can't
    // re-form a tag after one pass, then decode entities via the shared helper
    // (which decodes `&amp;` last, avoiding double-unescaping).
    let out = html;
    let prev: string;
    do {
      prev = out;
      out = out.replace(/<[^>]+>/g, '');
    } while (out !== prev);
    return decodeHtmlEntities(out).trim();
  };

  const theadMatch = tableHtml.match(/<thead[^>]*>([\s\S]*?)<\/thead>/i);
  const headerMatch = theadMatch ?? tableHtml.match(/<tr[^>]*>([\s\S]*?)<\/tr>/i);
  if (!headerMatch) return [];

  // Track whether headers came from <thead> (don't skip first <tr>) or first <tr> (skip it)
  const headersFromThead = theadMatch !== null;

  const headers: string[] = [];
  const thRegex = /<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi;
  let hMatch;
  while ((hMatch = thRegex.exec(headerMatch[1])) !== null) {
    headers.push(stripTags(hMatch[1]));
  }

  if (headers.length === 0) return [];

  // Extract data rows — only skip first <tr> when headers were extracted from it
  const trRegex = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  const rows: Record<string, string>[] = [];
  let isFirst = true;
  let trMatch;

  while ((trMatch = trRegex.exec(tableHtml)) !== null) {
    if (isFirst && !headersFromThead) { isFirst = false; continue; } // skip header row only when headers came from first <tr>
    isFirst = false;

    const cells: string[] = [];
    const tdRegex = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let tdMatch;
    while ((tdMatch = tdRegex.exec(trMatch[1])) !== null) {
      cells.push(stripTags(tdMatch[1]));
    }

    if (cells.length === 0) continue;

    const row: Record<string, string> = {};
    for (let j = 0; j < headers.length && j < cells.length; j++) {
      if (headers[j]) row[headers[j]] = cells[j];
    }
    rows.push(row);
  }

  return rows;
}

/**
 * Parse JSON array content into an array of row objects.
 */
export function parseJSONArray(raw: string): Record<string, unknown>[] {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    // Some APIs wrap arrays in an object
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key])) return parsed[key];
    }
    return [];
  } catch {
    return [];
  }
}

/**
 * Apply a column mapping to rename source columns to internal field names.
 */
export function applyColumnMapping(
  rows: Record<string, unknown>[],
  mapping: Record<string, string>,
): Record<string, unknown>[] {
  return rows.map(row => {
    const mapped: Record<string, unknown> = {};
    for (const [sourceCol, internalField] of Object.entries(mapping)) {
      if (sourceCol in row) {
        mapped[internalField] = row[sourceCol];
      }
    }
    // Keep unmapped fields too, but skip fields whose keys collide with mapping targets
    const mappingTargets = new Set(Object.values(mapping));
    for (const [key, val] of Object.entries(row)) {
      if (!Object.keys(mapping).includes(key) && !mappingTargets.has(key)) {
        mapped[key] = val;
      }
    }
    return mapped;
  });
}
