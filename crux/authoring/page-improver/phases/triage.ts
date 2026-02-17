/**
 * Triage Phase
 *
 * Performs a cheap news check to auto-select the appropriate improvement tier.
 */

import fs from 'fs';
import { MODELS } from '../../../lib/anthropic.ts';
import { stripFrontmatter } from '../../../lib/patterns.ts';
import type { PageData, TriageResult } from '../types.ts';
import { log, getFilePath, writeTemp } from '../utils.ts';
import { runAgent, executeWebSearch, executeScrySearch } from '../api.ts';
import { parseJsonFromLlm } from './json-parsing.ts';

export async function triagePhase(page: PageData, lastEdited: string): Promise<TriageResult> {
  log('triage', `Checking for news since ${lastEdited}: "${page.title}"`);

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');

  const contentAfterFm = stripFrontmatter(currentContent);
  const contentPreview = contentAfterFm.slice(0, 500);

  const searchQuery = `${page.title} developments news ${lastEdited} to ${new Date().toISOString().slice(0, 10)}`;
  const scryQuery = page.title;

  const [webResults, scryResults] = await Promise.all([
    executeWebSearch(searchQuery).catch(err => `Web search failed: ${err.message}`),
    executeScrySearch(scryQuery).catch(err => `SCRY search failed: ${err.message}`),
  ]);

  const classificationPrompt = `You are triaging whether a wiki page needs updating.

## Page
- Title: ${page.title}
- ID: ${page.id}
- Last edited: ${lastEdited}
- Content preview: ${contentPreview}

## Recent Web Results
${webResults}

## Recent EA Forum / LessWrong Results (SCRY)
${scryResults}

## Task

Based on the search results, determine if there are significant new developments since ${lastEdited} that warrant updating this page.

Classify into one of these tiers:

- **skip**: No meaningful new developments found. Page content is still current.
- **polish**: Minor updates only — small corrections, formatting, or very minor new info. (~$2-3)
- **standard**: Notable new developments that should be added — new papers, policy changes, funding rounds, etc. (~$5-8)
- **deep**: Major developments requiring thorough research — new organizations, paradigm shifts, major incidents, etc. (~$10-15)

Output ONLY a JSON object:
{
  "recommendedTier": "skip|polish|standard|deep",
  "reason": "1-2 sentence explanation of why this tier",
  "newDevelopments": ["list", "of", "specific", "new", "developments", "found"]
}`;

  const result = await runAgent(classificationPrompt, {
    model: MODELS.haiku,
    maxTokens: 1000,
  });

  const parsed = parseJsonFromLlm<{ recommendedTier: string; reason: string; newDevelopments: string[] }>(
    result,
    'triage',
    () => ({ recommendedTier: 'standard', reason: 'Triage parsing failed, using default', newDevelopments: [] }),
  );

  const validTiers: string[] = ['skip', 'polish', 'standard', 'deep'];
  const tier = (validTiers.includes(parsed.recommendedTier)
    ? parsed.recommendedTier
    : 'standard') as TriageResult['recommendedTier'];

  const costMap = { skip: '$0', polish: '$2-3', standard: '$5-8', deep: '$10-15' };

  const triageResult: TriageResult = {
    pageId: page.id,
    title: page.title,
    lastEdited,
    recommendedTier: tier,
    reason: parsed.reason || '',
    newDevelopments: parsed.newDevelopments || [],
    estimatedCost: costMap[tier],
    triageCost: '~$0.08',
  };

  writeTemp(page.id, 'triage.json', triageResult);
  log('triage', `Result: ${tier} — ${parsed.reason}`);
  return triageResult;
}
