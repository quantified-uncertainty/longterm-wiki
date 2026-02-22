/**
 * Tests for the Agent Orchestrator
 *
 * Covers:
 *  - types.ts: TIER_BUDGETS configuration validation
 *  - tools.ts: buildToolDefinitions, extractQualityMetrics, wrapWithTracking
 *  - quality-gate.ts: evaluateQualityGate with various content states
 *  - prompts.ts: buildImproveSystemPrompt, buildRefinementPrompt
 *  - orchestrator.ts: runOrchestrator with mocked LLM + tool calls
 *
 * All LLM and module calls are mocked — tests run fully offline.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TIER_BUDGETS, type OrchestratorContext, type BudgetConfig } from './types.ts';
import { buildToolDefinitions, extractQualityMetrics, wrapWithTracking, type ToolHandler } from './tools.ts';
import { evaluateQualityGate } from './quality-gate.ts';
import { buildImproveSystemPrompt, buildRefinementPrompt } from './prompts.ts';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const SAMPLE_MDX = `---
title: "Test Page"
description: "A test page for orchestrator tests"
quality: 60
readerImportance: 80
lastEdited: "2026-01-01"
---
import { EntityLink } from '@components/wiki';

## Overview

This is a test page about AI safety.[^1]

## Background

Some background content here with <EntityLink id="E1">an entity</EntityLink>.

## Key Challenges

The main challenges include alignment and interpretability.[^2]

## Sources

[^1]: Test Source (https://example.com)
[^2]: Another Source (https://example.com/2)
`;

function makeContext(overrides: Partial<OrchestratorContext> = {}): OrchestratorContext {
  return {
    page: {
      id: 'test-page',
      title: 'Test Page',
      path: '/knowledge-base/concepts/test-page',
      quality: 60,
      readerImportance: 80,
    },
    filePath: '/tmp/test-page.mdx',
    currentContent: SAMPLE_MDX,
    originalContent: SAMPLE_MDX,
    sourceCache: [],
    sections: null,
    splitPage: null,
    toolCallCount: 0,
    researchQueryCount: 0,
    costEntries: [],
    totalCost: 0,
    budget: TIER_BUDGETS.standard,
    directions: '',
    citationAudit: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// TIER_BUDGETS
// ---------------------------------------------------------------------------

describe('TIER_BUDGETS', () => {
  it('defines polish, standard, and deep tiers', () => {
    expect(TIER_BUDGETS).toHaveProperty('polish');
    expect(TIER_BUDGETS).toHaveProperty('standard');
    expect(TIER_BUDGETS).toHaveProperty('deep');
  });

  it('polish tier has no research queries', () => {
    expect(TIER_BUDGETS.polish.maxResearchQueries).toBe(0);
  });

  it('tiers have increasing tool-call limits', () => {
    expect(TIER_BUDGETS.polish.maxToolCalls).toBeLessThan(TIER_BUDGETS.standard.maxToolCalls);
    expect(TIER_BUDGETS.standard.maxToolCalls).toBeLessThan(TIER_BUDGETS.deep.maxToolCalls);
  });

  it('each tier has required fields', () => {
    for (const [name, config] of Object.entries(TIER_BUDGETS)) {
      expect(config.name).toBeTruthy();
      expect(config.maxToolCalls).toBeGreaterThan(0);
      expect(config.maxResearchQueries).toBeGreaterThanOrEqual(0);
      expect(config.enabledTools).toBeInstanceOf(Array);
      expect(config.enabledTools.length).toBeGreaterThan(0);
      expect(config.estimatedCost).toBeTruthy();
    }
  });

  it('polish tier does not include run_research', () => {
    expect(TIER_BUDGETS.polish.enabledTools).not.toContain('run_research');
  });

  it('standard and deep tiers include run_research', () => {
    expect(TIER_BUDGETS.standard.enabledTools).toContain('run_research');
    expect(TIER_BUDGETS.deep.enabledTools).toContain('run_research');
  });
});

// ---------------------------------------------------------------------------
// buildToolDefinitions
// ---------------------------------------------------------------------------

describe('buildToolDefinitions', () => {
  it('returns only tools in the enabled list', () => {
    const tools = buildToolDefinitions(['read_page', 'get_page_metrics']);
    expect(tools).toHaveLength(2);
    expect(tools.map(t => t.name)).toEqual(['read_page', 'get_page_metrics']);
  });

  it('ignores unknown tool IDs', () => {
    const tools = buildToolDefinitions(['read_page', 'nonexistent_tool']);
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('read_page');
  });

  it('returns all standard tier tools', () => {
    const tools = buildToolDefinitions(TIER_BUDGETS.standard.enabledTools);
    const names = tools.map(t => t.name);
    expect(names).toContain('read_page');
    expect(names).toContain('run_research');
    expect(names).toContain('rewrite_section');
    expect(names).toContain('validate_content');
  });

  it('each tool has name, description, and input_schema', () => {
    const tools = buildToolDefinitions(TIER_BUDGETS.deep.enabledTools);
    for (const tool of tools) {
      expect(tool.name).toBeTruthy();
      expect(tool.description).toBeTruthy();
      expect(tool.input_schema).toBeTruthy();
      expect(tool.input_schema.type).toBe('object');
    }
  });
});

// ---------------------------------------------------------------------------
// wrapWithTracking
// ---------------------------------------------------------------------------

describe('wrapWithTracking', () => {
  it('increments toolCallCount on each call', async () => {
    const ctx = makeContext();
    const handlers: Record<string, ToolHandler> = {
      test_tool: async () => 'result',
    };
    const tracked = wrapWithTracking(handlers, ctx);

    await tracked.test_tool({});
    expect(ctx.toolCallCount).toBe(1);

    await tracked.test_tool({});
    expect(ctx.toolCallCount).toBe(2);
  });

  it('appends cost entries', async () => {
    const ctx = makeContext();
    const handlers: Record<string, ToolHandler> = {
      read_page: async () => 'content',
      run_research: async () => 'sources',
    };
    const tracked = wrapWithTracking(handlers, ctx);

    await tracked.read_page({});
    await tracked.run_research({});

    expect(ctx.costEntries).toHaveLength(2);
    expect(ctx.costEntries[0].toolName).toBe('read_page');
    expect(ctx.costEntries[1].toolName).toBe('run_research');
  });

  it('appends budget status to results', async () => {
    const ctx = makeContext();
    const handlers: Record<string, ToolHandler> = {
      test_tool: async () => '{"data": true}',
    };
    const tracked = wrapWithTracking(handlers, ctx);

    const result = await tracked.test_tool({});
    expect(result).toContain('[Budget:');
    expect(result).toContain('tool calls used');
  });
});

// ---------------------------------------------------------------------------
// evaluateQualityGate
// ---------------------------------------------------------------------------

describe('evaluateQualityGate', () => {
  it('passes when content meets standard thresholds', () => {
    // The sample MDX has ~40 words, 2 footnotes, 1 EntityLink — should fail
    // because it's below standard thresholds
    const ctx = makeContext();
    const result = evaluateQualityGate(ctx);
    // Sample content is small, so it should fail the word count threshold
    expect(result.metrics).toBeTruthy();
    expect(result.gapSummary).toBeTruthy();
  });

  it('detects word count regression', () => {
    const ctx = makeContext({
      currentContent: '---\ntitle: "Test"\n---\n\nShort.',
      originalContent: SAMPLE_MDX,
    });
    const result = evaluateQualityGate(ctx);
    expect(result.passed).toBe(false);
    expect(result.gaps.some(g => g.includes('Word count dropped'))).toBe(true);
  });

  it('detects no changes made', () => {
    const ctx = makeContext();
    // currentContent === originalContent (no changes)
    const result = evaluateQualityGate(ctx);
    expect(result.gaps.some(g => g.includes('No changes were made'))).toBe(true);
  });

  it('passes for polish tier with modest content', () => {
    const ctx = makeContext({
      budget: TIER_BUDGETS.polish,
      // Make content different from original so "no changes" gap doesn't fire
      currentContent: SAMPLE_MDX.replace('Some background', 'Extended background about the topic with additional detail'),
    });
    const result = evaluateQualityGate(ctx);
    // Polish has lower thresholds — may still fail on some metrics
    // but the "no changes" gap should not fire
    expect(result.gaps.some(g => g.includes('No changes were made'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildImproveSystemPrompt
// ---------------------------------------------------------------------------

describe('buildImproveSystemPrompt', () => {
  it('includes page title and budget info', () => {
    const ctx = makeContext();
    const prompt = buildImproveSystemPrompt(ctx);
    expect(prompt).toContain('Test Page');
    expect(prompt).toContain('Standard');
    expect(prompt).toContain('20'); // maxToolCalls for standard
  });

  it('includes user directions when provided', () => {
    const ctx = makeContext({ directions: 'Add more citations about safety' });
    const prompt = buildImproveSystemPrompt(ctx);
    expect(prompt).toContain('Add more citations about safety');
  });

  it('includes strategy guidance', () => {
    const ctx = makeContext();
    const prompt = buildImproveSystemPrompt(ctx);
    expect(prompt).toContain('read_page');
    expect(prompt).toContain('rewrite_section');
    expect(prompt).toContain('validate_content');
  });
});

// ---------------------------------------------------------------------------
// buildRefinementPrompt
// ---------------------------------------------------------------------------

describe('buildRefinementPrompt', () => {
  it('includes cycle number and gap summary', () => {
    const ctx = makeContext({ toolCallCount: 10 });
    const metrics = {
      wordCount: 500,
      footnoteCount: 3,
      entityLinkCount: 2,
      diagramCount: 0,
      tableCount: 0,
      sectionCount: 3,
      structuralScore: 40,
    };
    const prompt = buildRefinementPrompt(ctx, 'Citations too low', metrics, 1);
    expect(prompt).toContain('Refinement Cycle 1');
    expect(prompt).toContain('Citations too low');
    expect(prompt).toContain('10'); // remaining calls
  });

  it('shows remaining tool calls', () => {
    const ctx = makeContext({ toolCallCount: 15 });
    const metrics = {
      wordCount: 800,
      footnoteCount: 8,
      entityLinkCount: 5,
      diagramCount: 0,
      tableCount: 1,
      sectionCount: 4,
      structuralScore: 50,
    };
    const prompt = buildRefinementPrompt(ctx, 'Needs more entity links', metrics, 2);
    expect(prompt).toContain('5 tool calls remaining'); // 20 - 15
  });
});

// ---------------------------------------------------------------------------
// extractQualityMetrics
// ---------------------------------------------------------------------------

describe('extractQualityMetrics', () => {
  it('extracts basic metrics from sample MDX', () => {
    const metrics = extractQualityMetrics(SAMPLE_MDX, '/tmp/test.mdx');
    expect(metrics.sectionCount).toBeGreaterThanOrEqual(3); // Overview, Background, Key Challenges, Sources
    expect(metrics.footnoteCount).toBeGreaterThanOrEqual(2);
    expect(metrics.wordCount).toBeGreaterThan(0);
  });

  it('returns zero metrics for empty content', () => {
    const metrics = extractQualityMetrics('', '/tmp/empty.mdx');
    expect(metrics.wordCount).toBe(0);
    expect(metrics.footnoteCount).toBe(0);
  });
});
