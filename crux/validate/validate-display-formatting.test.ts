/**
 * Tests for the display formatting validator.
 *
 * Tests the exported detection functions directly (unit tests) and
 * runs the validator against the current codebase (integration test).
 */

import { describe, it, expect } from 'vitest';
import { execSync } from 'child_process';
import {
  containsObjectObject,
  hasUnescapedMdxInTitle,
  isStringifiedNullish,
  isStringifiedNaN,
} from './validate-display-formatting.ts';

const REPO_ROOT = `${__dirname}/../..`;

function run(cmd: string): { stdout: string; exitCode: number } {
  try {
    const stdout = execSync(cmd, {
      cwd: REPO_ROOT,
      encoding: 'utf-8',
      timeout: 30_000,
    });
    return { stdout, exitCode: 0 };
  } catch (e: any) {
    return { stdout: (e.stdout || '') + (e.stderr || ''), exitCode: e.status ?? 1 };
  }
}

describe('containsObjectObject', () => {
  it('detects [object Object]', () => {
    expect(containsObjectObject('[object Object]')).toBe(true);
    expect(containsObjectObject('Name: [object Object]')).toBe(true);
    expect(containsObjectObject('Data is [object Object] here')).toBe(true);
  });

  it('rejects normal strings', () => {
    expect(containsObjectObject('Anthropic')).toBe(false);
    expect(containsObjectObject('An object in the room')).toBe(false);
    expect(containsObjectObject('')).toBe(false);
  });
});

describe('hasUnescapedMdxInTitle', () => {
  it('detects bare angle brackets not part of HTML tags', () => {
    // Bare < not followed by a tag name
    expect(hasUnescapedMdxInTitle('Revenue < $1M')).toBe(true);
    expect(hasUnescapedMdxInTitle('Score <100')).toBe(true);
    expect(hasUnescapedMdxInTitle('x < y')).toBe(true);
  });

  it('allows HTML-like tags', () => {
    // These look like valid HTML tags — the MDX compiler handles them
    expect(hasUnescapedMdxInTitle('<em>emphasis</em>')).toBe(false);
    expect(hasUnescapedMdxInTitle('<strong>bold</strong>')).toBe(false);
    expect(hasUnescapedMdxInTitle('</div>')).toBe(false);
  });

  it('detects bare curly braces', () => {
    expect(hasUnescapedMdxInTitle('Value {computed}')).toBe(true);
    expect(hasUnescapedMdxInTitle('Count: {}')).toBe(true);
    expect(hasUnescapedMdxInTitle('Result }')).toBe(true);
  });

  it('allows normal titles', () => {
    expect(hasUnescapedMdxInTitle('Anthropic')).toBe(false);
    expect(hasUnescapedMdxInTitle('AI Safety Research Overview')).toBe(false);
    expect(hasUnescapedMdxInTitle('OpenAI - GPT-4 Launch')).toBe(false);
    expect(hasUnescapedMdxInTitle('$100M Funding Round')).toBe(false);
  });
});

describe('isStringifiedNullish', () => {
  it('detects "undefined" and "null"', () => {
    expect(isStringifiedNullish('undefined')).toBe(true);
    expect(isStringifiedNullish('null')).toBe(true);
    expect(isStringifiedNullish(' undefined ')).toBe(true);
    expect(isStringifiedNullish(' null ')).toBe(true);
  });

  it('rejects normal strings containing these words', () => {
    expect(isStringifiedNullish('null hypothesis')).toBe(false);
    expect(isStringifiedNullish('undefined behavior')).toBe(false);
    expect(isStringifiedNullish('Anthropic')).toBe(false);
    expect(isStringifiedNullish('')).toBe(false);
  });
});

describe('isStringifiedNaN', () => {
  it('detects "NaN"', () => {
    expect(isStringifiedNaN('NaN')).toBe(true);
    expect(isStringifiedNaN(' NaN ')).toBe(true);
  });

  it('rejects normal strings', () => {
    expect(isStringifiedNaN('Nanjing')).toBe(false);
    expect(isStringifiedNaN('Banana')).toBe(false);
    expect(isStringifiedNaN('')).toBe(false);
  });
});

describe('validate-display-formatting integration', () => {
  it('passes on the current codebase', () => {
    const result = run('npx tsx crux/validate/validate-display-formatting.ts');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('No display formatting issues found');
  }, 30_000);
});
