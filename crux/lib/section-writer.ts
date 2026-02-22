/**
 * Section-Level Grounded Writer
 *
 * Rewrites a single wiki section (200–500 words) against a pre-built source
 * cache, producing an explicit claim-map that links every new factual claim to
 * a specific cached source.  Enrichment concerns (EntityLinks, diagrams) are
 * deliberately excluded so this tool stays focused and testable.
 *
 * Key design choices:
 *  - Full-page-rewrite avoidance: operates on one ## section at a time.
 *  - Strict-cache mode: when constraints.allowTrainingKnowledge === false the
 *    LLM is instructed not to add facts it cannot cite from the cache, and any
 *    it attempts are collected in `unsourceableClaims`.
 *  - Claim-map output: every new factual statement the LLM adds is mapped to
 *    a source ID, URL, and optional supporting quote.
 *  - Offline-safe: no network calls are made here; sources must be fetched
 *    beforehand and passed in via `sourceCache`.  See source-fetcher.ts.
 *
 * Usage:
 *   import { rewriteSection } from './section-writer.ts';
 *
 *   const result = await rewriteSection({
 *     sectionId: 'background',
 *     sectionContent: '## Background\n\nMIRI was founded in ...',
 *     pageContext: { title: 'MIRI', type: 'organization' },
 *     sourceCache: [
 *       { id: 'SRC-1', url: 'https://example.com', title: 'MIRI Overview',
 *         content: '...', facts: ['Founded 2000 as SIAI'] },
 *     ],
 *     constraints: { allowTrainingKnowledge: false, requireClaimMap: true },
 *   });
 *
 *   // result.content  — improved MDX with footnote markers
 *   // result.claimMap — [{claim, factId, sourceUrl, quote?}]
 *   // result.unsourceableClaims — claims writer wanted but couldn't source
 *
 * See issue #634.
 */

import { z } from 'zod';
import { createLlmClient, streamLlmCall, MODELS } from './llm.ts';
import { parseJsonFromLlm } from './json-parsing.ts';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** Minimal page context needed to frame the section rewrite. */
export interface PageContext {
  /** Page title, e.g. "Machine Intelligence Research Institute". */
  title: string;
  /** Entity type, e.g. 'organization', 'person', 'concept'. */
  type: string;
  /** Optional entity ID from data/entities, e.g. 'miri'. */
  entityId?: string;
}

/**
 * A pre-fetched source entry.  Build this cache before calling rewriteSection
 * (e.g. via source-fetcher.ts fetchSource / fetchSources).
 */
export interface SourceCacheEntry {
  /** Short unique identifier used to reference this source (e.g. 'SRC-1'). */
  id: string;
  url: string;
  title: string;
  author?: string;
  /** ISO date string, e.g. '2023-06-15'. */
  date?: string;
  /**
   * Full or excerpt content of the page.  Truncated to MAX_SOURCE_CONTENT_CHARS
   * before being included in the prompt.  Prefer pre-extracted excerpts here
   * to control token usage.
   */
  content: string;
  /**
   * Pre-extracted key facts (1-sentence bullet strings).  When provided,
   * these are shown *instead of* the raw content snippet in the prompt,
   * yielding cleaner, more token-efficient context.
   */
  facts?: string[];
}

/** Writer constraints passed to the LLM. */
export interface SectionWriteConstraints {
  /**
   * When false, the LLM must only add claims supported by the source cache.
   * Claims it wants to add but cannot source are placed in `unsourceableClaims`.
   */
  allowTrainingKnowledge: boolean;
  /**
   * When true, the LLM must populate `claimMap` with an entry for every new
   * factual claim it adds to the content.
   */
  requireClaimMap: boolean;
  /** Hard cap on the number of new factual claims to add. */
  maxNewClaims?: number;
}

/** Request to rewrite a single section. */
export interface GroundedWriteRequest {
  /** Slug-style identifier for the section, e.g. 'background' or 'funding'. */
  sectionId: string;
  /** Current raw MDX content of the section (including the ## heading). */
  sectionContent: string;
  pageContext: PageContext;
  /**
   * Sources the writer may cite.  Pass an empty array to allow pure
   * prose improvements without citations.
   */
  sourceCache: SourceCacheEntry[];
  /** Free-text improvement directions sent to the LLM. */
  directions?: string;
  /**
   * Constraint flags.  Defaults to permissive (training knowledge allowed,
   * claim map optional).
   */
  constraints?: SectionWriteConstraints;
}

/** A single entry in the claim-map linking a prose claim to its source. */
export interface ClaimEntry {
  /** The factual claim as it appears in the improved content. */
  claim: string;
  /** ID of the SourceCacheEntry that supports this claim. */
  factId: string;
  /** URL of the source (convenience copy from the cache entry). */
  sourceUrl: string;
  /** Optional verbatim quote from the source that supports the claim. */
  quote?: string;
}

