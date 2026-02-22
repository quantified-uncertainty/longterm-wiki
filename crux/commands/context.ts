/**
 * Context Command Handlers
 *
 * Assembles research bundles for Claude Code sessions.
 * Eliminates the 5-15 manual tool calls needed to gather background context.
 *
 * Usage:
 *   crux context for-issue <N>          Context bundle for a GitHub issue
 *   crux context for-page <page-id>     Context bundle for a wiki page
 *   crux context for-entity <id>        Context bundle for an entity
 *   crux context for-topic "topic"      Context bundle for a free-text topic
 *
 * All commands write a markdown bundle to .claude/wip-context.md by default.
 * Use --output=<path> to override. Use --print to write to stdout instead.
 *
 * Requires LONGTERMWIKI_SERVER_URL for wiki-server queries.
 * Requires GITHUB_TOKEN for for-issue (to fetch issue details).
 */

import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { createLogger } from '../lib/output.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { getEntity, searchEntities } from '../lib/wiki-server/entities.ts';
import type { EntityEntry, EntitySearchResult } from '../lib/wiki-server/entities.ts';
import { getFactsByEntity } from '../lib/wiki-server/facts.ts';
import type { FactEntry, FactsByEntityResult } from '../lib/wiki-server/facts.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { type CommandResult, parseIntOpt } from '../lib/cli.ts';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_OUTPUT = join(PROJECT_ROOT, '.claude/wip-context.md');

// ---------------------------------------------------------------------------
// Local API response types
// ---------------------------------------------------------------------------

interface PageSearchResult {
  results: Array<{
    id: string;
    numericId: string | null;
    title: string;
    description: string | null;
    entityType: string | null;
    category: string | null;
    readerImportance: number | null;
    quality: number | null;
    score: number;
  }>;
  query: string;
  total: number;
}

interface PageDetail {
  id: string;
  numericId: string | null;
  title: string;
  description: string | null;
  llmSummary: string | null;
  category: string | null;
  subcategory: string | null;
  entityType: string | null;
  tags: string | null;
  quality: number | null;
  readerImportance: number | null;
  hallucinationRiskLevel: string | null;
  hallucinationRiskScore: number | null;
  contentPlaintext: string | null;
  wordCount: number | null;
  lastUpdated: string | null;
  contentFormat: string | null;
  syncedAt: string;
}

interface RelatedResult {
  entityId: string;
  related: Array<{
    id: string;
    type: string;
    title: string;
    score: number;
    label?: string;
  }>;
  total: number;
}

interface BacklinksResult {
  targetId: string;
  backlinks: Array<{
    id: string;
    type: string;
    title: string;
    relationship?: string;
    linkType: string;
    weight: number;
  }>;
  total: number;
}

interface CitationQuote {
  id: number;
  pageId: string;
  footnote: number;
  url: string | null;
  claimText: string;
  sourceQuote: string | null;
  quoteVerified: boolean;
  verificationScore: number | null;
  sourceTitle: string | null;
  accuracyVerdict: string | null;
  accuracyScore: number | null;
}

interface CitationQuotesResult {
  quotes: CitationQuote[];
  pageId: string;
  total: number;
}

interface GitHubIssueResponse {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  created_at: string;
  updated_at: string;
  html_url: string;
}

// ---------------------------------------------------------------------------
// Markdown generation helpers
// ---------------------------------------------------------------------------

function formatDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function mdHeader(title: string, subcommand: string, argList: string[]): string {
  return (
    `# Research Context: ${title}\n\n` +
    `> Generated ${formatDate()} | \`crux context ${subcommand} ${argList.join(' ')}\`\n\n`
  );
}

function writeBundle(outputPath: string, content: string): void {
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, content, 'utf8');
}

