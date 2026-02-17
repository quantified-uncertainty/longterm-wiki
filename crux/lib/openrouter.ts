/**
 * OpenRouter API Integration
 *
 * Provides access to various models including Perplexity Sonar for research.
 *
 * Pricing (as of Jan 2025):
 * - perplexity/sonar: $1/M input, $1/M output (includes web search)
 * - perplexity/sonar-pro: $3/M input, $15/M output (better reasoning)
 * - google/gemini-flash-1.5: $0.075/M input, $0.30/M output
 * - deepseek/deepseek-chat: $0.14/M input, $0.28/M output
 */

import dotenv from 'dotenv';
dotenv.config();

import { getApiKey } from './api-keys.ts';

const OPENROUTER_API_KEY = getApiKey('OPENROUTER_API_KEY');
const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

/**
 * Available models for different use cases
 */
export const MODELS: Record<string, string> = {
  // Research (with web search built-in)
  PERPLEXITY_SONAR: 'perplexity/sonar',
  PERPLEXITY_SONAR_PRO: 'perplexity/sonar-pro',

  // Cheap general purpose
  GEMINI_FLASH: 'google/gemini-flash-1.5',
  DEEPSEEK_CHAT: 'deepseek/deepseek-chat',

  // Quality general purpose
  GEMINI_PRO: 'google/gemini-pro-1.5',
  GPT4O_MINI: 'openai/gpt-4o-mini',
};

export interface OpenRouterOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string | null;
}

export interface OpenRouterResult {
  content: string;
  citations: string[];
  model: string;
  usage: Record<string, unknown>;
  cost: number;
}

/**
 * Call OpenRouter API
 */
async function callOpenRouter(prompt: string, options: OpenRouterOptions = {}): Promise<OpenRouterResult> {
  const {
    model = MODELS.PERPLEXITY_SONAR,
    maxTokens = 2000,
    temperature = 0.7,
    systemPrompt = null,
  } = options;

  if (!OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY not set in environment');
  }

  const messages: Array<{ role: string; content: string }> = [];
  if (systemPrompt) {
    messages.push({ role: 'system', content: systemPrompt });
  }
  messages.push({ role: 'user', content: prompt });

  const response = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://www.longtermwiki.com',
      'X-Title': 'LongtermWiki Page Creator'
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
    })
  });

  const data = await response.json() as {
    error?: { message?: string };
    citations?: string[];
    choices: Array<{ message: { content: string; citations?: string[] } }>;
    model: string;
    usage: Record<string, unknown> & { cost?: number };
  };

  if (!response.ok || data.error) {
    const msg = data.error?.message || JSON.stringify(data.error) || `HTTP ${response.status}`;
    // Provide actionable diagnostics for common failures
    if (response.status === 401 || response.status === 403 || msg.includes('authenticate')) {
      throw new Error(`OpenRouter auth failed (${response.status}): check OPENROUTER_API_KEY — key may be invalid, expired, or contain embedded quotes`);
    }
    if (response.status === 402 || msg.includes('credits') || msg.includes('insufficient')) {
      throw new Error(`OpenRouter payment required: account has insufficient credits — visit https://openrouter.ai/credits`);
    }
    throw new Error(`OpenRouter error: ${msg}`);
  }

  // Perplexity includes citations in the response - extract them
  const citations = data.citations || data.choices[0]?.message?.citations || [];

  return {
    content: data.choices[0].message.content,
    citations,  // Array of source URLs that [1], [2], etc. refer to
    model: data.model,
    usage: data.usage,
    cost: data.usage?.cost || 0,
  };
}

export interface PerplexityResearchOptions {
  maxTokens?: number;
  detailed?: boolean;
}

/**
 * Perplexity research query - returns structured research with citations
 */
