import { describe, it, expect } from 'vitest';
import { ensureMdxSafeYaml } from './yaml-mdx-safe.ts';

describe('ensureMdxSafeYaml', () => {
  it('converts unquoted \\$ to double-quoted \\\\$', () => {
    const input = 'llmSummary: costs exceed \\$1B by 2027\n';
    const result = ensureMdxSafeYaml(input);
    expect(result).toBe('llmSummary: "costs exceed \\\\$1B by 2027"\n');
  });

  it('leaves already-double-quoted values unchanged', () => {
    const input = 'llmSummary: "costs exceed \\\\$1B by 2027"\n';
    const result = ensureMdxSafeYaml(input);
    expect(result).toBe(input);
  });

  it('leaves single-quoted values unchanged', () => {
    const input = "llmSummary: 'costs exceed \\$1B by 2027'\n";
    const result = ensureMdxSafeYaml(input);
    expect(result).toBe(input);
  });

  it('leaves values without \\$ unchanged', () => {
    const input = 'llmSummary: no dollar signs here\ntitle: Test Page\n';
    const result = ensureMdxSafeYaml(input);
    expect(result).toBe(input);
  });

  it('does not affect nested/indented keys', () => {
    const input = '  nested: value with \\$100\n';
    const result = ensureMdxSafeYaml(input);
    expect(result).toBe(input);
  });

  it('escapes double quotes in value when converting', () => {
    const input = 'description: He said "it costs \\$100"\n';
    const result = ensureMdxSafeYaml(input);
    expect(result).toBe('description: "He said \\"it costs \\\\$100\\""\n');
  });

  it('handles multiple \\$ in one value', () => {
    const input = 'description: between \\$5 and \\$10\n';
    const result = ensureMdxSafeYaml(input);
    expect(result).toBe('description: "between \\\\$5 and \\\\$10"\n');
  });
});
