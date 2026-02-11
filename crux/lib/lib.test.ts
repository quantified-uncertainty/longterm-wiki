import { describe, it, expect } from 'vitest';

import { findMdxFiles, findFiles, getDirectories } from './file-utils.ts';
import {
  parseFrontmatter,
  getContentBody,
  hasFrontmatter,
  extractH2Sections,
  extractHeadings,
  countWords,
  extractLinks,
} from './mdx-utils.ts';
import { getColors, createLogger, formatPath, formatCount } from './output.ts';
import {
  CONTENT_TYPES,
  getContentType,
  getStalenessThreshold,
  isIndexPage,
  extractEntityId,
  CONTENT_DIR,
} from './content-types.ts';

// =============================================================================
// file-utils.ts tests
// =============================================================================

describe('file-utils.ts', () => {
  it('findMdxFiles returns array', () => {
    const result = findMdxFiles('content/docs/knowledge-base/models');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length > 0).toBe(true);
    expect(result.every((f: string) => f.endsWith('.mdx') || f.endsWith('.md'))).toBe(true);
  });

  it('findMdxFiles handles non-existent directory', () => {
    const result = findMdxFiles('/nonexistent/path');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBe(0);
  });

  it('findFiles with extensions filter', () => {
    const result = findFiles('data', ['.yaml', '.yml']);
    expect(Array.isArray(result)).toBe(true);
    expect(result.length > 0).toBe(true);
    expect(result.every((f: string) => f.endsWith('.yaml') || f.endsWith('.yml'))).toBe(true);
  });

  it('getDirectories returns directories', () => {
    const result = getDirectories('content/docs/knowledge-base');
    expect(Array.isArray(result)).toBe(true);
    expect(result.length > 0).toBe(true);
  });
});

// =============================================================================
// mdx-utils.ts tests
// =============================================================================

describe('mdx-utils.ts', () => {
  const sampleMdx = `---
title: Test Page
description: A test description
quality: 3
---

## Overview

This is the overview section.

## Key Points

Some key points here.

### Subsection

A subsection with [a link](/path/to/page).
`;

  it('parseFrontmatter extracts YAML', () => {
    const result = parseFrontmatter(sampleMdx);
    expect(result.title).toBe('Test Page');
    expect(result.description).toBe('A test description');
    expect(result.quality).toBe(3);
  });

  it('parseFrontmatter handles missing frontmatter', () => {
    const result = parseFrontmatter('Just content, no frontmatter');
    expect(typeof result === 'object').toBe(true);
    expect(Object.keys(result).length).toBe(0);
  });

  it('getContentBody removes frontmatter', () => {
    const result = getContentBody(sampleMdx);
    expect(result.includes('---')).toBe(false);
    expect(result.includes('## Overview')).toBe(true);
  });

  it('hasFrontmatter detects frontmatter', () => {
    expect(hasFrontmatter(sampleMdx)).toBe(true);
    expect(hasFrontmatter('No frontmatter')).toBe(false);
  });

  it('extractH2Sections finds h2 headings', () => {
    const body = getContentBody(sampleMdx);
    const sections = extractH2Sections(body);
    expect(sections.length).toBe(2);
    expect(sections[0].title).toBe('Overview');
    expect(sections[1].title).toBe('Key Points');
  });

  it('extractHeadings finds all headings', () => {
    const body = getContentBody(sampleMdx);
    const headings = extractHeadings(body);
    expect(headings.length).toBe(3);
    expect(headings.some((h: any) => h.level === 2 && h.title === 'Overview')).toBe(true);
    expect(headings.some((h: any) => h.level === 3 && h.title === 'Subsection')).toBe(true);
  });

  it('countWords counts correctly', () => {
    const body = 'One two three four five.';
    expect(countWords(body)).toBe(5);
  });

  it('countWords excludes code blocks', () => {
    const body = 'Real words here.\n```\ncode block content\n```\nMore words.';
    const count = countWords(body);
    expect(count < 10).toBe(true);
  });

  it('extractLinks finds markdown links', () => {
    const body = getContentBody(sampleMdx);
    const links = extractLinks(body);
    expect(links.length).toBe(1);
    expect(links[0].url).toBe('/path/to/page');
    expect(links[0].text).toBe('a link');
  });
});

// =============================================================================
// output.ts tests
// =============================================================================

describe('output.ts', () => {
  it('getColors returns color object', () => {
    const colors = getColors(false);
    expect('red' in colors).toBe(true);
    expect('green' in colors).toBe(true);
    expect('reset' in colors).toBe(true);
    expect(colors.red.length > 0).toBe(true);
  });

  it('getColors returns empty in CI mode', () => {
    const colors = getColors(true);
    expect(colors.red).toBe('');
    expect(colors.green).toBe('');
  });

  it('createLogger returns logger object', () => {
    const logger = createLogger(true);
    expect(typeof logger.log === 'function').toBe(true);
    expect(typeof logger.error === 'function').toBe(true);
    expect(typeof logger.formatIssue === 'function').toBe(true);
  });

  it('formatPath removes cwd prefix', () => {
    const result = formatPath(process.cwd() + '/src/test.js');
    expect(result).toBe('src/test.js');
  });

  it('formatCount pluralizes correctly', () => {
    expect(formatCount(1, 'file')).toBe('1 file');
    expect(formatCount(2, 'file')).toBe('2 files');
    expect(formatCount(0, 'file')).toBe('0 files');
    expect(formatCount(2, 'entry', 'entries')).toBe('2 entries');
  });
});

// =============================================================================
// content-types.ts tests
// =============================================================================

describe('content-types.ts', () => {
  it('CONTENT_TYPES has expected types', () => {
    expect('model' in CONTENT_TYPES).toBe(true);
    expect('risk' in CONTENT_TYPES).toBe(true);
    expect('response' in CONTENT_TYPES).toBe(true);
  });

  it('getContentType identifies paths correctly', () => {
    expect(getContentType('/path/to/models/some-model.mdx')).toBe('model');
    expect(getContentType('/path/to/risks/some-risk.mdx')).toBe('risk');
    expect(getContentType('/path/to/responses/some-response.mdx')).toBe('response');
    expect(getContentType('/path/to/other/page.mdx')).toBe(null);
  });

  it('getStalenessThreshold returns thresholds', () => {
    const modelThreshold = getStalenessThreshold('model');
    const riskThreshold = getStalenessThreshold('risk');
    expect(typeof modelThreshold === 'number').toBe(true);
    expect(typeof riskThreshold === 'number').toBe(true);
    expect(modelThreshold).toBe(90);
    expect(riskThreshold).toBe(60);
  });

  it('isIndexPage detects index files', () => {
    expect(isIndexPage('/path/to/index.mdx')).toBe(true);
    expect(isIndexPage('/path/to/index.md')).toBe(true);
    expect(isIndexPage('/path/to/other.mdx')).toBe(false);
  });

  it('extractEntityId extracts filename', () => {
    expect(extractEntityId('/path/to/deceptive-alignment.mdx')).toBe('deceptive-alignment');
    expect(extractEntityId('/path/to/index.mdx')).toBe(null);
  });

  it('CONTENT_DIR is set correctly', () => {
    expect(CONTENT_DIR).toBe('content/docs');
  });
});
