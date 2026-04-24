import { describe, it, expect } from 'vitest';
import { buildReopenerTitle } from '../acceptance-reopener.ts';

describe('buildReopenerTitle', () => {
  it('produces a stable, deduplicatable title', () => {
    expect(buildReopenerTitle('anthropic', 'personnel')).toBe(
      'Coverage gap: anthropic - personnel',
    );
    expect(buildReopenerTitle('open-philanthropy', 'publications')).toBe(
      'Coverage gap: open-philanthropy - publications',
    );
  });

  it('uses ASCII hyphen (not em-dash) for Linear search compatibility', () => {
    const title = buildReopenerTitle('acme', 'grants');
    expect(title).not.toMatch(/[—–]/);
    expect(title).toContain(' - ');
  });

  it('is deterministic for identical inputs', () => {
    const a = buildReopenerTitle('acme', 'grants');
    const b = buildReopenerTitle('acme', 'grants');
    expect(a).toBe(b);
  });
});
