/**
 * Analyze Phase
 *
 * Analyzes a wiki page for improvement opportunities using an LLM.
 * Produces a structured analysis with gaps, research needs, and improvement priorities.
 */

import fs from 'fs';
import { MODELS } from '../../../lib/anthropic.ts';
import type { PageData, AnalysisResult, PipelineOptions } from '../types.ts';
import { log, getFilePath, writeTemp } from '../utils.ts';
import { runAgent } from '../api.ts';
import { parseJsonFromLlm } from './json-parsing.ts';

export async function analyzePhase(page: PageData, directions: string, options: PipelineOptions): Promise<AnalysisResult> {
  log('analyze', 'Starting analysis');

  const filePath = getFilePath(page.path);
  const currentContent = fs.readFileSync(filePath, 'utf-8');

  const prompt = `Analyze this wiki page for improvement opportunities.

## Page Info
- ID: ${page.id}
- Title: ${page.title}
- Quality: ${page.quality || 'N/A'}
- Importance: ${page.readerImportance || 'N/A'}
- Path: ${filePath}

## User-Specified Directions
${directions || 'No specific directions provided - do a general quality improvement.'}

## Current Content
\`\`\`mdx
${currentContent}
\`\`\`

## Analysis Required

Analyze the page and output a JSON object with:

1. **currentState**: Brief assessment of the page's current quality
2. **gaps**: Array of specific content gaps or issues
3. **researchNeeded**: Array of specific topics to research (for SCRY/web search)
4. **improvements**: Array of specific improvements to make, prioritized
5. **entityLinks**: Array of entity IDs that should be linked but aren't
6. **citations**: Assessment of citation quality (count, authoritative sources, gaps)
7. **objectivityIssues**: Array of specific objectivity/neutrality problems found (loaded language, evaluative labels, asymmetric framing, missing counterarguments, advocacy-adjacent tone)

Focus especially on the user's directions: "${directions || 'general improvement'}"

Output ONLY valid JSON, no markdown code blocks.`;

  const result = await runAgent(prompt, {
    model: options.analysisModel || MODELS.sonnet,
    maxTokens: 4000
  });

  const analysis = parseJsonFromLlm<AnalysisResult>(result, 'analyze', (raw, error) => ({
    raw,
    error,
  }));

  writeTemp(page.id, 'analysis.json', analysis);
  log('analyze', 'Complete');
  return analysis;
}
