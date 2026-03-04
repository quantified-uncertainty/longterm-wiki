/**
 * Tests for statement extraction utilities.
 */

import { describe, it, expect } from 'vitest';
import { parseRcFootnotes, buildSectionFootnoteMap, generateSourceFactKey } from './extract.ts';
import { cleanMdxForExtraction, splitIntoSections } from '../claims/extract.ts';

describe('parseRcFootnotes', () => {
  it('extracts rc- footnote references from text', () => {
    const text = 'Anthropic raised $30B.[^rc-1068] Total funding is $67B.[^rc-d84a]';
    const refs = parseRcFootnotes(text);
    expect(refs).toEqual(['rc-1068', 'rc-d84a']);
  });

  it('deduplicates repeated references', () => {
    const text = 'Fact 1.[^rc-1068] Fact 2.[^rc-1068] Fact 3.[^rc-d84a]';
    const refs = parseRcFootnotes(text);
    expect(refs).toEqual(['rc-1068', 'rc-d84a']);
  });

  it('returns empty array for no references', () => {
    const text = 'Plain text without any footnotes.';
    const refs = parseRcFootnotes(text);
    expect(refs).toEqual([]);
  });

  it('ignores cr- references', () => {
    const text = 'With claim ref.[^cr-1234] And citation ref.[^rc-5678]';
    const refs = parseRcFootnotes(text);
    expect(refs).toEqual(['rc-5678']);
  });
});

describe('buildSectionFootnoteMap', () => {
  it('maps footnotes to their sections', () => {
    const raw = `## Overview

Anthropic is an AI safety company founded by former OpenAI researchers that develops the Claude model family.[^rc-d84a]

## History

Founded in 2021 by former members of OpenAI, including siblings Daniela and Dario Amodei.[^rc-953f] Chris Olah had led the interpretability team at OpenAI.[^rc-876f]`;

    const cleanBody = cleanMdxForExtraction(raw);
    const sections = splitIntoSections(cleanBody);
    const map = buildSectionFootnoteMap(cleanBody, raw, sections);

    expect(map.get('Overview')).toEqual(['rc-d84a']);
    expect(map.get('History')).toContain('rc-953f');
    expect(map.get('History')).toContain('rc-876f');
  });
});

describe('generateSourceFactKey', () => {
  it('generates a stable key for same input', () => {
    const key1 = generateSourceFactKey('anthropic', 'Revenue reached $14B.');
    const key2 = generateSourceFactKey('anthropic', 'Revenue reached $14B.');
    expect(key1).toBe(key2);
  });

  it('generates different keys for different text', () => {
    const key1 = generateSourceFactKey('anthropic', 'Revenue reached $14B.');
    const key2 = generateSourceFactKey('anthropic', 'Revenue reached $9B.');
    expect(key1).not.toBe(key2);
  });

  it('generates different keys for different entities', () => {
    const key1 = generateSourceFactKey('anthropic', 'Revenue reached $14B.');
    const key2 = generateSourceFactKey('openai', 'Revenue reached $14B.');
    expect(key1).not.toBe(key2);
  });

  it('follows entityId.hash format', () => {
    const key = generateSourceFactKey('anthropic', 'Test statement.');
    expect(key).toMatch(/^anthropic\.[0-9a-f]{8}$/);
  });
});
