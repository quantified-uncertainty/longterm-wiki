/**
 * Tests for crux/lib/sourcing/subject-identity-gate.ts (QUA-724).
 */

import { describe, it, expect } from 'vitest';
import {
  subjectIdentityGate,
  type SubjectIdentityCandidate,
} from './subject-identity-gate.ts';

const ANTHROPIC_QID = 'Q108542504';
const XAI_QID = 'Q117104853';

function cand(url: string, html?: string): SubjectIdentityCandidate {
  return html === undefined ? { url } : { url, html };
}

describe('subjectIdentityGate', () => {
  it('drops a candidate whose URL points at a different Wikidata entity', () => {
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates: [cand(`https://www.wikidata.org/wiki/${XAI_QID}`)],
    });
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].reason).toBe('subject-mismatch');
    expect(result.dropped[0].detail).toBe(`${XAI_QID} != ${ANTHROPIC_QID}`);
    expect(result.dropped[0].candidate.url).toBe(
      `https://www.wikidata.org/wiki/${XAI_QID}`,
    );
  });

  it('keeps a candidate whose URL points at the matching Wikidata entity', () => {
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates: [cand(`https://www.wikidata.org/wiki/${ANTHROPIC_QID}`)],
    });
    expect(result.dropped).toEqual([]);
    expect(result.kept).toHaveLength(1);
  });

  it('keeps non-Wikidata candidates with no HTML (URL alone is not enough to judge)', () => {
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates: [
        cand('https://www.reuters.com/some-article'),
        cand('https://techcrunch.com/anthropic-news'),
      ],
    });
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toEqual([]);
  });

  it('drops a non-Wikidata candidate whose HTML references a different Wikidata entity', () => {
    const html = `<html><head>
      <link rel="alternate" href="https://www.wikidata.org/wiki/${XAI_QID}">
    </head><body>...</body></html>`;
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates: [cand('https://example.com/x-launch', html)],
    });
    expect(result.kept).toEqual([]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].detail).toBe(`${XAI_QID} != ${ANTHROPIC_QID}`);
  });

  it('keeps a non-Wikidata candidate whose HTML references the matching Wikidata entity', () => {
    const html = `schema.org sameAs: https://www.wikidata.org/wiki/${ANTHROPIC_QID}`;
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates: [cand('https://example.com/anthropic-news', html)],
    });
    expect(result.dropped).toEqual([]);
    expect(result.kept).toHaveLength(1);
  });

  it('fail-open: keeps everything when entity QID is null', () => {
    const result = subjectIdentityGate({
      entityQid: null,
      candidates: [
        cand(`https://www.wikidata.org/wiki/${XAI_QID}`),
        cand('https://example.com/x'),
      ],
    });
    expect(result.kept).toHaveLength(2);
    expect(result.dropped).toEqual([]);
  });

  it('fail-open: keeps a candidate when neither URL nor HTML reveals a QID', () => {
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates: [
        cand('https://example.com/article', '<html>no wikidata reference</html>'),
      ],
    });
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });

  it('preserves order among kept candidates', () => {
    const candidates = [
      cand('https://a.com/'),
      cand(`https://www.wikidata.org/wiki/${XAI_QID}`),
      cand('https://b.com/'),
      cand(`https://www.wikidata.org/wiki/${ANTHROPIC_QID}`),
      cand('https://c.com/'),
    ];
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates,
    });
    expect(result.kept.map((c) => c.url)).toEqual([
      'https://a.com/',
      'https://b.com/',
      `https://www.wikidata.org/wiki/${ANTHROPIC_QID}`,
      'https://c.com/',
    ]);
    expect(result.dropped).toHaveLength(1);
    expect(result.dropped[0].candidate.url).toBe(
      `https://www.wikidata.org/wiki/${XAI_QID}`,
    );
  });

  it('handles an empty candidate list cleanly', () => {
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates: [],
    });
    expect(result.kept).toEqual([]);
    expect(result.dropped).toEqual([]);
  });

  it('preserves arbitrary candidate fields on kept and dropped items', () => {
    type Tagged = SubjectIdentityCandidate & { provider: string };
    const candidates: Tagged[] = [
      { url: 'https://a.com/', provider: 'exa' },
      { url: `https://www.wikidata.org/wiki/${XAI_QID}`, provider: 'perplexity' },
    ];
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates,
    });
    expect(result.kept[0].provider).toBe('exa');
    expect(result.dropped[0].candidate.provider).toBe('perplexity');
  });

  it('URL match takes precedence over HTML (does not waste an HTML scan)', () => {
    // If both signals are present and disagree, URL wins. This is a guard
    // against a candidate URL whose page body links to many other Wikidata
    // entries — the URL is the authoritative subject signal.
    const result = subjectIdentityGate({
      entityQid: ANTHROPIC_QID,
      candidates: [
        {
          url: `https://www.wikidata.org/wiki/${ANTHROPIC_QID}`,
          html: `noise: https://www.wikidata.org/wiki/${XAI_QID}`,
        },
      ],
    });
    expect(result.kept).toHaveLength(1);
    expect(result.dropped).toEqual([]);
  });
});
