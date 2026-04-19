/**
 * Research Command Handlers
 *
 * Runs multi-source research for a topic, producing SourceCacheEntry[] for
 * the section-writer pipeline. Uses Exa, Perplexity/Sonar, and SCRY with
 * graceful degradation when keys are missing.
 *
 * Usage:
 *   crux research "Anthropic constitutional AI"
 *   crux research "MIRI funding" --for-page=miri
 *   crux research "deceptive alignment" --no-exa --no-scry
 *   crux research "AI safety" --budget=2.00 --json
 *
 * See issue #684.
 */

import { type CommandResult } from '../lib/cli.ts';
import { loadDatabase } from '../lib/content-types.ts';
import { createLogger } from '../lib/output.ts';
import { runResearch } from '../lib/search/research-agent.ts';
import type { ResearchRequest } from '../lib/search/research-agent.ts';

// ---------------------------------------------------------------------------
// run — default command: research a topic and print structured results
// ---------------------------------------------------------------------------

export async function run(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  // Topic is all positional args joined
  const topic = args.filter(a => !a.startsWith('-')).join(' ').trim();
  if (!topic) {
    return {
      output: `${c.red}Error: topic required.\n\nUsage:\n  crux research "your topic"\n  crux research "topic" --for-page=<page-id>${c.reset}`,
      exitCode: 1,
    };
  }

  // --for-page: optional page ID to focus the query
  const forPage = options.forPage as string | undefined;

  // --budget: max spend in USD (default 5.00)
  const budgetCap = options.budget !== undefined ? parseFloat(options.budget as string) : 5.0;
  if (isNaN(budgetCap) || budgetCap <= 0) {
    return {
      output: `${c.red}Error: --budget must be a positive number (e.g. --budget=3.00)${c.reset}`,
      exitCode: 1,
    };
  }

  // Source toggles
  const useExa = options.noExa ? false : undefined;       // undefined = auto (key present)
  const usePerplexity = options.noPerplexity ? false : undefined;
  const useScry = options.noScry ? false : undefined;
  const useGitHub = options.noGithub ? false : undefined;
  const useSemanticScholar = options.noSemanticScholar ? false : undefined;
  const useFederalRegister = options.noFederalRegister ? false : undefined;

  // --max-results: URLs per search source (default 8)
  const maxResultsPerSource = options.maxResults !== undefined
    ? parseInt(options.maxResults as string, 10) : undefined;

  // --max-urls: total URLs to fetch (default 20)
  const maxUrlsToFetch = options.maxUrls !== undefined
    ? parseInt(options.maxUrls as string, 10) : undefined;

  // --no-facts: skip Haiku fact extraction
  const extractFacts = options.noFacts ? false : undefined;

  // Resolve entity type from database.json when --for-page is provided,
  // so domain-specific providers (GitHub, Semantic Scholar, Federal Register)
  // are activated based on the entity's actual type, not the hardcoded 'page'.
  let pageContext: ResearchRequest['pageContext'];
  if (forPage) {
    let entityType = 'page';
    let entityTitle = forPage;
    try {
      const db = loadDatabase();
      const entities = (db as Record<string, unknown>).typedEntities as Array<Record<string, unknown>> | undefined;
      const entity = entities?.find(
        (e) => e.id === forPage || e.slug === forPage || e.stableId === forPage,
      );
      if (entity) {
        if (typeof entity.entityType === 'string') entityType = entity.entityType;
        if (typeof entity.title === 'string') entityTitle = entity.title;
      }
    } catch {
      // database.json may not exist (e.g. first build) — fall back to 'page'
    }
    pageContext = { title: entityTitle, type: entityType, entityId: forPage };
  }

  const request: ResearchRequest = {
    topic,
    pageContext,
    config: {
      ...(useExa !== undefined && { useExa }),
      ...(usePerplexity !== undefined && { usePerplexity }),
      ...(useScry !== undefined && { useScry }),
      ...(useGitHub !== undefined && { useGitHub }),
      ...(useSemanticScholar !== undefined && { useSemanticScholar }),
      ...(useFederalRegister !== undefined && { useFederalRegister }),
      ...(maxResultsPerSource !== undefined && { maxResultsPerSource }),
      ...(maxUrlsToFetch !== undefined && { maxUrlsToFetch }),
      ...(extractFacts !== undefined && { extractFacts }),
    },
    budgetCap,
  };

  log.info(`Researching: "${topic}"`);
  if (forPage) log.info(`  Page context: ${forPage}`);

  let result;
  try {
    result = await runResearch(request);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: `${c.red}Error running research: ${msg}${c.reset}`,
      exitCode: 1,
    };
  }

  const { sources, metadata } = result;

  if (options.json || options.ci) {
    return { output: JSON.stringify(result, null, 2), exitCode: 0 };
  }

  // Human-readable output
  let output = `\n${c.bold}${c.blue}Research: "${topic}"${c.reset}\n`;
  output += `${c.dim}Searched: ${metadata.sourcesSearched.join(', ') || 'none'} | `;
  output += `${metadata.urlsFetched} URL${metadata.urlsFetched !== 1 ? 's' : ''} fetched`;
  if (metadata.urlsDeduplicated > 0) output += ` (${metadata.urlsDeduplicated} deduplicated)`;
  output += ` | $${metadata.totalCost.toFixed(4)} | ${Math.round(metadata.durationMs / 1000)}s${c.reset}\n\n`;

  if (sources.length === 0) {
    output += `${c.yellow}No sources found. Check API keys or try a different topic.${c.reset}\n`;
    return { output, exitCode: 0 };
  }

  for (const src of sources) {
    output += `${c.bold}[${src.id}] ${src.title}${c.reset}\n`;
    output += `${c.dim}${src.url}${c.reset}\n`;
    if (src.facts && src.facts.length > 0) {
      output += `${c.green}Key facts:${c.reset}\n`;
      for (const fact of src.facts) {
        output += `  • ${fact}\n`;
      }
    } else if (src.content) {
      const snippet = src.content.slice(0, 200).replace(/\n+/g, ' ');
      output += `${c.dim}${snippet}${snippet.length < src.content.length ? '…' : ''}${c.reset}\n`;
    }
    output += '\n';
  }

  output += `${c.dim}Cost breakdown: search $${metadata.costBreakdown.searchCost.toFixed(4)}, facts $${metadata.costBreakdown.factExtractionCost.toFixed(4)}${c.reset}\n`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export function help(): CommandResult {
  return {
    output: `
Research Command — multi-source search to structured SourceCacheEntry[]

Usage:
  crux research <topic>                          Research a topic
  crux research <topic> --for-page=<page-id>     Focus using page context
  crux research <topic> --json                   Machine-readable JSON output

Options:
  --for-page=<id>        Page entity ID to focus the research query
  --budget=<usd>         Max spend in USD (default: 5.00)
  --max-results=<n>      Max URLs per search provider (default: 8)
  --max-urls=<n>         Max URLs to fetch in total (default: 20)
  --no-exa               Skip Exa web search
  --no-perplexity        Skip Perplexity (OpenRouter)
  --no-scry              Skip SCRY (EA Forum / LessWrong)
  --no-github            Skip GitHub Search (entity-type-routed)
  --no-semantic-scholar  Skip Semantic Scholar (entity-type-routed)
  --no-federal-register  Skip Federal Register (entity-type-routed)
  --no-facts             Skip Haiku fact extraction
  --json                 JSON output (machine-readable)

Domain-specific providers (activated by entity type via --for-page):
  GitHub               Repos, orgs for: organization, project, ai-model, benchmark
  Semantic Scholar     Papers, authors for: person, concept, approach, ai-model, benchmark
  Federal Register     Regulations, EOs for: policy

Environment:
  EXA_API_KEY          Exa web search (optional)
  OPENROUTER_API_KEY   Perplexity via OpenRouter (optional)
  SCRY_API_KEY         SCRY search (optional; falls back to public key)
  GITHUB_TOKEN         GitHub API (optional; needed for github provider)
  ANTHROPIC_BILLING_KEY    Optional: if absent, fact extraction is silently skipped
`,
    exitCode: 0,
  };
}
