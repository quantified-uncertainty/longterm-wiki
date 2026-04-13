#!/usr/bin/env node

/**
 * Validate that MDX pages do not contain placeholder footnote definitions.
 *
 * Scans `content/docs/**\/*.mdx` for footnote definitions like
 *   [^1]: Research data on AI safety from various sources
 *   [^2]: General background on machine learning interpretability
 *   [^3]: Multiple sources on alignment research
 *   [^4]: — user-provided directions
 *
 * A footnote is considered placeholder iff:
 *   (a) It does NOT contain a URL, DOI, arxiv ID, or ISBN, AND
 *   (b) Its body text matches one of the known placeholder patterns.
 *
 * Real citations (with URLs, arxiv IDs, DOIs, named documents) are not
 * flagged. Short bare prose without any identifier is NOT flagged on its
 * own — we require a matched phrase. This keeps the validator deliberately
 * conservative so it can be shipped as blocking.
 *
 * Defense-in-depth for the create/improve pipeline (root cause: QUA-290).
 *
 * Usage: npx tsx crux/validate/validate-placeholder-citations.ts
 */

import { readFileSync } from 'fs';
import { relative } from 'path';
import { CONTENT_DIR_ABS, PROJECT_ROOT } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { getColors } from '../lib/output.ts';

export interface PlaceholderViolation {
  file: string;
  line: number;
  label: string;
  pattern: string;
  text: string;
}

/**
 * Known placeholder phrases. A footnote whose body (case-insensitive)
 * contains any of these — and which has no URL / DOI / arxiv / ISBN — is
 * flagged. Each pattern has a human-readable name for the error message.
 *
 * Keep these tight: new patterns should only be added after observing
 * real occurrences in the content tree.
 */
