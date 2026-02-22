/**
 * Section-Level Improve Phase
 *
 * Replaces the monolithic single-pass improve phase with per-## section
 * rewrites.  Each section is rewritten independently via rewriteSection()
 * against a filtered slice of the source cache, then all sections are
 * reassembled and their footnotes renumbered into a consistent [^N] sequence.
 *
 * Activation: pass `sectionLevel: true` in PipelineOptions, or use the
 * `--section-level` CLI flag.  The old single-pass improve phase remains
 * the default.
 *
 * See issue #671.
 */

import fs from 'fs';
import { MODELS } from '../../../lib/anthropic.ts';
import { rewriteSection } from '../../../lib/section-writer.ts';
import {
  splitIntoSections,
  reassembleSections,
  renumberFootnotes,
  filterSourcesForSection,
  type ParsedSection,
} from '../../../lib/section-splitter.ts';
import type {
  PageData,
  AnalysisResult,
  ResearchResult,
  PipelineOptions,
  SectionWriteDecision,
} from '../types.ts';
import { log, getFilePath, writeTemp } from '../utils.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Sections with fewer body words than this are kept as-is. */
const MIN_SECTION_WORDS = 30;

/**
 * Section headings that must never be rewritten.
 * These are terminal/structural sections that contain citations, navigation
 * links, or boilerplate — not prose that benefits from section-writer.
 */
const SKIP_SECTION_HEADINGS = new Set([
  'sources',
  'references',
  'further-reading',
  'see-also',
  'related-pages',
  'related-content',
  'external-links',
  'key-links',
]);

// ---------------------------------------------------------------------------
// Section analysis — which sections need rewriting?
// ---------------------------------------------------------------------------

/**
 * Decide which sections to rewrite based on the analysis phase output.
 *
 * Strategy:
 *  - Skip sections whose body is too short (< MIN_SECTION_WORDS words).
 *  - If the analysis improvements/gaps text mentions the section heading
 *    text, mark it as high priority.
 *  - All other substantial sections are also rewritten (safe default:
 *    each call to rewriteSection() can improve prose even without sources).
 */
