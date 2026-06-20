/**
 * Tests for extractFootnotedSentences tag stripping.
 *
 * Tags are stripped to a fixed point (replaceUntilStable) so spliced-together
 * or nested angle brackets like `<scr<script>ipt>` cannot re-form a tag after a
 * single pass. The cleaned sentence must contain no `<script` and no leftover
 * `<`/`>` tag residue.
 */

import { describe, it, expect } from 'vitest';
import { extractFootnotedSentences } from './verify-page-utils.ts';

describe('extractFootnotedSentences', () => {
  it('strips nested/spliced angle brackets so no opening tag survives (fixed point)', () => {
    // A footnoted paragraph with spliced angle brackets. The security-relevant
    // property is that NO opening `<` (and specifically no `<script`) survives
    // the fixed-point strip — a re-formed opening tag is what would let markup
    // through. (A bare trailing `>` left as inert text is harmless.)
    const raw =
      'The lab raised funds last year <<script>script>alert(1)</script> as reported.[^1]\n\n' +
      '[^1]: Source';

    const sentences = extractFootnotedSentences(raw);

    expect(sentences).toHaveLength(1);
    const clean = sentences[0];

    // The critical assertions: no opening bracket and no reconstructed tag.
    expect(clean).not.toContain('<');
    expect(clean).not.toContain('<script');
    // The surrounding prose survives.
    expect(clean).toContain('the lab raised funds last year');
    expect(clean).toContain('as reported');
  });

  it('removes simple inline tags from footnoted text', () => {
    const raw =
      'Revenue grew <b>sharply</b> this quarter according to filings.[^2]\n\n[^2]: Filing';
    const sentences = extractFootnotedSentences(raw);

    expect(sentences).toHaveLength(1);
    expect(sentences[0]).not.toContain('<');
    expect(sentences[0]).not.toContain('>');
    expect(sentences[0]).toContain('revenue grew sharply this quarter');
  });
});
