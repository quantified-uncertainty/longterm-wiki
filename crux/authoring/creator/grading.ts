/**
 * Grading Module
 *
 * Grades generated articles for quality using Claude API.
 */

import fs from 'fs';
import path from 'path';
import { createClient, parseJsonResponse } from '../../lib/anthropic.ts';
import { appendEditLog } from '../../lib/edit-log.ts';

interface GradingContext {
  log: (phase: string, message: string) => void;
  saveResult: (topic: string, filename: string, data: unknown) => string;
  getTopicDir: (topic: string) => string;
}

interface GradingRatings {
  novelty: number;
  rigor: number;
  actionability: number;
  completeness: number;
}

interface GradingResult {
  importance: number;
  ratings: GradingRatings;
  llmSummary?: string;
  balanceFlags?: string[];
  reasoning?: string;
}

interface Frontmatter {
  title?: string;
  description?: string;
  importance?: number;
  ratings?: GradingRatings;
  quality?: number;
  llmSummary?: string;
  balanceFlags?: string[];
  metrics?: {
    wordCount: number;
    citations: number;
    tables: number;
    diagrams: number;
  };
  [key: string]: unknown;
}

const GRADING_SYSTEM_PROMPT = `You are an expert evaluator of AI safety content. Score this page on:

- importance (0-100): How significant for understanding AI risk
- quality dimensions (0-10 each): novelty, rigor, actionability, completeness
- llmSummary: 1-2 sentence summary with key conclusions
- balanceFlags: Array of any balance/bias issues detected (see below)

Be harsh but fair. Typical wiki content scores 3-5 on quality dimensions. 7+ is exceptional.

IMPORTANT: This content may describe events after your knowledge cutoff. If the article cites specific sources (URLs, publications, official announcements), assume the described events are real even if you're unfamiliar with them. Do NOT mark well-sourced content as "fictional" or "fabricated" just because you haven't heard of it. Evaluate based on the quality of sourcing, writing, and relevance to AI safety.

BALANCE CHECK - Flag these issues in balanceFlags array:
- "no-criticism-section": Article lacks a Criticisms, Concerns, or Limitations section
- "single-source-dominance": >50% of citations come from one source (e.g., company's own blog)
- "missing-source-incentives": For controversial claims, source's incentives aren't discussed
- "one-sided-framing": Article presents only positive OR only negative perspective without balance
- "uncritical-claims": Major claims presented as fact without attribution ("X is..." vs "X claims...")

BIOGRAPHICAL/ORGANIZATIONAL ACCURACY FLAGS (apply to person & org pages):
- "unsourced-biographical-details": Specific dates, roles, credentials, or achievements stated without citation
- "missing-primary-sources": No links to official websites, CVs, LinkedIn, company filings, or direct statements
- "unverified-quotes": Attributed quotes that may not be verbatim from a cited source
- "speculative-motivations": Attributing specific motivations or reasoning to a person without a direct quote or source

IMPORTANCE guidelines:
- 90-100: Essential for prioritization decisions
- 70-89: High value for practitioners
- 50-69: Useful context
- 30-49: Reference material
- 0-29: Peripheral or stubs

Respond with valid JSON only.`;

