/**
 * Research Phase
 *
 * Conducts web and SCRY searches to gather sources for page improvement.
 */

import { MODELS } from '../../../lib/anthropic.ts';
import type { PageData, AnalysisResult, ResearchResult, PipelineOptions } from '../types.ts';
import { log, writeTemp } from '../utils.ts';
import { runAgent } from '../api.ts';
import { parseJsonFromLlm } from './json-parsing.ts';

export async function researchPhase(page: PageData, analysis: AnalysisResult, options: PipelineOptions): Promise<ResearchResult> {
  log('research', 'Starting research');

  const topics: string[] = analysis.researchNeeded || [];
  if (topics.length === 0) {
    log('research', 'No research topics identified, skipping');
    return { sources: [] };
  }

  const prompt = `Research the following topics to improve a wiki page about "${page.title}".

## Topics to Research
${topics.map((t, i) => `${i + 1}. ${t}`).join('\n')}

## Research Instructions

For each topic:
1. Search SCRY (EA Forum/LessWrong) for relevant discussions
2. Search the web for authoritative sources

Use the tools provided to search. For each source found, extract:
- Title
- URL
- Author (if available)
- Date (if available)
- Key facts or quotes relevant to the topic

After researching, output a JSON object with:
{
  "sources": [
    {
      "topic": "which research topic this addresses",
      "title": "source title",
      "url": "source URL",
      "author": "author name",
      "date": "publication date",
      "facts": ["key fact 1", "key fact 2"],
      "relevance": "high/medium/low"
    }
  ],
  "summary": "brief summary of what was found"
}

Output ONLY valid JSON at the end.`;

  const tools = options.deep ? [
    {
      name: 'scry_search',
      description: 'Search EA Forum and LessWrong posts via SCRY',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' },
          table: { type: 'string', enum: ['mv_eaforum_posts', 'mv_lesswrong_posts'], default: 'mv_eaforum_posts' }
        },
        required: ['query']
      }
    },
    {
      name: 'web_search',
      description: 'Search the web for information',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  ] : [
    {
      name: 'web_search',
      description: 'Search the web for information',
      input_schema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Search query' }
        },
        required: ['query']
      }
    }
  ];

  const result = await runAgent(prompt, {
    model: options.researchModel || MODELS.sonnet,
    maxTokens: 8000,
    tools
  });

  const research = parseJsonFromLlm<ResearchResult>(result, 'research', (raw, error) => ({
    sources: [],
    raw,
    error,
  }));

  writeTemp(page.id, 'research.json', research);
  log('research', `Complete (${research.sources?.length || 0} sources found)`);
  return research;
}
