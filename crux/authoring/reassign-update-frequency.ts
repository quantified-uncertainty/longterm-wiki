#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Reassign Update Frequency Based on Volatility
 *
 * The bootstrap assigned update_frequency based on importance scores, but
 * importance != volatility. This script uses a hybrid approach:
 *   1. Rule-based heuristics for clear categories (subcategory, path)
 *   2. Claude Haiku for ambiguous cases
 *
 * Target distribution (~451 pages):
 *   3d:  ~5-10    (top AI labs, active breaking legislation)
 *   7d:  ~30-50   (active orgs, people in the news, fast-moving governance)
 *   21d: ~100-150 (moderately active areas, smaller orgs, active debates)
 *   45d: ~150-200 (established concepts, historical, less active orgs)
 *   90d: ~80-100  (theoretical frameworks, models, settled arguments)
 *
 * Usage:
 *   node crux/authoring/reassign-update-frequency.ts              # Dry run
 *   node crux/authoring/reassign-update-frequency.ts --apply      # Apply changes
 *   node crux/authoring/reassign-update-frequency.ts --verbose    # Show all decisions
 */

import { readFileSync, writeFileSync } from 'fs';
import { relative } from 'path';
import { fileURLToPath } from 'url';
import Anthropic from '@anthropic-ai/sdk';
import { CONTENT_DIR_ABS as CONTENT_DIR } from '../lib/content-types.ts';
import { findMdxFiles } from '../lib/file-utils.ts';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const VALID_FREQUENCIES: number[] = [3, 7, 21, 45, 90];
const CONCURRENCY = 10;
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Rule-based heuristics
// ---------------------------------------------------------------------------

/**
 * Subcategory-based defaults. These provide a starting point.
 * "null" means "use Haiku to decide."
 */
const SUBCATEGORY_DEFAULTS: Record<string, number> = {
  // Fast-moving orgs
  'labs': 7,                          // AI labs are fast-moving

  // Active governance
  'governance-legislation': 7,        // Active legislation changes weekly
  'governance': 21,
  'governance-international': 21,
  'governance-industry': 21,
  'governance-compute-governance': 21,
  'government': 21,
  'political-advocacy': 21,

  // Organizations - safety orgs have monthly news, others less so
  'safety-orgs': 21,
  'epistemic-orgs': 45,
  'biosecurity-orgs': 45,
  'community-building': 45,
  'field-building': 45,
  'institutions': 45,

  // Finance/funders
  'funders': 45,
  'finance': 21,
  'venture-capital': 21,

  // Active research areas (monthly developments)
  'alignment-evaluation': 21,
  'alignment-training': 45,
  'alignment-deployment': 21,
  'alignment-interpretability': 21,
  'alignment-policy': 21,
  'alignment': 21,
  'misuse': 21,
  'biosecurity': 21,
  'resilience': 45,

  // Conceptual/analytical (slow)
  'epistemic': 45,
  'epistemic-tools-tools': 45,
  'epistemic-tools-approaches': 45,
  'epistemic-tools': 45,
  'organizational-practices': 45,
  'track-records': 45,

  // Factors/structural (slow)
  'factors-civilizational-competence': 45,
  'factors-misalignment-potential': 45,
  'factors-misuse-potential': 45,
  'factors-ai-uses': 45,
  'factors-ai-capabilities': 45,
  'factors-ai-ownership': 45,
  'factors-transition-turbulence': 45,
  'factors': 45,
  'structural': 45,
  'accident': 45,

  // Theoretical models/frameworks (very slow)
  'domain-models': 90,
  'risk-models': 90,
  'societal-models': 90,
  'governance-models': 90,
  'analysis-models': 90,
  'dynamics-models': 90,
  'safety-models': 90,
  'intervention-models': 90,
  'impact-models': 90,
  'timeline-models': 90,
  'cascade-models': 90,
  'framework-models': 90,
  'threshold-models': 90,
  'race-models': 90,
  'alignment-theoretical': 90,
  'formal-arguments': 90,
  'models': 90,

  // Scenarios (slow)
  'scenarios-long-term-lockin': 45,
  'scenarios-ai-takeover': 45,
  'scenarios-human-catastrophe': 45,
  'scenarios': 45,
  'outcomes': 45,
};

