/**
 * Semi-realistic live test for section-writer.ts
 *
 * Runs the actual LLM on an ARC overview section with a source cache
 * drawn from realistic facts about ARC. Run multiple times to observe
 * prompt quality and iterate.
 *
 * Usage:
 *   node --import tsx/esm crux/lib/section-writer-live-test.mts
 *
 * Not a unit test — intended for prompt development / manual iteration.
 */

import { rewriteSection, type SourceCacheEntry, type GroundedWriteRequest } from './section-writer.ts';

// ---------------------------------------------------------------------------
// Test content
// ---------------------------------------------------------------------------

const ARC_OVERVIEW_SECTION = `## Overview

The <R id="0562f8c207d8b63f">Alignment Research Center (ARC)</R> represents a unique approach to AI safety, combining theoretical research on worst-case alignment scenarios with practical capability evaluations of frontier AI models. Founded in 2021 by <EntityLink id="paul-christiano">Paul Christiano</EntityLink> after his departure from <EntityLink id="openai">OpenAI</EntityLink>, ARC has become highly influential in establishing evaluations as a core governance tool.

ARC's dual focus stems from Christiano's belief that AI systems might be adversarial rather than merely misaligned, requiring robust safety measures that work even against deceptive models. This "worst-case alignment" philosophy distinguishes ARC from organizations pursuing more optimistic prosaic alignment approaches.

The organization has achieved significant impact through its ELK (Eliciting Latent Knowledge) problem formulation, which has influenced how the field thinks about truthfulness and <EntityLink id="scalable-oversight">scalable oversight</EntityLink>, and through ARC Evals, which has established the standard for systematic capability evaluations now adopted by major AI labs.`;

// Source cache with realistic entries
const SOURCE_CACHE: SourceCacheEntry[] = [
  {
    id: 'SRC-ARC-ABOUT',
    url: 'https://alignment.org/about/',
    title: 'About — Alignment Research Center',
    date: '2024-01-01',
    content: 'ARC is a nonprofit research organization working to ensure that AI systems are safe and beneficial. Founded by Paul Christiano in 2021.',
    facts: [
      'ARC was founded in 2021 by Paul Christiano',
      'ARC is a nonprofit research organization',
      'Paul Christiano previously worked at OpenAI as head of the AI safety team',
      'ARC operates two divisions: ARC Theory and ARC Evals (formerly ARC Evals, now METR)',
      'ARC Theory focuses on worst-case alignment problems including the ELK (Eliciting Latent Knowledge) problem',
    ],
  },
  {
    id: 'SRC-METR',
    url: 'https://metr.org/',
    title: 'METR — Model Evaluation & Threat Research',
    date: '2023-11-01',
    content: 'METR (formerly ARC Evals) is an independent organization conducting evaluations of frontier AI models for dangerous capabilities.',
    facts: [
      'ARC Evals became an independent organization called METR in late 2023',
      'METR conducts pre-deployment evaluations for dangerous capabilities at major labs including OpenAI, Anthropic, and Google DeepMind',
      'METR developed the ATLAS framework for autonomous task evaluation',
      'METR evaluated GPT-4 and Claude 2 for autonomous replication and resource acquisition capabilities before their releases',
    ],
  },
  {
    id: 'SRC-ELK',
    url: 'https://alignment.org/eliciting-latent-knowledge/',
    title: 'Eliciting Latent Knowledge (ELK) — ARC',
    date: '2022-01-15',
    content: 'The ELK problem asks: how can we ensure an AI system reports what it actually believes rather than what the human wants to hear?',
    facts: [
      'ARC released the ELK problem formulation in January 2022 with a $50,000 prize',
      'The ELK problem asks how to distinguish what an AI model "knows" from what it represents as knowing',
      'Over 200 submissions were received for the ELK prize',
      'No complete solution was found — all proposed approaches had counterexamples',
      'ELK is considered a core problem for scalable oversight and deceptive alignment research',
    ],
  },
  {
    id: 'SRC-CHRISTIANO-BACKGROUND',
    url: 'https://paulfchristiano.com/',
    title: 'Paul Christiano — AI Safety Researcher',
    date: '2024-06-01',
    facts: [
      'Paul Christiano led the reinforcement learning from human feedback (RLHF) research at OpenAI',
      'Christiano departed OpenAI in 2021 to found ARC',
      'ARC received initial funding from Open Philanthropy (~$5M+)',
      'Christiano is now a US Government AI Safety Institute (AISI) advisor',
    ],
  },
];

