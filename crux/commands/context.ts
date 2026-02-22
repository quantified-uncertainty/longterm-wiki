/**
 * Context Command Handlers
 *
 * Assembles research bundles for Claude Code sessions — queries the wiki-server
 * and local files to produce a structured markdown file with everything needed
 * for a given task. Saves 5-15 tool calls per session by gathering context upfront.
 *
 * Usage:
 *   crux context for-page scheming
 *   crux context for-entity anthropic
 *   crux context for-issue 563
 *   crux context for-topic "compute governance trends 2025"
 *
 * Output defaults to .claude/wip-context.md. Override with --output=<path>.
 *
 * Requires LONGTERMWIKI_SERVER_URL (set in environment).
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import type { CommandResult } from '../lib/cli.ts';
import { parseIntOpt } from '../lib/cli.ts';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { getEntity } from '../lib/wiki-server/entities.ts';
import { getFactsByEntity } from '../lib/wiki-server/facts.ts';
import { findPageById } from '../lib/page-resolution.ts';
import { githubApi, REPO } from '../lib/github.ts';
import { PROJECT_ROOT, DATA_DIR_ABS } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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
  wordCount: number | null;
  lastUpdated: string | null;
  contentFormat: string | null;
  syncedAt: string;
}

interface RelatedItem {
  id: string;
  type: string;
  title: string;
  score: number;
  label?: string;
}

interface RelatedResult {
  entityId: string;
  related: RelatedItem[];
  total: number;
}

interface BacklinkItem {
  id: string;
  type: string;
  title: string;
  relationship?: string;
  linkType: string;
  weight: number;
}

interface BacklinksResult {
  targetId: string;
  backlinks: BacklinkItem[];
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

interface SearchResult {
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

interface EntitySearchResult {
  results: Array<{
    id: string;
    entityType: string;
    title: string;
    description: string | null;
  }>;
  query: string;
  total: number;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  labels: Array<{ name: string }>;
  html_url: string;
  created_at: string;
  updated_at: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Default output path for context bundles */
const DEFAULT_OUTPUT = path.join(PROJECT_ROOT, '.claude/wip-context.md');

/** Write context to file and return success message */
function writeContext(content: string, outputPath: string): void {
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(outputPath, content, 'utf-8');
}

/** Format a number or null as a string with fallback */
function fmt(val: number | null | undefined, decimals = 0): string {
  if (val === null || val === undefined) return 'N/A';
  return decimals > 0 ? val.toFixed(decimals) : String(val);
}

/** Find entity YAML snippet for a given entity ID by scanning data/entities/ */
function findEntityYaml(entityId: string): string | null {
  const entitiesDir = path.join(DATA_DIR_ABS, 'entities');
  if (!fs.existsSync(entitiesDir)) return null;

  const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(entitiesDir, file), 'utf-8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA });
      if (!Array.isArray(parsed)) continue;
      const entity = parsed.find((e: unknown) => (e as { id?: string })?.id === entityId);
      if (entity) {
        // Serialize just this entity back to YAML
        return yaml.dump([entity], { indent: 2, lineWidth: 120 });
      }
    } catch {
      // Skip malformed files
    }
  }
  return null;
}

