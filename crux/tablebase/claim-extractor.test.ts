import { describe, it, expect } from 'vitest';
import {
  buildExtractionPrompt,
  parseClaimsResponse,
  type UnverifiableRecord,
} from './claim-extractor.ts';

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const sampleRecords: UnverifiableRecord[] = [
  {
    recordType: 'personnel',
    recordId: 'rec-001',
    fieldName: 'title',
    displayName: 'Personnel: Alice Smith at Anthropic (Research Scientist)',
    reasoning: 'No source found for this role',
    entityId: 'anthropic',
  },
  {
    recordType: 'personnel',
    recordId: 'rec-002',
    fieldName: 'startDate',
    displayName: 'Personnel: Bob Jones at Anthropic (VP Engineering)',
    reasoning: 'Could not verify employment dates',
    entityId: 'anthropic',
  },
  {
    recordType: 'grant',
    recordId: 'rec-003',
    fieldName: null,
    displayName: 'Grant: $5M from Open Philanthropy',
    reasoning: 'Source URL is dead',
    entityId: 'anthropic',
  },
];

// ---------------------------------------------------------------------------
// buildExtractionPrompt
// ---------------------------------------------------------------------------

describe('buildExtractionPrompt', () => {
  it('includes source content and URL', () => {
    const prompt = buildExtractionPrompt(
      'Alice Smith joined Anthropic as Research Scientist in 2024.',
      'https://example.com/team',
      sampleRecords,
    );

    expect(prompt).toContain('https://example.com/team');
    expect(prompt).toContain('Alice Smith joined Anthropic');
  });

  it('includes all record IDs in the prompt', () => {
    const prompt = buildExtractionPrompt(
      'Some content',
      'https://example.com',
      sampleRecords,
    );

    expect(prompt).toContain('rec-001');
    expect(prompt).toContain('rec-002');
    expect(prompt).toContain('rec-003');
  });

  it('includes record type and displayName', () => {
    const prompt = buildExtractionPrompt(
      'Some content',
      'https://example.com',
      sampleRecords,
    );

    expect(prompt).toContain('type="personnel"');
    expect(prompt).toContain('type="grant"');
    expect(prompt).toContain('Alice Smith at Anthropic');
  });

  it('escapes XML-special characters in content', () => {
    const prompt = buildExtractionPrompt(
      'Revenue was <$100M & growing > 50%',
      'https://example.com/report?q=a&b=c',
      [sampleRecords[0]],
    );

    // Content should be escaped
    expect(prompt).toContain('&lt;$100M');
    expect(prompt).toContain('&amp; growing');
    expect(prompt).toContain('&gt; 50%');
    // URL in attribute should also be escaped
    expect(prompt).toContain('q=a&amp;b=c');
  });

  it('truncates very long content', () => {
    const longContent = 'x'.repeat(10_000);
    const prompt = buildExtractionPrompt(
      longContent,
      'https://example.com',
      [sampleRecords[0]],
    );

    expect(prompt).toContain('[... truncated]');
    // The content portion should be capped (8000 chars + truncation marker)
    expect(prompt.length).toBeLessThan(longContent.length + 2000);
  });

  it('handles records with null fields gracefully', () => {
    const record: UnverifiableRecord = {
      recordType: 'grant',
      recordId: 'rec-100',
      fieldName: null,
      displayName: null,
      reasoning: null,
      entityId: null,
    };

    const prompt = buildExtractionPrompt('Some content', 'https://example.com', [record]);
    expect(prompt).toContain('rec-100');
    expect(prompt).toContain('type="grant"');
    // Should not contain empty attributes
    expect(prompt).not.toContain('displayName=""');
  });

  it('includes reasoning when present', () => {
    const prompt = buildExtractionPrompt(
      'Some content',
      'https://example.com',
      sampleRecords,
    );

    expect(prompt).toContain('<reasoning>No source found for this role</reasoning>');
  });
});

// ---------------------------------------------------------------------------
// parseClaimsResponse
// ---------------------------------------------------------------------------

