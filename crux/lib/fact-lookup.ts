/**
 * Fact Lookup Utilities
 *
 * Builds a fact lookup table for LLM prompts, so the improve pipeline
 * knows which <F> tags are available for a given page.
 *
 * Parallel to entity-lookup.ts — entities tell the LLM which EntityLinks
 * exist; this tells the LLM which canonical facts exist.
 *
 * Usage:
 *   const table = buildFactLookupForContent(pageId, content, ROOT);
 *   // Include `table` in the LLM prompt
 */

import fs from 'fs';
import path from 'path';
import { parse as parseYaml } from 'yaml';

interface FactEntry {
  value: string;
  numeric?: number;
  asOf?: string;
  note?: string;
  source?: string;
  noCompute?: boolean;
  compute?: string;
}

interface FactFile {
  entity: string;
  facts: Record<string, FactEntry>;
}

let _allFacts: FactFile[] | null = null;

function loadAllFacts(ROOT: string): FactFile[] {
  if (_allFacts) return _allFacts;

  const factsDir = path.join(ROOT, 'data/facts');
  if (!fs.existsSync(factsDir)) {
    _allFacts = [];
    return _allFacts;
  }

  const files = fs.readdirSync(factsDir).filter(f => f.endsWith('.yaml'));
  _allFacts = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(factsDir, file), 'utf-8');
      const parsed = parseYaml(raw) as FactFile;
      if (parsed?.entity && parsed?.facts) {
        _allFacts.push(parsed);
      }
    } catch {
      // Skip malformed YAML files
    }
  }

  return _allFacts;
}

/**
 * Build a fact lookup table relevant to the given page content.
 *
 * Strategy:
 * 1. Always include facts for the page's own entity (if pageId matches an entity)
 * 2. Search for entity names mentioned in the content → include their facts
 * 3. Format as a compact table the LLM can reference
 */
export function buildFactLookupForContent(pageId: string, content: string, ROOT: string): string {
  const allFacts = loadAllFacts(ROOT);
  if (allFacts.length === 0) return '';

  const contentLower = content.toLowerCase();
  const relevantEntities = new Set<string>();

  // 1. Always include facts for the page's own entity
  for (const factFile of allFacts) {
    if (pageId === factFile.entity || pageId.startsWith(factFile.entity + '-')) {
      relevantEntities.add(factFile.entity);
    }
  }

  // 2. Check which entities are mentioned in the content
  //    Entity display names → entity IDs
  const entityDisplayNames: Record<string, string[]> = {
    'anthropic': ['Anthropic'],
    'openai': ['OpenAI'],
    'sam-altman': ['Sam Altman', 'Altman'],
    'jaan-tallinn': ['Jaan Tallinn', 'Tallinn'],
  };

  for (const factFile of allFacts) {
    if (relevantEntities.has(factFile.entity)) continue;

    const names = entityDisplayNames[factFile.entity] || [factFile.entity];
    for (const name of names) {
      if (contentLower.includes(name.toLowerCase())) {
        relevantEntities.add(factFile.entity);
        break;
      }
    }
  }

  if (relevantEntities.size === 0) return '';

  // 3. Format as a compact table
  const sections: string[] = [];

  for (const factFile of allFacts) {
    if (!relevantEntities.has(factFile.entity)) continue;

    const rows: string[] = [];
    for (const [factId, fact] of Object.entries(factFile.facts)) {
      if (fact.compute) continue; // Skip computed facts — use <Calc> for those

      const parts = [`${factFile.entity}.${factId}: "${fact.value}"`];
      if (fact.asOf) parts.push(`(as of ${fact.asOf})`);
      if (fact.note) parts.push(`— ${fact.note}`);
      rows.push(parts.join(' '));
    }

    if (rows.length > 0) {
      sections.push(`# ${factFile.entity}\n${rows.join('\n')}`);
    }
  }

  return sections.join('\n\n');
}

/** Clear cached data (useful for testing) */
export function clearFactLookupCache(): void {
  _allFacts = null;
}
