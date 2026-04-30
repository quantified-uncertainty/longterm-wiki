/**
 * Integration test for the source-discover engine — QUA-926.
 *
 * Runs ONE real end-to-end discovery call against the Anthropic API. Skipped
 * unless RUN_INTEGRATION=1 is set, so `pnpm test` doesn't burn credits.
 *
 * To run:
 *
 *   ANTHROPIC_BILLING_KEY=<key> RUN_INTEGRATION=1 pnpm vitest run \
 *     --config crux/vitest.config.ts \
 *     crux/lib/sourcing/source-discover-integration.test.ts
 *
 * Cost: ~$0.05 per call (Sonnet + a few web_search invocations).
 */
import dotenv from 'dotenv';
import { resolve } from 'path';

dotenv.config({ path: resolve(import.meta.dirname, '../../../.env') });

import { describe, it, expect } from 'vitest';
import { discoverSourceForFact } from './source-discover.ts';
import type { Entity, Fact, Property } from '../../../packages/factbase/src/types.ts';

const RUN_INTEGRATION = process.env.RUN_INTEGRATION === '1';
const HAVE_KEY = Boolean(process.env.ANTHROPIC_BILLING_KEY);

describe.skipIf(!RUN_INTEGRATION || !HAVE_KEY)('source-discover integration (real LLM call)', () => {
  it('returns at least one candidate with a valid URL for a well-known fact', async () => {
    // Use a well-known fact: Anthropic's founding year. This should be
    // trivially findable via web search and gives the engine a high-signal
    // input to score against.
    const entity: Entity = {
      id: 'mK9pX3rQ7n',
      stableId: 'mK9pX3rQ7n',
      type: 'organization',
      name: 'Anthropic',
    };
    const fact: Fact = {
      id: 'f_integration_test_founded',
      subjectId: entity.id,
      propertyId: 'founded',
      value: { type: 'date', value: '2021' },
      asOf: '2021',
    };
    const property: Property = {
      id: 'founded',
      name: 'Founded',
      description: 'Year the entity was founded',
      dataType: 'date',
      verifiable: true,
    };

    const result = await discoverSourceForFact(
      { entity, fact, property, formattedValue: '2021' },
      { maxWebSearchUses: 2, maxTokens: 1500 },
    );

    expect(result.candidates.length).toBeGreaterThan(0);
    for (const c of result.candidates) {
      expect(c.url).toMatch(/^https?:\/\//);
      expect(c.confidence).toBeGreaterThanOrEqual(0);
      expect(c.confidence).toBeLessThanOrEqual(1);
    }
    expect(result.costUsd).toBeGreaterThan(0);
    // For this trivially-true fact, we expect at least one strong candidate.
    expect(result.best).not.toBeNull();
  }, 90_000);
});