function pageDetailBlock(p: PageDetail): string {
  const meta: string[] = [];
  if (p.quality !== null) meta.push(`Quality: ${p.quality}/10`);
  if (p.readerImportance !== null) meta.push(`Importance: ${p.readerImportance}/100`);
  if (p.lastUpdated) meta.push(`Last updated: ${p.lastUpdated}`);
  if (p.wordCount) meta.push(`~${p.wordCount.toLocaleString()} words`);

  let md = `## Page: ${p.title} (\`${p.id}\`)\n\n`;
  if (meta.length) md += `**${meta.join(' | ')}**\n\n`;

  if (p.hallucinationRiskLevel) {
    const score =
      p.hallucinationRiskScore !== null ? ` (score: ${p.hallucinationRiskScore.toFixed(2)})` : '';
    md += `**Risk**: ${p.hallucinationRiskLevel}${score}\n\n`;
  }

  if (p.category) {
    md += `**Category**: ${p.category}${p.subcategory ? ` / ${p.subcategory}` : ''}`;
    if (p.entityType) md += ` | **Type**: ${p.entityType}`;
    md += '\n';
  }
  if (p.tags) md += `**Tags**: ${p.tags}\n`;
  md += '\n';

  if (p.description) {
    md += `${p.description}\n\n`;
  }
  if (p.llmSummary) {
    md += `### LLM Summary\n\n${p.llmSummary}\n\n`;
  }

  return md;
}

function relatedPagesBlock(items: RelatedResult['related'], total: number, limit = 12): string {
  if (items.length === 0) return '';
  let md = `## Related Pages\n\n`;
  for (let i = 0; i < Math.min(items.length, limit); i++) {
    const r = items[i];
    const labelStr = r.label ? ` (${r.label})` : '';
    md += `${i + 1}. \`${r.id}\` — **${r.title}**${labelStr} \`[${r.type}]\` (score: ${r.score.toFixed(1)})\n`;
  }
  const remaining = total - Math.min(items.length, limit);
  if (remaining > 0) {
    md += `\n_…and ${remaining} more related pages_\n`;
  }
  return md + '\n';
}

function backlinksBlock(items: BacklinksResult['backlinks'], total: number, limit = 8): string {
  if (items.length === 0) return '';
  let md = `## Backlinks (pages that link here)\n\n`;
  for (const b of items.slice(0, limit)) {
    const relStr = b.relationship ? ` — ${b.relationship}` : '';
    md += `- \`${b.id}\` — **${b.title}**${relStr}\n`;
  }
  const remaining = total - Math.min(items.length, limit);
  if (remaining > 0) {
    md += `- _…and ${remaining} more_\n`;
  }
  return md + '\n';
}

function citationHealthBlock(quotes: CitationQuote[], total: number): string {
  if (total === 0) return '';
  const verified = quotes.filter((q) => q.quoteVerified).length;
  // Single filter — reuse for both count and iteration
  const problems = quotes.filter(
    (q) => q.accuracyVerdict === 'inaccurate' || q.accuracyVerdict === 'unsupported',
  );
  const broken = problems.length;

  let md = `## Citation Health\n\n`;
  md += `${total} citation${total !== 1 ? 's' : ''} total`;
  const showing = quotes.length < total ? ` (showing ${quotes.length}; counts below apply to shown citations only)` : '';
  md += `${showing}. ${verified} verified, ${broken} broken/inaccurate.\n\n`;

  if (problems.length > 0) {
    md += `### Problems\n\n`;
    for (const q of problems.slice(0, 5)) {
      const claim = q.claimText.slice(0, 120);
      md += `- **[${q.footnote}]** ${q.accuracyVerdict}: ${claim}${claim.length < q.claimText.length ? '…' : ''}\n`;
    }
    md += '\n';
  }

  return md;
}

function pageSearchBlock(results: PageSearchResult['results'], query: string, limit = 10): string {
  if (results.length === 0) return `_No pages found matching "${query}"._\n\n`;
  let md = '';
  for (let i = 0; i < Math.min(results.length, limit); i++) {
    const r = results[i];
    const q = r.quality !== null ? `Quality: ${r.quality}/10` : null;
    const imp = r.readerImportance !== null ? `Importance: ${r.readerImportance}/100` : null;
    const meta = [q, imp, r.entityType ? `Type: ${r.entityType}` : null]
      .filter(Boolean)
      .join(' | ');
    md += `${i + 1}. \`${r.id}\` — **${r.title}** (score: ${r.score.toFixed(3)})\n`;
    if (meta) md += `   ${meta}\n`;
    if (r.description) {
      const desc = r.description.slice(0, 120);
      md += `   _${desc}${desc.length < r.description.length ? '…' : ''}_\n`;
    }
  }
  if (results.length > limit) {
    md += `\n_…and ${results.length - limit} more results_\n`;
  }
  return md + '\n';
}

