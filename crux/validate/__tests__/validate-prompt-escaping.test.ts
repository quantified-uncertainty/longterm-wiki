import { describe, it, expect } from 'vitest';
import { PROMPT_FUNC_PATTERNS, checkPromptLine } from '../validate-prompt-escaping.ts';

describe('validate-prompt-escaping — pattern detection', () => {
  // Test the XML interpolation regex via checkPromptLine (the actual validator logic)

  it('detects unescaped XML interpolation', () => {
    const violations = checkPromptLine(
      '      parts.push(`   <claim_text>${cl.claim_text}</claim_text>`);'
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].expr).toBe('cl.claim_text');
  });

  it('passes escaped XML interpolation (escapeXml present)', () => {
    const violations = checkPromptLine(
      '      parts.push(`   <claim_text>${escapeXml(cl.claim_text)}</claim_text>`);'
    );
    expect(violations).toHaveLength(0);
  });

  it('passes plain template literals without XML tags', () => {
    const violations = checkPromptLine('  return `Source: ${sourceUrl}`;');
    expect(violations).toHaveLength(0);
  });

  it('passes static XML tags without interpolation', () => {
    const violations = checkPromptLine(
      '  return `<source_content>static text</source_content>`;'
    );
    expect(violations).toHaveLength(0);
  });

  it('detects multiple interpolations on one line', () => {
    const violations = checkPromptLine('<a>${x}</a> <b>${y}</b>');
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.expr)).toEqual(['x', 'y']);
  });

  it('detects hyphenated tag names', () => {
    const violations = checkPromptLine('<claim-text>${data}</claim-text>');
    expect(violations).toHaveLength(1);
    expect(violations[0].expr).toBe('data');
  });
});

describe('validate-prompt-escaping — prompt function detection', () => {
  function matchesPromptFunc(line: string): boolean {
    return PROMPT_FUNC_PATTERNS.some((p) => {
      p.lastIndex = 0;
      return p.test(line);
    });
  }

  it('matches function buildMultiClaimPrompt(...)', () => {
    expect(matchesPromptFunc('function buildMultiClaimPrompt(')).toBe(true);
  });

  it('matches const buildPrompt = (...)', () => {
    expect(matchesPromptFunc('const buildPrompt = (claims) => {')).toBe(true);
  });

  it('matches function buildSourceCheckPrompt(...)', () => {
    expect(matchesPromptFunc('function buildSourceCheckPrompt(entity, facts) {')).toBe(true);
  });

  it('matches method definition buildPrompt(...) {', () => {
    // This is the method-call pattern from the validator
    expect(matchesPromptFunc('buildPrompt(claims) {')).toBe(true);
  });

  it('matches method definition with return type annotation', () => {
    expect(matchesPromptFunc('buildPrompt(claims): string {')).toBe(true);
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
  it('suppresses violations when // prompt-escape-ok is present', () => {
    const violations = checkPromptLine(
      '      <tag>${raw.data}</tag>  // prompt-escape-ok'
    );
    expect(violations).toHaveLength(0);
  });

  it('does not suppress without the comment', () => {
    const violations = checkPromptLine('      <tag>${raw.data}</tag>');
    expect(violations).toHaveLength(1);
    expect(violations[0].expr).toBe('raw.data');
  });

  it('skips comment lines entirely', () => {
    const violations = checkPromptLine('  // <tag>${raw.data}</tag>');
    expect(violations).toHaveLength(0);
  });
});
