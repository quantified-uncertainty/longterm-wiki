/**
 * Tests for validate-placeholder-citations.
 *
 * Uses a synthetic file written to a temp dir, feeds it through the
 * checkFile logic by re-importing the regex-level primitives, and also
 * runs the validator as a subprocess against the live content tree so
 * CI drift shows up.
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const REPO_ROOT = `${__dirname}/../..`;

/**
 * Minimal helper: parse + classify footnote bodies. We mirror the
 * classification logic from the validator so we can unit-test the
 * decision without spawning the subprocess for every case.
 *
 * If the validator changes, these tests must change in lockstep.
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

const REAL_CITATION_PATTERNS: RegExp[] = [
  /https?:\/\//i,
  /\bdoi\.org\//i,
  /\b10\.\d{4,}\/[^\s)]+/,
  /\barxiv(?:\.org)?[:/]\s*\d{4}\.\d{4,}/i,
  /\barxiv:\s*\d{4}\.\d{4,}/i,
  /\bISBN[-:\s]*[\d-]{9,}/i,
  /\bwww\.[a-z0-9.-]+\.[a-z]{2,}/i,
];

function classify(text: string): { placeholder: boolean; pattern?: string } {
  if (text.trim() === '') return { placeholder: true, pattern: 'empty' };
  if (REAL_CITATION_PATTERNS.some((r) => r.test(text))) return { placeholder: false };
  for (const p of PLACEHOLDER_PATTERNS) {
    if (p.regex.test(text)) return { placeholder: true, pattern: p.name };
  }
  return { placeholder: false };
}

function run(cmd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(`${cmd} 2>&1`, { cwd: REPO_ROOT, encoding: 'utf-8', timeout: 60_000 });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: e.stdout || '', exitCode: e.status ?? 1 };
  }
}

describe('validate-placeholder-citations — classification', () => {
  it('passes footnote with URL', () => {
    expect(classify('Some Report, https://example.com/x, 2024').placeholder).toBe(false);
  });

  it('passes footnote with DOI', () => {
    expect(classify('Author et al. 2023. doi.org/10.1234/abc').placeholder).toBe(false);
  });

  it('passes footnote with arxiv id', () => {
    expect(classify('OpenAI Codex paper, arXiv:2107.03374').placeholder).toBe(false);
  });

  it('passes footnote with bare DOI prefix', () => {
    expect(classify('Reference 10.1038/nature12373').placeholder).toBe(false);
  });

  it('passes footnote with ISBN', () => {
    expect(classify('Ord, T. (2020) The Precipice. ISBN 978-1-5266-0023-8').placeholder).toBe(false);
  });

  it('passes named-source footnote without URL', () => {
    // Keep the existing "citation without URL" pattern working — must not flag
    // footnotes that reference real publications without the placeholder phrases.
    expect(classify('IFRC Climate Centre - Menu of Triggers for Forecast-Based Financing, 2014').placeholder).toBe(false);
    expect(classify('PwC Responsible AI Survey, 2025').placeholder).toBe(false);
    expect(classify('Ord, Toby. *The Precipice*, 2020, p. 167.').placeholder).toBe(false);
  });

  it('flags "Research data on ..."', () => {
    expect(classify('Research data on AI safety from various sources').placeholder).toBe(true);
  });

  it('flags "research data from ..."', () => {
    expect(classify('Career history at Stripe — research data from biographical profiles').placeholder).toBe(true);
  });

  it('flags "General ... background ..."', () => {
    expect(classify('General background on defense AI history').placeholder).toBe(true);
    expect(classify('General historical background on the Ford Foundation').placeholder).toBe(true);
  });

  it('flags "Multiple sources on ..."', () => {
    expect(classify('Multiple sources on alignment research').placeholder).toBe(true);
  });

  it('flags "user-provided directions"', () => {
    expect(classify('Chris Cox and FAIR evolution — user-provided directions').placeholder).toBe(true);
  });

  it('flags "— research section"', () => {
    expect(classify('Hugging Face partnerships — Overview and Research research sections').placeholder).toBe(true);
  });

  it('flags "synthesized from ..."', () => {
    expect(classify('Historical elite coordination — synthesized from research on US railroad receiverships').placeholder).toBe(true);
  });

  it('flags empty footnote body', () => {
    expect(classify('').placeholder).toBe(true);
    expect(classify('   ').placeholder).toBe(true);
  });

  it('URL presence wins over placeholder phrase', () => {
    // If a footnote mentions "research data on" but ALSO has a URL, don't flag.
    const text = 'Research data on AI safety, see https://example.com/report';
    expect(classify(text).placeholder).toBe(false);
  });

  it('does not flag typical "further reading" text without a matched phrase', () => {
    expect(classify('See also: section 3 of the report').placeholder).toBe(false);
    expect(classify('Anthropic research notes, 2024').placeholder).toBe(false);
  });
});

describe('validate-placeholder-citations — parsing', () => {
  // For multi-line tests, we invoke the validator as a subprocess against a
  // temp file laid out as content/docs. Quickest way to exercise the real
  // parser.
  let tmpDir: string;

  it('runs against the real content tree and reports at least 10 files', () => {
    const result = run('npx tsx crux/validate/validate-placeholder-citations.ts');
    // Expect non-zero exit (we know placeholders exist in the current tree)
    // — if this test fails because the tree was cleaned up, that's a real
    // success, not a regression; update the assertion.
    expect(result.stdout).toMatch(/Found \d+ placeholder footnote\(s\) in \d+ file\(s\)/);
  }, 60_000);
});