const PLACEHOLDER_PATTERNS: Array<{ name: string; regex: RegExp }> = [
  { name: 'research data on',          regex: /\bresearch data on\b/i },
  { name: 'research data from',        regex: /\bresearch data from\b/i },
  { name: 'research data compiled',    regex: /\bresearch data compiled\b/i },
  { name: 'research data —/–',         regex: /\bresearch data\s+[—–-]/i },
  { name: '— research data',           regex: /[—–-]\s*research data\b/i },
  { name: 'General ... background',    regex: /\bGeneral\b[A-Za-z0-9 .,'\-]{0,60}?\bbackground\b/i },
  { name: 'Multiple sources on',       regex: /\bmultiple sources on\b/i },
  { name: 'user-provided directions',  regex: /\buser[- ]provided directions\b/i },
  { name: '— research section',        regex: /[—–-]\s*[A-Za-z][A-Za-z0-9 ,'\-]{0,80}?research sections?\b/i },
  { name: 'from various sources',      regex: /\bfrom various sources\b/i },
  { name: 'synthesized from',          regex: /\bsynthesized from\b/i },
  { name: 'cited in research data',    regex: /\bcited in research data\b/i },
  { name: 'Perplexity research data',  regex: /\bperplexity research data\b/i },
];

/**
 * Anything that strongly indicates a real citation. If ANY of these match
 * the footnote body, we do not flag — even if a placeholder phrase matches.
 * URL presence wins.
 */
const REAL_CITATION_PATTERNS: RegExp[] = [
  /https?:\/\//i,                         // any URL
  /\bdoi\.org\//i,                        // DOI URL
  /\b10\.\d{4,}\/[^\s)]+/,                // bare DOI prefix
  /\barxiv(?:\.org)?[:/]\s*\d{4}\.\d{4,}/i, // arxiv ID
  /\barxiv:\s*\d{4}\.\d{4,}/i,            // arXiv:NNNN.NNNNN
  /\bISBN[-:\s]*[\d-]{9,}/i,              // ISBN
  /\bwww\.[a-z0-9.-]+\.[a-z]{2,}/i,       // www.domain
];

/**
 * Strip MDX block comments so we don't flag placeholder-looking text
 * that's commented out.
 */
function stripMdxComments(src: string): string {
  return src.replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

/**
 * Parse footnote definitions from a file. Handles multi-line footnotes
 * where subsequent indented lines belong to the same definition.
 */
interface ParsedFootnote {
  label: string;
  text: string;
  startLine: number; // 1-indexed
}

function parseFootnotes(src: string): ParsedFootnote[] {
  const lines = src.split('\n');
  const defRe = /^\[\^([^\]]+)\]:\s*(.*)$/;
  const out: ParsedFootnote[] = [];

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(defRe);
    if (!m) continue;
    const label = m[1];
    let body = m[2];
    // Consume continuation lines: must be indented (4+ spaces or a tab)
    // and must not be a new footnote definition or a blank line.
    let j = i + 1;
    while (j < lines.length) {
      const next = lines[j];
      if (next.trim() === '') break;
      if (defRe.test(next)) break;
      if (!/^(\s{4,}|\t)/.test(next)) break;
      body += ' ' + next.trim();
      j++;
    }
    out.push({ label, text: body, startLine: i + 1 });
    i = j - 1;
  }
  return out;
}

function hasRealCitation(text: string): boolean {
  return REAL_CITATION_PATTERNS.some((re) => re.test(text));
}

function matchedPlaceholderPattern(text: string): string | null {
  for (const { name, regex } of PLACEHOLDER_PATTERNS) {
    if (regex.test(text)) return name;
  }
  return null;
}

function checkFile(filePath: string): PlaceholderViolation[] {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }
  if (!/^\[\^/m.test(raw)) return [];

  const src = stripMdxComments(raw);
  const footnotes = parseFootnotes(src);
  const relPath = relative(PROJECT_ROOT, filePath);
  const violations: PlaceholderViolation[] = [];

  for (const fn of footnotes) {
    if (fn.text.trim() === '') {
      violations.push({
        file: relPath,
        line: fn.startLine,
        label: fn.label,
        pattern: 'empty footnote body',
        text: '',
      });
      continue;
    }
    if (hasRealCitation(fn.text)) continue;
    const patternName = matchedPlaceholderPattern(fn.text);
    if (!patternName) continue;
    violations.push({
      file: relPath,
      line: fn.startLine,
      label: fn.label,
      pattern: patternName,
      text: fn.text.length > 120 ? fn.text.slice(0, 117) + '...' : fn.text,
    });
  }
  return violations;
}

export function runCheck(): { passed: boolean; errors: number; violations: PlaceholderViolation[] } {
  const c = getColors();
  console.log(`${c.blue}Scanning for placeholder footnote citations...${c.reset}\n`);

  const mdxFiles = findMdxFiles(CONTENT_DIR_ABS);
  const allViolations: PlaceholderViolation[] = [];
  for (const file of mdxFiles) {
    allViolations.push(...checkFile(file));
  }

  if (allViolations.length === 0) {
    console.log(`${c.green}No placeholder footnotes found (${mdxFiles.length} files checked)${c.reset}`);
    return { passed: true, errors: 0, violations: [] };
  }

  const byFile = new Map<string, PlaceholderViolation[]>();
  for (const v of allViolations) {
    const bucket = byFile.get(v.file) ?? [];
    bucket.push(v);
    byFile.set(v.file, bucket);
  }

  console.log(`${c.red}Found ${allViolations.length} placeholder footnote(s) in ${byFile.size} file(s):${c.reset}\n`);
  for (const [file, vs] of byFile) {
    console.log(`  ${c.red}${file}${c.reset} (${vs.length})`);
    for (const v of vs) {
      console.log(`    ${c.dim}:${v.line} [^${v.label}] (${v.pattern}): ${v.text}${c.reset}`);
    }
    console.log();
  }
  console.log(`${c.dim}Fix: replace each flagged footnote with a real citation (URL, DOI, arxiv ID, or specific document reference).${c.reset}`);
  console.log(`${c.dim}     Root cause tracked in QUA-290 — the create/improve pipeline should not emit these.${c.reset}`);
  return { passed: false, errors: allViolations.length, violations: allViolations };
}

if (process.argv[1]?.includes('validate-placeholder-citations')) {
  const result = runCheck();
  process.exit(result.passed ? 0 : 1);
}
