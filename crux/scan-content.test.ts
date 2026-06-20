import { describe, it, expect } from 'vitest';
import { extractTextContent } from './scan-content.ts';

describe('extractTextContent (scan-content)', () => {
  it('removes paired JSX components with their content', () => {
    expect(extractTextContent('<Callout>hidden</Callout>\nprose').trim()).toBe('prose');
  });

  it('removes self-closing JSX components', () => {
    expect(extractTextContent('<Image src="x" />\nprose').trim()).toBe('prose');
  });

  it('strips spliced/nested markup to a fixed point (no <script bypass)', () => {
    const out = extractTextContent('<Sc<Script>x</Script>ript>body');
    expect(out).not.toContain('<Script');
    expect(out).not.toContain('</Script');
  });

  it('removes HTML comments and MDX expression comments', () => {
    expect(extractTextContent('a<!--secret-->b{/* c */}d').trim()).toBe('abd');
  });

  it('removes spliced HTML comments to a fixed point', () => {
    const out = extractTextContent('x<!--<!--y-->-->z');
    expect(out).not.toContain('<!--');
  });
});