/** Extract page IDs and keywords from text (issue body, etc.) */
function extractKeywords(text: string): string[] {
  // Remove URLs, markdown links, code blocks
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, ' $1 ');

  // Extract slug-like words that look like page IDs (kebab-case, 3+ chars)
  const slugPattern = /\b([a-z][a-z0-9]{2,}(?:-[a-z0-9]+)+)\b/g;
  const slugCandidates = [...cleaned.matchAll(slugPattern)].map(m => m[1]);

  // Extract meaningful nouns/phrases (capitalized words, multi-word phrases)
  const words = cleaned
    .split(/[\s\n\r,;:!?()[\]{}"']+/)
    .filter(w => w.length >= 4 && /^[a-zA-Z]/.test(w))
    .map(w => w.toLowerCase());

  return [...new Set([...slugCandidates, ...words])].slice(0, 30);
}

/** Format a markdown table row */
function tableRow(...cells: string[]): string {
  return `| ${cells.join(' | ')} |`;
}

/** Format a citation status summary */
function formatCitationSummary(quotes: CitationQuote[], total: number | undefined): string {
  const verified = quotes.filter(q => q.quoteVerified).length;
  const broken = quotes.filter(q => q.accuracyVerdict === 'inaccurate' || q.accuracyVerdict === 'unsupported').length;
  const unchecked = quotes.filter(q => !q.accuracyVerdict).length;
  const totalStr = (total !== undefined && total !== null) ? String(total) : String(quotes.length);
  return `${totalStr} total, ${verified} verified, ${broken} broken, ${unchecked} unchecked`;
}

// ---------------------------------------------------------------------------
// for-page — context bundle for editing a specific wiki page
// ---------------------------------------------------------------------------

export async function forPage(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const pageId = args.find(a => !a.startsWith('-'));
  if (!pageId) {
    return { output: `Error: page ID required. Usage: crux context for-page <page-id>`, exitCode: 1 };
  }

  const outputPath = (options.output as string) || DEFAULT_OUTPUT;
  const relatedLimit = parseIntOpt(options.related, 10);
  const backlinkLimit = parseIntOpt(options.backlinks, 10);

  // Fetch all data in parallel
  const [pageResult, relatedResult, backlinksResult, citationsResult] = await Promise.all([
    apiRequest<PageDetail>('GET', `/api/pages/${encodeURIComponent(pageId)}`),
    apiRequest<RelatedResult>('GET', `/api/links/related/${encodeURIComponent(pageId)}?limit=${relatedLimit}`),
    apiRequest<BacklinksResult>('GET', `/api/links/backlinks/${encodeURIComponent(pageId)}?limit=${backlinkLimit}`),
    apiRequest<CitationQuotesResult>('GET', `/api/citations/quotes?page_id=${encodeURIComponent(pageId)}&limit=50`),
  ]);

  if (!pageResult.ok) {
    return { output: `Error: could not fetch page "${pageId}": ${pageResult.message}`, exitCode: 1 };
  }

  const p = pageResult.data;

  // Read frontmatter from filesystem
  const pageInfo = findPageById(pageId);
  const frontmatter = pageInfo?.frontmatter || {};

  // Find entity YAML if the page is linked to an entity
  const entityId = (frontmatter.entityId as string) || pageId;
  const entityYaml = findEntityYaml(entityId);

  // Fetch entity facts if entity exists
  let factsSection = '';
  if (entityYaml) {
    const factsResult = await getFactsByEntity(entityId, 15, 0);
    if (factsResult.ok && factsResult.data.facts.length > 0) {
      const facts = factsResult.data.facts;
      factsSection = `## Key Facts (${entityId})\n\n`;
      factsSection += tableRow('Label/Measure', 'Value', 'Date', 'Note') + '\n';
      factsSection += tableRow('---', '---', '---', '---') + '\n';
      for (const f of facts) {
        const label = (f.label || f.measure || f.factId || '').slice(0, 40);
        let value = typeof f.value === 'object' && f.value !== null ? JSON.stringify(f.value) : (f.value || '');
        if (f.numeric !== null && f.numeric !== undefined) {
          value = String(f.numeric);
          if (f.low !== null && f.high !== null) value += ` [${f.low}–${f.high}]`;
          if (f.format) value += ` ${f.format}`;
        }
        const date = f.asOf ? f.asOf.slice(0, 10) : '';
        const note = (f.note || '').slice(0, 60);
        factsSection += tableRow(label, value, date, note) + '\n';
      }
      factsSection += '\n';
    }
  }

  // Assemble markdown
  const title = p.title || pageId;
  const typeStr = p.entityType ? ` (${p.entityType})` : '';
  let md = `# Context: ${title}${typeStr}\n\n`;
  md += `> Generated by \`crux context for-page ${pageId}\` on ${new Date().toISOString().slice(0, 10)}\n\n`;

  // Page Metadata
  md += `## Page Metadata\n\n`;
  md += `- **ID**: \`${p.id}\`\n`;
  if (p.numericId) md += `- **Numeric ID**: ${p.numericId}\n`;
  if (p.entityType) md += `- **Type**: ${p.entityType}\n`;
  if (p.category) md += `- **Category**: ${p.category}${p.subcategory ? ` / ${p.subcategory}` : ''}\n`;
  if (p.quality !== null) md += `- **Quality**: ${fmt(p.quality)}/100\n`;
  if (p.readerImportance !== null) md += `- **Reader Importance**: ${fmt(p.readerImportance)}/100\n`;
  if (p.hallucinationRiskLevel) {
    md += `- **Hallucination Risk**: ${p.hallucinationRiskLevel}`;
    if (p.hallucinationRiskScore !== null) md += ` (score: ${fmt(p.hallucinationRiskScore, 2)})`;
    md += '\n';
  }
  if (p.wordCount) md += `- **Word Count**: ${p.wordCount.toLocaleString()}\n`;
  if (p.lastUpdated) md += `- **Last Updated**: ${p.lastUpdated}\n`;
  if (p.tags) md += `- **Tags**: ${p.tags}\n`;
  md += '\n';

  if (p.description) {
    md += `### Description\n\n${p.description}\n\n`;
  }

  if (p.llmSummary) {
    md += `### Summary\n\n${p.llmSummary}\n\n`;
  }

  // Facts
  if (factsSection) {
    md += factsSection;
  }

  // Related Pages
  if (relatedResult.ok && relatedResult.data.related.length > 0) {
    const items = relatedResult.data.related;
    md += `## Related Pages (top ${items.length})\n\n`;
    md += tableRow('Page ID', 'Title', 'Type', 'Relationship', 'Score') + '\n';
    md += tableRow('---', '---', '---', '---', '---') + '\n';
    for (const r of items) {
      md += tableRow(r.id, r.title, r.type, r.label || '', r.score.toFixed(1)) + '\n';
    }
    md += '\n';
  }

  // Backlinks
  if (backlinksResult.ok && backlinksResult.data.backlinks.length > 0) {
    const items = backlinksResult.data.backlinks;
    md += `## Backlinks (${backlinksResult.data.total} pages link here)\n\n`;
    md += tableRow('Page ID', 'Title', 'Link Type', 'Weight') + '\n';
    md += tableRow('---', '---', '---', '---') + '\n';
    for (const r of items) {
      md += tableRow(r.id, r.title, r.linkType, String(r.weight)) + '\n';
    }
    md += '\n';
  }

  // Citation Health
  if (citationsResult.ok) {
    const { quotes, total } = citationsResult.data;
    md += `## Citation Health\n\n`;
    md += `- **Summary**: ${formatCitationSummary(quotes, total)}\n`;
    const broken = quotes.filter(q => q.accuracyVerdict === 'inaccurate' || q.accuracyVerdict === 'unsupported');
    if (broken.length > 0) {
      md += `- **Broken Citations**:\n`;
      for (const b of broken) {
        md += `  - Footnote ${b.footnote}: ${b.claimText.slice(0, 100)}`;
        if (b.sourceTitle) md += ` (${b.sourceTitle})`;
        md += '\n';
      }
    }
    md += '\n';
  }

  // Entity YAML
  if (entityYaml) {
    md += `## Entity YAML (\`${entityId}\`)\n\n`;
    md += '```yaml\n';
    md += entityYaml;
    md += '```\n\n';
  }

  // Frontmatter
  if (pageInfo && Object.keys(frontmatter).length > 0) {
    md += `## MDX Frontmatter\n\n`;
    md += '```yaml\n';
    md += yaml.dump(frontmatter, { indent: 2, lineWidth: 120 });
    md += '```\n\n';
    if (pageInfo.filePath) {
      md += `> File: \`${path.relative(PROJECT_ROOT, pageInfo.filePath)}\`\n\n`;
    }
  }

  // Write output
  writeContext(md, outputPath);

  const relPath = path.relative(process.cwd(), outputPath);
  return {
    output: `✓ Context bundle written to ${relPath}\n  Page: ${title}\n  Related: ${relatedResult.ok ? relatedResult.data.related.length : 0} pages, Backlinks: ${backlinksResult.ok ? backlinksResult.data.total : 0}, Citations: ${citationsResult.ok ? citationsResult.data.total : 0}`,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// for-entity — context bundle for working with a specific entity
// ---------------------------------------------------------------------------

export async function forEntity(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const entityId = args.find(a => !a.startsWith('-'));
  if (!entityId) {
    return { output: `Error: entity ID required. Usage: crux context for-entity <entity-id>`, exitCode: 1 };
  }

  const outputPath = (options.output as string) || DEFAULT_OUTPUT;

  // Fetch entity data and facts in parallel
  const [entityResult, factsResult, backlinksResult] = await Promise.all([
    getEntity(entityId),
    getFactsByEntity(entityId, 30, 0),
    apiRequest<BacklinksResult>('GET', `/api/links/backlinks/${encodeURIComponent(entityId)}?limit=15`),
  ]);

  if (!entityResult.ok) {
    if (entityResult.error === 'bad_request') {
      return { output: `Error: entity not found: ${entityId}`, exitCode: 1 };
    }
    return { output: `Error: ${entityResult.message}`, exitCode: 1 };
  }

  const e = entityResult.data;

  // Find entity YAML from filesystem
  const entityYaml = findEntityYaml(entityId);

  // Assemble markdown
  let md = `# Context: Entity — ${e.title}\n\n`;
  md += `> Generated by \`crux context for-entity ${entityId}\` on ${new Date().toISOString().slice(0, 10)}\n\n`;

  // Entity Metadata
  md += `## Entity Metadata\n\n`;
  md += `- **ID**: \`${e.id}\`\n`;
  if (e.numericId) md += `- **Numeric ID**: ${e.numericId}\n`;
  md += `- **Type**: ${e.entityType}\n`;
  if (e.status) md += `- **Status**: ${e.status}\n`;
  if (e.website) md += `- **Website**: ${e.website}\n`;
  if (e.lastUpdated) md += `- **Last Updated**: ${e.lastUpdated}\n`;
  if (e.tags?.length) md += `- **Tags**: ${e.tags.join(', ')}\n`;
  md += '\n';

  if (e.description) {
    md += `### Description\n\n${e.description}\n\n`;
  }

  // Custom Fields
  if (e.customFields?.length) {
    md += `### Custom Fields\n\n`;
    for (const f of e.customFields) {
      md += `- **${f.label}**: ${f.value}${f.link ? ` ([link](${f.link}))` : ''}\n`;
    }
    md += '\n';
  }

  // Related Entities
  if (e.relatedEntries?.length) {
    md += `## Related Entities\n\n`;
    md += tableRow('ID', 'Type', 'Relationship') + '\n';
    md += tableRow('---', '---', '---') + '\n';
    for (const r of e.relatedEntries) {
      md += tableRow(r.id, r.type, r.relationship || '') + '\n';
    }
    md += '\n';
  }

  // Facts
  if (factsResult.ok && factsResult.data.facts.length > 0) {
    const facts = factsResult.data.facts;
    md += `## Numeric Facts (${factsResult.data.total} total)\n\n`;
    md += tableRow('Label/Measure', 'Value', 'Date', 'Note') + '\n';
    md += tableRow('---', '---', '---', '---') + '\n';
    for (const f of facts.slice(0, 20)) {
      const label = (f.label || f.measure || f.factId || '').slice(0, 40);
      let value = typeof f.value === 'object' && f.value !== null ? JSON.stringify(f.value) : (f.value || '');
      if (f.numeric !== null && f.numeric !== undefined) {
        value = String(f.numeric);
        if (f.low !== null && f.high !== null) value += ` [${f.low}–${f.high}]`;
        if (f.format) value += ` ${f.format}`;
      }
      const date = f.asOf ? f.asOf.slice(0, 10) : '';
      const note = (f.note || '').slice(0, 60);
      md += tableRow(label, value, date, note) + '\n';
    }
    md += '\n';
  }

  // Pages linking to this entity
  if (backlinksResult.ok && backlinksResult.data.backlinks.length > 0) {
    const items = backlinksResult.data.backlinks;
    md += `## Pages Referencing This Entity (${backlinksResult.data.total} total)\n\n`;
    md += tableRow('Page ID', 'Title', 'Link Type') + '\n';
    md += tableRow('---', '---', '---') + '\n';
    for (const r of items) {
      md += tableRow(r.id, r.title, r.linkType) + '\n';
    }
    md += '\n';
  }

  // Sources
  if (e.sources?.length) {
    md += `## Sources\n\n`;
    for (const s of e.sources) {
      md += `- ${s.title}`;
      if (s.author) md += ` — ${s.author}`;
      if (s.date) md += ` (${s.date})`;
      if (s.url) md += ` — [link](${s.url})`;
      md += '\n';
    }
    md += '\n';
  }

  // Entity YAML
  if (entityYaml) {
    md += `## Entity YAML\n\n`;
    md += '```yaml\n';
    md += entityYaml;
    md += '```\n\n';
  }

  writeContext(md, outputPath);

  const relPath = path.relative(process.cwd(), outputPath);
  return {
    output: `✓ Context bundle written to ${relPath}\n  Entity: ${e.title} (${e.entityType})\n  Facts: ${factsResult.ok ? factsResult.data.total : 0}, Backlinks: ${backlinksResult.ok ? backlinksResult.data.total : 0}`,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// for-issue — context bundle assembled from a GitHub issue
// ---------------------------------------------------------------------------

export async function forIssue(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const issueNumStr = args.find(a => !a.startsWith('-'));
  if (!issueNumStr) {
    return { output: `Error: issue number required. Usage: crux context for-issue <N>`, exitCode: 1 };
  }

  const issueNum = parseInt(issueNumStr, 10);
  if (isNaN(issueNum)) {
    return { output: `Error: invalid issue number: ${issueNumStr}`, exitCode: 1 };
  }

  const outputPath = (options.output as string) || DEFAULT_OUTPUT;

  // Fetch issue from GitHub
  let issue: GitHubIssue;
  try {
    issue = await githubApi<GitHubIssue>(`/repos/${REPO}/issues/${issueNum}`);
  } catch (err) {
    return { output: `Error: could not fetch issue #${issueNum}: ${(err as Error).message}`, exitCode: 1 };
  }

  const body = issue.body || '';
  const fullText = `${issue.title}\n\n${body}`;

  // Extract keywords and search the wiki
  const keywords = extractKeywords(fullText);
  const searchQuery = keywords.slice(0, 8).join(' ');

  // Find explicit page ID references in the issue body (slug-like patterns).
  // Strip URLs first to avoid false positives from URL path segments.
  const bodyWithoutUrls = body.replace(/https?:\/\/\S+/g, ' ');
  const pageRefs = [...bodyWithoutUrls.matchAll(/\b([a-z][a-z0-9-]{3,})\b/g)]
    .map(m => m[1])
    .filter(s => s.includes('-'))
    .slice(0, 5);

  // Run searches in parallel
  const [searchResult, entitySearchResult, ...pageResults] = await Promise.all([
    apiRequest<SearchResult>('GET', `/api/pages/search?q=${encodeURIComponent(searchQuery)}&limit=10`),
    apiRequest<EntitySearchResult>('GET', `/api/entities/search?q=${encodeURIComponent(searchQuery)}&limit=8`),
    ...pageRefs.map(ref => apiRequest<PageDetail>('GET', `/api/pages/${encodeURIComponent(ref)}`)),
  ]);

  // Assemble markdown
  let md = `# Context: Issue #${issueNum} — ${issue.title}\n\n`;
  md += `> Generated by \`crux context for-issue ${issueNum}\` on ${new Date().toISOString().slice(0, 10)}\n`;
  md += `> GitHub: ${issue.html_url}\n\n`;

  // Issue Details
  md += `## Issue Details\n\n`;
  md += `- **Number**: #${issueNum}\n`;
  md += `- **Title**: ${issue.title}\n`;
  md += `- **Labels**: ${issue.labels.map(l => l.name).join(', ') || 'none'}\n`;
  md += `- **Created**: ${issue.created_at.slice(0, 10)}\n`;
  md += `- **Updated**: ${issue.updated_at.slice(0, 10)}\n\n`;

  md += `### Issue Body\n\n`;
  md += body + '\n\n';

  // Specific pages referenced in the issue
  const resolvedPages = pageResults
    .map((r) => r)
    .filter((r): r is Extract<typeof r, { ok: true }> => r.ok);

  if (resolvedPages.length > 0) {
    md += `## Referenced Wiki Pages\n\n`;
    for (const result of resolvedPages) {
      const p = result.data;
      md += `### ${p.title} (\`${p.id}\`)\n\n`;
      md += `- **Type**: ${p.entityType || 'N/A'}\n`;
      md += `- **Category**: ${p.category || 'N/A'}${p.subcategory ? ` / ${p.subcategory}` : ''}\n`;
      if (p.quality !== null) md += `- **Quality**: ${fmt(p.quality)}/100\n`;
      if (p.hallucinationRiskLevel) md += `- **Risk**: ${p.hallucinationRiskLevel}\n`;
      if (p.wordCount) md += `- **Words**: ${p.wordCount.toLocaleString()}\n`;
      if (p.lastUpdated) md += `- **Last Updated**: ${p.lastUpdated}\n`;
      if (p.description) md += `\n${p.description.slice(0, 300)}\n`;
      md += '\n';
    }
  }

  // Search results
  if (searchResult.ok && searchResult.data.results.length > 0) {
    const results = searchResult.data.results;
    md += `## Related Wiki Pages (search: "${searchQuery}")\n\n`;
    md += tableRow('Page ID', 'Title', 'Type', 'Importance', 'Score') + '\n';
    md += tableRow('---', '---', '---', '---', '---') + '\n';
    for (const r of results) {
      md += tableRow(r.id, r.title, r.entityType || '', fmt(r.readerImportance), r.score.toFixed(3)) + '\n';
    }
    md += '\n';
  }

  // Related entities
  if (entitySearchResult.ok && entitySearchResult.data.results.length > 0) {
    const results = entitySearchResult.data.results;
    md += `## Related Entities\n\n`;
    md += tableRow('Entity ID', 'Type', 'Title', 'Description') + '\n';
    md += tableRow('---', '---', '---', '---') + '\n';
    for (const e of results) {
      const desc = (e.description || '').slice(0, 80);
      md += tableRow(e.id, e.entityType, e.title, desc) + '\n';
    }
    md += '\n';
  }

  writeContext(md, outputPath);

  const relPath = path.relative(process.cwd(), outputPath);
  return {
    output: `✓ Context bundle written to ${relPath}\n  Issue: #${issueNum} — ${issue.title}\n  Search results: ${searchResult.ok ? searchResult.data.results.length : 0} pages, ${entitySearchResult.ok ? entitySearchResult.data.results.length : 0} entities`,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// for-topic — context bundle for a free-text topic
// ---------------------------------------------------------------------------

export async function forTopic(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const topic = args.filter(a => !a.startsWith('-')).join(' ');
  if (!topic) {
    return { output: `Error: topic required. Usage: crux context for-topic "topic description"`, exitCode: 1 };
  }

  const outputPath = (options.output as string) || DEFAULT_OUTPUT;
  const searchLimit = parseIntOpt(options.limit, 12);

  // Run page search and entity search in parallel
  const [pageSearchResult, entitySearchResult] = await Promise.all([
    apiRequest<SearchResult>('GET', `/api/pages/search?q=${encodeURIComponent(topic)}&limit=${searchLimit}`),
    apiRequest<EntitySearchResult>('GET', `/api/entities/search?q=${encodeURIComponent(topic)}&limit=10`),
  ]);

  if (!pageSearchResult.ok) {
    return { output: `Error: search failed: ${pageSearchResult.message}`, exitCode: 1 };
  }

  const topPages = pageSearchResult.data.results.slice(0, 5);

  // Fetch related pages for the top result (to expand context)
  const expandedRelated = topPages.length > 0
    ? await apiRequest<RelatedResult>('GET', `/api/links/related/${encodeURIComponent(topPages[0].id)}?limit=8`)
    : null;

  // Assemble markdown
  let md = `# Context: Topic — ${topic}\n\n`;
  md += `> Generated by \`crux context for-topic "${topic}"\` on ${new Date().toISOString().slice(0, 10)}\n\n`;

  // Search Results
  if (pageSearchResult.data.results.length === 0) {
    md += `No wiki pages found for topic: "${topic}"\n\n`;
  } else {
    const results = pageSearchResult.data.results;
    md += `## Matching Wiki Pages (${pageSearchResult.data.total} total)\n\n`;
    md += tableRow('Page ID', 'Title', 'Type', 'Importance', 'Score') + '\n';
    md += tableRow('---', '---', '---', '---', '---') + '\n';
    for (const r of results) {
      md += tableRow(r.id, r.title, r.entityType || '', fmt(r.readerImportance), r.score.toFixed(3)) + '\n';
    }
    md += '\n';

    // Brief summaries for top 3
    md += `## Top Page Details\n\n`;
    for (const r of results.slice(0, 3)) {
      md += `### ${r.title} (\`${r.id}\`)\n\n`;
      md += `- **Type**: ${r.entityType || 'N/A'}\n`;
      md += `- **Category**: ${r.category || 'N/A'}\n`;
      if (r.readerImportance !== null) md += `- **Importance**: ${fmt(r.readerImportance)}/100\n`;
      if (r.quality !== null) md += `- **Quality**: ${fmt(r.quality)}/100\n`;
      if (r.description) md += `\n${r.description.slice(0, 300)}\n`;
      md += '\n';
    }
  }

  // Related pages (expanded from top result)
  if (expandedRelated?.ok && expandedRelated.data.related.length > 0) {
    md += `## Pages Related to "${topPages[0].title}"\n\n`;
    md += tableRow('Page ID', 'Title', 'Type', 'Score') + '\n';
    md += tableRow('---', '---', '---', '---') + '\n';
    for (const r of expandedRelated.data.related) {
      md += tableRow(r.id, r.title, r.type, r.score.toFixed(1)) + '\n';
    }
    md += '\n';
  }

  // Related entities
  if (entitySearchResult.ok && entitySearchResult.data.results.length > 0) {
    const results = entitySearchResult.data.results;
    md += `## Related Entities\n\n`;
    md += tableRow('Entity ID', 'Type', 'Title', 'Description') + '\n';
    md += tableRow('---', '---', '---', '---') + '\n';
    for (const e of results) {
      const desc = (e.description || '').slice(0, 80);
      md += tableRow(e.id, e.entityType, e.title, desc) + '\n';
    }
    md += '\n';
  }

  writeContext(md, outputPath);

  const relPath = path.relative(process.cwd(), outputPath);
  return {
    output: `✓ Context bundle written to ${relPath}\n  Topic: "${topic}"\n  Found: ${pageSearchResult.data.total} pages, ${entitySearchResult.ok ? entitySearchResult.data.results.length : 0} entities`,
    exitCode: 0,
  };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands: Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> = {
  'for-page': forPage,
  'for-entity': forEntity,
  'for-issue': forIssue,
  'for-topic': forTopic,
  default: async (_args, _options) => ({
    output: getHelp(),
    exitCode: 0,
  }),
};

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function getHelp(): string {
  return `
Context Domain — Assemble research bundles for Claude Code sessions

Queries the wiki-server and local files to produce a structured markdown
file with everything needed for a given task. Saves 5-15 tool calls per
session by gathering context upfront.

Commands:
  for-page <page-id>       Context for editing a specific wiki page
  for-entity <entity-id>   Context for working with a specific entity
  for-issue <N>            Context assembled from GitHub issue #N
  for-topic "query"        Context for a free-text topic (search-based)

Options:
  --output=<path>          Output file (default: .claude/wip-context.md)
  --related=N              Number of related pages (for-page, default: 10)
  --backlinks=N            Number of backlinks (for-page, default: 10)
  --limit=N                Search result limit (for-topic, default: 12)

Examples:
  crux context for-page scheming
  crux context for-page scheming --output=.claude/scheming-context.md
  crux context for-entity anthropic
  crux context for-issue 563
  crux context for-topic "compute governance trends 2025"
  crux context for-topic "deceptive alignment" --limit=20
`;
}