interface PageData {
  filePath: string;
  title: string;
  subcategory: string | null;
  importance: string | null;
  currentFreq: number;
  firstParagraph: string;
  path: string;
  content: string;
}

interface ClassificationResult {
  frequency: number;
  reason: string;
  source: string;
}

interface PageResult extends PageData, ClassificationResult {}

/**
 * Path-based heuristics (applied when no subcategory match)
 */
function getPathDefault(pagePath: string): number | null {
  if (pagePath.includes('history')) return 90;
  if (pagePath.includes('models/')) return 90;
  if (pagePath.includes('people/')) return 45;
  if (pagePath.includes('cruxes/')) return 45;
  if (pagePath.includes('scenarios/')) return 45;
  if (pagePath.includes('worldviews/')) return 45;
  // organizations/ without a subcategory match → let Haiku decide
  return null; // ambiguous
}

/**
 * Exact title matches for specific known entities.
 * Only matches the EXACT title, not substrings.
 */
const TITLE_EXACT_OVERRIDES: Record<string, number> = {
  // Top labs → 3d (only the main org page)
  'OpenAI': 3,
  'Anthropic': 3,
  'Google DeepMind': 3,
  'Meta AI (FAIR)': 3,
  'xAI': 3,
  'Microsoft AI': 7,

  // Active governance entities → 7d
  'OpenAI Foundation': 7,
  'OpenAI Foundation Governance Paradox': 7,
  'Musk v. OpenAI Lawsuit': 7,

  // Active legislation → 7d
  'California SB 1047': 7,
  'California SB 53': 7,
  'EU AI Act': 7,

  // Active people → 7d
  'Sam Altman': 7,
  'Dario Amodei': 7,
  'Elon Musk': 7,

  // Analytical pages about labs → use subcategory/path instead (no override)
};

function ruleBasedClassify(page: PageData): ClassificationResult | null {
  // 1. Check exact title overrides
  if (TITLE_EXACT_OVERRIDES[page.title] != null) {
    return {
      frequency: TITLE_EXACT_OVERRIDES[page.title],
      reason: `title: ${page.title}`,
      source: 'rule',
    };
  }

  // 2. Check subcategory
  if (page.subcategory && SUBCATEGORY_DEFAULTS[page.subcategory] != null) {
    return {
      frequency: SUBCATEGORY_DEFAULTS[page.subcategory],
      reason: `subcategory: ${page.subcategory}`,
      source: 'rule',
    };
  }

  // 3. Check path
  const pathFreq = getPathDefault(page.path);
  if (pathFreq != null) {
    return { frequency: pathFreq, reason: `path: ${page.path}`, source: 'rule' };
  }

  // 4. No rule matched → needs Haiku
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): Record<string, string> {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const lines = match[1].split('\n');
  const result: Record<string, string> = {};
  for (const line of lines) {
    const kv = line.match(/^(\w[\w_]*):\s*(.+)$/);
    if (kv) {
      let val = kv[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      result[kv[1]] = val;
    }
  }
  return result;
}

function getFirstParagraph(content: string): string {
  const match = content.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
  if (!match) return '';
  const body = match[1];
  const lines = body.split('\n');
  const paragraph: string[] = [];
  let inParagraph = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (inParagraph) break;
      continue;
    }
    if (trimmed.startsWith('import ')) continue;
    if (trimmed.startsWith('<') && !trimmed.startsWith('<a')) continue;
    if (trimmed.startsWith('#')) continue;
    if (trimmed.startsWith('```')) continue;
    if (trimmed.startsWith('export ')) continue;

    inParagraph = true;
    paragraph.push(trimmed);
  }

  const text = paragraph.join(' ');
  const words = text.split(/\s+/);
  return words.slice(0, 150).join(' ');
}

function getPathContext(filePath: string): string {
  const rel = relative(CONTENT_DIR, filePath);
  const parts = rel.split('/');
  parts.pop();
  return parts.join('/');
}

function replaceUpdateFrequency(content: string, newFreq: number): string {
  return content.replace(
    /^(update_frequency:\s*)\d+/m,
    `$1${newFreq}`
  );
}