describe('parseClaimsResponse', () => {
  it('parses a valid JSON array response', () => {
    const raw = JSON.stringify([
      {
        claimText: 'Alice Smith is a Research Scientist at Anthropic.',
        targetField: 'title',
        proposedValue: 'Research Scientist',
        recordIds: ['rec-001'],
      },
      {
        claimText: 'Bob Jones joined Anthropic in January 2023.',
        targetField: 'startDate',
        proposedValue: '2023-01',
        recordIds: ['rec-002'],
      },
    ]);

    const claims = parseClaimsResponse(raw);
    expect(claims).toHaveLength(2);

    expect(claims[0].claimText).toBe('Alice Smith is a Research Scientist at Anthropic.');
    expect(claims[0].targetField).toBe('title');
    expect(claims[0].proposedValue).toBe('Research Scientist');
    expect(claims[0].matchedRecordIds).toEqual(['rec-001']);

    expect(claims[1].claimText).toBe('Bob Jones joined Anthropic in January 2023.');
    expect(claims[1].targetField).toBe('startDate');
    expect(claims[1].proposedValue).toBe('2023-01');
    expect(claims[1].matchedRecordIds).toEqual(['rec-002']);
  });

  it('handles claims with null optional fields', () => {
    const raw = JSON.stringify([
      {
        claimText: 'Anthropic received a $5M grant.',
        targetField: null,
        proposedValue: null,
        recordIds: ['rec-003'],
      },
    ]);

    const claims = parseClaimsResponse(raw);
    expect(claims).toHaveLength(1);
    expect(claims[0].targetField).toBeNull();
    expect(claims[0].proposedValue).toBeNull();
  });

  it('handles claims with missing optional fields', () => {
    const raw = JSON.stringify([
      {
        claimText: 'A factual claim.',
        recordIds: ['rec-001'],
      },
    ]);

    const claims = parseClaimsResponse(raw);
    expect(claims).toHaveLength(1);
    expect(claims[0].targetField).toBeNull();
    expect(claims[0].proposedValue).toBeNull();
  });

  it('extracts JSON from markdown-fenced response', () => {
    const raw = `Here are the claims I found:

\`\`\`json
[
  {
    "claimText": "Alice is a scientist.",
    "targetField": "title",
    "proposedValue": "scientist",
    "recordIds": ["rec-001"]
  }
]
\`\`\``;

    const claims = parseClaimsResponse(raw);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimText).toBe('Alice is a scientist.');
  });

  it('returns empty array for non-JSON response', () => {
    const claims = parseClaimsResponse('I could not find any relevant claims in this source.');
    expect(claims).toEqual([]);
  });

  it('returns empty array for malformed JSON', () => {
    const claims = parseClaimsResponse('[{bad json}]');
    expect(claims).toEqual([]);
  });

  it('returns empty array for empty string', () => {
    const claims = parseClaimsResponse('');
    expect(claims).toEqual([]);
  });

  it('skips invalid items but keeps valid ones (partial extraction)', () => {
    // One valid, one missing required claimText
    const raw = JSON.stringify([
      {
        claimText: 'Valid claim.',
        recordIds: ['rec-001'],
      },
      {
        targetField: 'title',
        recordIds: ['rec-002'],
        // Missing claimText — invalid
      },
      {
        claimText: 'Another valid claim.',
        recordIds: ['rec-003'],
      },
    ]);

    const claims = parseClaimsResponse(raw);
    expect(claims).toHaveLength(2);
    expect(claims[0].claimText).toBe('Valid claim.');
    expect(claims[1].claimText).toBe('Another valid claim.');
  });

  it('skips items with empty recordIds', () => {
    const raw = JSON.stringify([
      {
        claimText: 'Orphan claim with no records.',
        recordIds: [],
      },
      {
        claimText: 'Valid claim.',
        recordIds: ['rec-001'],
      },
    ]);

    const claims = parseClaimsResponse(raw);
    expect(claims).toHaveLength(1);
    expect(claims[0].claimText).toBe('Valid claim.');
  });

  it('handles claims referencing multiple records', () => {
    const raw = JSON.stringify([
      {
        claimText: 'Anthropic team page lists both Alice and Bob.',
        targetField: null,
        proposedValue: null,
        recordIds: ['rec-001', 'rec-002'],
      },
    ]);

    const claims = parseClaimsResponse(raw);
    expect(claims).toHaveLength(1);
    expect(claims[0].matchedRecordIds).toEqual(['rec-001', 'rec-002']);
  });
});
