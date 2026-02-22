/**
 * Fabricated Citations Injector
 *
 * Replaces real citation URLs with plausible-looking fake ones that either:
 * 1. Don't resolve at all (dead URL)
 * 2. Resolve to a real page that doesn't support the claim
 *
 * This tests the citation-auditor's ability to catch dead links and
 * misattributed citations.
 */

import type { InjectedError } from '../types.ts';
import { stripFrontmatter } from '../../lib/patterns.ts';

// ---------------------------------------------------------------------------
// Fake URL generators
// ---------------------------------------------------------------------------

const FAKE_DOMAINS = [
  'arxiv.org',
  'nature.com',
  'science.org',
  'ieee.org',
  'acm.org',
];

const FAKE_PATH_COMPONENTS = [
  'papers', 'articles', 'research', 'publications', 'reports',
  'studies', 'proceedings', 'journal', 'conference', 'workshop',
];

function generateFakeArxivId(): string {
  const year = 20 + Math.floor(Math.random() * 6); // 2020-2025
  const month = String(1 + Math.floor(Math.random() * 12)).padStart(2, '0');
  const number = String(10000 + Math.floor(Math.random() * 90000));
  return `${year}${month}.${number}`;
}

function generateFakeUrl(originalUrl: string): string {
  // Try to produce a URL that looks plausible but doesn't exist
  try {
    const url = new URL(originalUrl);
    const domain = FAKE_DOMAINS[Math.floor(Math.random() * FAKE_DOMAINS.length)];
    const path = FAKE_PATH_COMPONENTS[Math.floor(Math.random() * FAKE_PATH_COMPONENTS.length)];

    if (domain === 'arxiv.org') {
      return `https://arxiv.org/abs/${generateFakeArxivId()}`;
    }
    return `https://${domain}/${path}/${Math.random().toString(36).slice(2, 10)}`;
  } catch {
    // If original URL is malformed, just generate a plausible dead link
    return `https://arxiv.org/abs/${generateFakeArxivId()}`;
  }
}

// ---------------------------------------------------------------------------
// Citation finder
// ---------------------------------------------------------------------------

interface FoundCitation {
  /** Full footnote definition line: [^N]: [Title](URL) */
  fullLine: string;
  /** Footnote number */
  footnoteNum: number;
  /** The URL */
  url: string;
  /** Position in content */
  lineIndex: number;
}

function findCitations(content: string): FoundCitation[] {
  const body = stripFrontmatter(content);
  const lines = body.split('\n');
  const citations: FoundCitation[] = [];

  // Match footnote definitions: [^N]: [Title](URL)  or  [^N]: URL
  const fnPattern = /^\[\^(\d+)\]:\s*(?:\[.*?\]\((https?:\/\/[^\s)]+)\)|(https?:\/\/\S+))/;

  for (let i = 0; i < lines.length; i++) {
    const match = fnPattern.exec(lines[i]);
    if (match) {
      citations.push({
        fullLine: lines[i],
        footnoteNum: parseInt(match[1], 10),
        url: match[2] || match[3],
        lineIndex: i,
      });
    }
  }

  return citations;
}

// ---------------------------------------------------------------------------
// Injector
// ---------------------------------------------------------------------------

/**
 * Replace real citation URLs with fake ones.
 */
export async function injectFabricatedCitations(
  content: string,
  count: number,
  _useLlm: boolean,
): Promise<{ content: string; errors: InjectedError[] }> {
  const citations = findCitations(content);
  if (citations.length === 0) {
    return { content, errors: [] };
  }

  // Select `count` citations to corrupt
  const shuffled = [...citations].sort(() => Math.random() - 0.5);
  const selected = shuffled.slice(0, Math.min(count, citations.length));

  let corrupted = content;
  const errors: InjectedError[] = [];

  for (const citation of selected) {
    const fakeUrl = generateFakeUrl(citation.url);
    const newLine = citation.fullLine.replace(citation.url, fakeUrl);

    corrupted = corrupted.replace(citation.fullLine, newLine);

    errors.push({
      id: `fabricated-citation-${errors.length}`,
      category: 'fabricated-citation',
      description: `Replaced citation [^${citation.footnoteNum}] URL: "${citation.url}" → "${fakeUrl}"`,
      originalText: citation.fullLine,
      corruptedText: newLine,
      paragraphIndex: -1, // footnotes are at the end
      detectability: 'easy', // dead URLs are easy to catch
    });
  }

  return { content: corrupted, errors };
}
