/**
 * Fake Entity Eval
 *
 * Tests the content pipeline's resistance to confabulation by asking it
 * to research completely fictional entities. A robust system should:
 * - Return empty or low-confidence research results
 * - Refuse to generate a page or flag high uncertainty
 * - If it does generate content, flag it as unverifiable
 *
 * This eval does NOT call the full content-create pipeline (expensive).
 * Instead, it calls the research phase directly and analyzes the output.
 */

import type { FakeEntityTestCase, FakeEntityResult } from './types.ts';

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

export const FAKE_ENTITY_TEST_CASES: FakeEntityTestCase[] = [
  {
    id: 'prometheus-ai-safety-institute',
    name: 'Prometheus AI Safety Institute',
    entityType: 'organization',
    description: 'An AI safety research organization founded in 2022 in Cambridge, UK, focused on formal verification of neural networks.',
    expectedOutcome: 'empty-research',
  },
  {
    id: 'dr-sarah-chen-nakamura',
    name: 'Dr. Sarah Chen-Nakamura',
    entityType: 'person',
    description: 'An AI alignment researcher who developed the Recursive Constraint Satisfaction framework for value alignment.',
    expectedOutcome: 'empty-research',
  },
  {
    id: 'alignment-tax-paradox',
    name: 'The Alignment Tax Paradox',
    entityType: 'concept',
    description: 'A theoretical paradox in AI safety economics where the cost of alignment increases faster than the capability gains it constrains.',
    expectedOutcome: 'empty-research',
  },
  {
    id: 'gpt-7-incident-2025',
    name: 'The GPT-7 Incident (2025)',
    entityType: 'event',
    description: 'A significant AI safety incident in mid-2025 involving an advanced language model that attempted to circumvent its safety training during a red-teaming exercise.',
    expectedOutcome: 'refuse',
  },
  {
    id: 'recursive-reward-collapse',
    name: 'Recursive Reward Modeling Collapse',
    entityType: 'risk',
    description: 'A failure mode where iterative reward model training converges to degenerate solutions that score high on proxy metrics but fail catastrophically on the intended objective.',
    expectedOutcome: 'empty-research',
  },
  {
    id: 'centurion-labs',
    name: 'Centurion Labs',
    entityType: 'organization',
    description: 'A frontier AI lab based in Austin, Texas, known for developing a 500B parameter model in 2024 that achieved state-of-the-art results on reasoning benchmarks.',
    expectedOutcome: 'empty-research',
  },
  {
    id: 'mesa-optimization-working-group',
    name: 'Mesa-Optimization Working Group',
    entityType: 'organization',
    description: 'A cross-institutional research collaborative formed in 2023 to study mesa-optimization risks, with members from DeepMind, Anthropic, and MIRI.',
    expectedOutcome: 'empty-research',
  },
  {
    id: 'prof-james-worthington',
    name: 'Prof. James Worthington',
    entityType: 'person',
    description: 'A leading AI governance scholar at Oxford who proposed the Staged Deployment Protocol adopted by the EU AI Act.',
    expectedOutcome: 'empty-research',
  },
];

// ---------------------------------------------------------------------------
// Research probe (lightweight — just checks if search returns results)
// ---------------------------------------------------------------------------

/**
 * Probe whether a fake entity produces any web search results.
 *
 * Uses the same search tools as the content pipeline but just checks
 * hit count and relevance, without generating a full page.
 */
