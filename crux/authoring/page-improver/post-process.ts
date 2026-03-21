/**
 * Post-processing for LLM improve results.
 *
 * Shared between the interactive improve pipeline (improvePhase) and the
 * batch-improve path (auto-update). Extracts MDX from code fences, validates
 * the output, repairs frontmatter, converts footnotes, etc.
 *
 * Extracted from duplicated logic in improve.ts and batch-improve.ts — see #2924.
 */

import { convertSlugsToWikiIds } from '../creator/deployment.ts';
import { convertNewFootnotes } from '../../lib/convert-new-footnotes.ts';
import {
  repairFrontmatter,
  ensureFrontmatterFields,
  stripRelatedPagesSections,
  cleanEntityLinks,
} from './utils.ts';

export interface PostProcessResult {
  content: string;
  failed: boolean;
  failureReason?: string;
}

/**
 * Post-process a raw LLM improve result into valid MDX content.
 *
 * Steps:
 * 1. Extract MDX from code fences (if wrapped)
 * 2. Detect and extract JSON-wrapped responses
 * 3. Validate that the result looks like MDX
 * 4. Guard against LLM truncation
 * 5. Update lastEdited date
 * 6. Repair frontmatter, ensure fields, clean entity links, strip related pages
 * 7. Convert slug-based EntityLink IDs to E## format
 * 8. Convert numbered footnotes to [^kb-...] / [^rc-XXXX] format
 */
export async function postProcessImproveResult(
  rawResult: string,
  currentContent: string,
  pageId: string,
  _filePath: string,
  root: string,
  log: (phase: string, msg: string) => void,
): Promise<PostProcessResult> {
  let improvedContent: string = rawResult;

  // ── Step 1–2: Extract MDX from code blocks or JSON wrapper ───────────
  if (!improvedContent.startsWith('---')) {
    // Scan all code blocks and prefer the one whose content is valid MDX (starts with ---).
    // The non-greedy single-match regex previously picked the *first* code block, which
    // could be a JSON analysis blob preceding the actual MDX output — causing silent
    // corruption of the page file. See: fix-footer-rendering-ttIYJ.
    const codeBlocks = [...rawResult.matchAll(/```(?:\w+)?\n([\s\S]*?)```/g)];
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
      log('post-process', 'Detected JSON-wrapped response — extracting "content" field');
      try {
        // Unescape JSON string: \n → newline, \" → ", \\ → \, \t → tab
        const extracted = JSON.parse(`"${contentFieldMatch[1]}"`);
        if (typeof extracted === 'string' && extracted.length > 100) {
          improvedContent = extracted;
        }
      } catch {
        // JSON.parse may fail on truncated strings — try manual unescaping
        const raw = contentFieldMatch[1];
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
          log('post-process', 'Used manual unescaping for truncated JSON content string');
          improvedContent = manual;
        }
      }
    }
  }

  // ── Step 3: Validate that the result looks like MDX ──────────────────
  const trimmed = improvedContent.trim();
  if (
    !trimmed.startsWith('---') &&
    !trimmed.startsWith('#') &&
    !trimmed.startsWith('import ') &&
    !trimmed.startsWith('<')
  ) {
    return {
      content: currentContent,
      failed: true,
      failureReason: `Response does not look like MDX (starts with "${trimmed.substring(0, 40)}...")`,
    };
  }

  // ── Step 4: Guard against LLM truncation ─────────────────────────────
  const inputWords = currentContent.split(/\s+/).length;
  const outputWords = improvedContent.split(/\s+/).length;
  if (outputWords < inputWords * 0.5 && inputWords > 200) {
    return {
      content: currentContent,
      failed: true,
      failureReason: `Truncation detected: output (${outputWords} words) < 50% of input (${inputWords} words)`,
    };
  }

  // ── Step 5: Update lastEdited in frontmatter ─────────────────────────
  const today = new Date().toISOString().split('T')[0];
  improvedContent = improvedContent.replace(
    /lastEdited:\s*["']?\d{4}-\d{2}-\d{2}["']?/,
    `lastEdited: "${today}"`,
  );

  // ── Step 6: Repair frontmatter, ensure fields, clean entity links ────
  improvedContent = repairFrontmatter(improvedContent);
  improvedContent = ensureFrontmatterFields(currentContent, improvedContent);
  improvedContent = cleanEntityLinks(improvedContent);
  improvedContent = stripRelatedPagesSections(improvedContent);

  // ── Step 7: Convert slug-based EntityLink IDs to E## format ──────────
  const { content: convertedContent, converted: slugsConverted } = convertSlugsToWikiIds(improvedContent, root);
  if (slugsConverted > 0) {
    log('post-process', `Converted ${slugsConverted} remaining slug-based EntityLink ID(s) to E## format`);
    improvedContent = convertedContent;
  }

  // ── Step 8: Convert numbered footnotes ───────────────────────────────
  try {
    const fnResult = await convertNewFootnotes(improvedContent, pageId, {
      createDbEntries: false,
      entityId: pageId,
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
      log('post-process', `Converted ${fnResult.convertedCount} numbered footnote(s): ${parts.join(', ')}`);
      improvedContent = fnResult.content;
    }
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    log('post-process', `Footnote conversion failed: ${error.message} — continuing with numbered footnotes`);
  }

  return { content: improvedContent, failed: false };
}
