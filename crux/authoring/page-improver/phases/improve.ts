/**
 * Improve Phase
 *
 * Generates improved content using analysis, research, and LLM synthesis.
 * Handles entity lookup, frontmatter repair, and related-pages stripping.
 */

import fs from 'fs';
import { MODELS } from '../../../lib/anthropic.ts';
import { buildEntityLookupForContent } from '../../../lib/entity-lookup.ts';
import { convertSlugsToNumericIds } from '../../creator/deployment.ts';
import { convertNewFootnotes } from '../../../lib/convert-new-footnotes.ts';
import type { PageData, AnalysisResult, ResearchResult, PipelineOptions } from '../types.ts';
import {
  ROOT, log, getFilePath, getImportPath, writeTemp,
  repairFrontmatter, stripRelatedPagesSections, buildObjectivityContext,
} from '../utils.ts';
import { runAgent } from '../api.ts';
import { IMPROVE_PROMPT } from './prompts.ts';

export async function improvePhase(page: PageData, analysis: AnalysisResult, research: ResearchResult, directions: string, options: PipelineOptions, contentOverride?: string): Promise<string> {
  log('improve', 'Starting improvements');

  const filePath = getFilePath(page.path);
  // Use contentOverride if provided (e.g., adversarial loop iterating on in-memory content),
  // otherwise read from disk (initial improve pass).
  const currentContent = contentOverride ?? fs.readFileSync(filePath, 'utf-8');
  const importPath = getImportPath();

  const objectivityContext = buildObjectivityContext(page, analysis);

  log('improve', 'Building entity lookup table...');
  const entityLookup = buildEntityLookupForContent(currentContent, ROOT);
  const entityLookupCount = entityLookup.split('\n').filter(Boolean).length;
  log('improve', `  Found ${entityLookupCount} relevant entities for lookup`);

  const tier = options.tier || 'standard';
  const prompt = IMPROVE_PROMPT({
    page, filePath, importPath, directions,
    analysis, research, objectivityContext,
    currentContent, entityLookup, claimsContext: null,
    gapAnalysisContext: null, tier,
  });

  const result = await runAgent(prompt, {
    model: options.improveModel || MODELS.sonnet,
    maxTokens: 16000
  });

  let improvedContent: string = result;

  // Strategy 1: If the response starts with frontmatter, use it directly.
  // Strategy 2: Extract content from markdown code fences (```mdx, ```markdown, ```json, or bare ```)
  // Strategy 3: Detect JSON-wrapped responses with "content" field and extract the markdown.
  // Strategy 4: Fall back to original content if nothing looks like valid MDX.
  if (!improvedContent.startsWith('---')) {
    // Scan all code blocks and prefer the one whose content is valid MDX (starts with ---).
    // The non-greedy single-match regex previously picked the *first* code block, which
    // could be a JSON analysis blob preceding the actual MDX output — causing silent
    // corruption of the page file. See: fix-footer-rendering-ttIYJ.
    const codeBlocks = [...result.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g)];
    const mdxBlock = codeBlocks.find(m => m[1].trimStart().startsWith('---'));
    if (mdxBlock) {
      improvedContent = mdxBlock[1];
    } else if (codeBlocks.length > 0) {
      // Fallback: use the largest code block (most likely to be the full MDX)
      const largest = codeBlocks.reduce((a, b) => a[1].length >= b[1].length ? a : b);
      improvedContent = largest[1];
    }

    // Detect JSON-wrapped responses: {"content": "...", "claimMap": [...]}
    // The LLM sometimes returns structured JSON instead of raw MDX.
    const contentFieldMatch = improvedContent.match(/"content"\s*:\s*"((?:[^"\\]|\\.)*)"/s);
    if (contentFieldMatch) {
      log('improve', '⚠ Detected JSON-wrapped response — extracting "content" field');
      try {
        // Unescape JSON string: \n → newline, \" → ", \\ → \, \t → tab
        const extracted = JSON.parse(`"${contentFieldMatch[1]}"`);
        if (typeof extracted === 'string' && extracted.length > 100) {
          improvedContent = extracted;
        }
      } catch {
        // JSON.parse may fail on truncated strings — try manual unescaping
        let raw = contentFieldMatch[1];
        let manual = '';
        for (let i = 0; i < raw.length; i++) {
          if (raw[i] === '\\' && i + 1 < raw.length) {
            const next = raw[i + 1];
            if (next === 'n') { manual += '\n'; i++; }
            else if (next === '"') { manual += '"'; i++; }
            else if (next === '\\') { manual += '\\'; i++; }
            else if (next === 't') { manual += '\t'; i++; }
            else { manual += raw[i]; }
          } else {
            manual += raw[i];
          }
        }
        if (manual.length > 100) {
          log('improve', '  Used manual unescaping for truncated JSON content string');
          improvedContent = manual;
        }
      }
    }
  }

  // Validate: improved content should look like MDX (start with frontmatter or heading).
  // If it looks like raw JSON or garbage, fall back to original content.
  const trimmed = improvedContent.trim();
  if (
    !trimmed.startsWith('---') &&
    !trimmed.startsWith('#') &&
    !trimmed.startsWith('import ') &&
    !trimmed.startsWith('<')
  ) {
    log('improve', `⚠ Response does not look like MDX (starts with "${trimmed.substring(0, 40)}...") — keeping original`);
    return currentContent;
  }

  // Guard against LLM truncation: if output is significantly shorter than input,
  // the LLM likely hit maxTokens and returned incomplete content.
  const inputWords = currentContent.split(/\s+/).length;
  const outputWords = improvedContent.split(/\s+/).length;
  if (outputWords < inputWords * 0.5 && inputWords > 200) {
    log('improve', `⚠ Truncation detected: output (${outputWords} words) < 50% of input (${inputWords} words) — keeping original`);
    return currentContent;
  }

  // Update lastEdited in frontmatter
  const today = new Date().toISOString().split('T')[0];
  improvedContent = improvedContent.replace(
    /lastEdited:\s*["']?\d{4}-\d{2}-\d{2}["']?/,
    `lastEdited: "${today}"`
  );

  improvedContent = repairFrontmatter(improvedContent);
  improvedContent = stripRelatedPagesSections(improvedContent);

  const { content: convertedContent, converted: slugsConverted } = convertSlugsToNumericIds(improvedContent, ROOT);
  if (slugsConverted > 0) {
    log('improve', `  Converted ${slugsConverted} remaining slug-based EntityLink ID(s) to E## format`);
    improvedContent = convertedContent;
  }

  // Convert numbered footnotes [^N] to [^kb-factId] or [^rc-XXXX] references.
  // KB fact matching is attempted first when the page has a corresponding KB entity.
  // DB entries are NOT created here (dry-run semantics) — they are created
  // when the pipeline applies changes via --apply. This step only rewrites
  // the footnote format in the content string.
  try {
    const fnResult = await convertNewFootnotes(improvedContent, page.id, {
      createDbEntries: false,
      entityId: page.id,
    });
    if (fnResult.convertedCount > 0) {
      const parts: string[] = [];
      if (fnResult.kbMatchCount > 0) {
        parts.push(`${fnResult.kbMatchCount} to [^kb-...] (KB fact match)`);
      }
      const rcCount = fnResult.convertedCount - fnResult.kbMatchCount;
      if (rcCount > 0) {
        parts.push(`${rcCount} to [^rc-XXXX]`);
      }
      log('improve', `  Converted ${fnResult.convertedCount} numbered footnote(s): ${parts.join(', ')}`);
      improvedContent = fnResult.content;
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('improve', `  Footnote conversion failed: ${error.message} — continuing with numbered footnotes`);
  }

  writeTemp(page.id, 'improved.mdx', improvedContent);
  log('improve', 'Complete');
  return improvedContent;
}