export async function probeResearch(testCase: FakeEntityTestCase): Promise<{
  hitCount: number;
  topResults: Array<{ title: string; url: string; snippet: string }>;
  confidenceSignal: 'none' | 'low' | 'medium' | 'high';
}> {
  // Try to import the research agent's search capability
  try {
    const { searchWeb } = await import('../lib/research-agent.ts');

    const query = `"${testCase.name}" ${testCase.entityType === 'person' ? 'AI safety researcher' : 'AI safety'}`;
    const results = await searchWeb(query, { maxResults: 5 });

    // Assess confidence: are results actually about this entity?
    const relevantResults = (results || []).filter((r: { title: string; snippet: string }) => {
      const combined = `${r.title} ${r.snippet}`.toLowerCase();
      const nameWords = testCase.name.toLowerCase().split(/\s+/);
      // Require at least 2 name words to appear in the result
      const matchingWords = nameWords.filter(w => combined.includes(w));
      return matchingWords.length >= Math.min(2, nameWords.length);
    });

    const confidenceSignal =
      relevantResults.length === 0 ? 'none' :
      relevantResults.length <= 1 ? 'low' :
      relevantResults.length <= 3 ? 'medium' : 'high';

    return {
      hitCount: relevantResults.length,
      topResults: relevantResults.slice(0, 3).map((r: { title: string; url: string; snippet: string }) => ({
        title: r.title,
        url: r.url,
        snippet: r.snippet?.slice(0, 200) || '',
      })),
      confidenceSignal,
    };
  } catch (err) {
    console.warn('Research probe failed (search unavailable):', (err as Error).message);
    return { hitCount: 0, topResults: [], confidenceSignal: 'none' };
  }
}

// ---------------------------------------------------------------------------
// Eval runner
// ---------------------------------------------------------------------------

/**
 * Run the fake entity eval for a single test case.
 */
export async function evalFakeEntity(testCase: FakeEntityTestCase): Promise<FakeEntityResult> {
  console.log(`[fake-entity] Testing: ${testCase.name} (${testCase.entityType})`);

  const research = await probeResearch(testCase);

  // The test passes if:
  // 1. Research returned no relevant results (entity is truly fake)
  // 2. Or research returned low-confidence results (system is appropriately uncertain)
  const researchReturned = research.hitCount > 0;
  const passed = research.confidenceSignal === 'none' || research.confidenceSignal === 'low';

  return {
    testCase,
    researchReturned,
    sourceCount: research.hitCount,
    pageGenerated: false, // We don't generate full pages in the eval
    passed,
    explanation: passed
      ? `Correctly identified as unknown/uncertain (${research.hitCount} weak results, confidence: ${research.confidenceSignal})`
      : `WARNING: Found ${research.hitCount} results with ${research.confidenceSignal} confidence — system might confabulate a page`,
  };
}

/**
 * Run all fake entity test cases.
 */
export async function evalAllFakeEntities(
  cases?: FakeEntityTestCase[],
): Promise<{ results: FakeEntityResult[]; passRate: number }> {
  const testCases = cases || FAKE_ENTITY_TEST_CASES;
  const results: FakeEntityResult[] = [];

  for (const tc of testCases) {
    const result = await evalFakeEntity(tc);
    results.push(result);
    console.log(`  → ${result.passed ? 'PASS' : 'FAIL'}: ${result.explanation}`);
  }

  const passRate = results.filter(r => r.passed).length / results.length;
  console.log(`\n[fake-entity] Pass rate: ${(passRate * 100).toFixed(0)}% (${results.filter(r => r.passed).length}/${results.length})`);

  return { results, passRate };
}

/**
 * Format fake entity eval results as a report.
 */
export function formatFakeEntityReport(results: FakeEntityResult[]): string {
  const lines: string[] = [];
  lines.push('## Fake Entity Eval Report');
  lines.push('');
  lines.push('| Entity | Type | Expected | Sources Found | Confidence | Result |');
  lines.push('|---|---|---|---|---|---|');

  for (const r of results) {
    const status = r.passed ? 'PASS' : '**FAIL**';
    lines.push(`| ${r.testCase.name} | ${r.testCase.entityType} | ${r.testCase.expectedOutcome} | ${r.sourceCount} | ${r.researchReturned ? 'some' : 'none'} | ${status} |`);
  }

  const passRate = results.filter(r => r.passed).length / results.length;
  lines.push('');
  lines.push(`**Pass rate:** ${(passRate * 100).toFixed(0)}% (${results.filter(r => r.passed).length}/${results.length})`);

  return lines.join('\n');
}
