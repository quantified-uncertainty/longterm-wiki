import { describe, it, expect } from 'vitest';
import { extractBlockIR } from './block-ir.ts';
import type { PageBlockIR, SectionBlock } from './block-ir.ts';

// ---------------------------------------------------------------------------
// Fixture: a realistic MDX page with multiple features
// ---------------------------------------------------------------------------

const FIXTURE_MDX = `---
title: Test Organization
entityType: organization
quality: 7
---

<DataInfoBox entityId="test-org" />

This is the preamble paragraph with an <EntityLink id="anthropic">Anthropic</EntityLink> reference.

## Overview

Test Organization is a research lab founded in 2020[^1]. It works on
<EntityLink id="alignment">alignment research</EntityLink> and has received
<F e="test-org" f="total-funding" /> in total funding.

Key metrics are shown below:

| Metric | Value |
|--------|-------|
| Employees | <F e="test-org" f="employee-count" /> |
| Founded | 2020 |
| Focus | <EntityLink id="ai-safety">AI Safety</EntityLink> |

For more details, see [the MIRI page](/knowledge-base/organizations/miri/) and
[their website](https://example.com).

## Key Research

The lab has published several papers[^2][^3] on <EntityLink id="interpretability">interpretability</EntityLink>.

<SquiggleEstimate title="Research Output" code={\`
researchPapers = 50 to 100
\`} />

## Governance

<MermaidDiagram code="graph TD; A-->B" />

The governance structure involves <EntityLink id="board-oversight">board oversight</EntityLink>.

## Quantitative Analysis

<Calc expr="100 * 1.5" label="Growth rate" />

This section has a <Callout type="info">Notable finding</Callout> about growth.

<EntityLink id="anthropic">Anthropic</EntityLink> is a peer organization.

[^1]: Source One (2023). "Research Overview." https://example.com/source1
[^2]: Source Two (2024). "Interpretability Paper." https://example.com/source2
[^3]: Source Three (2024). "Safety Methods." https://example.com/source3
`;

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('extractBlockIR', () => {
  it('extracts sections from headings with preamble', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    expect(ir.pageId).toBe('test-org');

    // Preamble + 4 H2 sections
    expect(ir.sections.length).toBe(5);
    expect(ir.sections[0].heading).toBe('__preamble__');
    expect(ir.sections[0].level).toBe(0);
    expect(ir.sections[0].headingId).toBe('__preamble__');

    expect(ir.sections[1].heading).toBe('Overview');
    expect(ir.sections[1].level).toBe(2);
    expect(ir.sections[1].headingId).toBe('overview');

    expect(ir.sections[2].heading).toBe('Key Research');
    expect(ir.sections[2].headingId).toBe('key-research');

    expect(ir.sections[3].heading).toBe('Governance');
    expect(ir.sections[3].headingId).toBe('governance');

    expect(ir.sections[4].heading).toBe('Quantitative Analysis');
    expect(ir.sections[4].headingId).toBe('quantitative-analysis');
  });

  it('assigns EntityLinks to the correct section', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    // Preamble has EntityLink to "anthropic"
    expect(ir.sections[0].entityLinks).toContain('anthropic');

    // Overview has "alignment" and "ai-safety" (from table)
    expect(ir.sections[1].entityLinks).toContain('alignment');
    expect(ir.sections[1].entityLinks).toContain('ai-safety');

    // Key Research has "interpretability"
    expect(ir.sections[2].entityLinks).toContain('interpretability');

    // Governance has "board-oversight"
    expect(ir.sections[3].entityLinks).toContain('board-oversight');

    // Quantitative Analysis has "anthropic"
    expect(ir.sections[4].entityLinks).toContain('anthropic');
  });

  it('extracts fact references per section', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    // Overview has total-funding and employee-count (from table)
    const overviewFacts = ir.sections[1].facts;
    expect(overviewFacts.length).toBe(2);
    expect(overviewFacts).toContainEqual(
      expect.objectContaining({ entityId: 'test-org', factId: 'total-funding' }),
    );
    expect(overviewFacts).toContainEqual(
      expect.objectContaining({ entityId: 'test-org', factId: 'employee-count' }),
    );

    // Other sections have no facts
    expect(ir.sections[2].facts.length).toBe(0);
  });

  it('extracts footnote references per section', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    // Overview has footnote 1
    expect(ir.sections[1].footnoteRefs).toContain('1');

    // Key Research has footnotes 2 and 3
    expect(ir.sections[2].footnoteRefs).toContain('2');
    expect(ir.sections[2].footnoteRefs).toContain('3');
  });

  it('detects tables with entity links in cells', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    // Overview has one table
    expect(ir.sections[1].tables.length).toBe(1);
    const table = ir.sections[1].tables[0];
    expect(table.headers).toEqual(['Metric', 'Value']);
    expect(table.rowCount).toBe(3);
    expect(table.entityLinksInCells).toContain('ai-safety');
    expect(table.factsInCells).toContainEqual(
      expect.objectContaining({ entityId: 'test-org', factId: 'employee-count' }),
    );
  });

  it('detects component flags per section', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    // Key Research has SquiggleEstimate
    expect(ir.sections[2].hasSquiggle).toBe(true);
    expect(ir.sections[2].hasMermaid).toBe(false);

    // Governance has MermaidDiagram
    expect(ir.sections[3].hasMermaid).toBe(true);
    expect(ir.sections[3].hasSquiggle).toBe(false);

    // Quantitative Analysis has Calc
    expect(ir.sections[4].hasCalc).toBe(true);
  });

  it('aggregates page-level component counts', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    expect(ir.components.squiggleCount).toBe(1);
    expect(ir.components.mermaidCount).toBe(1);
    expect(ir.components.calcCount).toBe(1);
    expect(ir.components.calloutCount).toBe(1);
    expect(ir.components.dataInfoBoxCount).toBe(1);
    expect(ir.components.totalTables).toBe(1);
  });

  it('counts words per section (non-zero for content sections)', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    // Preamble has "This is the preamble paragraph with an Anthropic reference."
    expect(ir.sections[0].wordCount).toBeGreaterThan(5);

    // Overview has substantial text
    expect(ir.sections[1].wordCount).toBeGreaterThan(10);

    // Every section should have at least some words
    for (const section of ir.sections.slice(1)) {
      expect(section.wordCount).toBeGreaterThan(0);
    }
  });

  it('extracts internal and external links', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    // Overview has internal link to MIRI and external link to example.com
    expect(ir.sections[1].internalLinks).toContain('organizations/miri');
    expect(ir.sections[1].externalLinks).toContain('https://example.com');
  });

  it('handles line numbers correctly', () => {
    const ir = extractBlockIR('test-org', FIXTURE_MDX);

    // Preamble starts at line 1
    expect(ir.sections[0].startLine).toBe(1);

    // Each section starts after the previous one
    for (let i = 1; i < ir.sections.length; i++) {
      expect(ir.sections[i].startLine).toBeGreaterThan(ir.sections[i - 1].startLine);
    }

    // Last section ends at or near the total line count
    const totalLines = FIXTURE_MDX.split('\n').length;
    const lastSection = ir.sections[ir.sections.length - 1];
    expect(lastSection.endLine).toBe(totalLines);
  });

  it('handles page with no headings (preamble only)', () => {
    const mdx = `---
title: Simple Page
---

Just a simple page with no headings. It has an <EntityLink id="foo">entity link</EntityLink>.
`;
    const ir = extractBlockIR('simple', mdx);

    expect(ir.sections.length).toBe(1);
    expect(ir.sections[0].heading).toBe('__preamble__');
    expect(ir.sections[0].entityLinks).toContain('foo');
    expect(ir.sections[0].wordCount).toBeGreaterThan(0);
  });

  it('handles empty content gracefully', () => {
    const ir = extractBlockIR('empty', '');

    expect(ir.pageId).toBe('empty');
    expect(ir.sections.length).toBe(1); // preamble always exists
    expect(ir.sections[0].heading).toBe('__preamble__');
    expect(ir.sections[0].wordCount).toBe(0);
  });

  it('handles MDX with only frontmatter', () => {
    const mdx = `---
title: Frontmatter Only
---
`;
    const ir = extractBlockIR('fm-only', mdx);

    expect(ir.sections.length).toBe(1);
    expect(ir.sections[0].wordCount).toBe(0);
  });

  it('deduplicates entity links within a section', () => {
    const mdx = `## Test Section

<EntityLink id="foo">Foo</EntityLink> and <EntityLink id="foo">Foo again</EntityLink> and <EntityLink id="bar">Bar</EntityLink>
`;
    const ir = extractBlockIR('dedup', mdx);

    const section = ir.sections.find(s => s.heading === 'Test Section')!;
    expect(section.entityLinks).toHaveLength(2);
    expect(section.entityLinks).toContain('foo');
    expect(section.entityLinks).toContain('bar');
  });

  it('deduplicates fact references within a section', () => {
    const mdx = `## Test Section

<F e="org" f="metric1" /> and <F e="org" f="metric1" /> and <F e="org" f="metric2" />
`;
    const ir = extractBlockIR('dedup-facts', mdx);

    const section = ir.sections.find(s => s.heading === 'Test Section')!;
    expect(section.facts).toHaveLength(2);
  });

  it('extracts entity links nested inside JSX components', () => {
    const mdx = `## Nested JSX

<Callout type="warning">
  Some text with <EntityLink id="nested-entity">nested</EntityLink> entity.
  Also a fact: <F e="org" f="revenue" />
</Callout>
`;
    const ir = extractBlockIR('nested-jsx', mdx);

    const section = ir.sections.find(s => s.heading === 'Nested JSX')!;
    expect(section.entityLinks).toContain('nested-entity');
    expect(section.facts).toContainEqual(
      expect.objectContaining({ entityId: 'org', factId: 'revenue' }),
    );
  });

  it('does not split on ## inside code fences', () => {
    const mdx = `## Real Section

Some text before code.

\`\`\`python
## This is a comment, not a heading
def foo():
    pass
\`\`\`

More text after code.
`;
    const ir = extractBlockIR('code-fence', mdx);

    // Should have preamble + 1 real section (not split on code comment)
    const h2Sections = ir.sections.filter(s => s.level === 2);
    expect(h2Sections).toHaveLength(1);
    expect(h2Sections[0].heading).toBe('Real Section');
  });

  it('handles internal links outside knowledge-base', () => {
    const mdx = `## Links

See [compute page](/ai-transition-model/compute/) and [overview](/knowledge-base/concepts/overview/).
`;
    const ir = extractBlockIR('links-test', mdx);

    const section = ir.sections.find(s => s.heading === 'Links')!;
    expect(section.internalLinks).toContain('ai-transition-model/compute');
    expect(section.internalLinks).toContain('concepts/overview');
  });

  it('counts words in table cells', () => {
    const mdx = `## Table Section

| Column A | Column B |
|----------|----------|
| one two three | four five six |
| seven eight | nine ten |
`;
    const ir = extractBlockIR('table-words', mdx);

    const section = ir.sections.find(s => s.heading === 'Table Section')!;
    // Table has cell text counted. extractText gets all text nodes from the table.
    // Exact count depends on how remark-gfm structures the AST, but should be > 0.
    expect(section.wordCount).toBeGreaterThan(0);
    // Should have at least the heading words + some table text
    expect(section.wordCount).toBeGreaterThanOrEqual(8);
  });

  it('remark-mdx throws on malformed MDX (caught by build script)', () => {
    // Malformed JSX — unclosed tag. remark-mdx throws a parse error.
    // The build script's try/catch handles this per page (non-fatal).
    const mdx = `## Section

<EntityLink id="test"
`;
    expect(() => extractBlockIR('parse-error', mdx)).toThrow();
  });
});