export async function runGrading(topic: string, { log, saveResult, getTopicDir }: GradingContext): Promise<{ success: boolean; error?: string; importance?: number; quality?: number; ratings?: GradingRatings; llmSummary?: string }> {
  log('grade', 'Running quality grading on temp file...');

  const finalPath = path.join(getTopicDir(topic), 'final.mdx');
  if (!fs.existsSync(finalPath)) {
    log('grade', 'No final.mdx found, skipping grading');
    return { success: false, error: 'No final.mdx found' };
  }

  const content = fs.readFileSync(finalPath, 'utf-8');

  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) {
    log('grade', 'Could not parse frontmatter');
    return { success: false, error: 'Invalid frontmatter' };
  }

  const [, fmYaml, body] = fmMatch;

  let frontmatter: Frontmatter;
  try {
    const { parse: parseYaml } = await import('yaml');
    frontmatter = parseYaml(fmYaml) as Frontmatter;
  } catch (err: unknown) {
    const e = err instanceof Error ? err : new Error(String(err));
    log('grade', `Frontmatter parse error: ${e.message}`);
    return { success: false, error: 'Frontmatter parse error' };
  }

  const title = frontmatter.title || topic;
  const description = frontmatter.description || '';

  log('grade', 'Calling Claude for grading...');

  try {
    const client = createClient();
    if (!client) {
      return { success: false, error: 'Anthropic API key not configured' };
    }

    const userPrompt = `Grade this content page:

**Title**: ${title}
**Description**: ${description}

---
FULL CONTENT:
${body.slice(0, 30000)}
---

Respond with JSON:
{
  "importance": <0-100>,
  "ratings": {
    "novelty": <0-10>,
    "rigor": <0-10>,
    "actionability": <0-10>,
    "completeness": <0-10>
  },
  "llmSummary": "<1-2 sentences with conclusions>",
  "balanceFlags": ["<flag-id>", ...] or [] if none,
  "reasoning": "<brief explanation>"
}`;

    const response = await client.messages.create({
      model: 'claude-sonnet-4-5-20250929',
      max_tokens: 800,
      system: GRADING_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const block = response.content[0];
    if (!block || block.type !== 'text') {
      return { success: false, error: 'Expected text response from API' };
    }
    const text = block.text;
    const grades = parseJsonResponse(text) as GradingResult | null;

    if (!grades || !grades.importance) {
      log('grade', 'Invalid grading response');
      return { success: false, error: 'Invalid response' };
    }

    log('grade', `Importance: ${grades.importance}, Quality: ${Math.round((grades.ratings.novelty + grades.ratings.rigor + grades.ratings.actionability + grades.ratings.completeness) * 2.5)}`);

    const balanceFlags = grades.balanceFlags || [];
    if (balanceFlags.length > 0) {
      log('grade', `Balance issues detected:`);
      for (const flag of balanceFlags) {
        log('grade', `   - ${flag}`);
      }
    } else {
      log('grade', `No balance issues detected`);
    }

    const quality = Math.round(
      (grades.ratings.novelty + grades.ratings.rigor +
       grades.ratings.actionability + grades.ratings.completeness) * 2.5
    );

    // Update frontmatter
    frontmatter.importance = grades.importance;
    frontmatter.ratings = grades.ratings;
    frontmatter.quality = quality;
    frontmatter.llmSummary = grades.llmSummary;
    if (balanceFlags.length > 0) {
      frontmatter.balanceFlags = balanceFlags;
    }

    // Metrics (wordCount, citations, tables, diagrams) are computed at build time
    // by app/scripts/lib/metrics-extractor.mjs — not stored in frontmatter.
    delete frontmatter.metrics;

    // Write updated file
    const { stringify: stringifyYaml } = await import('yaml');
    let yamlStr = stringifyYaml(frontmatter);
    yamlStr = yamlStr.replace(/^(lastEdited:\s*)(\d{4}-\d{2}-\d{2})$/m, '$1"$2"');
    const newContent = `---\n${yamlStr}---\n${body}`;
    fs.writeFileSync(finalPath, newContent);

    // Use sanitized topic as page ID (matches deployment.ts slug derivation).
    // Do NOT use pageIdFromPath(finalPath) — finalPath is a temp dir path
    // like .claude/temp/page-creator/topic/final.mdx which would resolve to "final".
    const pageId = topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    appendEditLog(pageId, {
      tool: 'crux-grade',
      agency: 'automated',
      note: `Initial creation grading: quality=${quality}, importance=${grades.importance}`,
    });

    log('grade', `Graded: imp=${grades.importance}, qual=${quality}`);
    log('grade', `  Summary: ${grades.llmSummary?.slice(0, 100)}...`);

    return {
      success: true,
      importance: grades.importance,
      quality,
      ratings: grades.ratings,
      llmSummary: grades.llmSummary
    };

  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('grade', `Grading API error: ${error.message}`);
    return { success: false, error: error.message };
  }
}