export async function perplexityResearch(query: string, options: PerplexityResearchOptions = {}): Promise<OpenRouterResult> {
  const {
    maxTokens = 2000,
    detailed = false,
  } = options;

  const model = detailed ? MODELS.PERPLEXITY_SONAR_PRO : MODELS.PERPLEXITY_SONAR;

  const systemPrompt = `You are a research assistant gathering information for a wiki article.
For each piece of information, note the source if available.
Focus on:
- Factual claims with dates and numbers
- Key people and their roles
- Funding amounts and sources
- Criticisms and controversies
- Recent developments

Format your response with clear sections and bullet points.`;

  return callOpenRouter(query, {
    model,
    maxTokens,
    systemPrompt,
  });
}

export interface BatchQuery {
  query: string;
  category: string;
  detailed?: boolean;
}

export interface BatchResearchResult extends OpenRouterResult {
  query: string;
  category: string;
}

export interface BatchResearchOptions {
  concurrency?: number;
  delayMs?: number;
}

/**
 * Batch research - run multiple queries in parallel
 */
export async function batchResearch(queries: BatchQuery[], options: BatchResearchOptions = {}): Promise<BatchResearchResult[]> {
  const {
    concurrency = 3,
    delayMs = 500,
  } = options;

  const results: BatchResearchResult[] = [];

  // Process in batches to avoid rate limits
  for (let i = 0; i < queries.length; i += concurrency) {
    const batch = queries.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(q => perplexityResearch(q.query, { detailed: q.detailed }))
    );

    results.push(...batchResults.map((r, idx) => ({
      query: batch[idx].query,
      category: batch[idx].category,
      ...r
    })));

    // Small delay between batches
    if (i + concurrency < queries.length) {
      await new Promise<void>(resolve => setTimeout(resolve, delayMs));
    }
  }

  return results;
}

type TopicType = 'organization' | 'person' | 'event' | 'concept';

/**
 * Detect topic type using heuristics
 */
function detectTopicType(topic: string): TopicType {
  const lowerTopic = topic.toLowerCase();

  // Known AI organizations (hardcoded for accuracy)
  const knownOrgs = [
    'anthropic', 'openai', 'deepmind', 'google deepmind', 'miri',
    'redwood research', 'alignment research center', 'conjecture',
    'ought', 'open philanthropy', 'givewell', 'cea', 'future of humanity institute',
    'center for ai safety', 'cais', 'far ai', 'epoch', 'metr', 'apollo research',
    'arc evals', // Use full name to avoid substring match with "research"
  ];
  // Exact match or topic starts/ends with org name (to catch "Anthropic Inc" but not "arc" in "research")
  if (knownOrgs.some(org => lowerTopic === org || lowerTopic.startsWith(org + ' ') || lowerTopic.endsWith(' ' + org))) {
    return 'organization';
  }

  // Event/Incident patterns
  if (/\(\d{4}\)/.test(topic) || // Year in parens like "(2025)"
      /incident|event|attack|breach|hack|scandal|crisis|disaster/i.test(topic)) {
    return 'event';
  }

  // Organization patterns
  // Note: "Research" only counts if preceded by a proper noun (capitalized, not a common word)
  const hasOrgSuffix = /\b(inc|corp|llc|ltd|labs?|institute|foundation|center|centre|company|org|association)\b/i.test(topic);
  const hasResearchSuffix = /^[A-Z][a-z]+\s+Research$/.test(topic); // "Redwood Research" (case-sensitive)
  const isAcronym = /^[A-Z]{2,}$/.test(topic); // "MIRI"
  const endsWithAI = /AI$/.test(topic) && topic.length > 2; // "OpenAI" but not just "AI"

  if (hasOrgSuffix || hasResearchSuffix || isAcronym || endsWithAI) {
    return 'organization';
  }

  // Person patterns - needs at least one common first name indicator
  // or specific "firstname lastname" where first is short and second is longer
  const words = topic.split(/\s+/);
  if (words.length >= 2 && words.length <= 3 &&
      words.every(w => /^[A-Z][a-z]+$/.test(w))) {
    // Additional check: first word should look like a first name (shorter, common patterns)
    const firstName = words[0];
    // Common first name patterns: 3-7 chars, ends in vowel or common consonants
    if (firstName.length >= 3 && firstName.length <= 8) {
      return 'person';
    }
  }

  // Default to concept
  return 'concept';
}