/** Result of a section rewrite. */
export interface GroundedWriteResult {
  /** Improved section content (MDX with GFM footnotes for new citations). */
  content: string;
  /**
   * Maps each new factual claim to its source.  May be empty if no new
   * claims were added or if requireClaimMap was false.
   */
  claimMap: ClaimEntry[];
  /**
   * Claims the LLM wanted to add but could not source from the cache.
   * Populated when constraints.allowTrainingKnowledge === false.
   */
  unsourceableClaims: string[];
  /** Echo of the request's sectionId for correlation. */
  sectionId: string;
}

/** Options for the rewriteSection call. */
export interface SectionWriterOptions {
  /** Claude model to use.  Defaults to Sonnet. */
  model?: string;
  /** Max output tokens.  Defaults to 4000. */
  maxTokens?: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Max chars of source content to include in the prompt per source entry. */
export const MAX_SOURCE_CONTENT_CHARS = 3_000;

export const DEFAULT_CONSTRAINTS: SectionWriteConstraints = {
  allowTrainingKnowledge: true,
  requireClaimMap: false,
};

/** Merge user-supplied constraints with defaults. */
function resolveConstraints(raw?: SectionWriteConstraints): SectionWriteConstraints {
  return { ...DEFAULT_CONSTRAINTS, ...raw };
}

// ---------------------------------------------------------------------------
// Zod schema for the LLM JSON response
// ---------------------------------------------------------------------------

const ClaimEntrySchema = z.object({
  claim: z.string().min(1),
  factId: z.string().min(1),
  sourceUrl: z.string(),
  quote: z.string().optional(),
});

const GroundedWriteResponseSchema = z.object({
  content: z.string().min(1),
  claimMap: z.array(ClaimEntrySchema).default([]),
  unsourceableClaims: z.array(z.string()).default([]),
});

type GroundedWriteResponse = z.infer<typeof GroundedWriteResponseSchema>;

// ---------------------------------------------------------------------------
// Prompt helpers (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Format source cache entries into a human-readable block for the LLM prompt.
 * Each entry is given a `[ID]` header.  When `facts` are provided they are
 * shown instead of the raw content snippet.
 */
export function formatSourcesForPrompt(sources: SourceCacheEntry[]): string {
  if (sources.length === 0) {
    return '(No sources provided — improve prose and structure only)';
  }

  return sources.map(src => {
    const lines: string[] = [`### [${src.id}] ${src.title}`, `URL: ${src.url}`];

    if (src.author) lines.push(`Author: ${src.author}`);
    if (src.date) lines.push(`Date: ${src.date}`);

    if (src.facts && src.facts.length > 0) {
      lines.push('Key facts:');
      src.facts.forEach(f => lines.push(`- ${f}`));
    } else if (src.content) {
      const excerpt = src.content.slice(0, MAX_SOURCE_CONTENT_CHARS);
      const truncated = src.content.length > MAX_SOURCE_CONTENT_CHARS;
      lines.push('Content excerpt:');
      lines.push(excerpt + (truncated ? '\n...(truncated)' : ''));
    }

    return lines.join('\n');
  }).join('\n\n---\n\n');
}

/**
 * Build the full LLM prompt for a section rewrite.
 * Exported for unit testing.
 */
export function buildSectionWriterPrompt(request: GroundedWriteRequest): string {
  const {
    sectionId, sectionContent, pageContext, sourceCache, directions,
    constraints: rawConstraints,
  } = request;
  const constraints = resolveConstraints(rawConstraints);
  const validSourceIds = new Set(sourceCache.map(s => s.id));
  const sourceList = formatSourcesForPrompt(sourceCache);

  // Constraint prose
  const knowledgeRule = constraints.allowTrainingKnowledge
    ? 'You may use your training knowledge to improve prose clarity and structure. ' +
      'When you add a new factual claim, cite from the source cache if a relevant source exists.'
    : 'STRICT MODE: You must ONLY add NEW claims supported by the provided source cache. ' +
      'Do NOT introduce NEW facts from training knowledge. ' +
      'Preserve existing claims from the original content as-is — do not remove them. ' +
      'If you want to add a NEW fact that is not in the cache, list it in "unsourceableClaims" ' +
      'and do NOT include it in the rewritten content.';

  const claimMapRule = constraints.requireClaimMap
    ? 'REQUIRED: You MUST populate "claimMap" with one entry per cited sentence — ' +
      'each sentence that has a footnote marker gets its own entry in the claim map.'
    : 'Populate "claimMap" with one entry per sentence you cite from the source cache.';

  const maxClaimsRule = constraints.maxNewClaims !== undefined
    ? `Add at most ${constraints.maxNewClaims} new cited sentences (i.e. sentences that did not exist in the original and carry a footnote).`
    : '';

  const sourceIdList = sourceCache.length > 0
    ? `Valid source IDs: ${[...validSourceIds].join(', ')}`
    : '(No sources — claim map will be empty)';

  const originalWordCount = sectionContent.split(/\s+/).length;

  return `You are a precise, citation-grounded writer for an AI safety wiki.
Your task is to improve ONE section of the page "${pageContext.title}" (type: ${pageContext.type}).
${pageContext.entityId ? `Entity: ${pageContext.entityId}` : ''}

## Section to Improve
Section ID: ${sectionId}

${directions ? `## Directions\n${directions}\n` : ''}

## Source Cache (${sourceCache.length} sources available)
${sourceList}

## Constraints
${knowledgeRule}
${claimMapRule}
${maxClaimsRule ? maxClaimsRule + '\n' : ''}
## Current Section Content
${sectionContent}

## Output Instructions
Respond with a single JSON object (no markdown code fences). Fields:

{
  "content": "<improved MDX for this section, preserving the ## heading>",
  "claimMap": [
    {
      "claim": "<the sentence or phrase as it appears in your content>",
      "factId": "<source ID from cache, e.g. SRC-1>",
      "sourceUrl": "<URL of the source>",
      "quote": "<brief supporting quote from the source, 1-2 sentences max>"
    }
  ],
  "unsourceableClaims": ["<claim you wanted to add but could not source>"]
}

Rules:
- "content" must be valid MDX. Use named GFM footnotes for citations:
  inline marker [^SRC-1] and definition [^SRC-1]: Title (URL) at the section end.
  Each cited sentence gets one marker; multiple sentences citing the same source
  each get their own [^SRC-X] inline marker (repeat the same marker as needed).
- CLAIM MAP: one entry per cited sentence. If three sentences cite SRC-1,
  include three claimMap entries — one per sentence — each with factId: "SRC-1".
- Each "factId" in "claimMap" MUST be one of: ${sourceIdList}
- "unsourceableClaims" is for facts you wanted but could not source.
  ${constraints.allowTrainingKnowledge ? 'Leave empty if training knowledge is allowed.' : 'Must not appear in "content".'}
- Preserve the existing ## heading and general structure.
- Do NOT add EntityLinks, diagrams, or cross-page references. Preserve existing ones.
- Length: aim for roughly ${Math.round(originalWordCount * 1.1)}–${Math.round(originalWordCount * 1.5)} words${directions ? ' unless directions call for more expansion' : ''}. Don't pad.`;
}

// ---------------------------------------------------------------------------
// Result parsing (exported for unit testing)
// ---------------------------------------------------------------------------

/**
 * Parse the LLM JSON response into a GroundedWriteResult.
 *
 * Post-processing:
 *  - Validates claimMap factIds against the source cache.
 *  - Moves entries with unknown factIds to unsourceableClaims when
 *    training knowledge is disallowed.
 */
export function parseGroundedResult(
  raw: string,
  request: GroundedWriteRequest,
): GroundedWriteResult {
  const constraints = resolveConstraints(request.constraints);
  const validSourceIds = new Set(request.sourceCache.map(s => s.id));

  const parsed = parseJsonFromLlm<GroundedWriteResponse>(
    raw,
    'section-writer',
    (rawStr, _err) => ({
      content: rawStr,
      claimMap: [],
      unsourceableClaims: [],
    }),
  );

  // Validate against schema — coerce missing arrays to []
  const schemaResult = GroundedWriteResponseSchema.safeParse(parsed);
  const response: GroundedWriteResponse = schemaResult.success
    ? schemaResult.data
    : { content: parsed?.content ?? raw, claimMap: [], unsourceableClaims: [] };

  // Validate factIds against the source cache.
  //
  // When allowTrainingKnowledge === true we trust the LLM's claimMap even for
  // unknown source IDs (the writer may be citing training knowledge intentionally).
  //
  // When allowTrainingKnowledge === false, only entries with valid cache IDs are
  // kept; the rest are moved to unsourceableClaims so callers can audit them.
  const validClaims: ClaimEntry[] = [];
  const invalidClaims: string[] = [];
  const noSourceConstraint = validSourceIds.size === 0;

  for (const entry of response.claimMap) {
    if (noSourceConstraint || validSourceIds.has(entry.factId) || constraints.allowTrainingKnowledge) {
      validClaims.push(entry);
    } else {
      // Strict mode: unknown source ID — treat as unsourceable
      invalidClaims.push(entry.claim);
    }
  }

  const unsourceableClaims = [
    ...response.unsourceableClaims,
    ...invalidClaims,
  ];

  return {
    content: response.content,
    claimMap: validClaims,
    unsourceableClaims,
    sectionId: request.sectionId,
  };
}

// ---------------------------------------------------------------------------
// Main exported function
// ---------------------------------------------------------------------------

/** Lazy singleton LLM client. */
let _client: ReturnType<typeof createLlmClient> | null = null;
function getClient() {
  if (!_client) _client = createLlmClient();
  return _client;
}

/**
 * Rewrite a single wiki section against a pre-built source cache.
 *
 * @param request - Section content, page context, sources, and constraints.
 * @param options - Model and token configuration.
 * @returns Improved content, claim-map, and any unsourceable claims.
 */
export async function rewriteSection(
  request: GroundedWriteRequest,
  options: SectionWriterOptions = {},
): Promise<GroundedWriteResult> {
  const {
    model = MODELS.sonnet,
    maxTokens = 4_000,
  } = options;

  const prompt = buildSectionWriterPrompt(request);
  const raw = await streamLlmCall(getClient(), prompt, {
    model,
    maxTokens,
    retryLabel: 'section-writer',
    heartbeatPhase: 'section-writer',
  });

  return parseGroundedResult(raw, request);
}