function decideSections(
  sections: ParsedSection[],
  analysis: AnalysisResult,
): SectionWriteDecision[] {
  const improvementText = (analysis.improvements ?? []).join(' ').toLowerCase();
  const gapsText = (analysis.gaps ?? []).join(' ').toLowerCase();

  return sections.map(section => {
    // Never rewrite terminal/citation sections — they contain footnote
    // definitions and navigation links, not improvable prose.
    if (SKIP_SECTION_HEADINGS.has(section.id)) {
      return {
        sectionId: section.id,
        shouldRewrite: false,
        reason: 'terminal section (citations/navigation)',
      };
    }

    // Strip heading to get body text
    const bodyText = section.content.slice(section.heading.length).trim();
    const wordCount = bodyText.split(/\s+/).filter(Boolean).length;

    if (wordCount < MIN_SECTION_WORDS) {
      return {
        sectionId: section.id,
        shouldRewrite: false,
        reason: `too short (${wordCount} words)`,
      };
    }

    const headingKeywords = section.heading
      .replace(/^#+\s*/, '')
      .toLowerCase();

    const mentionedInAnalysis =
      improvementText.includes(headingKeywords) ||
      gapsText.includes(headingKeywords);

    return {
      sectionId: section.id,
      shouldRewrite: true,
      reason: mentionedInAnalysis ? 'mentioned in analysis' : 'substantial content',
    };
  });
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/**
 * Section-level improve phase.
 *
 * @param page        Page metadata.
 * @param analysis    Output from the analyze phase.
 * @param research    Output from the research phase (sourceCache used if present).
 * @param directions  Free-text improvement directions from the user.
 * @param options     Pipeline options (model selection, etc.).
 * @param contentOverride  Optional in-memory content (skips disk read).
 * @returns Improved MDX content with renumbered footnotes.
 */
export async function improveSectionsPhase(
  page: PageData,
  analysis: AnalysisResult,
  research: ResearchResult,
  directions: string,
  options: PipelineOptions,
  contentOverride?: string,
): Promise<string> {
  log('improve-sections', 'Starting section-level improvement');

  const filePath = getFilePath(page.path);
  const currentContent = contentOverride ?? fs.readFileSync(filePath, 'utf-8');

  // ── Split ─────────────────────────────────────────────────────────────────

  const split = splitIntoSections(currentContent);
  const sectionCount = split.sections.length;
  log('improve-sections', `Found ${sectionCount} section(s)`);

  if (sectionCount === 0) {
    log('improve-sections', 'No ## sections found — returning content unchanged');
    return currentContent;
  }

  // ── Source cache ──────────────────────────────────────────────────────────

  const sourceCache = research.sourceCache ?? [];
  if (sourceCache.length > 0) {
    log('improve-sections', `Using ${sourceCache.length} grounded source(s) from cache`);
  } else if ((research.sources ?? []).length > 0) {
    log('improve-sections', `Note: research has ${research.sources.length} entries but no pre-fetched source cache`);
    log('improve-sections', '  (Run with source cache for grounded per-section rewriting — see #668)');
  }

  // ── Decide which sections to rewrite ─────────────────────────────────────

  const decisions = decideSections(split.sections, analysis);
  const toRewriteCount = decisions.filter(d => d.shouldRewrite).length;
  log('improve-sections', `Rewriting ${toRewriteCount}/${sectionCount} section(s):`);
  for (const d of decisions) {
    log('improve-sections', `  ${d.shouldRewrite ? '✓' : '✗'} ${d.sectionId}: ${d.reason}`);
  }

  // ── Page context (passed to section-writer) ───────────────────────────────

  const pageContext = {
    title: page.title,
    type: 'wiki-page',
    entityId: page.id,
  };

  // ── Rewrite each section ──────────────────────────────────────────────────

  const rewrittenSections: ParsedSection[] = [];
  const allClaimMaps: Array<{ sectionId: string; claims: unknown[] }> = [];
  const allUnsourceable: string[] = [];

  for (let i = 0; i < split.sections.length; i++) {
    const section = split.sections[i];
    const decision = decisions[i];

    if (!decision.shouldRewrite) {
      log('improve-sections', `  Skip: ${section.id}`);
      rewrittenSections.push(section);
      continue;
    }

    log('improve-sections', `  Rewrite: ${section.id}`);

    // Filter and rank sources for this section
    const sectionSources = filterSourcesForSection(section, sourceCache);

    try {
      const result = await rewriteSection(
        {
          sectionId: section.id,
          sectionContent: section.content,
          pageContext,
          sourceCache: sectionSources,
          directions: directions || undefined,
          constraints: {
            allowTrainingKnowledge: true,
            requireClaimMap: sectionSources.length > 0,
          },
        },
        { model: options.improveModel ?? MODELS.sonnet },
      );

      rewrittenSections.push({
        id: section.id,
        heading: section.heading,
        content: result.content,
      });

      if (result.claimMap.length > 0) {
        allClaimMaps.push({ sectionId: section.id, claims: result.claimMap });
      }
      if (result.unsourceableClaims.length > 0) {
        allUnsourceable.push(
          ...result.unsourceableClaims.map(c => `[${section.id}] ${c}`),
        );
      }
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      log(
        'improve-sections',
        `  ⚠ Failed to rewrite ${section.id}: ${error.message} — keeping original`,
      );
      rewrittenSections.push(section);
    }
  }

  // ── Reassemble ────────────────────────────────────────────────────────────

  const reassembled = reassembleSections({
    frontmatter: split.frontmatter,
    preamble: split.preamble,
    sections: rewrittenSections,
  });

  // ── Footnote renumbering ──────────────────────────────────────────────────
  // Converts [^SRC-N] markers (section-writer) to [^N] (pipeline convention).

  const renumbered = renumberFootnotes(reassembled);

  // ── Update lastEdited ────────────────────────────────────────────────────

  const today = new Date().toISOString().split('T')[0];
  const finalContent = renumbered.replace(
    /lastEdited:\s*["']?\d{4}-\d{2}-\d{2}["']?/,
    `lastEdited: "${today}"`,
  );

  // ── Persist debug artefacts ──────────────────────────────────────────────

  if (allClaimMaps.length > 0) {
    const totalClaims = allClaimMaps.reduce((n, m) => n + (m.claims as unknown[]).length, 0);
    log('improve-sections', `Claim map: ${totalClaims} claim(s) across ${allClaimMaps.length} section(s)`);
    writeTemp(page.id, 'section-claim-maps.json', allClaimMaps);
  }

  if (allUnsourceable.length > 0) {
    log('improve-sections', `Unsourceable claims: ${allUnsourceable.length}`);
    writeTemp(page.id, 'unsourceable-claims.txt', allUnsourceable.join('\n'));
  }

  writeTemp(page.id, 'improved.mdx', finalContent);
  log('improve-sections', 'Complete');
  return finalContent;
}
