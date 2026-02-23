import { describe, it, expect } from 'vitest';
import { footnoteIntegrityRule } from './footnote-integrity.ts';
import { ValidationEngine, Severity } from '../validation-engine.ts';

// Minimal mock of ContentFile and ValidationEngine for rule testing
function makeContentFile(body: string, path = 'content/docs/knowledge-base/test.mdx') {
  return {
    path,
    frontmatter: {} as any,
    body,
    rawContent: `---\ntitle: Test\n---\n${body}`,
  } as any;
}

const engine = {} as ValidationEngine;

describe('footnoteIntegrityRule', () => {
  it('returns no issues for well-formed footnotes', () => {
    const body = `## Section

Some claim here.[^1] Another claim.[^2]

[^1]: Source One (https://example.com/1)
[^2]: Source Two (https://example.com/2)
`;
    const issues = footnoteIntegrityRule.check(makeContentFile(body), engine);
    expect(issues).toHaveLength(0);
  });

  it('detects orphaned inline ref (no definition)', () => {
    const body = `## Section

Claim with ref.[^1] Another claim.[^2]

[^1]: Source One (https://example.com/1)
`;
    const issues = footnoteIntegrityRule.check(makeContentFile(body), engine);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Orphaned footnote reference [^2]');
  });

  it('detects orphaned definition (no inline ref)', () => {
    const body = `## Section

Claim with ref.[^1]

[^1]: Source One (https://example.com/1)
[^2]: Source Two (https://example.com/2)
`;
    const issues = footnoteIntegrityRule.check(makeContentFile(body), engine);
    expect(issues).toHaveLength(1);
    expect(issues[0].message).toContain('Orphaned footnote definition [^2]');
  });

  it('detects leaked SRC-style markers as ERROR', () => {
    const body = `## Section

Claim here.[^SRC-1]

[^SRC-1]: Source (https://example.com)
`;
    const issues = footnoteIntegrityRule.check(makeContentFile(body), engine);
    const srcIssues = issues.filter(i => i.message.includes('Leaked pipeline marker'));
    expect(srcIssues.length).toBeGreaterThanOrEqual(1);
    expect(srcIssues[0].severity).toBe(Severity.ERROR);
  });

  it('detects leaked S{i}-SRC-N markers from deduplication', () => {
    const body = `## Section

Claim here.[^S1-SRC-1]

[^S1-SRC-1]: Source (https://example.com)
`;
    const issues = footnoteIntegrityRule.check(makeContentFile(body), engine);
    const srcIssues = issues.filter(i => i.message.includes('Leaked pipeline marker'));
    expect(srcIssues.length).toBeGreaterThanOrEqual(1);
  });

  it('skips internal documentation pages', () => {
    const body = `## Section

Example: [^SRC-1] is a pipeline marker.
`;
    const issues = footnoteIntegrityRule.check(
      makeContentFile(body, 'content/docs/internal/pipeline-guide.mdx'),
      engine,
    );
    expect(issues).toHaveLength(0);
  });

  it('ignores footnote-like patterns inside code fences', () => {
    const body = `## Section

\`\`\`markdown
[^SRC-1]: This is inside a code fence
\`\`\`

Claim here.[^1]

[^1]: Real source (https://example.com)
`;
    const issues = footnoteIntegrityRule.check(makeContentFile(body), engine);
    expect(issues).toHaveLength(0);
  });

  it('handles page with no footnotes', () => {
    const body = `## Section

Just plain text, no footnotes at all.
`;
    const issues = footnoteIntegrityRule.check(makeContentFile(body), engine);
    expect(issues).toHaveLength(0);
  });

  it('handles multiple orphans', () => {
    const body = `## Section

Claim A.[^1] Claim B.[^3] Claim C.[^5]

[^1]: Source One (https://example.com/1)
[^2]: Unused source
[^4]: Another unused source
`;
    const issues = footnoteIntegrityRule.check(makeContentFile(body), engine);
    // Orphaned refs: [^3], [^5]
    // Orphaned defs: [^2], [^4]
    const orphanedRefs = issues.filter(i => i.message.includes('Orphaned footnote reference'));
    const orphanedDefs = issues.filter(i => i.message.includes('Orphaned footnote definition'));
    expect(orphanedRefs).toHaveLength(2);
    expect(orphanedDefs).toHaveLength(2);
  });

  it('recognizes footnote definitions without space after colon', () => {
    const body = `## Section

Claim here.[^1]

[^1]:Source without space (https://example.com)
`;
    const issues = footnoteIntegrityRule.check(makeContentFile(body), engine);
    // Should NOT report orphaned ref or def — the definition is valid
    expect(issues).toHaveLength(0);
  });
});