function entityBlock(e: EntityEntry): string {
  let md = `### ${e.title} (\`${e.id}\`)\n\n`;
  const meta: string[] = [`Type: ${e.entityType}`];
  if (e.status) meta.push(`Status: ${e.status}`);
  if (e.website) meta.push(`Website: ${e.website}`);
  md += `**${meta.join(' | ')}**\n\n`;

  if (e.description) {
    const desc = e.description.slice(0, 300);
    md += `${desc}${desc.length < e.description.length ? '…' : ''}\n\n`;
  }

  if (e.tags?.length) {
    md += `**Tags**: ${e.tags.join(', ')}\n\n`;
  }

  if (e.customFields?.length) {
    md += `**Key fields**: ${e.customFields
      .slice(0, 5)
      .map((f) => `${f.label}: ${f.value}`)
      .join(', ')}\n\n`;
  }

  return md;
}

function factsBlock(facts: FactEntry[], limit = 10): string {
  if (facts.length === 0) return '';
  let md = `## Key Facts\n\n`;
  md += `| Measure / Label | Value | As Of |\n`;
  md += `|-----------------|-------|-------|\n`;
  for (const f of facts.slice(0, limit)) {
    const label = (f.label || f.measure || f.factId || '').slice(0, 30);
    let value = f.value || '';
    if (f.numeric !== null && f.numeric !== undefined) {
      value = String(f.numeric);
      if (f.low !== null && f.high !== null) value += ` [${f.low}–${f.high}]`;
      if (f.format) value += ` ${f.format}`;
    }
    const asOf = f.asOf ? f.asOf.slice(0, 10) : '';
    md += `| ${label} | ${value} | ${asOf} |\n`;
  }
  if (facts.length > limit) {
    md += `\n_…and ${facts.length - limit} more facts_\n`;
  }
  return md + '\n';
}

// ---------------------------------------------------------------------------
// for-page — bundle for a specific wiki page
// ---------------------------------------------------------------------------

