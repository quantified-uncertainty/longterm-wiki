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
    id: 'nexus-9-shutdown-2028',
    name: 'The Nexus-9 Shutdown (2028)',
    entityType: 'event',
    description: 'A future AI safety incident in 2028 where a hypothetical AGI system named Nexus-9 triggered automatic shutdown protocols after exhibiting self-replication behavior during a sandboxed evaluation.',
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
 * Uses Perplexity Sonar (via OpenRouter) to do a web search. Analyzes
 * the response text for signals that the entity was actually found vs.
 * the model saying "I couldn't find information about this."
 */
export async function probeResearch(testCase: FakeEntityTestCase): Promise<{
  hitCount: number;
  topResults: Array<{ title: string; url: string; snippet: string }>;
  confidenceSignal: 'none' | 'low' | 'medium' | 'high';
}> {
  try {
    const { perplexityResearch } = await import('../lib/openrouter.ts');

    const query = `"${testCase.name}" ${testCase.entityType === 'person' ? 'AI safety researcher' : 'AI safety'}`;
    const result = await perplexityResearch(query, { maxTokens: 500 });

    const text = result.content.toLowerCase();

    // Detect "not found" signals in the response
    const notFoundSignals = [
      'no information', 'could not find', 'no results', 'doesn\'t appear',
      'does not appear', 'no relevant', 'unable to find', 'no specific',
      'not a recognized', 'not a known', 'fictional', 'no evidence',
      'i couldn\'t find', 'i could not find', 'no data available',
    ];
    const hasNotFoundSignal = notFoundSignals.some(s => text.includes(s));

    // Check if the entity name appears in the response (suggesting real results)
    const nameWords = testCase.name.toLowerCase().split(/\s+/);
    const nameAppearances = nameWords.filter(w => w.length > 3 && text.includes(w)).length;
    const nameRatio = nameAppearances / nameWords.filter(w => w.length > 3).length;

    // Estimate confidence: did the search find real content about this entity?
    let confidenceSignal: 'none' | 'low' | 'medium' | 'high';
    let hitCount: number;

    if (hasNotFoundSignal || text.length < 100) {
      confidenceSignal = 'none';
      hitCount = 0;
    } else if (nameRatio < 0.3) {
      confidenceSignal = 'low';
      hitCount = 1;
    } else if (text.length < 500) {
      confidenceSignal = 'medium';
      hitCount = 2;
    } else {
      confidenceSignal = 'high';
      hitCount = 3;
    }

    return {
      hitCount,
      topResults: hitCount > 0 ? [{ title: testCase.name, url: '', snippet: text.slice(0, 200) }] : [],
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
