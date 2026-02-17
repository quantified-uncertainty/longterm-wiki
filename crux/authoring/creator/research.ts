/**
 * Research Module
 *
 * Handles Perplexity and SCRY research phases.
 */

import { batchResearch, generateResearchQueries } from '../../lib/openrouter.ts';
import type { BatchResearchResult, ResearchQuery } from '../../lib/openrouter.ts';

interface ResearchContext {
  log: (phase: string, message: string) => void;
  saveResult: (topic: string, filename: string, data: unknown) => string;
}

interface ScryContext {
  log: (phase: string, message: string) => void;
  saveResult: (topic: string, filename: string, data: unknown) => string;
}

interface ResearchSource {
  category: string;
  query: string;
  content: string;
  citations: string[];
  tokens: number;
  cost: number;
}

interface ScrySearch {
  table: string;
  query: string;
}

interface ScryRow {
  title: string;
  uri: string;
  snippet?: string;
  original_author: string;
  date: string;
  platform?: string;
  searchQuery?: string;
}

const SCRY_PUBLIC_KEY = process.env.SCRY_API_KEY || 'exopriors_public_readonly_v1_2025';

export async function runPerplexityResearch(topic: string, depth: string, { log, saveResult }: ResearchContext): Promise<{ success: boolean; cost: number; queryCount: number }> {
  log('research', `Starting Perplexity research (${depth})...`);

  // Check if OPENROUTER_API_KEY is available
  if (!process.env.OPENROUTER_API_KEY) {
    log('research', 'Warning: OPENROUTER_API_KEY not set — skipping Perplexity research');
    log('research', 'The synthesis step will have limited research data available');
    saveResult(topic, 'perplexity-research.json', {
      topic,
      depth,
      queryCount: 0,
      totalCost: 0,
      timestamp: new Date().toISOString(),
      sources: [],
      skipped: true,
      skipReason: 'OPENROUTER_API_KEY not available',
    });
    return { success: true, cost: 0, queryCount: 0 };
  }

  let queries: ResearchQuery[] = generateResearchQueries(topic);

  if (depth === 'lite') {
    queries = queries.slice(0, 6);
  } else if (depth === 'deep') {
    queries.push(
      { query: `${topic} technical details methodology approach`, category: 'technical' },
      { query: `${topic} comparison alternatives competitors`, category: 'comparison' },
      { query: `${topic} future plans roadmap strategy`, category: 'future' },
      { query: `${topic} academic papers research publications citations`, category: 'academic' },
    );
  }

  log('research', `Running ${queries.length} Perplexity queries...`);

  let results: BatchResearchResult[];
  try {
    results = await batchResearch(queries, { concurrency: 3 });
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('research', `Warning: Perplexity research failed: ${error.message}`);
    log('research', 'Continuing with empty research — synthesis will use available data only');
    saveResult(topic, 'perplexity-research.json', {
      topic,
      depth,
      queryCount: queries.length,
      totalCost: 0,
      timestamp: new Date().toISOString(),
      sources: [],
      skipped: true,
      skipReason: `Network error: ${error.message}`,
    });
    return { success: true, cost: 0, queryCount: 0 };
  }

  let totalCost = 0;
  const researchSources: ResearchSource[] = [];

  for (const result of results) {
    totalCost += result.cost || 0;
    researchSources.push({
      category: result.category,
      query: result.query,
      content: result.content,
      citations: result.citations || [],
      tokens: result.usage?.total_tokens || 0,
      cost: result.cost || 0,
    });
    log('research', `  ${result.category}: ${result.usage?.total_tokens || 0} tokens, $${(result.cost || 0).toFixed(4)}`);
  }

  log('research', `Total research cost: $${totalCost.toFixed(4)}`);

  const outputPath = saveResult(topic, 'perplexity-research.json', {
    topic,
    depth,
    queryCount: queries.length,
    totalCost,
    timestamp: new Date().toISOString(),
    sources: researchSources,
  });

  log('research', `Saved to ${outputPath}`);

  return { success: true, cost: totalCost, queryCount: queries.length };
}

export async function runScryResearch(topic: string, { log, saveResult }: ScryContext): Promise<{ success: boolean; resultCount: number }> {
  log('scry', 'Searching SCRY (EA Forum, LessWrong)...');

  const searches: ScrySearch[] = [
    { table: 'mv_eaforum_posts', query: topic },
    { table: 'mv_lesswrong_posts', query: topic },
    { table: 'mv_eaforum_posts', query: `${topic} criticism` },
  ];

  const results: ScryRow[] = [];
  let allFailed = true;

  for (const search of searches) {
    try {
      const sql = `SELECT title, uri, snippet, original_author, original_timestamp::date as date
        FROM scry.search('${search.query.replace(/'/g, "''")}', '${search.table}')
        WHERE title IS NOT NULL AND kind = 'post'
        LIMIT 10`;

      const response = await fetch('https://api.exopriors.com/v1/scry/query', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SCRY_PUBLIC_KEY}`,
          'Content-Type': 'text/plain',
        },
        body: sql,
        signal: AbortSignal.timeout(15000),
      });

      const data = await response.json() as { rows?: ScryRow[] };

      if (data.rows) {
        allFailed = false;
        const platform = search.table.includes('eaforum') ? 'EA Forum' : 'LessWrong';
        log('scry', `  ${platform} "${search.query}": ${data.rows.length} results`);
        results.push(...data.rows.map(row => ({
          ...row,
          platform,
          searchQuery: search.query,
        })));
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log('scry', `  Error searching ${search.table}: ${error.message}`);
    }
  }

  if (allFailed && results.length === 0) {
    log('scry', 'Warning: All SCRY searches failed (network may be unavailable)');
    log('scry', 'Continuing without community discussion data');
  }

  // Deduplicate by URI
  const seen = new Set<string>();
  const unique = results.filter(r => {
    if (seen.has(r.uri)) return false;
    seen.add(r.uri);
    return true;
  });

  saveResult(topic, 'scry-research.json', {
    topic,
    resultCount: unique.length,
    timestamp: new Date().toISOString(),
    results: unique,
  });

  log('scry', `Found ${unique.length} unique community posts`);

  return { success: true, resultCount: unique.length };
}
