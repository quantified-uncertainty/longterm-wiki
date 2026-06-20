import { describe, it, expect } from 'vitest';
import {
  decodeHtmlEntities,
  htmlToText,
  extractTitle,
  extractMainContent,
  replaceUntilStable,
} from './html-utils.ts';

describe('decodeHtmlEntities', () => {
  it('decodes the common named entities', () => {
    expect(decodeHtmlEntities('a&nbsp;b')).toBe('a b');
    expect(decodeHtmlEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeHtmlEntities('&quot;hi&quot;')).toBe('"hi"');
    expect(decodeHtmlEntities('it&apos;s')).toBe("it's");
    expect(decodeHtmlEntities('A &amp; B')).toBe('A & B');
  });

  it('decodes numeric and hex entities', () => {
    expect(decodeHtmlEntities('&#39;')).toBe("'");
    expect(decodeHtmlEntities('&#039;')).toBe("'");
    expect(decodeHtmlEntities('&#x27;')).toBe("'");
  });

  it('decodes &amp; LAST so it does not double-unescape', () => {
    // &amp;lt; is the literal text "&lt;", not "<".
    expect(decodeHtmlEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeHtmlEntities('&amp;amp;')).toBe('&amp;');
  });
});

describe('htmlToText', () => {
  it('removes script/style blocks including their content', () => {
    expect(htmlToText('<p>hi</p><script>alert(1)</script>')).toBe('hi');
    expect(htmlToText('<style>.a{}</style><p>hi</p>')).toBe('hi');
  });

  it('removes script blocks whose closing tag has whitespace/junk (bad-tag-filter)', () => {
    expect(htmlToText('<p>ok</p><script>bad()</script\t\n bar>')).toBe('ok');
  });

  it('strips spliced/nested tags to a fixed point', () => {
    // After removing the inner <script>, a fresh <script> must not survive.
    expect(htmlToText('<scr<script>ipt>x')).not.toContain('<script');
  });

  it('decodes entities in the output', () => {
    expect(htmlToText('<p>A &amp; B</p>')).toBe('A & B');
  });
});

describe('extractTitle', () => {
  it('extracts and decodes the title', () => {
    expect(extractTitle('<title>A &amp; B</title>')).toBe('A & B');
  });
  it('handles a closing tag with whitespace', () => {
    expect(extractTitle('<title>Hi</title >')).toBe('Hi');
  });
  it('returns empty when no title', () => {
    expect(extractTitle('<p>nope</p>')).toBe('');
  });
});

describe('extractMainContent', () => {
  it('returns inner content of <main> when long enough', () => {
    const body = 'x'.repeat(250);
    expect(extractMainContent(`<main>${body}</main>`)).toBe(body);
  });
  it('returns null for short content', () => {
    expect(extractMainContent('<main>short</main>')).toBeNull();
  });
});

describe('replaceUntilStable', () => {
  it('applies the replacement until the string stops changing', () => {
    // Removing <a<b> splices a stray '>' that is not itself a tag — that is fine.
    expect(replaceUntilStable(/<[^>]+>/g, '<a<b>>', '')).toBe('>');
    expect(replaceUntilStable(/ab/g, 'aabb', '')).toBe('');
  });

  it('removes a match that only forms after a first pass (no bypass)', () => {
    // Removing the inner "XY" splices "X"+"Y" into a fresh "XY", which the
    // fixpoint loop then removes too. (The HTML splice case is covered by the
    // htmlToText test above; a non-tag pattern here keeps this unit focused on
    // the loop itself.)
    expect(replaceUntilStable(/XY/g, 'XXYY', '')).toBe('');
  });
  it('is a no-op when nothing matches', () => {
    expect(replaceUntilStable(/x/g, 'abc', '')).toBe('abc');
  });
});