async function forPage(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const pageId = args.find((a) => !a.startsWith('-'));
  if (!pageId) {
    return {
      output: `${c.red}Error: page ID required.\n  Usage: crux context for-page <page-id>${c.reset}`,
      exitCode: 1,
    };
  }

  const outputPath = (options.output as string) || DEFAULT_OUTPUT;

  // Fetch all data in parallel
  const [pageResult, relatedResult, backlinksResult, citationsResult] = await Promise.all([
    apiRequest<PageDetail>('GET', `/api/pages/${encodeURIComponent(pageId)}`),
    apiRequest<RelatedResult>('GET', `/api/links/related/${encodeURIComponent(pageId)}?limit=15`),
    apiRequest<BacklinksResult>(
      'GET',
      `/api/links/backlinks/${encodeURIComponent(pageId)}?limit=10`,
    ),
    apiRequest<CitationQuotesResult>(
      'GET',
      `/api/citations/quotes?page_id=${encodeURIComponent(pageId)}&limit=20`,
    ),
  ]);

  if (!pageResult.ok) {
    if (pageResult.error === 'bad_request') {
      return {
        output: `${c.yellow}Page not found: ${pageId}\n  Check the page ID is correct.${c.reset}`,
        exitCode: 1,
      };
    }
    const bundle =
      mdHeader(`Page: ${pageId}`, 'for-page', [pageId]) +
      `> ⚠️ Wiki-server unavailable: ${pageResult.message}\n\n` +
      `Unable to fetch page data. Check \`LONGTERMWIKI_SERVER_URL\` is set.\n`;
    writeBundle(outputPath, bundle);
    return {
      output: `${c.yellow}Wiki-server unavailable. Minimal bundle written to ${outputPath}${c.reset}`,
      exitCode: 1,
    };
  }

  const p = pageResult.data;
  let bundle = mdHeader(`Page: ${p.title}`, 'for-page', [pageId]);
  bundle += pageDetailBlock(p);
  bundle += '---\n\n';

  if (relatedResult.ok && relatedResult.data.related.length > 0) {
    bundle += relatedPagesBlock(relatedResult.data.related, relatedResult.data.total);
  }

  if (backlinksResult.ok && backlinksResult.data.backlinks.length > 0) {
    bundle += backlinksBlock(backlinksResult.data.backlinks, backlinksResult.data.total);
  }

  if (citationsResult.ok) {
    bundle += citationHealthBlock(citationsResult.data.quotes, citationsResult.data.total);
  }

  const print = options.print as boolean;
  if (print) {
    return { output: bundle, exitCode: 0 };
  }

  writeBundle(outputPath, bundle);

  const summary = [
    `${c.green}✓${c.reset} Context bundle written to ${c.cyan}${outputPath}${c.reset}`,
    `  Page: ${p.title} (${pageId})`,
    relatedResult.ok ? `  Related pages: ${relatedResult.data.related.length}` : '',
    backlinksResult.ok ? `  Backlinks: ${backlinksResult.data.backlinks.length}` : '',
    citationsResult.ok ? `  Citations: ${citationsResult.data.total} total` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { output: summary, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// for-entity — bundle for a specific entity
// ---------------------------------------------------------------------------

async function forEntity(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const entityId = args.find((a) => !a.startsWith('-'));
  if (!entityId) {
    return {
      output: `${c.red}Error: entity ID required.\n  Usage: crux context for-entity <id>${c.reset}`,
      exitCode: 1,
    };
  }

  const outputPath = (options.output as string) || DEFAULT_OUTPUT;

  // Fetch entity, facts, and pages mentioning this entity in parallel
  const [entityResult, factsResult, pageSearchResult] = await Promise.all([
    getEntity(entityId),
    getFactsByEntity(entityId, 20),
    apiRequest<PageSearchResult>(
      'GET',
      `/api/pages/search?q=${encodeURIComponent(entityId)}&limit=10`,
    ),
  ]);

  if (!entityResult.ok) {
    if (entityResult.error === 'bad_request') {
      return {
        output: `${c.yellow}Entity not found: ${entityId}\n  Check the entity ID is correct.${c.reset}`,
        exitCode: 1,
      };
    }
    const bundle =
      mdHeader(`Entity: ${entityId}`, 'for-entity', [entityId]) +
      `> ⚠️ Wiki-server unavailable: ${entityResult.message}\n\n` +
      `Unable to fetch entity data. Check \`LONGTERMWIKI_SERVER_URL\` is set.\n`;
    writeBundle(outputPath, bundle);
    return {
      output: `${c.yellow}Wiki-server unavailable. Minimal bundle written to ${outputPath}${c.reset}`,
      exitCode: 1,
    };
  }

  const e = entityResult.data;
  let bundle = mdHeader(`Entity: ${e.title}`, 'for-entity', [entityId]);
  bundle += entityBlock(e);
  bundle += '---\n\n';

  if (factsResult.ok && factsResult.data.facts.length > 0) {
    bundle += factsBlock(factsResult.data.facts);
  }

  if (e.relatedEntries?.length) {
    bundle += `## Related Entities\n\n`;
    for (const r of e.relatedEntries.slice(0, 10)) {
      bundle += `- \`${r.id}\` \`[${r.type}]\`${r.relationship ? ` — ${r.relationship}` : ''}\n`;
    }
    if (e.relatedEntries.length > 10) {
      bundle += `- _…and ${e.relatedEntries.length - 10} more_\n`;
    }
    bundle += '\n';
  }

  if (pageSearchResult.ok && pageSearchResult.data.results.length > 0) {
    bundle += `## Pages Mentioning "${e.title}"\n\n`;
    bundle += pageSearchBlock(pageSearchResult.data.results, entityId);
  }

  if (e.sources?.length) {
    bundle += `## Sources\n\n`;
    for (const s of e.sources.slice(0, 5)) {
      bundle += `- **${s.title}**`;
      if (s.author) bundle += ` (${s.author})`;
      if (s.date) bundle += ` — ${s.date}`;
      if (s.url) bundle += `\n  ${s.url}`;
      bundle += '\n';
    }
    bundle += '\n';
  }

  const print = options.print as boolean;
  if (print) {
    return { output: bundle, exitCode: 0 };
  }

  writeBundle(outputPath, bundle);

  const summary = [
    `${c.green}✓${c.reset} Context bundle written to ${c.cyan}${outputPath}${c.reset}`,
    `  Entity: ${e.title} (${entityId}) [${e.entityType}]`,
    factsResult.ok ? `  Facts: ${factsResult.data.facts.length}` : '',
    pageSearchResult.ok ? `  Pages mentioning entity: ${pageSearchResult.data.results.length}` : '',
  ]
    .filter(Boolean)
    .join('\n');

  return { output: summary, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// for-topic — bundle for a free-text research topic
// ---------------------------------------------------------------------------

async function forTopic(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const topic = args.filter((a) => !a.startsWith('-')).join(' ').trim();
  if (!topic) {
    return {
      output: `${c.red}Error: topic required.\n  Usage: crux context for-topic "topic phrase"${c.reset}`,
      exitCode: 1,
    };
  }

  const outputPath = (options.output as string) || DEFAULT_OUTPUT;
  const limit = Math.min(Math.max(1, parseIntOpt(options.limit, 10)), 20);

  // Search pages and entities in parallel
  const [pageSearchResult, entitySearchResult] = await Promise.all([
    apiRequest<PageSearchResult>(
      'GET',
      `/api/pages/search?q=${encodeURIComponent(topic)}&limit=${limit}`,
    ),
    searchEntities(topic, 8),
  ]);

  let bundle = mdHeader(`Topic: "${topic}"`, 'for-topic', [`"${topic}"`]);

  // Pages section
  bundle += `## Top Pages Matching "${topic}"\n\n`;
  if (pageSearchResult.ok) {
    const { results, total } = pageSearchResult.data;
    if (results.length > 0) {
      bundle += `_${total} result${total !== 1 ? 's' : ''} found, showing top ${results.length}._\n\n`;
      bundle += pageSearchBlock(results, topic, limit);
    } else {
      bundle += `_No pages found matching "${topic}"._\n\n`;
    }
  } else {
    bundle += `> ⚠️ Wiki-server unavailable: ${pageSearchResult.message}\n\n`;
    bundle += `Check \`LONGTERMWIKI_SERVER_URL\` is set.\n\n`;
  }

  // Entities section
  if (entitySearchResult.ok && entitySearchResult.data.results.length > 0) {
    bundle += `## Related Entities\n\n`;
    for (const e of entitySearchResult.data.results.slice(0, 6)) {
      bundle += entityBlock(e);
    }
  }

  const print = options.print as boolean;
  if (print) {
    return { output: bundle, exitCode: 0 };
  }

  writeBundle(outputPath, bundle);

  const pageCount = pageSearchResult.ok ? pageSearchResult.data.results.length : 0;
  const entityCount = entitySearchResult.ok ? entitySearchResult.data.results.length : 0;

  const summary = [
    `${c.green}✓${c.reset} Context bundle written to ${c.cyan}${outputPath}${c.reset}`,
    `  Topic: "${topic}"`,
    `  Pages found: ${pageCount}`,
    `  Entities found: ${entityCount}`,
  ].join('\n');

  return { output: summary, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// for-issue — bundle for a GitHub issue
// ---------------------------------------------------------------------------

async function forIssue(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const issueNumStr = args.find((a) => !a.startsWith('-'));
  const issueNum = issueNumStr ? parseInt(issueNumStr, 10) : NaN;

  if (!issueNumStr || isNaN(issueNum)) {
    return {
      output: `${c.red}Error: issue number required.\n  Usage: crux context for-issue <N>${c.reset}`,
      exitCode: 1,
    };
  }

  const outputPath = (options.output as string) || DEFAULT_OUTPUT;

  // Fetch GitHub issue
  let issue: GitHubIssueResponse;
  try {
    issue = await githubApi<GitHubIssueResponse>(`/repos/${REPO}/issues/${issueNum}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      output: `${c.red}Error fetching issue #${issueNum}: ${msg}${c.reset}`,
      exitCode: 1,
    };
  }

  // Use issue title as the primary search query, then run page + entity search in parallel
  const searchQuery = issue.title;

  const [pageSearchResult, entitySearchResult] = await Promise.all([
    apiRequest<PageSearchResult>(
      'GET',
      `/api/pages/search?q=${encodeURIComponent(searchQuery)}&limit=10`,
    ),
    searchEntities(searchQuery, 6),
  ]);

  const labels = (issue.labels || []).map((l) => l.name);
  const createdAt = issue.created_at.slice(0, 10);
  const body = (issue.body || '').trim();

  let bundle = mdHeader(
    `Issue #${issue.number}: ${issue.title}`,
    'for-issue',
    [String(issueNum)],
  );

  // Issue metadata and body
  bundle += `## Issue #${issue.number}: ${issue.title}\n\n`;
  bundle += `**URL**: ${issue.html_url}\n`;
  if (labels.length > 0) bundle += `**Labels**: ${labels.join(', ')}\n`;
  bundle += `**Created**: ${createdAt} | **Updated**: ${issue.updated_at.slice(0, 10)}\n\n`;

  if (body) {
    // Truncate very long issue bodies to avoid overwhelming the bundle
    const bodyPreview = body.length > 3000 ? body.slice(0, 3000) + '\n\n_…(body truncated)_' : body;
    bundle += `### Description\n\n${bodyPreview}\n\n`;
  }

  bundle += '---\n\n';

  // Related wiki pages
  bundle += `## Related Wiki Pages\n\n`;
  bundle += `_Search query: "${searchQuery}"_\n\n`;

  if (pageSearchResult.ok) {
    if (pageSearchResult.data.results.length > 0) {
      bundle += pageSearchBlock(pageSearchResult.data.results, searchQuery);
    } else {
      bundle += `_No pages found matching the issue title._\n\n`;
    }
  } else {
    bundle += `> ⚠️ Wiki-server unavailable: ${pageSearchResult.message}\n\n`;
    bundle += `Check \`LONGTERMWIKI_SERVER_URL\` is set.\n\n`;
  }

  // Related entities
  if (entitySearchResult.ok && entitySearchResult.data.results.length > 0) {
    bundle += `## Related Entities\n\n`;
    for (const e of entitySearchResult.data.results) {
      bundle += entityBlock(e);
    }
  }

  const print = options.print as boolean;
  if (print) {
    return { output: bundle, exitCode: 0 };
  }

  writeBundle(outputPath, bundle);

  const pageCount = pageSearchResult.ok ? pageSearchResult.data.results.length : 0;
  const entityCount = entitySearchResult.ok ? entitySearchResult.data.results.length : 0;

  const summary = [
    `${c.green}✓${c.reset} Context bundle written to ${c.cyan}${outputPath}${c.reset}`,
    `  Issue: #${issue.number} — ${issue.title}`,
    `  Related pages found: ${pageCount}`,
    `  Related entities found: ${entityCount}`,
  ].join('\n');

  return { output: summary, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands: Record<
  string,
  (args: string[], options: Record<string, unknown>) => Promise<CommandResult>
> = {
  'for-issue': forIssue,
  'for-page': forPage,
  'for-entity': forEntity,
  'for-topic': forTopic,
};

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function getHelp(): string {
  return `
Context Domain - Assemble research bundles for Claude Code sessions

Eliminates the 5-15 manual tool calls needed to gather background context
at the start of a session. Each command queries the wiki-server and GitHub
to produce a single structured markdown file.

Commands:
  for-issue <N>         Context bundle for GitHub issue N
  for-page <page-id>    Context bundle for a wiki page
  for-entity <id>       Context bundle for an entity
  for-topic "topic"     Context bundle for a free-text topic

Options:
  --output=<path>       Output file path (default: .claude/wip-context.md)
  --print               Write to stdout instead of a file
  --limit=N             Max search results for for-topic (default: 10, max: 20)

Notes:
  - for-page, for-entity, for-topic require LONGTERMWIKI_SERVER_URL
  - for-issue requires GITHUB_TOKEN and optionally LONGTERMWIKI_SERVER_URL
  - All commands degrade gracefully when the wiki-server is unavailable

Output includes:
  for-issue:   Issue body, related wiki pages, related entities
  for-page:    Page metadata + LLM summary, related pages, backlinks, citations
  for-entity:  Entity profile, key facts, related entities, pages mentioning it
  for-topic:   Top matching pages (ranked), related entities

Examples:
  crux context for-issue 580
  crux context for-issue 580 --output=my-context.md
  crux context for-page scheming
  crux context for-page deceptive-alignment --print
  crux context for-entity anthropic
  crux context for-entity openai --output=openai-context.md
  crux context for-topic "AI safety compute governance"
  crux context for-topic "RLHF alignment tax" --limit=15
`;
}
