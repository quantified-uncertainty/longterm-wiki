/**
 * Tests for the auto-verify-stakeholders CLI command.
 *
 * Tests dry-run mode with real YAML data (no LLM or API calls needed).
 */

import { describe, it, expect } from 'vitest';
import { commands } from './auto-verify-stakeholders.ts';

describe('crux w auto-verify-stakeholders --dry-run', () => {
  it('lists stakeholders to verify across all policies', async () => {
    const result = await commands.verify([], { dryRun: true });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('Stakeholders to verify');
    expect(result.output).toContain('Position:');
    expect(result.output).toContain('Source:');
    expect(result.output).toContain('Thing ID:');
  });

  it('filters by policy ID', async () => {
    const result = await commands.verify([], {
      dryRun: true,
      policy: 'california-sb1047',
    });
    expect(result.exitCode).toBe(0);
    expect(result.output).toContain('california-sb1047');
    // Should NOT contain other policies
    expect(result.output).not.toContain('colorado-ai-act');
    expect(result.output).not.toContain('eu-ai-act');
  });

  it('returns error for nonexistent policy', async () => {
    const result = await commands.verify([], {
      dryRun: true,
      policy: 'nonexistent-policy-xyz',
    });
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('No policy entity found');
  });

  it('returns JSON in json mode', async () => {
    const result = await commands.verify([], {
      dryRun: true,
      policy: 'colorado-ai-act',
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(Array.isArray(data)).toBe(true);
    expect(data.length).toBeGreaterThan(0);
    expect(data[0]).toHaveProperty('policyId');
    expect(data[0]).toHaveProperty('stakeholderName');
    expect(data[0]).toHaveProperty('position');
    expect(data[0]).toHaveProperty('sourceUrl');
    expect(data[0]).toHaveProperty('thingId');
  });

  it('respects budget limit in dry-run', async () => {
    const result = await commands.verify([], {
      dryRun: true,
      budget: '3',
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output);
    expect(data.length).toBe(3);
  });

  it('generates thing IDs (placeholder in dry-run without server)', async () => {
    const result = await commands.verify([], {
      dryRun: true,
      policy: 'california-sb1047',
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output) as Array<{ thingId: string; stakeholderName: string }>;

    // In dry-run without wiki-server, thingId is a placeholder "policySlug:stakeholderName".
    // With a live wiki-server, it would be the canonical 10-char hash from the things table.
    const elonEntry = data.find((d) => d.stakeholderName === 'Elon Musk');
    expect(elonEntry).toBeDefined();
    expect(elonEntry!.thingId).toBeTruthy();

    const openaiEntry = data.find((d) => d.stakeholderName === 'OpenAI');
    expect(openaiEntry).toBeDefined();
    expect(openaiEntry!.thingId).toBeTruthy();
  });

  it('only includes stakeholders with source URLs', async () => {
    const result = await commands.verify([], {
      dryRun: true,
      policy: 'california-sb1047',
      json: true,
    });
    expect(result.exitCode).toBe(0);
    const data = JSON.parse(result.output) as Array<{ sourceUrl: string }>;

    // All entries should have source URLs
    for (const entry of data) {
      expect(entry.sourceUrl).toBeTruthy();
      expect(entry.sourceUrl).toMatch(/^https?:\/\//);
    }
  });

  it('default command is verify', async () => {
    // The default export should be the same as verify
    const defaultResult = await commands.default([], { dryRun: true, policy: 'colorado-ai-act', json: true });
    const verifyResult = await commands.verify([], { dryRun: true, policy: 'colorado-ai-act', json: true });
    expect(defaultResult.output).toBe(verifyResult.output);
  });
});