export interface ResearchQuery {
  query: string;
  category: string;
}

/**
 * Generate adversarial queries tailored to topic type
 */
function generateAdversarialQueries(topic: string, topicType: TopicType): ResearchQuery[] {
  switch (topicType) {
    case 'organization':
      return [
        { query: `${topic} criticism concerns controversies problems`, category: 'criticism' },
        { query: `${topic} failed projects mistakes failures`, category: 'failures' },
        { query: `${topic} conflicts of interest funding controversies`, category: 'incentives' },
      ];

    case 'person':
      return [
        { query: `${topic} criticism concerns controversies`, category: 'criticism' },
        { query: `${topic} wrong predictions mistakes failures`, category: 'failures' },
        { query: `${topic} conflicts of interest bias motivations`, category: 'incentives' },
      ];

    case 'event':
      return [
        { query: `${topic} skepticism doubts questions`, category: 'skepticism' },
        { query: `${topic} overhyped exaggerated misleading narrative`, category: 'hype' },
        { query: `${topic} alternative explanation what really happened`, category: 'alternatives' },
        { query: `"${topic}" who benefits incentives motivations`, category: 'incentives' },
      ];

    case 'concept':
    default:
      return [
        { query: `${topic} criticism counterarguments objections`, category: 'criticism' },
        { query: `${topic} limitations problems weaknesses`, category: 'limitations' },
        { query: `arguments against ${topic}`, category: 'counter' },
      ];
  }
}

/**
 * Generate research queries for a topic
 */
export function generateResearchQueries(topic: string): ResearchQuery[] {
  const topicType = detectTopicType(topic);
  const adversarialQueries = generateAdversarialQueries(topic, topicType);

  // Base queries (some vary by type)
  const baseQueries: ResearchQuery[] = [
    { query: `What is ${topic}? Overview, mission, and key facts`, category: 'overview' },
    { query: `${topic} history founding story timeline key events`, category: 'history' },
  ];

  // Type-specific base queries
  if (topicType === 'organization') {
    baseQueries.push(
      { query: `${topic} team leadership founders key people backgrounds`, category: 'people' },
      { query: `${topic} funding grants investors revenue financial information`, category: 'funding' },
      { query: `${topic} Open Philanthropy grants funding`, category: 'funding-op' },
      { query: `${topic} projects research publications major work output`, category: 'work' },
      { query: `${topic} impact effectiveness results achievements`, category: 'impact' },
    );
  } else if (topicType === 'person') {
    baseQueries.push(
      { query: `${topic} background education career biography`, category: 'background' },
      { query: `${topic} publications research work contributions`, category: 'work' },
      { query: `${topic} views opinions positions beliefs`, category: 'views' },
      { query: `${topic} predictions forecasts track record`, category: 'predictions' },
    );
  } else if (topicType === 'event') {
    baseQueries.push(
      { query: `${topic} timeline what happened sequence of events`, category: 'timeline' },
      { query: `${topic} who was involved key actors players`, category: 'actors' },
      { query: `${topic} impact consequences aftermath effects`, category: 'impact' },
      { query: `${topic} response reaction how people responded`, category: 'response' },
    );
  } else {
    // Concept
    baseQueries.push(
      { query: `${topic} definition explanation how it works`, category: 'definition' },
      { query: `${topic} examples applications use cases`, category: 'examples' },
      { query: `${topic} research studies evidence`, category: 'research' },
    );
  }

  // Common queries for all types
  const commonQueries: ResearchQuery[] = [
    { query: `${topic} news articles recent developments 2024 2025`, category: 'news' },
    { query: `${topic} AI safety alignment existential risk connection`, category: 'ai-safety' },
    { query: `${topic} EA Forum LessWrong discussion community opinion`, category: 'community' },
  ];

  return [...baseQueries, ...adversarialQueries, ...commonQueries];
}

