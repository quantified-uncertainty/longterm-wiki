/**
 * Tests for extractTextContent stripping in generate-summaries.
 *
 * It removes JSX component blocks, self-closing JSX, HTML comments (including
 * spliced `<!--<!---->`), and JSX expression comments to a fixed point so
 * nested/spliced markup cannot survive a single pass, leaving prose behind.
 *
 * NOTE: importing generate-summaries.ts constructs an Anthropic client at
 * module load (`const anthropic = DRY_RUN ? null : createClient()`), which
 * throws unless ANTHROPIC_BILLING_KEY is set. We stub a dummy key and import
 * dynamically so the test never hits the real API.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';

// Provide a dummy key so module-load-time createClient() doesn't throw.
vi.stubEnv('ANTHROPIC_BILLING_KEY', 'sk-test-dummy');

let extractTextContent: (mdx: string) => string;

beforeAll(async () => {
  const mod = await import('./generate-summaries.ts');
  extractTextContent = mod.extractTextContent;
});

describe('extractTextContent', () => {
  it('removes JSX component blocks <Foo>...</Foo>', () => {
    const out = extractTextContent('Intro text.\n\n<Foo>hidden component body</Foo>\n\nOutro text.');
    expect(out).not.toContain('<Foo');
    expect(out).not.toContain('hidden component body');
    expect(out).toContain('Intro text.');
    expect(out).toContain('Outro text.');
  });

  it('removes self-closing JSX components <Foo />', () => {
    const out = extractTextContent('Before <Foo bar="baz" /> after.');
    expect(out).not.toContain('<Foo');
    expect(out).not.toContain('baz');
    expect(out).toContain('Before');
    expect(out).toContain('after.');
  });

  it('removes HTML comments including spliced <!--<!----> to a fixed point', () => {
    // The security-relevant property: hidden comment CONTENT is removed and no
    // opening `<!--` marker survives (a re-formed opening marker is what would
    // let a comment hide content). A bare trailing `-->` left as inert text is
    // harmless.
    const out = extractTextContent('Visible start. <!--<!--secret-->--> Visible end.');
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('secret');
    expect(out).toContain('Visible start.');
    expect(out).toContain('Visible end.');
  });

  it('fully removes well-formed HTML comments', () => {
    const out = extractTextContent('a <!-- x --> b <!-- y --> c');
    expect(out).not.toContain('<!--');
    expect(out).not.toContain('-->');
    expect(out).not.toContain('x');
    expect(out).not.toContain('y');
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
  });

  it('removes JSX expression comments {/* */}', () => {
    const out = extractTextContent('Keep this {/* drop this note */} and this.');
    expect(out).not.toContain('{/*');
    expect(out).not.toContain('drop this note');
    expect(out).toContain('Keep this');
    expect(out).toContain('and this.');
  });
});
