/**
 * Tool Definitions and Handlers for the Agent Orchestrator
 *
 * Each module in the composable architecture is exposed as a tool that the
 * orchestrator LLM can call via the Anthropic tool-use API. Tool handlers
 * are closures over the OrchestratorContext, so calling a tool can update
 * shared state (content, source cache, metrics).
 *
 * See E766 Part 11 and issue #692.
 */

import type Anthropic from '@anthropic-ai/sdk';
import { splitIntoSections, reassembleSections, renumberFootnotes, filterSourcesForSection } from '../../lib/section-splitter.ts';
import { rewriteSection } from '../../lib/section-writer.ts';
import { runResearch, type ResearchRequest } from '../../lib/research-agent.ts';
import { auditCitations, type AuditRequest } from '../../lib/citation-auditor.ts';
import { enrichEntityLinks } from '../../enrich/enrich-entity-links.ts';
import { enrichFactRefs } from '../../enrich/enrich-fact-refs.ts';
import { extractMetrics } from '../../lib/metrics-extractor.ts';
import { validateSingleFile } from '../../lib/validation-engine.ts';
import { allRules } from '../../lib/rules/index.ts';
import { MODELS } from '../../lib/anthropic.ts';
import type { OrchestratorContext, QualityMetrics } from './types.ts';

// ---------------------------------------------------------------------------
// Tool definitions (Anthropic tool-use schema)
// ---------------------------------------------------------------------------

/**
 * Build the tool definitions array for the orchestrator. Only includes tools
 * that are enabled for the current tier.
 */
