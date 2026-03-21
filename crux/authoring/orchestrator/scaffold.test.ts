import { describe, it, expect } from 'vitest';
import { generateCreateScaffold } from './scaffold.ts';

describe('generateCreateScaffold', () => {
  it('generates valid MDX with frontmatter for a person', () => {
    const result = generateCreateScaffold('Buck Shlegeris', 'person', 'E46');

    // Check frontmatter
    expect(result).toContain('wikiId: E46');
    expect(result).toContain('title: "Buck Shlegeris"');
    expect(result).toContain('lastEdited:');
    expect(result).toContain('createdAt:');

    // Check imports
    expect(result).toContain("import {EntityLink, R, KBF, Calc, DataInfoBox, DataExternalLinks} from '@components/wiki'");

    // Check person-specific sections
    expect(result).toContain('## Overview');
    expect(result).toContain('## Background and Career');
    expect(result).toContain('## Key Work and Contributions');
    expect(result).toContain('## Views and Positions');
    expect(result).toContain('## Criticisms and Concerns');
    expect(result).toContain('## Key Uncertainties');
    expect(result).toContain('## Sources');
  });

  it('generates organization sections for org entity type', () => {
    const result = generateCreateScaffold('Anthropic', 'organization');

    expect(result).toContain('## History');
    expect(result).toContain('## Activities and Products');
    expect(result).toContain('## Funding and Financials');
    expect(result).toContain('## People');
    expect(result).not.toContain('wikiId:'); // No wikiId when not provided
  });

  it('falls back to default sections for unknown entity type', () => {
    const result = generateCreateScaffold('Some Topic', 'unknown-type');

    expect(result).toContain('## Overview');
    expect(result).toContain('## Background');
    expect(result).toContain('## Key Details');
    expect(result).toContain('## Criticisms and Concerns');
  });

  it('escapes quotes in topic title', () => {
    const result = generateCreateScaffold('The "AI Safety" Debate', 'concept');
    expect(result).toContain('title: "The \\"AI Safety\\" Debate"');
  });

  it('includes Quick Assessment table template for person', () => {
    const result = generateCreateScaffold('Test Person', 'person');
    expect(result).toContain('| Property | Value |');
    expect(result).toContain('| **Type** | person |');
  });

  it('includes Key Links table template', () => {
    const result = generateCreateScaffold('Test Person', 'person');
    expect(result).toContain('| Source | Link |');
    expect(result).toContain('| Wikipedia | {needs research} |');
  });
});
