/**
 * Cross-Reference Checker Agent
 *
 * Checks that facts stated on multiple pages are consistent. For example,
 * if page A says "Anthropic was founded in 2021" and page B says
 * "Anthropic was founded in 2020", this agent flags the contradiction.
 *
 * Works by:
 * 1. Extracting structured facts from pages (dates, numbers, roles)
 * 2. Grouping facts by entity
 * 3. Comparing across pages for contradictions
 */

import { readFile, readdir } from 'node:fs/promises';
import { join, basename } from 'node:path';
import type { AdversarialFinding } from '../types.ts';
import { stripFrontmatter } from '../../lib/patterns.ts';

// ---------------------------------------------------------------------------
// Fact extraction (regex-based, no LLM)
// ---------------------------------------------------------------------------

interface ExtractedFact {
  pageId: string;
  entityMention: string; // The entity name mentioned
  factType: 'founding-year' | 'funding' | 'employee-count' | 'role' | 'date';
  value: string;
  context: string; // Surrounding sentence
  paragraphIndex: number;
}

/** Patterns to extract structured facts. */
const FACT_PATTERNS: Array<{
  regex: RegExp;
  factType: ExtractedFact['factType'];
  entityGroup: number;
  valueGroup: number;
}> = [
  // "X was founded in YYYY"
  {
    regex: /(\b[A-Z][a-zA-Z\s&.-]+?) (?:was )?(?:founded|established|created|launched|incorporated) (?:in )?((?:19|20)\d{2})/g,
    factType: 'founding-year',
    entityGroup: 1,
    valueGroup: 2,
  },
  // "X raised $N million/billion" (handles escaped \$ in MDX)
  {
    regex: /(\b[A-Z][a-zA-Z\s&.-]+?) (?:has )?(?:raised|received|secured) \\?\$([\d,.]+)\s*(million|billion)/gi,
    factType: 'funding',
    entityGroup: 1,
    valueGroup: 2,
  },
  // "X has/had/grown to N employees/staff/researchers"
  {
    regex: /(\b[A-Z][a-zA-Z\s&.-]+?) (?:has|had|employs|employed)(?: grown to)? (?:approximately |about |around |~)?([\d,]+) (?:employees|staff|researchers|people|members)/gi,
    factType: 'employee-count',
    entityGroup: 1,
    valueGroup: 2,
  },
];

/**
 * Extract structured facts from a page.
 */
export function extractFacts(pageId: string, content: string): ExtractedFact[] {
  const body = stripFrontmatter(content);
  const paragraphs = body.split(/\n\n+/);
  const facts: ExtractedFact[] = [];

  for (let pi = 0; pi < paragraphs.length; pi++) {
    const para = paragraphs[pi];

    for (const pattern of FACT_PATTERNS) {
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
      let match: RegExpExecArray | null;

      while ((match = regex.exec(para)) !== null) {
        const entity = match[pattern.entityGroup].trim();
        const value = match[pattern.valueGroup].trim();

        // Skip very short entity names (likely false positives)
        if (entity.length < 3) continue;

        facts.push({
          pageId,
          entityMention: entity,
          factType: pattern.factType,
          value,
          context: match[0],
          paragraphIndex: pi,
        });
      }
    }
  }

  return facts;
}

/**
 * Normalize entity names for matching (lowercase, remove "the", trim).
 */
function normalizeEntityName(name: string): string {
  return name.toLowerCase().replace(/^the\s+/, '').replace(/[,.]+$/, '').trim();
}

/**
 * Check for contradictions in a set of facts about the same entity+factType.
 */
function findContradictions(facts: ExtractedFact[]): AdversarialFinding[] {
  // Group by normalized entity name + fact type
  const groups = new Map<string, ExtractedFact[]>();

  for (const fact of facts) {
    const key = `${normalizeEntityName(fact.entityMention)}:${fact.factType}`;
    const existing = groups.get(key) || [];
    existing.push(fact);
    groups.set(key, existing);
  }

  const findings: AdversarialFinding[] = [];

  for (const [key, groupFacts] of groups.entries()) {
    // Only check groups with facts from different pages
    const pages = new Set(groupFacts.map(f => f.pageId));
    if (pages.size < 2) continue;

    // Check for value disagreements
    const values = new Set(groupFacts.map(f => f.value));
    if (values.size <= 1) continue; // All agree

    // Found a contradiction!
    const [entityName, factType] = key.split(':');
    const details = groupFacts.map(f => `  - ${f.pageId}: "${f.value}" (context: "${f.context}")`).join('\n');

    for (const fact of groupFacts) {
      findings.push({
        pageId: fact.pageId,
        agent: 'cross-reference-checker',
        category: 'cross-page-contradiction',
        severity: 'critical',
        claim: `${entityName} ${factType}: "${fact.value}"`,
        evidence: `Contradictory values found across pages:\n${details}`,
        suggestion: `Verify the correct ${factType} for ${entityName} and update all references.`,
        confidence: 0.8,
        paragraphIndex: fact.paragraphIndex,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Main agent entry point
// ---------------------------------------------------------------------------

/**
 * Run cross-reference checking across a set of pages.
 *
 * Unlike other agents that work per-page, this one needs to see multiple
 * pages to find contradictions.
 */
export async function checkCrossReferences(
  pages: Array<{ id: string; content: string }>,
): Promise<AdversarialFinding[]> {
  console.log(`[cross-ref] Extracting facts from ${pages.length} pages...`);

  // Extract facts from all pages
  const allFacts: ExtractedFact[] = [];
  for (const page of pages) {
    const facts = extractFacts(page.id, page.content);
    allFacts.push(...facts);
  }

  console.log(`[cross-ref] Extracted ${allFacts.length} facts, checking for contradictions...`);

  // Find contradictions
  const findings = findContradictions(allFacts);

  console.log(`[cross-ref] Found ${findings.length} contradictions`);

  return findings;
}

/**
 * Load all pages from the content directory for cross-reference checking.
 */
export async function loadAllPages(
  limit?: number,
): Promise<Array<{ id: string; content: string }>> {
  const contentDir = join(process.cwd(), 'content/docs/knowledge-base');
  const pages: Array<{ id: string; content: string }> = [];

  async function scanDir(dir: string): Promise<void> {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (limit && pages.length >= limit) return;

        const fullPath = join(dir, entry.name);
        if (entry.isDirectory()) {
          await scanDir(fullPath);
        } else if (entry.name.endsWith('.mdx')) {
          const id = basename(entry.name, '.mdx');
          const content = await readFile(fullPath, 'utf-8');
          pages.push({ id, content });
        }
      }
    } catch {
      // Skip directories we can't read
    }
  }

  await scanDir(contentDir);
  return pages;
}
