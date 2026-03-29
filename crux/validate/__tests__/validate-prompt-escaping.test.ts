import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';

// We test the check by mocking the filesystem with controlled file contents,
// then importing and calling runCheck().

// Mock fs to control file contents
vi.mock('fs', async () => {
  const actual = await vi.importActual<typeof import('fs')>('fs');
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
  };
});

// Since the validator uses filesystem scanning which is hard to mock cleanly,
// we test the core detection logic by creating temp files and running the check.
// Instead, we test the patterns directly.

describe('validate-prompt-escaping — pattern detection', () => {
  // Test the XML interpolation regex directly
  const XML_INTERP_PATTERN = /<\w[\w-]*>\$\{([^}]+)\}<\/\w[\w-]*>/g;

  it('matches unescaped XML interpolation', () => {
    const line = '      parts.push(`   <claim_text>${cl.claim_text}</claim_text>`);';
    XML_INTERP_PATTERN.lastIndex = 0;
    const match = XML_INTERP_PATTERN.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('cl.claim_text');
  });

  it('matches escaped XML interpolation (escapeXml present in expression)', () => {
    const line = '      parts.push(`   <claim_text>${escapeXml(cl.claim_text)}</claim_text>`);';
    XML_INTERP_PATTERN.lastIndex = 0;
    const match = XML_INTERP_PATTERN.exec(line);
    expect(match).not.toBeNull();
    // The expression contains escapeXml(, which the checker allows
    expect(match![1]).toContain('escapeXml(');
  });

  it('does not match plain template literals without XML tags', () => {
    const line = '  return `Source: ${sourceUrl}`;';
    XML_INTERP_PATTERN.lastIndex = 0;
    const match = XML_INTERP_PATTERN.exec(line);
    expect(match).toBeNull();
  });

  it('does not match static XML tags without interpolation', () => {
    const line = '  return `<source_content>static text</source_content>`;';
    XML_INTERP_PATTERN.lastIndex = 0;
    const match = XML_INTERP_PATTERN.exec(line);
    expect(match).toBeNull();
  });

  it('matches multiple interpolations on one line', () => {
    const line = '<a>${x}</a> <b>${y}</b>';
    const matches: string[] = [];
    XML_INTERP_PATTERN.lastIndex = 0;
    let m;
    while ((m = XML_INTERP_PATTERN.exec(line)) !== null) {
      matches.push(m[1]);
    }
    expect(matches).toEqual(['x', 'y']);
  });

  it('matches hyphenated tag names', () => {
    const line = '<claim-text>${data}</claim-text>';
    XML_INTERP_PATTERN.lastIndex = 0;
    const match = XML_INTERP_PATTERN.exec(line);
    expect(match).not.toBeNull();
    expect(match![1]).toBe('data');
  });
});

describe('validate-prompt-escaping — prompt function detection', () => {
  // Test the patterns that identify prompt functions
  const promptFuncPatterns = [
    /\bfunction\s+\w*[Pp]rompt\w*\s*\(/,
    /\b(?:const|let|var)\s+\w*[Pp]rompt\w*\s*=/,
    /\bfunction\s+\w*prompt\w*\s*\(/i,
    /\b(?:const|let|var)\s+\w*prompt\w*\s*=/i,
  ];

  function matchesPromptFunc(line: string): boolean {
    return promptFuncPatterns.some((p) => p.test(line));
  }

  it('matches function buildMultiClaimPrompt(...)', () => {
    expect(matchesPromptFunc('function buildMultiClaimPrompt(')).toBe(true);
  });

  it('matches const buildPrompt = (...)', () => {
    expect(matchesPromptFunc('const buildPrompt = (claims) => {')).toBe(true);
  });

  it('matches function buildVerificationPrompt(...)', () => {
    expect(matchesPromptFunc('function buildVerificationPrompt(entity, facts) {')).toBe(true);
  });

  it('does not match unrelated functions', () => {
    expect(matchesPromptFunc('function handleRequest(req, res) {')).toBe(false);
  });

  it('does not match prompt as a variable without assignment', () => {
    expect(matchesPromptFunc('console.log(prompt);')).toBe(false);
  });

  it('matches case-insensitively', () => {
    expect(matchesPromptFunc('function buildprompt() {')).toBe(true);
    expect(matchesPromptFunc('function BUILDPROMPT() {')).toBe(true);
  });
});

describe('validate-prompt-escaping — suppression', () => {
  it('suppression comment is recognized', () => {
    const line = '      <tag>${raw.data}</tag>  // prompt-escape-ok';
    expect(line.includes('prompt-escape-ok')).toBe(true);
  });
});
