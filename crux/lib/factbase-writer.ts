/**
 * YAML read-modify-write utilities for KB entity files.
 *
 * Uses `parseDocument()` from the `yaml` package to preserve comments and
 * formatting when appending facts to entity YAML files.
 *
 * All writes are atomic: write to a `.tmp` file, then rename.
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Document, parseDocument, isSeq, isMap } from 'yaml';
import { generateFactId } from '../../packages/factbase/src/ids.ts';
import { CUSTOM_TAGS } from '../../packages/factbase/src/loader.ts';

// ── Public types ──────────────────────────────────────────────────────

export interface RawFactInput {
  property: string;
  value: unknown;
  asOf?: string;
  source?: string;
  sourceResource?: string;
  sourceQuote?: string;
  notes?: string;
  currency?: string;
}

// ── Core functions ────────────────────────────────────────────────────

/**
 * Read an entity YAML file as a Document (preserves comments/formatting).
 */
export function readEntityDocument(filepath: string): Document {
  const content = readFileSync(filepath, 'utf-8');
  return parseDocument(content, { customTags: CUSTOM_TAGS });
}

/**
 * Append a fact to an entity YAML document.
 * Adds to the `facts` sequence node, preserving existing structure.
 * Auto-generates a plain 10-char alphanumeric fact ID.
 */
export function appendFact(doc: Document, fact: RawFactInput): string {
  const factId = generateFactId();

  // Build the fact object in the order we want it serialized
  const factObj: Record<string, unknown> = { id: factId, property: fact.property };

  factObj.value = fact.value;

  if (fact.asOf !== undefined) {
    factObj.asOf = fact.asOf;
  }
  if (fact.source !== undefined) {
    factObj.source = fact.source;
  }
  if (fact.sourceResource !== undefined) {
    factObj.sourceResource = fact.sourceResource;
  }
  if (fact.sourceQuote !== undefined) {
    factObj.sourceQuote = fact.sourceQuote;
  }
  if (fact.notes !== undefined) {
    factObj.notes = fact.notes;
  }
  if (fact.currency !== undefined) {
    factObj.currency = fact.currency;
  }

  // Create a properly typed YAML node from our object
  const factNode = doc.createNode(factObj);

  // Get or create the `facts` sequence
  const contents = doc.contents;
  if (!isMap(contents)) {
    throw new Error('Document root is not a mapping');
  }

  let factsNode = contents.get('facts', true);
  if (!factsNode) {
    // No facts key yet — create a new sequence
    const newSeq = doc.createNode([]);
    contents.set('facts', newSeq);
    factsNode = contents.get('facts', true);
  }

  if (!isSeq(factsNode)) {
    throw new Error('`facts` node is not a sequence');
  }

  factsNode.items.push(factNode);

  return factId;
}

/**
 * Update an existing fact in a YAML document, matching by (property, asOf).
 * Returns the ID of the updated fact, or null if no match was found.
 */
export function updateFact(
  doc: Document,
  match: { property: string; asOf: string },
  updates: { value?: unknown; source?: string; notes?: string },
): string | null {
  const contents = doc.contents;
  if (!isMap(contents)) return null;

  const factsNode = contents.get('facts', true);
  if (!isSeq(factsNode)) return null;

  for (const item of factsNode.items) {
    if (!isMap(item)) continue;
    const prop = item.get('property');
    const asOf = item.get('asOf');
    if (prop === match.property && String(asOf) === match.asOf) {
      if (updates.value !== undefined) item.set('value', updates.value);
      if (updates.source !== undefined) item.set('source', updates.source);
      if (updates.notes !== undefined) item.set('notes', updates.notes);
      return String(item.get('id') ?? '');
    }
  }
  return null;
}

/**
 * Write a YAML document back to file atomically (write to temp, rename).
 */
export function writeEntityDocument(filepath: string, doc: Document): void {
  const content = doc.toString();
  const tmpPath = filepath + '.tmp';
  writeFileSync(tmpPath, content, 'utf-8');
  renameSync(tmpPath, filepath);
}

/**
 * Find the YAML file path for an entity.
 * Checks both single-file (things/<slug>.yaml) and directory (things/<dir>/entity.yaml) patterns.
 *
 * @param entitySlug - The slug (filename stem) for the entity
 * @param dataDir - The KB data directory (e.g., packages/factbase/data)
 * @returns Absolute file path, or null if not found
 */
export function findEntityFilePath(entitySlug: string, dataDir: string): string | null {
  const thingsDir = join(dataDir, 'things');

  // Check single-file pattern: things/<slug>.yaml
  const singleFile = join(thingsDir, `${entitySlug}.yaml`);
  if (existsSync(singleFile)) {
    return singleFile;
  }

  // Check directory pattern: things/<slug>/entity.yaml
  const dirFile = join(thingsDir, entitySlug, 'entity.yaml');
  if (existsSync(dirFile)) {
    return dirFile;
  }

  return null;
}