export function buildToolDefinitions(enabledTools: string[]): Anthropic.Messages.Tool[] {
  const allTools: Record<string, Anthropic.Messages.Tool> = {
    read_page: {
      name: 'read_page',
      description: 'Read the current page content. Returns the full MDX content including frontmatter. Use this to understand the current state of the page before making changes.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },

    get_page_metrics: {
      name: 'get_page_metrics',
      description: 'Extract quality metrics from the current page content: word count, footnote/citation count, EntityLink count, diagram count, table count, section count, and structural score.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },

    split_into_sections: {
      name: 'split_into_sections',
      description: 'Split the current page into ## sections. Returns the list of section IDs and their headings. Use this to plan which sections to rewrite.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },

    run_research: {
      name: 'run_research',
      description: 'Run multi-source research on a topic. Searches Exa, Perplexity, and SCRY (EA Forum/LessWrong), fetches source URLs, and extracts structured facts. Results are added to the source cache for use by rewrite_section. Cost: $1-3 per call.',
      input_schema: {
        type: 'object' as const,
        properties: {
          topic: {
            type: 'string',
            description: 'The topic to research (e.g. "Anthropic constitutional AI safety")',
          },
          query: {
            type: 'string',
            description: 'Optional more specific search query (defaults to topic)',
          },
        },
        required: ['topic'],
      },
    },

    rewrite_section: {
      name: 'rewrite_section',
      description: 'Rewrite a single ## section of the page. Uses the source cache for grounded, cited content. Each call improves one section — call multiple times for multiple sections. The section must exist in the current page. Cost: $0.10-0.30 per section.',
      input_schema: {
        type: 'object' as const,
        properties: {
          section_id: {
            type: 'string',
            description: 'The section ID to rewrite (from split_into_sections output, e.g. "background")',
          },
          directions: {
            type: 'string',
            description: 'Specific improvement directions for this section (optional — general directions are already provided)',
          },
        },
        required: ['section_id'],
      },
    },

    audit_citations: {
      name: 'audit_citations',
      description: 'Verify all citations on the current page against their source URLs. Returns per-citation verdicts (verified, unsupported, misattributed, url-dead). Use after rewriting to check citation quality. Cost: $0.10-0.30.',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },

    add_entity_links: {
      name: 'add_entity_links',
      description: 'Scan the current page content and insert <EntityLink> tags for entity mentions that are not yet linked. Idempotent — safe to call multiple times. Cost: ~$0.05 (Haiku).',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },

    add_fact_refs: {
      name: 'add_fact_refs',
      description: 'Scan the current page content and wrap hardcoded numbers with <F> (canonical fact) tags where matching facts exist in the YAML data layer. Idempotent. Cost: ~$0.05 (Haiku).',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },

    validate_content: {
      name: 'validate_content',
      description: 'Run validation checks on the current content: MDX syntax, dollar-sign escaping, comparison operators, frontmatter schema, EntityLink IDs. Auto-fixes what it can. Returns critical and quality issues. Cost: $0 (no LLM).',
      input_schema: {
        type: 'object' as const,
        properties: {},
        required: [],
      },
    },
  };

  return enabledTools
    .filter(id => allTools[id])
    .map(id => allTools[id]);
}

// ---------------------------------------------------------------------------
// Estimated costs per tool (USD)
// ---------------------------------------------------------------------------

const TOOL_COST_ESTIMATES: Record<string, number> = {
  read_page: 0,
  get_page_metrics: 0,
  split_into_sections: 0,
  run_research: 1.50,
  rewrite_section: 0.20,
  audit_citations: 0.20,
  add_entity_links: 0.05,
  add_fact_refs: 0.05,
  validate_content: 0,
};

// ---------------------------------------------------------------------------
// Quality metrics extraction (shared with quality-gate.ts)
// ---------------------------------------------------------------------------

/** Extract quality metrics from content string. */
export function extractQualityMetrics(content: string, filePath: string): QualityMetrics {
  const metrics = extractMetrics(content, filePath);
  return {
    wordCount: metrics.wordCount,
    footnoteCount: metrics.footnoteCount,
    entityLinkCount: metrics.internalLinks,
    diagramCount: metrics.diagramCount,
    tableCount: metrics.tableCount,
    sectionCount: metrics.sectionCount.h2,
    structuralScore: metrics.structuralScoreNormalized,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const CRITICAL_RULES = [
  'dollar-signs',
  'comparison-operators',
  'frontmatter-schema',
  'entitylink-ids',
  'prefer-entitylink',
  'internal-links',
  'fake-urls',
  'component-props',
  'citation-urls',
];

const QUALITY_RULES = [
  'tilde-dollar',
  'markdown-lists',
  'consecutive-bold-labels',
  'placeholders',
  'vague-citations',
  'temporal-artifacts',
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

export interface ToolHandler {
  (input: Record<string, unknown>): Promise<string>;
}

/**
 * Build tool handlers as closures over the orchestrator context.
 * Each handler may mutate the context (update content, add sources, etc.).
 */
export function buildToolHandlers(
  ctx: OrchestratorContext,
  writerModel: string = MODELS.sonnet,
): Record<string, ToolHandler> {
  const ROOT = ctx.filePath.replace(/\/content\/docs\/.*$/, '');

  return {
    read_page: async () => {
      return ctx.currentContent;
    },

    get_page_metrics: async () => {
      const metrics = extractQualityMetrics(ctx.currentContent, ctx.filePath);
      return JSON.stringify(metrics, null, 2);
    },

    split_into_sections: async () => {
      const split = splitIntoSections(ctx.currentContent);
      ctx.splitPage = split;
      ctx.sections = split.sections;
      const sectionInfo = split.sections.map(s => ({
        id: s.id,
        heading: s.heading.trim(),
        wordCount: s.content.split(/\s+/).filter(Boolean).length,
      }));
      return JSON.stringify({
        sectionCount: split.sections.length,
        hasFrontmatter: split.frontmatter.length > 0,
        preambleLength: split.preamble.split(/\s+/).filter(Boolean).length,
        sections: sectionInfo,
      }, null, 2);
    },

    run_research: async (input) => {
      const topic = String(input.topic);
      const query = input.query ? String(input.query) : undefined;
      ctx.researchQueryCount++;

      if (ctx.researchQueryCount > ctx.budget.maxResearchQueries) {
        return JSON.stringify({
          error: `Research query budget exceeded (max ${ctx.budget.maxResearchQueries} for ${ctx.budget.name} tier). Improve the page with existing sources.`,
        });
      }

      try {
        const request: ResearchRequest = {
          topic,
          query,
          pageContext: {
            title: ctx.page.title,
            type: ctx.page.entityType || 'unknown',
            entityId: ctx.page.id,
          },
          budgetCap: 3.00,
        };

        const result = await runResearch(request);

        // Merge new sources into the context's source cache
        const existingUrls = new Set(ctx.sourceCache.map(s => s.url));
        let newCount = 0;
        for (const src of result.sources) {
          if (!existingUrls.has(src.url)) {
            ctx.sourceCache.push(src);
            existingUrls.add(src.url);
            newCount++;
          }
        }

        return JSON.stringify({
          sourcesFound: result.sources.length,
          newSourcesAdded: newCount,
          totalSourceCache: ctx.sourceCache.length,
          cost: result.metadata.totalCost,
          providers: result.metadata.sourcesSearched,
        }, null, 2);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Research failed: ${error.message}` });
      }
    },

    rewrite_section: async (input) => {
      const sectionId = String(input.section_id);
      const sectionDirections = input.directions ? String(input.directions) : undefined;

      // Ensure we have a current section split
      if (!ctx.splitPage) {
        const split = splitIntoSections(ctx.currentContent);
        ctx.splitPage = split;
        ctx.sections = split.sections;
      }

      const section = ctx.sections?.find(s => s.id === sectionId);
      if (!section) {
        const available = ctx.sections?.map(s => s.id).join(', ') || 'none';
        return JSON.stringify({
          error: `Section "${sectionId}" not found. Available sections: ${available}`,
        });
      }

      // Filter sources relevant to this section
      const sectionSources = filterSourcesForSection(section, ctx.sourceCache);

      try {
        const result = await rewriteSection(
          {
            sectionId: section.id,
            sectionContent: section.content,
            pageContext: {
              title: ctx.page.title,
              type: ctx.page.entityType || 'wiki-page',
              entityId: ctx.page.id,
            },
            sourceCache: sectionSources,
            directions: [
              ctx.directions,
              sectionDirections,
              'Preserve any existing Markdown tables — improve their data if needed but do not replace them with prose.',
            ].filter(Boolean).join('\n'),
            constraints: {
              // Strict mode when sources are available — only add claims backed by cache
              // Training knowledge allowed when no sources (polish tier polish-only)
              allowTrainingKnowledge: sectionSources.length === 0,
              requireClaimMap: sectionSources.length > 0,
            },
          },
          { model: writerModel },
        );

        // Update the section in context
        const sectionIdx = ctx.sections!.findIndex(s => s.id === sectionId);
        if (sectionIdx !== -1) {
          ctx.sections![sectionIdx] = {
            id: section.id,
            heading: section.heading,
            content: result.content,
          };

          // Reassemble the full page from updated sections
          const reassembled = reassembleSections({
            frontmatter: ctx.splitPage!.frontmatter,
            preamble: ctx.splitPage!.preamble,
            sections: ctx.sections!,
          });
          ctx.currentContent = renumberFootnotes(reassembled);
        }

        return JSON.stringify({
          sectionId,
          claimMapEntries: result.claimMap.length,
          unsourceableClaims: result.unsourceableClaims.length,
          wordsBefore: section.content.split(/\s+/).length,
          wordsAfter: result.content.split(/\s+/).length,
        }, null, 2);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Section rewrite failed: ${error.message}` });
      }
    },

    audit_citations: async () => {
      try {
        const request: AuditRequest = {
          content: ctx.currentContent,
          fetchMissing: true,
          passThreshold: 0.7,
        };

        const result = await auditCitations(request);
        ctx.citationAudit = result.citations;

        return JSON.stringify({
          total: result.summary.total,
          verified: result.summary.verified,
          failed: result.summary.failed,
          misattributed: result.summary.misattributed,
          unchecked: result.summary.unchecked,
          pass: result.pass,
          // Show details for failed citations
          failedCitations: result.citations
            .filter(c => c.verdict === 'unsupported' || c.verdict === 'misattributed')
            .map(c => ({
              footnoteRef: c.footnoteRef,
              claim: c.claim.slice(0, 100),
              verdict: c.verdict,
              explanation: c.explanation,
            })),
        }, null, 2);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Citation audit failed: ${error.message}` });
      }
    },

    add_entity_links: async () => {
      try {
        const result = await enrichEntityLinks(ctx.currentContent, { root: ROOT });

        // Prevent self-linking: extract the page's own entity ID from DataInfoBox
        // and strip any EntityLink tags pointing to it (a page shouldn't link to itself)
        const selfEntityMatch = ctx.currentContent.match(/<DataInfoBox\s+entityId="([^"]+)"/);
        let enrichedContent = result.content;
        let selfFilteredReplacements = result.replacements;
        if (selfEntityMatch) {
          const selfId = selfEntityMatch[1];
          const selfLinkRe = new RegExp(
            `<EntityLink\\s[^>]*id="${selfId}"[^>]*>([\\s\\S]*?)</EntityLink>`,
            'g',
          );
          enrichedContent = enrichedContent.replace(selfLinkRe, '$1');
          selfFilteredReplacements = result.replacements.filter(r => r.entityId !== selfId);
        }

        ctx.currentContent = enrichedContent;
        // Invalidate section cache since content changed
        ctx.splitPage = null;
        ctx.sections = null;

        return JSON.stringify({
          insertedCount: selfFilteredReplacements.length,
          replacements: selfFilteredReplacements.slice(0, 10).map(r => ({
            text: r.searchText,
            entityId: r.entityId,
          })),
        }, null, 2);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Entity link enrichment failed: ${error.message}` });
      }
    },

    add_fact_refs: async () => {
      try {
        const result = await enrichFactRefs(ctx.currentContent, {
          pageId: ctx.page.id,
          root: ROOT,
        });
        ctx.currentContent = result.content;
        // Invalidate section cache since content changed
        ctx.splitPage = null;
        ctx.sections = null;

        return JSON.stringify({
          insertedCount: result.insertedCount,
          replacements: result.replacements.slice(0, 10).map(r => ({
            text: r.searchText,
            entityId: r.entityId,
            factId: r.factId,
          })),
        }, null, 2);
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Fact ref enrichment failed: ${error.message}` });
      }
    },

    validate_content: async () => {
      try {
        const fs = await import('fs');
        const originalContent = fs.readFileSync(ctx.filePath, 'utf-8');

        // Temporarily write current content to disk for validation
        fs.writeFileSync(ctx.filePath, ctx.currentContent);

        try {
          const result = await validateSingleFile(
            ctx.filePath,
            CRITICAL_RULES,
            QUALITY_RULES,
            allRules,
          );

          // Apply auto-fixes
          const fixableIssues = [
            ...result.critical.flatMap(r => r.issues),
            ...result.quality.flatMap(r => r.issues),
          ].filter(i => i.isFixable);

          if (fixableIssues.length > 0) {
            result.engine.applyFixes(fixableIssues);
            ctx.currentContent = fs.readFileSync(ctx.filePath, 'utf-8');
            // Invalidate section cache
            ctx.splitPage = null;
            ctx.sections = null;
          }

          const critical = result.critical.filter(r => r.count > 0);
          const quality = result.quality.filter(r => r.count > 0);

          return JSON.stringify({
            criticalIssues: critical.map(r => ({
              rule: r.rule,
              count: r.count,
              details: r.issues.slice(0, 3).map(i => i.toString()),
            })),
            qualityWarnings: quality.map(r => ({
              rule: r.rule,
              count: r.count,
            })),
            autoFixesApplied: fixableIssues.length,
          }, null, 2);
        } finally {
          // Restore original file content
          fs.writeFileSync(ctx.filePath, originalContent);
        }
      } catch (err: unknown) {
        const error = err instanceof Error ? err : new Error(String(err));
        return JSON.stringify({ error: `Validation failed: ${error.message}` });
      }
    },
  };
}

/**
 * Wrap tool handlers with cost tracking and tool-call counting.
 * Returns handlers that update the context's cost/count fields.
 */
export function wrapWithTracking(
  handlers: Record<string, ToolHandler>,
  ctx: OrchestratorContext,
): Record<string, ToolHandler> {
  const wrapped: Record<string, ToolHandler> = {};

  for (const [name, handler] of Object.entries(handlers)) {
    wrapped[name] = async (input) => {
      ctx.toolCallCount++;
      const cost = TOOL_COST_ESTIMATES[name] || 0;
      ctx.costEntries.push({
        toolName: name,
        estimatedCost: cost,
        timestamp: Date.now(),
      });
      ctx.totalCost += cost;

      const result = await handler(input);

      // Append budget status to every tool result so the agent stays informed
      const budgetStatus = `\n\n[Budget: ${ctx.toolCallCount}/${ctx.budget.maxToolCalls} tool calls used, ~$${ctx.totalCost.toFixed(2)} spent]`;
      return result + budgetStatus;
    };
  }

  return wrapped;
}