// ---------------------------------------------------------------------------
// Test scenarios
// ---------------------------------------------------------------------------

async function runScenario(label: string, request: GroundedWriteRequest) {
  console.log('\n' + '='.repeat(70));
  console.log(`SCENARIO: ${label}`);
  console.log('='.repeat(70));
  console.log(`Sources in cache: ${request.sourceCache.length}`);
  console.log(`Directions: ${request.directions ?? '(none)'}`);
  console.log(`Constraints: allowTraining=${request.constraints?.allowTrainingKnowledge ?? true}, requireClaimMap=${request.constraints?.requireClaimMap ?? false}`);
  console.log('');

  const start = Date.now();
  const result = await rewriteSection(request);
  const elapsed = ((Date.now() - start) / 1000).toFixed(1);

  console.log(`--- RESULT (${elapsed}s) ---`);
  console.log('\n📝 Content:');
  console.log(result.content);

  console.log('\n🗺️  Claim Map:');
  if (result.claimMap.length === 0) {
    console.log('  (empty)');
  } else {
    for (const entry of result.claimMap) {
      console.log(`  [${entry.factId}] "${entry.claim.slice(0, 80)}..."`);
      if (entry.quote) console.log(`    Quote: "${entry.quote.slice(0, 60)}..."`);
    }
  }

  if (result.unsourceableClaims.length > 0) {
    console.log('\n⚠️  Unsourceable Claims:');
    for (const c of result.unsourceableClaims) {
      console.log(`  - ${c.slice(0, 100)}`);
    }
  }

  // Checks
  const issues: string[] = [];
  if (!result.content.includes('## ')) issues.push('❌ No section heading in content');
  if (result.content.includes('UNKNOWN_SOURCE')) issues.push('❌ Hallucinated source ID in content');
  const footnoteRefs = (result.content.match(/\[\^[A-Z0-9-]+\]/g) ?? []);
  const footnoteDefsInContent = (result.content.match(/^\[\^[A-Z0-9-]+\]:/gm) ?? []);
  if (footnoteRefs.length > 0 && footnoteDefsInContent.length === 0) {
    issues.push('❌ Footnote markers without definitions');
  }
  // Check claimMap factIds are valid
  const invalidIds = result.claimMap.filter(e => !request.sourceCache.some(s => s.id === e.factId));
  if (invalidIds.length > 0) {
    issues.push(`⚠️  ${invalidIds.length} claimMap entries with unknown factIds: ${invalidIds.map(e => e.factId).join(', ')}`);
  }

  if (issues.length > 0) {
    console.log('\n🔍 Issues:');
    for (const i of issues) console.log(`  ${i}`);
  } else {
    console.log('\n✅ No structural issues detected');
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  console.log('Section Writer Live Test');
  console.log('Model: claude-sonnet-4-6 (Sonnet)');
  console.log('Page: ARC (Alignment Research Center)');

  // Scenario 1: Standard improve with training knowledge allowed
  await runScenario('Standard improve (training knowledge allowed)', {
    sectionId: 'overview',
    sectionContent: ARC_OVERVIEW_SECTION,
    pageContext: { title: 'ARC (Alignment Research Center)', type: 'organization', entityId: 'arc' },
    sourceCache: SOURCE_CACHE,
    directions: 'Add specific dates and numbers where available from the sources. Note the METR spin-off.',
    constraints: { allowTrainingKnowledge: true, requireClaimMap: true },
  });

  // Scenario 2: Strict mode — cache-only
  await runScenario('Strict mode (cache-only, no training knowledge)', {
    sectionId: 'overview',
    sectionContent: ARC_OVERVIEW_SECTION,
    pageContext: { title: 'ARC (Alignment Research Center)', type: 'organization', entityId: 'arc' },
    sourceCache: SOURCE_CACHE,
    constraints: { allowTrainingKnowledge: false, requireClaimMap: true, maxNewClaims: 4 },
  });

  // Scenario 3: Empty source cache — prose-only polish
  await runScenario('Prose polish only (empty cache)', {
    sectionId: 'overview',
    sectionContent: ARC_OVERVIEW_SECTION,
    pageContext: { title: 'ARC (Alignment Research Center)', type: 'organization', entityId: 'arc' },
    sourceCache: [],
    directions: 'Tighten the prose. Remove redundancy. Improve the first sentence.',
    constraints: { allowTrainingKnowledge: true, requireClaimMap: false },
  });
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