// ---------------------------------------------------------------------------
// Claude API (for ambiguous pages only)
// ---------------------------------------------------------------------------

async function classifyWithHaiku(client: Anthropic, page: PageData, retries: number = 0): Promise<ClassificationResult> {
  const prompt: string = `Classify this AI safety wiki page by how often the UNDERLYING SUBJECT changes in reality. This is about volatility of the real-world topic, NOT importance.

Title: ${page.title}
Path: ${page.path}
Current frequency: ${page.currentFreq}d

First paragraph:
${page.firstParagraph || '(no content)'}

STRICT RULES - follow these exactly:
- 3: ONLY for the 3-4 biggest AI labs (OpenAI, Anthropic, DeepMind) and actively-debated legislation
- 7: Active organizations that generate weekly news, specific people currently making news, active policy developments with weekly changes
- 21: Research areas with monthly developments, smaller orgs, ongoing debates, metrics/benchmarks that update monthly
- 45: Established concepts, historical analysis, less active orgs, theoretical topics, risk scenarios, epistemic tools, crux pages
- 90: Abstract models, theoretical frameworks, formal arguments, settled debates, deceased persons, pure history, analytical constructs

DEFAULTS by page type (deviate ONLY with strong reason):
- Any page about a "model" (analytical framework) → 90
- Concept/theory pages → 45
- History pages → 90
- Crux/debate pages → 45
- Risk scenario pages → 45
- Worldview pages → 45
- Capabilities pages (LLMs, benchmarks) → 21
- Metrics/tracking pages → 21
- Specific org pages → 21
- Specific person pages → 45

The wiki has ~450 pages. Target: ~5 at 3d, ~40 at 7d, ~125 at 21d, ~175 at 45d, ~100 at 90d.
Most pages should be 45d or higher. Be CONSERVATIVE. When in doubt, go SLOWER (higher number).

Return ONLY: {"frequency": N, "reason": "5 words max"}`;

  try {
    const response = await client.messages.create({
      model: 'claude-3-5-haiku-20241022',
      max_tokens: 60,
      messages: [{ role: 'user', content: prompt }],
    });

    const block = response.content[0];
    if (!block || block.type !== 'text') throw new Error('No text block in response');
    const text = block.text.trim();
    const jsonMatch = text.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error(`No JSON: ${text}`);

    const parsed: { frequency: number; reason: string } = JSON.parse(jsonMatch[0]);
    const freq = Number(parsed.frequency);

    if (!VALID_FREQUENCIES.includes(freq)) {
      throw new Error(`Invalid frequency ${freq}`);
    }

    return { frequency: freq, reason: parsed.reason, source: 'haiku' };
  } catch (err: unknown) {
    if (retries < MAX_RETRIES) {
      const delay = Math.pow(2, retries) * 1000;
      await new Promise<void>(r => setTimeout(r, delay));
      return classifyWithHaiku(client, page, retries + 1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const apply: boolean = args.includes('--apply');
  const verbose: boolean = args.includes('--verbose');

  const client = new Anthropic();

  // Collect all pages that have update_frequency
  const files = findMdxFiles(CONTENT_DIR);
  const pages: PageData[] = [];

  for (const filePath of files) {
    if (filePath.endsWith('index.mdx') || filePath.endsWith('index.md')) continue;

    const content = readFileSync(filePath, 'utf-8');
    const fm = parseFrontmatter(content);

    if (!fm.update_frequency) continue;
    if (fm.pageType === 'stub' || fm.pageType === 'documentation' || fm.pageType === '"documentation"') continue;

    pages.push({
      filePath,
      title: fm.title || relative(CONTENT_DIR, filePath),
      subcategory: fm.subcategory || null,
      importance: fm.importance || null,
      currentFreq: Number(fm.update_frequency),
      firstParagraph: getFirstParagraph(content),
      path: getPathContext(filePath),
      content,
    });
  }

  console.log(`\nReassign Update Frequency (Volatility-Based)`);
  console.log('\u2500'.repeat(55));
  console.log(`  Pages to classify: ${pages.length}`);
  console.log(`  Mode: ${apply ? 'APPLY' : 'DRY RUN'}`);
  console.log('');

  // Phase 1: Rule-based classification
  const ruleResults: PageResult[] = [];
  const needsHaiku: PageData[] = [];

  for (const page of pages) {
    const result = ruleBasedClassify(page);
    if (result) {
      ruleResults.push({ ...page, ...result });
    } else {
      needsHaiku.push(page);
    }
  }

  console.log(`  Rule-based: ${ruleResults.length} pages`);
  console.log(`  Needs Haiku: ${needsHaiku.length} pages`);
  console.log('');

  // Phase 2: Haiku classification for ambiguous pages
  const haikuResults: PageResult[] = [];
  let processed = 0;
  let errors = 0;

  for (let i = 0; i < needsHaiku.length; i += CONCURRENCY) {
    const batch = needsHaiku.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.allSettled(
      batch.map(page => classifyWithHaiku(client, page))
    );

    for (let j = 0; j < batch.length; j++) {
      const page = batch[j];
      const result = batchResults[j];
      processed++;

      if (result.status === 'rejected') {
        errors++;
        const reason = result.reason instanceof Error ? result.reason : new Error(String(result.reason));
        console.error(`  ERROR ${page.title}: ${reason.message}`);
        haikuResults.push({ ...page, frequency: page.currentFreq, reason: 'ERROR', source: 'error' });
        continue;
      }

      haikuResults.push({ ...page, ...result.value });
    }

    process.stderr.write(`\r  Haiku progress: ${processed}/${needsHaiku.length} (${errors} errors)`);
  }

  if (needsHaiku.length > 0) console.log('');

  // Combine results
  const allResults: PageResult[] = [...ruleResults, ...haikuResults];

  // Apply changes
  let changeCount = 0;
  for (const r of allResults) {
    const changed: boolean = r.frequency !== r.currentFreq;

    if (changed) {
      changeCount++;
      const arrow: string = r.currentFreq > r.frequency ? '\u2193' : '\u2191';
      console.log(`  ${String(r.currentFreq + 'd').padEnd(4)} \u2192 ${String(r.frequency + 'd').padEnd(4)} ${arrow} ${r.title} [${r.source}] (${r.reason})`);

      if (apply) {
        const newContent = replaceUpdateFrequency(r.content, r.frequency);
        writeFileSync(r.filePath, newContent, 'utf-8');
      }
    } else if (verbose) {
      console.log(`  ${String(r.frequency + 'd').padEnd(4)}  =  ${r.title} [${r.source}]`);
    }
  }

  console.log('');

  // Summary
  console.log('\u2500'.repeat(55));
  console.log(`  Total processed: ${allResults.length}`);
  console.log(`  Changed:         ${changeCount}`);
  console.log(`  Unchanged:       ${allResults.length - changeCount}`);
  console.log(`  Errors:          ${errors}`);
  console.log('');

  // Distribution
  const beforeDist: Record<string, number> = {};
  const afterDist: Record<string, number> = {};
  for (const r of allResults) {
    beforeDist[r.currentFreq + 'd'] = (beforeDist[r.currentFreq + 'd'] || 0) + 1;
    afterDist[r.frequency + 'd'] = (afterDist[r.frequency + 'd'] || 0) + 1;
  }

  console.log('Frequency Distribution:');
  console.log('  Freq    Before  After   Target');
  const targets: Record<string, string> = { '3d': '5-10', '7d': '30-50', '21d': '100-150', '45d': '150-200', '90d': '80-100' };
  for (const f of ['3d', '7d', '21d', '45d', '90d']) {
    const before: number = beforeDist[f] || 0;
    const after: number = afterDist[f] || 0;
    const diff: number = after - before;
    const diffStr: string = diff > 0 ? `+${diff}` : diff < 0 ? `${diff}` : '  0';
    console.log(`  ${f.padEnd(5)}  ${String(before).padStart(5)}  ${String(after).padStart(5)} (${diffStr.padStart(4)})  [${targets[f]}]`);
  }

  if (!apply && changeCount > 0) {
    console.log(`\nDry run complete. Use --apply to write changes.`);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
