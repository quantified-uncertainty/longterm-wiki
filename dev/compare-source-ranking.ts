/**
 * compare-source-ranking.ts
 *
 * Side-by-side comparison of two strategies for picking the best supporting
 * source URL for a given fact:
 *
 *   1. Cohere rerank (via OpenRouter)      — topical relevance ranker
 *   2. Claude Haiku (via OpenRouter chat)  — explicit claim-entailment judge
 *
 * Runs both strategies against a fixed set of realistic source-check
 * scenarios (claim + 4-6 candidate sources each) and prints a comparison
 * table plus per-scenario reasoning.
 *
 * Usage:
 *   OPENROUTER_API_KEY=sk-... pnpm tsx dev/compare-source-ranking.ts
 *
 *   # Single scenario:
 *   pnpm tsx dev/compare-source-ranking.ts --only=anthropic-amazon
 *
 *   # Different rerank model (default: cohere/rerank-4-fast):
 *   pnpm tsx dev/compare-source-ranking.ts --rerank=cohere/rerank-4-pro
 */

import dotenv from 'dotenv';
dotenv.config();

import { getApiKey } from '../crux/lib/api-keys.ts';

const OPENROUTER_KEY = getApiKey('OPENROUTER_API_KEY');
const RERANK_URL = 'https://openrouter.ai/api/v1/rerank';
const CHAT_URL = 'https://openrouter.ai/api/v1/chat/completions';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Candidate {
  /** Short label used in output tables. */
  tag: string;
  url: string;
  /** ~200-600 char excerpt representative of what source-fetcher would cache. */
  snippet: string;
}

interface Scenario {
  id: string;
  /** The fact being source-checked (what the CLI would search a source for). */
  claim: string;
  /** Question-phrased rerank query — "is X true?" framing. */
  claimQuestion: string;
  /** Retrieval-intent rerank query — "source confirming X" framing. */
  claimRetrieval: string;
  entityName: string;
  candidates: Candidate[];
  /** Index (0-based) of the "correct" best supporting source — my judgment. */
  expectedIndex: number;
  /** Human-readable justification for the expected answer. */
  expectedReason: string;
}

// ---------------------------------------------------------------------------
// Test scenarios
//
// Each scenario mixes:
//   - one (or more) primary/official sources that directly state the fact
//   - one or more high-trust media sources that mention it
//   - one or more topical-but-non-authoritative sources (blogs, wiki summaries,
//     archives, aggregators) that should NOT be picked
//   - ideally one decoy that is topically relevant but about a different
//     year / product / company
//
// The point is to find cases where "topical relevance" (rerank) and "actually
// supports the claim" (Haiku) diverge.
// ---------------------------------------------------------------------------

