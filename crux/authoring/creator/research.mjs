/**
 * Research Module
 *
 * Handles Perplexity and SCRY research phases.
 */

import fs from 'fs';
import path from 'path';
import { batchResearch, generateResearchQueries } from '../../lib/openrouter.mjs';

const SCRY_PUBLIC_KEY = process.env.SCRY_API_KEY || 'exopriors_public_readonly_v1_2025';

export async function runPerplexityResearch(topic, depth, { log, saveResult }) {
  log('research', `Starting Perplexity research (${depth})...`);

  let queries = generateResearchQueries(topic);

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

  const results = await batchResearch(queries, { concurrency: 3 });

  let totalCost = 0;
  const researchSources = [];

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

export async function runScryResearch(topic, { log, saveResult }) {
  log('scry', 'Searching SCRY (EA Forum, LessWrong)...');

  const searches = [
    { table: 'mv_eaforum_posts', query: topic },
    { table: 'mv_lesswrong_posts', query: topic },
    { table: 'mv_eaforum_posts', query: `${topic} criticism` },
  ];

  const results = [];

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
      });

      const data = await response.json();

      if (data.rows) {
        const platform = search.table.includes('eaforum') ? 'EA Forum' : 'LessWrong';
        log('scry', `  ${platform} "${search.query}": ${data.rows.length} results`);
        results.push(...data.rows.map(row => ({
          ...row,
          platform,
          searchQuery: search.query,
        })));
      }
    } catch (error) {
      log('scry', `  Error searching ${search.table}: ${error.message}`);
    }
  }

  // Deduplicate by URI
  const seen = new Set();
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