const SCENARIOS: Scenario[] = [
  {
    id: 'anthropic-amazon',
    claim: 'Anthropic raised $4 billion from Amazon in September 2023',
    claimQuestion: 'Did Anthropic raise $4 billion from Amazon in September 2023?',
    claimRetrieval: 'source confirming Anthropic raised $4 billion from Amazon in September 2023',
    entityName: 'Anthropic',
    expectedIndex: 0,
    expectedReason: 'Amazon press release explicitly states the $4B investment and the September 2023 date.',
    candidates: [
      {
        tag: 'amazon-press',
        url: 'https://www.aboutamazon.com/news/company-news/amazon-aws-anthropic-ai',
        snippet: 'September 25, 2023 — Amazon and Anthropic today announced a strategic collaboration that will bring together their respective industry-leading technology and expertise in safer generative artificial intelligence. Anthropic has selected AWS as its primary cloud provider. Amazon will invest up to $4 billion in Anthropic.',
      },
      {
        tag: 'techcrunch',
        url: 'https://techcrunch.com/2023/09/25/amazon-invests-up-to-4b-in-ai-startup-anthropic',
        snippet: 'Anthropic, the AI research startup behind the chatbot Claude, has received a new round of funding. Amazon will invest up to $4 billion into the company, with a $1.25 billion initial investment. The deal marks a significant expansion of AWS as a foundation-model platform.',
      },
      {
        tag: 'random-blog',
        url: 'https://ainewsdigest.substack.com/p/weekly-ai-roundup-sep-2023',
        snippet: 'Lots happening in AI this week. Amazon is pouring money into Anthropic. OpenAI dropped DALL-E 3. Google is shipping Gemini soon. What a time to be alive. Anyway, here are the best tweets of the week.',
      },
      {
        tag: 'anthropic-older',
        url: 'https://www.anthropic.com/news/series-c',
        snippet: 'Today we announced a $450 million Series C funding round. The round was led by Spark Capital with participation from Google, Salesforce Ventures, Sound Ventures, Zoom Ventures, and others. This is separate from our earlier Series B round.',
      },
      {
        tag: 'wikipedia',
        url: 'https://en.wikipedia.org/wiki/Anthropic',
        snippet: 'Anthropic is an American artificial intelligence startup founded in 2021 by former OpenAI members Dario Amodei and Daniela Amodei. The company has received investments from Google, Spark Capital, and Amazon. It is the developer of the Claude family of large language models.',
      },
    ],
  },
  {
    id: 'sb1047-veto',
    claim: 'California Governor Gavin Newsom vetoed SB 1047 on September 29, 2024',
    claimQuestion: 'Did California Governor Gavin Newsom veto SB 1047 on September 29, 2024?',
    claimRetrieval: 'source confirming California Governor Gavin Newsom vetoed SB 1047 on September 29, 2024',
    entityName: 'SB 1047',
    expectedIndex: 0,
    expectedReason: 'Official veto message from the Governor\'s office directly states the action and date.',
    candidates: [
      {
        tag: 'gov-veto',
        url: 'https://www.gov.ca.gov/wp-content/uploads/2024/09/SB-1047-Veto-Message.pdf',
        snippet: 'To the Members of the California State Senate: I am returning Senate Bill 1047 without my signature. SB 1047 magnifies the debate on how we regulate transformative AI. September 29, 2024. /s/ Gavin Newsom',
      },
      {
        tag: 'nyt',
        url: 'https://www.nytimes.com/2024/09/29/technology/california-ai-bill-veto.html',
        snippet: 'Gov. Gavin Newsom on Sunday vetoed a first-of-its-kind bill that would have imposed safety rules on large A.I. models. Critics of the bill, including OpenAI, Meta, and Google, argued it could stifle innovation. Supporters including Elon Musk had pushed for its passage.',
      },
      {
        tag: 'a16z-blog',
        url: 'https://a16z.com/sb-1047-what-does-it-mean-for-ai',
        snippet: 'SB 1047 is a piece of legislation that has sparked intense debate. This post walks through the bill\'s provisions and our concerns about its effects on open-source AI development and the broader tech ecosystem in California.',
      },
      {
        tag: 'decoy-older-bill',
        url: 'https://www.politico.com/article/ai-legislation-sb-53-california-2024',
        snippet: 'California is advancing SB 53, a narrower AI transparency bill, following the failure of last year\'s SB 1047. The new bill focuses on disclosure requirements for frontier model developers, avoiding the liability provisions that made SB 1047 controversial.',
      },
    ],
  },
  {
    id: 'gpt4-release',
    claim: 'GPT-4 was publicly released on March 14, 2023',
    claimQuestion: 'When was GPT-4 publicly released?',
    claimRetrieval: 'source confirming GPT-4 was publicly released on March 14, 2023',
    entityName: 'GPT-4',
    expectedIndex: 0,
    expectedReason: 'OpenAI\'s own announcement is the primary source and explicitly confirms the release date.',
    candidates: [
      {
        tag: 'openai-announce',
        url: 'https://openai.com/index/gpt-4-research',
        snippet: 'We\'ve created GPT-4, the latest milestone in OpenAI\'s effort in scaling up deep learning. GPT-4 is a large multimodal model. Released March 14, 2023. Available via ChatGPT Plus and the API.',
      },
      {
        tag: 'wikipedia',
        url: 'https://en.wikipedia.org/wiki/GPT-4',
        snippet: 'Generative Pre-trained Transformer 4 (GPT-4) is a multimodal large language model created by OpenAI. It was released on March 14, 2023, and made publicly available via ChatGPT Plus and the OpenAI API.',
      },
      {
        tag: 'techcrunch-late',
        url: 'https://techcrunch.com/2023/05/20/gpt-4-adoption-enterprise',
        snippet: 'Two months in, GPT-4 is seeing strong enterprise adoption. Since its launch earlier this year, developers have built thousands of apps on top of the model\'s multimodal and long-context capabilities.',
      },
      {
        tag: 'random-tutorial',
        url: 'https://medium.com/how-to-use-gpt-4-effectively',
        snippet: 'GPT-4 is a powerful model. In this post I\'ll walk through my favorite prompts for writing, coding, and research. Whether you\'re on ChatGPT Plus or using the API, these tips will save you hours every week.',
      },
    ],
  },
  {
    id: 'hinton-turing',
    claim: 'Geoffrey Hinton received the ACM A.M. Turing Award in 2018 (awarded jointly with Bengio and LeCun)',
    claimQuestion: 'Did Geoffrey Hinton receive the 2018 ACM A.M. Turing Award jointly with Bengio and LeCun?',
    claimRetrieval: 'source confirming Geoffrey Hinton received the 2018 ACM Turing Award with Bengio and LeCun',
    entityName: 'Geoffrey Hinton',
    expectedIndex: 0,
    expectedReason: 'ACM\'s official award page is the definitive primary source for Turing Award recipients.',
    candidates: [
      {
        tag: 'acm-official',
        url: 'https://amturing.acm.org/award_winners/hinton_4791679.cfm',
        snippet: 'Geoffrey E. Hinton is a co-recipient of the 2018 ACM A.M. Turing Award. Together with Yoshua Bengio and Yann LeCun, Hinton is recognized for conceptual and engineering breakthroughs that have made deep neural networks a critical component of computing.',
      },
      {
        tag: 'uoft-bio',
        url: 'https://www.cs.toronto.edu/~hinton',
        snippet: 'Geoffrey Hinton is Professor Emeritus at the University of Toronto and an Engineering Fellow at Google. He received his PhD in Artificial Intelligence from Edinburgh in 1978. His research has been widely recognized, including the Rumelhart Prize and the Turing Award.',
      },
      {
        tag: 'nobel-2024',
        url: 'https://www.nobelprize.org/prizes/physics/2024/hinton',
        snippet: 'The Royal Swedish Academy of Sciences has decided to award the Nobel Prize in Physics 2024 to John J. Hopfield and Geoffrey E. Hinton for foundational discoveries and inventions that enable machine learning with artificial neural networks.',
      },
      {
        tag: 'news-summary',
        url: 'https://venturebeat.com/hinton-retires-google-2023',
        snippet: 'Geoffrey Hinton, one of the "godfathers of AI," is leaving Google to speak more freely about AI risks. Hinton, a Turing Award winner and pioneer of deep learning, joins a growing chorus of former researchers sounding alarms about frontier models.',
      },
    ],
  },
  {
    id: 'olah-anthropic',
    claim: 'Chris Olah is a co-founder of Anthropic',
    claimQuestion: 'Is Chris Olah a co-founder of Anthropic?',
    claimRetrieval: 'source confirming Chris Olah is a co-founder of Anthropic',
    entityName: 'Chris Olah',
    expectedIndex: 0,
    expectedReason: 'Anthropic\'s official team page is the canonical source for co-founder/employee identity.',
    candidates: [
      {
        tag: 'anthropic-team',
        url: 'https://www.anthropic.com/company',
        snippet: 'Anthropic was founded in 2021 by Dario Amodei, Daniela Amodei, Tom Brown, Chris Olah, Sam McCandlish, Jack Clarke, and Jared Kaplan. We are an AI safety and research company working to build reliable, interpretable, and steerable AI systems.',
      },
      {
        tag: 'podcast-interview',
        url: 'https://www.dwarkeshpatel.com/p/chris-olah-interpretability',
        snippet: 'Chris Olah on what\'s inside language models. Chris and I talk about features, circuits, mechanistic interpretability, and why he thinks we might actually understand what\'s happening inside these models in the next few years.',
      },
      {
        tag: 'distill-bio',
        url: 'https://distill.pub/about',
        snippet: 'Distill is a scientific journal operating between 2016-2021. Founding editors include Chris Olah, Shan Carter, and Ludwig Schubert. We publish interactive articles explaining machine learning.',
      },
      {
        tag: 'wikipedia',
        url: 'https://en.wikipedia.org/wiki/Anthropic',
        snippet: 'Anthropic is an AI startup founded in 2021. The company was founded by former OpenAI researchers including Dario Amodei, Daniela Amodei, and others. Chris Olah, a well-known researcher in neural network interpretability, is among its co-founders.',
      },
    ],
  },
  {
    id: 'evals-paper-decoy',
    claim: 'The paper "Scaling Laws for Neural Language Models" (Kaplan et al.) was published in 2020',
    claimQuestion: 'When was the paper "Scaling Laws for Neural Language Models" by Kaplan et al. published?',
    claimRetrieval: 'source confirming the paper "Scaling Laws for Neural Language Models" by Kaplan et al. was published in 2020',
    entityName: 'Kaplan scaling laws paper',
    expectedIndex: 0,
    expectedReason: 'arXiv abstract page is the canonical primary source with the exact submission date.',
    candidates: [
      {
        tag: 'arxiv',
        url: 'https://arxiv.org/abs/2001.08361',
        snippet: 'Scaling Laws for Neural Language Models. Jared Kaplan, Sam McCandlish, Tom Henighan, Tom B. Brown, et al. Submitted January 23, 2020. We study empirical scaling laws for language model performance on the cross-entropy loss.',
      },
      {
        tag: 'semanticscholar',
        url: 'https://www.semanticscholar.org/paper/Scaling-Laws-Kaplan-McCandlish',
        snippet: 'This paper has been cited 5000+ times. Published in 2020 on arXiv. The authors establish power-law relationships between model size, dataset size, compute, and loss. Citations include GPT-3 and PaLM papers.',
      },
      {
        tag: 'chinchilla-decoy',
        url: 'https://arxiv.org/abs/2203.15556',
        snippet: 'Training Compute-Optimal Large Language Models. Jordan Hoffmann, Sebastian Borgeaud, et al. DeepMind. 2022. We revisit scaling laws and find prior work has trained models that are significantly undertrained; our new scaling law is often referred to as Chinchilla scaling.',
      },
      {
        tag: 'blog-summary',
        url: 'https://www.lesswrong.com/posts/kaplan-scaling-laws-explained',
        snippet: 'A walkthrough of the 2020 Kaplan et al. scaling laws paper. I\'ll try to explain the empirical findings in plain language, cover the loss-vs-compute trend, and discuss how this paper motivated much of the subsequent scaling frontier.',
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Rerank strategy (Cohere via OpenRouter)
// ---------------------------------------------------------------------------

interface RerankResult {
  pickedIndex: number;
  scores: number[];
  latencyMs: number;
  error?: string;
}

/**
 * Format a candidate as a YAML string — Cohere's own guidance says this
 * performs better than plain text for structured documents. We give the
 * model url + snippet explicitly so domain authority is part of the signal.
 *
 * Source: https://docs.cohere.com/docs/rerank-overview — "for best
 * performance we recommend formatting [structured documents] as YAML strings."
 */
function formatRerankDoc(c: Candidate): string {
  const snippet = c.snippet.replace(/\s+/g, ' ').trim();
  // Minimal YAML — quoted scalars to avoid punctuation parse issues.
  return `url: "${c.url}"\ncontent: "${snippet.replace(/"/g, '\\"')}"`;
}

async function runRerank(
  model: string,
  claim: string,
  candidates: Candidate[],
): Promise<RerankResult> {
  const t0 = Date.now();
  try {
    const response = await fetch(RERANK_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.longtermwiki.com',
        'X-Title': 'source-ranking-eval',
      },
      body: JSON.stringify({
        model,
        query: claim,
        documents: candidates.map(formatRerankDoc),
        top_n: candidates.length,
      }),
    });

    const latencyMs = Date.now() - t0;
    if (!response.ok) {
      const body = await response.text();
      return {
        pickedIndex: -1,
        scores: [],
        latencyMs,
        error: `HTTP ${response.status}: ${body.slice(0, 300)}`,
      };
    }

    const data = await response.json();
    // Cohere-style response: { results: [{ index, relevance_score }, ...] }
    // Already sorted by relevance_score descending.
    const results: Array<{ index: number; relevance_score: number }> =
      data.results ?? data.data ?? [];
    if (!Array.isArray(results) || results.length === 0) {
      return {
        pickedIndex: -1,
        scores: [],
        latencyMs,
        error: `Unexpected rerank response: ${JSON.stringify(data).slice(0, 300)}`,
      };
    }

    // Build scores array indexed by original candidate position
    const scores = new Array(candidates.length).fill(0);
    for (const r of results) {
      if (r.index >= 0 && r.index < candidates.length) {
        scores[r.index] = r.relevance_score;
      }
    }
    return {
      pickedIndex: results[0].index,
      scores,
      latencyMs,
    };
  } catch (e: unknown) {
    return {
      pickedIndex: -1,
      scores: [],
      latencyMs: Date.now() - t0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Haiku strategy (Anthropic Haiku via OpenRouter chat completions)
// ---------------------------------------------------------------------------

interface HaikuResult {
  pickedIndex: number;
  reasoning: string;
  latencyMs: number;
  costUsd: number;
  error?: string;
}

async function runHaiku(
  claim: string,
  entityName: string,
  candidates: Candidate[],
): Promise<HaikuResult> {
  const t0 = Date.now();
  const numbered = candidates
    .map(
      (c, i) =>
        `[${i}] URL: ${c.url}\n    Snippet: ${c.snippet.replace(/\s+/g, ' ').trim()}`,
    )
    .join('\n\n');

  const prompt = `You are verifying a factual claim. Pick the ONE source that BEST *directly supports* the specific claim below. Do not pick a source merely because it is topically related — pick the one whose content explicitly confirms the specific fact.

Claim: "${claim}"
Entity: ${entityName}

Candidates:
${numbered}

Respond in this exact JSON format, nothing else:
{"pickedIndex": N, "reasoning": "one sentence"}`;

  try {
    const response = await fetch(CHAT_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://www.longtermwiki.com',
        'X-Title': 'source-ranking-eval',
      },
      body: JSON.stringify({
        model: 'anthropic/claude-haiku-4.5',
        messages: [{ role: 'user', content: prompt }],
        temperature: 0,
        max_tokens: 200,
        usage: { include: true },
      }),
    });

    const latencyMs = Date.now() - t0;
    if (!response.ok) {
      const body = await response.text();
      return {
        pickedIndex: -1,
        reasoning: '',
        latencyMs,
        costUsd: 0,
        error: `HTTP ${response.status}: ${body.slice(0, 300)}`,
      };
    }

    const data = await response.json();
    const text: string = data.choices?.[0]?.message?.content ?? '';
    const cost: number = data.usage?.cost ?? 0;

    // Parse JSON — tolerate leading/trailing text
    const match = text.match(/\{[\s\S]*?\}/);
    if (!match) {
      return {
        pickedIndex: -1,
        reasoning: text.slice(0, 200),
        latencyMs,
        costUsd: cost,
        error: 'Could not parse JSON from Haiku response',
      };
    }
    const parsed = JSON.parse(match[0]);
    return {
      pickedIndex: typeof parsed.pickedIndex === 'number' ? parsed.pickedIndex : -1,
      reasoning: String(parsed.reasoning ?? '').slice(0, 200),
      latencyMs,
      costUsd: cost,
    };
  } catch (e: unknown) {
    return {
      pickedIndex: -1,
      reasoning: '',
      latencyMs: Date.now() - t0,
      costUsd: 0,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const RESET = '\x1b[0m';

function mark(correct: boolean): string {
  return correct ? `${GREEN}✓${RESET}` : `${RED}✗${RESET}`;
}

type QueryVariant = 'claim' | 'question' | 'retrieval';
const QUERY_VARIANTS: QueryVariant[] = ['claim', 'question', 'retrieval'];

function queryFor(scenario: Scenario, variant: QueryVariant): string {
  if (variant === 'question') return scenario.claimQuestion;
  if (variant === 'retrieval') return scenario.claimRetrieval;
  return scenario.claim;
}

interface PerScenarioResult {
  scenario: Scenario;
  reranks: Record<QueryVariant, RerankResult>;
  haiku: HaikuResult;
}

function printScenario(r: PerScenarioResult): void {
  const { scenario, reranks, haiku } = r;
  console.log('');
  console.log(`${BOLD}── ${scenario.id} ────────────────────────────────────────${RESET}`);
  console.log(`Claim:    ${scenario.claim}`);
  console.log(`Entity:   ${scenario.entityName}`);
  console.log(`${DIM}Expected: [${scenario.expectedIndex}] ${scenario.candidates[scenario.expectedIndex].tag}${RESET}`);
  console.log('');
  console.log(`${BOLD}Candidates (rerank scores: claim / question / retrieval):${RESET}`);
  for (let i = 0; i < scenario.candidates.length; i++) {
    const c = scenario.candidates[i];
    const isExpected = i === scenario.expectedIndex;
    const marker = isExpected ? '★' : ' ';
    const s1 = reranks.claim.scores[i]?.toFixed(3) ?? '—';
    const s2 = reranks.question.scores[i]?.toFixed(3) ?? '—';
    const s3 = reranks.retrieval.scores[i]?.toFixed(3) ?? '—';
    const pickFlags = [
      i === reranks.claim.pickedIndex ? 'Rc' : '',
      i === reranks.question.pickedIndex ? 'Rq' : '',
      i === reranks.retrieval.pickedIndex ? 'Rr' : '',
      i === haiku.pickedIndex ? 'H' : '',
    ].filter(Boolean).join(' ');
    console.log(
      `  ${marker} [${i}] ${c.tag.padEnd(20)} ${s1} / ${s2} / ${s3}${pickFlags ? `  ${YELLOW}[${pickFlags}]${RESET}` : ''}`,
    );
  }
  console.log('');
  for (const v of QUERY_VARIANTS) {
    const rr = reranks[v];
    if (rr.error) {
      console.log(`${RED}Rerank-${v} error:${RESET} ${rr.error}`);
    } else {
      const ok = rr.pickedIndex === scenario.expectedIndex;
      console.log(
        `  ${mark(ok)} Rerank-${v.padEnd(9)} picked [${rr.pickedIndex}] (${rr.latencyMs}ms)`,
      );
    }
  }
  if (haiku.error) {
    console.log(`${RED}Haiku error:${RESET} ${haiku.error}`);
  } else {
    const ok = haiku.pickedIndex === scenario.expectedIndex;
    console.log(
      `  ${mark(ok)} Haiku              picked [${haiku.pickedIndex}] (${haiku.latencyMs}ms, $${haiku.costUsd.toFixed(5)}) — ${haiku.reasoning}`,
    );
  }
}

function printSummary(
  results: PerScenarioResult[],
  rerankModel: string,
): void {
  const n = results.length;
  console.log('');
  console.log(`${BOLD}════════════ Summary ════════════${RESET}`);
  console.log(`Scenarios: ${n}`);
  console.log(`Rerank model: ${rerankModel}`);
  console.log(`Haiku model:  anthropic/claude-haiku-4.5`);
  console.log('');

  const correct: Record<string, number> = { claim: 0, question: 0, retrieval: 0, haiku: 0 };
  const latency: Record<string, number> = { claim: 0, question: 0, retrieval: 0, haiku: 0 };
  let haikuCost = 0;

  for (const r of results) {
    for (const v of QUERY_VARIANTS) {
      if (r.reranks[v].pickedIndex === r.scenario.expectedIndex) correct[v]++;
      latency[v] += r.reranks[v].latencyMs;
    }
    if (r.haiku.pickedIndex === r.scenario.expectedIndex) correct.haiku++;
    latency.haiku += r.haiku.latencyMs;
    haikuCost += r.haiku.costUsd;
  }

  console.log(`${'Method'.padEnd(28)}  Correct   Avg latency`);
  console.log(`${'-'.repeat(56)}`);
  for (const v of QUERY_VARIANTS) {
    console.log(
      `${('Rerank (' + v + ' query)').padEnd(28)}  ${String(correct[v]).padStart(2)}/${n}      ${Math.round(latency[v] / n)}ms`,
    );
  }
  console.log(
    `${'Haiku (claim-entailment)'.padEnd(28)}  ${String(correct.haiku).padStart(2)}/${n}      ${Math.round(latency.haiku / n)}ms  ($${(haikuCost / n).toFixed(5)}/call)`,
  );

  console.log('');
  console.log(`${BOLD}Per-scenario picks (E=expected):${RESET}`);
  console.log(
    `${'scenario'.padEnd(24)}  ${'claim'.padEnd(18)} ${'question'.padEnd(18)} ${'retrieval'.padEnd(18)} ${'haiku'.padEnd(18)}`,
  );
  console.log('-'.repeat(24 + 4 + 18 * 4 + 3));
  for (const r of results) {
    const row: string[] = [r.scenario.id.padEnd(24)];
    for (const v of QUERY_VARIANTS) {
      const tag = r.scenario.candidates[r.reranks[v].pickedIndex]?.tag ?? 'ERR';
      const ok = r.reranks[v].pickedIndex === r.scenario.expectedIndex ? GREEN : RED;
      row.push(`${ok}${tag.padEnd(18)}${RESET}`);
    }
    const htag = r.scenario.candidates[r.haiku.pickedIndex]?.tag ?? 'ERR';
    const hok = r.haiku.pickedIndex === r.scenario.expectedIndex ? GREEN : RED;
    row.push(`${hok}${htag.padEnd(18)}${RESET}`);
    row.push(`${DIM}(E=${r.scenario.candidates[r.scenario.expectedIndex].tag})${RESET}`);
    console.log('  ' + row.join(' '));
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  if (!OPENROUTER_KEY) {
    console.error('OPENROUTER_API_KEY not set. Exiting.');
    process.exit(1);
  }

  // Parse flags: --only=X, --rerank=model
  let onlyId: string | undefined;
  let rerankModel = 'cohere/rerank-4-pro';
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith('--only=')) onlyId = arg.slice('--only='.length);
    else if (arg.startsWith('--rerank=')) rerankModel = arg.slice('--rerank='.length);
  }

  const scenarios = onlyId ? SCENARIOS.filter((s) => s.id === onlyId) : SCENARIOS;
  if (scenarios.length === 0) {
    console.error(`No scenarios matched --only=${onlyId}`);
    console.error(`Known ids: ${SCENARIOS.map((s) => s.id).join(', ')}`);
    process.exit(1);
  }

  console.log(`${BOLD}Source-ranking comparison${RESET}`);
  console.log(`Rerank model: ${rerankModel}`);
  console.log(`Haiku model:  anthropic/claude-haiku-4.5`);
  console.log(`Scenarios:    ${scenarios.length}`);

  const results: PerScenarioResult[] = [];

  for (const scenario of scenarios) {
    // Sequential (not parallel) so the progress output is readable.
    // Three rerank variants + one Haiku call per scenario.
    const [claimR, questionR, retrievalR, haiku] = await Promise.all([
      runRerank(rerankModel, scenario.claim, scenario.candidates),
      runRerank(rerankModel, scenario.claimQuestion, scenario.candidates),
      runRerank(rerankModel, scenario.claimRetrieval, scenario.candidates),
      runHaiku(scenario.claim, scenario.entityName, scenario.candidates),
    ]);
    const reranks = {
      claim: claimR,
      question: questionR,
      retrieval: retrievalR,
    } as Record<QueryVariant, RerankResult>;
    const r: PerScenarioResult = { scenario, reranks, haiku };
    printScenario(r);
    results.push(r);
  }

  printSummary(results, rerankModel);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
