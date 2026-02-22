/**
 * Query Command Handlers
 *
 * Query the wiki-server database for pages, entities, facts, links, citations,
 * risk scores, and recent activity. Replaces manual grep-based YAML file searches
 * with structured PostgreSQL queries.
 *
 * Usage:
 *   crux query search "deceptive alignment"    Full-text page search (ranked)
 *   crux query entity anthropic                Structured entity data
 *   crux query facts anthropic                 Numeric facts for an entity
 *   crux query related scheming                Related pages (graph query)
 *   crux query backlinks rlhf                  What links to this page?
 *   crux query page scheming                   Full page metadata
 *   crux query recent-changes --days=7         What changed this week?
 *   crux query recent-edits --days=7           Recent edit log entries
 *   crux query citations scheming              Citation health for a page
 *   crux query risk scheming                   Hallucination risk score
 *   crux query stats                           Wiki-wide statistics
 *
 * All commands support --json for machine-readable output.
 * Requires LONGTERMWIKI_SERVER_URL (set in environment).
 */

import { type CommandResult, parseIntOpt } from '../lib/cli.ts';
import { createLogger } from '../lib/output.ts';
import { apiRequest, getServerUrl } from '../lib/wiki-server/client.ts';
import { getEntity } from '../lib/wiki-server/entities.ts';
import { getFactsByEntity } from '../lib/wiki-server/facts.ts';
import {
  searchPages,
  getPage,
  getRelatedPages,
  getBacklinks,
  getCitationQuotes,
} from '../lib/wiki-server/pages.ts';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function serverUnavailableError(c: ReturnType<typeof createLogger>, result: { error: string; message: string }): CommandResult {
  const label = result.error === 'timeout' ? 'request timed out' : 'not available';
  return {
    output: `${c.colors.red}Error: wiki-server ${label} (${result.error}): ${result.message}\n  Check LONGTERMWIKI_SERVER_URL is set.${c.colors.reset}`,
    exitCode: 1,
  };
}

// ---------------------------------------------------------------------------
// search — full-text page search (PostgreSQL tsvector, ranked)
// ---------------------------------------------------------------------------

export async function search(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const query = args.filter((a) => !a.startsWith('-')).join(' ');
  if (!query) {
    return { output: `${c.red}Error: search query required. Usage: crux query search "topic"${c.reset}`, exitCode: 1 };
  }

  const limit = parseIntOpt(options.limit, 10);
  const result = await searchPages(query, limit);

  if (!result.ok) return serverUnavailableError(log, result);

  if (options.json || options.ci) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  const { results, total } = result.data;

  if (results.length === 0) {
    return { output: `${c.dim}No results for "${query}"${c.reset}`, exitCode: 0 };
  }

  let output = `${c.bold}${c.blue}Search: "${query}"${c.reset}\n`;
  output += `${c.dim}${total} result${total !== 1 ? 's' : ''}${c.reset}\n\n`;

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const scoreStr = r.score.toFixed(3);
    const typeStr = r.entityType ? ` ${c.dim}[${r.entityType}]${c.reset}` : '';
    output += `${c.bold}${String(i + 1).padStart(2)}.${c.reset} ${c.cyan}${r.id}${c.reset}${typeStr}\n`;
    output += `    ${c.bold}${r.title}${c.reset} ${c.dim}(score: ${scoreStr})${c.reset}\n`;
    if (r.description) {
      output += `    ${c.dim}${r.description.slice(0, 120)}${r.description.length > 120 ? '…' : ''}${c.reset}\n`;
    }
    output += '\n';
  }

  return { output: output.trimEnd(), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// entity — structured entity data
// ---------------------------------------------------------------------------

export async function entity(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const id = args.find((a) => !a.startsWith('-'));
  if (!id) {
    return { output: `${c.red}Error: entity ID required. Usage: crux query entity <id>${c.reset}`, exitCode: 1 };
  }

  const result = await getEntity(id);
  if (!result.ok) {
    if (result.error === 'bad_request') {
      return { output: `${c.yellow}Entity not found: ${id}${c.reset}`, exitCode: 1 };
    }
    return serverUnavailableError(log, result);
  }

  if (options.json || options.ci) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  const e = result.data;
  let output = `${c.bold}${c.blue}Entity: ${e.id}${c.reset}\n\n`;
  output += `  ${c.bold}Type:${c.reset}    ${e.entityType}\n`;
  output += `  ${c.bold}Title:${c.reset}   ${e.title}\n`;
  if (e.description) output += `  ${c.bold}Desc:${c.reset}    ${e.description.slice(0, 200)}${e.description.length > 200 ? '…' : ''}\n`;
  if (e.website) output += `  ${c.bold}Website:${c.reset} ${e.website}\n`;
  if (e.status) output += `  ${c.bold}Status:${c.reset}  ${e.status}\n`;
  if (e.tags?.length) output += `  ${c.bold}Tags:${c.reset}    ${e.tags.join(', ')}\n`;
  if (e.lastUpdated) output += `  ${c.bold}Updated:${c.reset} ${e.lastUpdated}\n`;

  if (e.customFields?.length) {
    output += `\n  ${c.bold}Custom Fields:${c.reset}\n`;
    for (const f of e.customFields) {
      output += `    ${f.label}: ${f.value}${f.link ? ` (${f.link})` : ''}\n`;
    }
  }

  if (e.relatedEntries?.length) {
    output += `\n  ${c.bold}Related Entities:${c.reset}\n`;
    for (const r of e.relatedEntries.slice(0, 10)) {
      output += `    ${c.dim}[${r.type}]${c.reset} ${r.id}${r.relationship ? ` — ${r.relationship}` : ''}\n`;
    }
    if (e.relatedEntries.length > 10) {
      output += `    ${c.dim}…and ${e.relatedEntries.length - 10} more${c.reset}\n`;
    }
  }

  if (e.sources?.length) {
    output += `\n  ${c.bold}Sources:${c.reset}\n`;
    for (const s of e.sources.slice(0, 5)) {
      output += `    ${s.title}`;
      if (s.author) output += ` (${s.author})`;
      if (s.date) output += ` — ${s.date}`;
      output += '\n';
    }
  }

  output += `\n  ${c.dim}Synced: ${e.syncedAt}${c.reset}`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// facts — numeric facts for an entity
// ---------------------------------------------------------------------------

export async function facts(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const entityId = args.find((a) => !a.startsWith('-'));
  if (!entityId) {
    return { output: `${c.red}Error: entity ID required. Usage: crux query facts <entity-id>${c.reset}`, exitCode: 1 };
  }

  const measure = options.measure as string | undefined;
  const limit = parseIntOpt(options.limit, 50);

  const result = await getFactsByEntity(entityId, limit, 0, measure);
  if (!result.ok) {
    if (result.error === 'bad_request') {
      return { output: `${c.yellow}No facts found for entity: ${entityId}${c.reset}`, exitCode: 0 };
    }
    return serverUnavailableError(log, result);
  }

  if (options.json || options.ci) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  const { facts: factList, total } = result.data;

  if (factList.length === 0) {
    return {
      output: `${c.dim}No facts found for "${entityId}"${measure ? ` (measure: ${measure})` : ''}${c.reset}`,
      exitCode: 0,
    };
  }

  let output = `${c.bold}${c.blue}Facts: ${entityId}${c.reset}`;
  if (measure) output += ` ${c.dim}(${measure})${c.reset}`;
  output += `\n${c.dim}${factList.length} of ${total} fact${total !== 1 ? 's' : ''}${c.reset}\n\n`;

  // Column widths
  const labelW = Math.min(30, Math.max(10, ...factList.map((f) => (f.label || f.measure || '').length)));
  output += `${c.bold}${'Label/Measure'.padEnd(labelW)}  ${'Value'.padEnd(20)}  Date${''.padEnd(6)}  Note${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(labelW + 40)}${c.reset}\n`;

  for (const f of factList) {
    const label = (f.label || f.measure || f.factId || '').slice(0, labelW).padEnd(labelW);
    let value = f.value || '';
    if (f.numeric !== null && f.numeric !== undefined) {
      value = String(f.numeric);
      if (f.low !== null && f.high !== null) value += ` [${f.low}–${f.high}]`;
      if (f.format) value += ` ${f.format}`;
    }
    const dateStr = f.asOf ? f.asOf.slice(0, 10) : '';
    const note = (f.note || '').slice(0, 40);
    const valueCell = value.length > 20 ? value.slice(0, 19) + '…' : value.padEnd(20);
    output += `${label}  ${valueCell}  ${dateStr.padEnd(10)}  ${note}\n`;
  }

  if (total > factList.length) {
    output += `\n${c.dim}Showing ${factList.length} of ${total}. Use --limit=N for more.${c.reset}`;
  }

  return { output: output.trimEnd(), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// related — related pages via graph query
// ---------------------------------------------------------------------------

export async function related(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const pageId = args.find((a) => !a.startsWith('-'));
  if (!pageId) {
    return { output: `${c.red}Error: page ID required. Usage: crux query related <page-id>${c.reset}`, exitCode: 1 };
  }

  const limit = parseIntOpt(options.limit, 15);
  const result = await getRelatedPages(pageId, limit);

  if (!result.ok) return serverUnavailableError(log, result);

  if (options.json || options.ci) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  const { related: items, total } = result.data;

  if (items.length === 0) {
    return { output: `${c.dim}No related pages found for "${pageId}"${c.reset}`, exitCode: 0 };
  }

  let output = `${c.bold}${c.blue}Related Pages: ${pageId}${c.reset}\n`;
  output += `${c.dim}${total} result${total !== 1 ? 's' : ''}${c.reset}\n\n`;

  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    const typeStr = ` ${c.dim}[${r.type}]${c.reset}`;
    const labelStr = r.label ? ` ${c.dim}— ${r.label}${c.reset}` : '';
    const scoreStr = ` ${c.dim}(${r.score.toFixed(1)})${c.reset}`;
    output += `${String(i + 1).padStart(2)}. ${c.cyan}${r.id}${c.reset}${typeStr}${labelStr}\n`;
    output += `    ${r.title}${scoreStr}\n`;
  }

  return { output: output.trimEnd(), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// backlinks — pages that link to this page
// ---------------------------------------------------------------------------

export async function backlinks(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const pageId = args.find((a) => !a.startsWith('-'));
  if (!pageId) {
    return { output: `${c.red}Error: page ID required. Usage: crux query backlinks <page-id>${c.reset}`, exitCode: 1 };
  }

  const limit = parseIntOpt(options.limit, 20);
  const result = await getBacklinks(pageId, limit);

  if (!result.ok) return serverUnavailableError(log, result);

  if (options.json || options.ci) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  const { backlinks: items, total } = result.data;

  if (items.length === 0) {
    return { output: `${c.dim}No backlinks found for "${pageId}"${c.reset}`, exitCode: 0 };
  }

  let output = `${c.bold}${c.blue}Backlinks: ${pageId}${c.reset}\n`;
  output += `${c.dim}${total} page${total !== 1 ? 's' : ''} link here${c.reset}\n\n`;

  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    const typeStr = ` ${c.dim}[${r.type}]${c.reset}`;
    const relStr = r.relationship ? ` ${c.dim}— ${r.relationship}${c.reset}` : '';
    output += `${String(i + 1).padStart(2)}. ${c.cyan}${r.id}${c.reset}${typeStr}${relStr}\n`;
    output += `    ${r.title} ${c.dim}(${r.linkType}, weight: ${r.weight})${c.reset}\n`;
  }

  return { output: output.trimEnd(), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// page — full page metadata
// ---------------------------------------------------------------------------

export async function page(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const pageId = args.find((a) => !a.startsWith('-'));
  if (!pageId) {
    return { output: `${c.red}Error: page ID required. Usage: crux query page <page-id>${c.reset}`, exitCode: 1 };
  }

  const result = await getPage(pageId);

  if (!result.ok) {
    if (result.error === 'bad_request') {
      return { output: `${c.yellow}Page not found: ${pageId}${c.reset}`, exitCode: 1 };
    }
    return serverUnavailableError(log, result);
  }

  if (options.json || options.ci) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  const p = result.data;
  const riskColor = p.hallucinationRiskLevel === 'high' ? c.red :
                    p.hallucinationRiskLevel === 'medium' ? c.yellow : c.green;

  let output = `${c.bold}${c.blue}Page: ${p.id}${c.reset}\n\n`;
  if (p.numericId) output += `  ${c.bold}Numeric ID:${c.reset}  ${p.numericId}\n`;
  output += `  ${c.bold}Title:${c.reset}       ${p.title}\n`;
  if (p.entityType) output += `  ${c.bold}Type:${c.reset}        ${p.entityType}\n`;
  if (p.category) output += `  ${c.bold}Category:${c.reset}    ${p.category}${p.subcategory ? ` / ${p.subcategory}` : ''}\n`;
  if (p.quality !== null) output += `  ${c.bold}Quality:${c.reset}     ${p.quality}/10\n`;
  if (p.readerImportance !== null) output += `  ${c.bold}Importance:${c.reset}  ${p.readerImportance}/100\n`;
  if (p.hallucinationRiskLevel) {
    output += `  ${c.bold}Risk:${c.reset}        ${riskColor}${p.hallucinationRiskLevel}${c.reset}`;
    if (p.hallucinationRiskScore !== null) output += ` (${p.hallucinationRiskScore.toFixed(2)})`;
    output += '\n';
  }
  if (p.wordCount) output += `  ${c.bold}Word count:${c.reset}  ${p.wordCount.toLocaleString()}\n`;
  if (p.lastUpdated) output += `  ${c.bold}Last updated:${c.reset} ${p.lastUpdated}\n`;
  if (p.tags) output += `  ${c.bold}Tags:${c.reset}        ${p.tags}\n`;
  if (p.description) {
    output += `\n  ${c.bold}Description:${c.reset}\n`;
    output += `  ${p.description.slice(0, 400)}${p.description.length > 400 ? '…' : ''}\n`;
  }
  if (p.llmSummary && options.summary) {
    output += `\n  ${c.bold}Summary:${c.reset}\n`;
    output += `  ${p.llmSummary.slice(0, 600)}${p.llmSummary.length > 600 ? '…' : ''}\n`;
  }

  output += `\n  ${c.dim}Synced: ${p.syncedAt}${c.reset}`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// recent-changes — recent session page changes
// ---------------------------------------------------------------------------

interface SessionEntry {
  id: number;
  date: string;
  branch: string | null;
  title: string;
  model: string | null;
  prUrl: string | null;
  pages: string[];
}

interface SessionPageChangesResult {
  sessions: SessionEntry[];
}

export async function recentChanges(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const days = parseIntOpt(options.days, 7);
  const limit = parseIntOpt(options.limit, 20);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  // Pass `since` to server so we get all sessions in the window, not just `limit` most recent
  const result = await apiRequest<SessionPageChangesResult>(
    'GET',
    `/api/sessions/page-changes?limit=${limit}&since=${cutoff}`,
  );

  if (!result.ok) return serverUnavailableError(log, result);

  const sessions = result.data.sessions;

  if (options.json || options.ci) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  if (sessions.length === 0) {
    return { output: `${c.dim}No page changes in the last ${days} day${days !== 1 ? 's' : ''}${c.reset}`, exitCode: 0 };
  }

  let output = `${c.bold}${c.blue}Recent Changes (last ${days} day${days !== 1 ? 's' : ''})${c.reset}\n`;
  output += `${c.dim}${sessions.length} session${sessions.length !== 1 ? 's' : ''}${c.reset}\n\n`;

  for (const s of sessions) {
    output += `${c.bold}${s.date}${c.reset} ${c.dim}[${s.id}]${c.reset} ${s.title.slice(0, 60)}\n`;
    if (s.branch) output += `  ${c.dim}branch: ${s.branch}${c.reset}\n`;
    if (s.prUrl) output += `  ${c.dim}PR: ${s.prUrl}${c.reset}\n`;
    if (s.pages.length > 0) {
      output += `  ${c.dim}pages (${s.pages.length}): ${s.pages.slice(0, 5).join(', ')}${s.pages.length > 5 ? ` +${s.pages.length - 5} more` : ''}${c.reset}\n`;
    }
    output += '\n';
  }

  return { output: output.trimEnd(), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// recent-edits — recent edit log entries
// ---------------------------------------------------------------------------

interface EditLogAllResult {
  entries: Array<{
    id: number;
    pageId: string;
    date: string;
    tool: string;
    agency: string;
    requestedBy: string | null;
    note: string | null;
  }>;
  total: number;
}

export async function recentEdits(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const days = parseIntOpt(options.days, 7);
  const limit = Math.min(parseIntOpt(options.limit, 30), 200);
  const cutoffDate = new Date();
  cutoffDate.setDate(cutoffDate.getDate() - days);
  const cutoff = cutoffDate.toISOString().slice(0, 10);

  const result = await apiRequest<EditLogAllResult>(
    'GET',
    `/api/edit-logs/all?limit=${limit}&offset=0&since=${cutoff}`,
  );

  if (!result.ok) return serverUnavailableError(log, result);

  const entries = result.data.entries;

  if (options.json || options.ci) {
    return { output: JSON.stringify({ entries, total: result.data.total }, null, 2), exitCode: 0 };
  }

  if (entries.length === 0) {
    return { output: `${c.dim}No edit log entries in the last ${days} day${days !== 1 ? 's' : ''}${c.reset}`, exitCode: 0 };
  }

  let output = `${c.bold}${c.blue}Recent Edits (last ${days} day${days !== 1 ? 's' : ''})${c.reset}\n`;
  output += `${c.dim}${entries.length} entries${c.reset}\n\n`;

  output += `${c.bold}${'Date'.padEnd(11)} ${'Agency'.padEnd(10)} ${'Tool'.padEnd(16)} Page${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(65)}${c.reset}\n`;

  for (const e of entries) {
    const agencyColor = e.agency === 'human' ? c.green : e.agency === 'ai-directed' ? c.cyan : c.dim;
    output += `${e.date}  ${agencyColor}${e.agency.padEnd(10)}${c.reset} ${e.tool.padEnd(16)} ${e.pageId}\n`;
    if (e.note) output += `  ${c.dim}${e.note}${c.reset}\n`;
  }

  return { output: output.trimEnd(), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// citations — citation health for a page
// ---------------------------------------------------------------------------

interface BrokenCitationsResult {
  broken: Array<{
    pageId: string;
    footnote: number;
    url: string | null;
    claimText: string;
    verificationScore: number | null;
    accuracyVerdict: string | null;
    accuracyScore: number | null;
    sourceTitle: string | null;
  }>;
  total: number;
}

export async function citations(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const isBroken = options.broken as boolean;
  const limit = parseIntOpt(options.limit, 20);

  // crux query citations --broken [--limit=N]
  if (isBroken) {
    const result = await apiRequest<BrokenCitationsResult>(
      'GET',
      `/api/citations/broken?limit=${limit}`,
    );
    if (!result.ok) return serverUnavailableError(log, result);

    if (options.json || options.ci) {
      return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
    }

    const { broken, total } = result.data;
    if (broken.length === 0) {
      return { output: `${c.green}No broken citations found.${c.reset}`, exitCode: 0 };
    }

    let output = `${c.bold}${c.red}Broken Citations${c.reset}\n`;
    output += `${c.dim}${total} broken citation${total !== 1 ? 's' : ''}${c.reset}\n\n`;

    for (const b of broken) {
      const scoreStr = b.verificationScore !== null ? ` (score: ${b.verificationScore.toFixed(2)})` : '';
      output += `${c.bold}${b.pageId}${c.reset} — footnote ${b.footnote}${scoreStr}\n`;
      if (b.sourceTitle) output += `  Source: ${b.sourceTitle}\n`;
      if (b.url) output += `  URL: ${c.dim}${b.url.slice(0, 80)}${b.url.length > 80 ? '…' : ''}${c.reset}\n`;
      output += `  ${c.dim}${b.claimText.slice(0, 100)}${b.claimText.length > 100 ? '…' : ''}${c.reset}\n\n`;
    }

    return { output: output.trimEnd(), exitCode: 0 };
  }

  // crux query citations <page-id>
  const pageId = args.find((a) => !a.startsWith('-'));
  if (!pageId) {
    return {
      output: `${c.red}Error: page ID required (or use --broken for wiki-wide broken citations).\n  Usage: crux query citations <page-id>${c.reset}`,
      exitCode: 1,
    };
  }

  const result = await getCitationQuotes(pageId, limit);

  if (!result.ok) return serverUnavailableError(log, result);

  if (options.json || options.ci) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  const { quotes, total } = result.data;

  if (quotes.length === 0) {
    return { output: `${c.dim}No citations found for "${pageId}"${c.reset}`, exitCode: 0 };
  }

  let output = `${c.bold}${c.blue}Citations: ${pageId}${c.reset}\n`;
  output += `${c.dim}${total} citation${total !== 1 ? 's' : ''}${c.reset}\n\n`;

  for (const q of quotes) {
    const verdictColor = q.accuracyVerdict === 'accurate' ? c.green :
                         q.accuracyVerdict === 'inaccurate' ? c.red :
                         q.accuracyVerdict === 'unsupported' ? c.red : c.yellow;
    const verifiedStr = q.quoteVerified ? `${c.green}✓${c.reset}` : `${c.dim}?${c.reset}`;
    const verdictStr = q.accuracyVerdict ? `${verdictColor}${q.accuracyVerdict}${c.reset}` : `${c.dim}unchecked${c.reset}`;

    output += `${c.bold}[${q.footnote}]${c.reset} ${verifiedStr} ${verdictStr}`;
    if (q.verificationScore !== null) output += ` ${c.dim}(${q.verificationScore.toFixed(2)})${c.reset}`;
    output += '\n';
    if (q.sourceTitle) output += `  ${c.dim}Source: ${q.sourceTitle}${c.reset}\n`;
    output += `  ${q.claimText.slice(0, 120)}${q.claimText.length > 120 ? '…' : ''}\n\n`;
  }

  if (total > quotes.length) {
    output += `${c.dim}Showing ${quotes.length} of ${total}. Use --limit=N for more.${c.reset}`;
  }

  return { output: output.trimEnd(), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// risk — hallucination risk scores
// ---------------------------------------------------------------------------

interface RiskLatestResult {
  pages: Array<{
    pageId: string;
    score: number;
    level: string;
    factors: unknown;
    computedAt: string;
  }>;
}

export async function risk(args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const level = options.level as string | undefined;
  const limit = parseIntOpt(options.limit, 20);
  const pageId = args.find((a) => !a.startsWith('-'));

  if (pageId) {
    if (level && !options.json && !options.ci) {
      // --level is only meaningful for wiki-wide listing, not per-page history
      process.stderr.write(`${c.dim}Note: --level is ignored when a page ID is given (shows history for that page instead).${c.reset}\n`);
    }
    // Single page risk history — use --limit for history depth
    const historyLimit = Math.min(limit, 50);
    const result = await apiRequest<{ pageId: string; snapshots: Array<{ score: number; level: string; factors: unknown; computedAt: string }> }>(
      'GET',
      `/api/hallucination-risk/history?page_id=${encodeURIComponent(pageId)}&limit=${historyLimit}`,
    );

    if (!result.ok) return serverUnavailableError(log, result);

    if (options.json || options.ci) {
      return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
    }

    const { snapshots } = result.data;
    if (snapshots.length === 0) {
      return { output: `${c.dim}No risk data found for "${pageId}"${c.reset}`, exitCode: 0 };
    }

    const latest = snapshots[0];
    const riskColor = latest.level === 'high' ? c.red : latest.level === 'medium' ? c.yellow : c.green;

    let output = `${c.bold}${c.blue}Risk: ${pageId}${c.reset}\n\n`;
    output += `  ${c.bold}Level:${c.reset} ${riskColor}${latest.level}${c.reset}\n`;
    output += `  ${c.bold}Score:${c.reset} ${latest.score.toFixed(3)}\n`;
    output += `  ${c.bold}As of:${c.reset} ${latest.computedAt}\n`;

    if (latest.factors && typeof latest.factors === 'object') {
      output += `\n  ${c.bold}Risk Factors:${c.reset}\n`;
      for (const [k, v] of Object.entries(latest.factors as Record<string, unknown>)) {
        output += `    ${k}: ${JSON.stringify(v)}\n`;
      }
    }

    if (snapshots.length > 1) {
      output += `\n  ${c.bold}History:${c.reset}\n`;
      for (const s of snapshots.slice(1)) {
        const sc = s.level === 'high' ? c.red : s.level === 'medium' ? c.yellow : c.green;
        output += `    ${s.computedAt.slice(0, 10)} ${sc}${s.level}${c.reset} ${s.score.toFixed(3)}\n`;
      }
    }

    return { output, exitCode: 0 };
  }

  // Wiki-wide risk listing
  let path = `/api/hallucination-risk/latest?limit=${limit}`;
  if (level) path += `&level=${encodeURIComponent(level)}`;

  const result = await apiRequest<RiskLatestResult>('GET', path);
  if (!result.ok) return serverUnavailableError(log, result);

  if (options.json || options.ci) {
    return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
  }

  const { pages } = result.data;

  if (pages.length === 0) {
    return { output: `${c.dim}No risk data found${level ? ` for level: ${level}` : ''}${c.reset}`, exitCode: 0 };
  }

  let output = `${c.bold}${c.blue}Hallucination Risk${level ? ` (${level})` : ''}${c.reset}\n`;
  output += `${c.dim}Top ${pages.length} pages${c.reset}\n\n`;

  output += `${c.bold}${'Score'.padStart(6)}  ${'Level'.padEnd(8)} Page${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(55)}${c.reset}\n`;

  for (const p of pages) {
    const riskColor = p.level === 'high' ? c.red : p.level === 'medium' ? c.yellow : c.green;
    output += `${p.score.toFixed(3).padStart(6)}  ${riskColor}${p.level.padEnd(8)}${c.reset} ${p.pageId}\n`;
  }

  return { output: output.trimEnd(), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// stats — wiki-wide statistics
// ---------------------------------------------------------------------------

interface HealthResult {
  status: string;
  database: string;
  totalIds: number;
  totalPages: number;
  totalEntities: number;
  totalFacts: number;
  nextId: number;
  uptime: number;
}

export async function stats(_args: string[], options: Record<string, unknown>): Promise<CommandResult> {
  const log = createLogger(options.ci as boolean);
  const c = log.colors;

  const healthResult = await apiRequest<HealthResult>('GET', '/health');
  if (!healthResult.ok) return serverUnavailableError(log, healthResult);

  if (options.json || options.ci) {
    return { output: JSON.stringify(healthResult.data, null, 2), exitCode: 0 };
  }

  const h = healthResult.data;
  const statusColor = h.status === 'healthy' ? c.green : c.red;
  const uptimeMin = Math.floor(h.uptime / 60);
  const uptimeStr = uptimeMin >= 60 ? `${Math.floor(uptimeMin / 60)}h ${uptimeMin % 60}m` : `${uptimeMin}m`;

  let output = `${c.bold}${c.blue}Wiki Server Stats${c.reset}\n\n`;
  output += `  ${c.bold}Status:${c.reset}    ${statusColor}${h.status}${c.reset}\n`;
  output += `  ${c.bold}Uptime:${c.reset}    ${uptimeStr}\n`;
  output += `  ${c.bold}Pages:${c.reset}     ${h.totalPages.toLocaleString()}\n`;
  output += `  ${c.bold}Entities:${c.reset}  ${h.totalEntities.toLocaleString()}\n`;
  output += `  ${c.bold}Facts:${c.reset}     ${h.totalFacts.toLocaleString()}\n`;
  output += `  ${c.bold}Total IDs:${c.reset} ${h.totalIds.toLocaleString()} (next: ${h.nextId})\n`;

  const serverUrl = getServerUrl();
  if (serverUrl) output += `\n  ${c.dim}Server: ${serverUrl}${c.reset}`;

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Command registry
// ---------------------------------------------------------------------------

export const commands: Record<string, (args: string[], options: Record<string, unknown>) => Promise<CommandResult>> = {
  search,
  entity,
  facts,
  related,
  backlinks,
  page,
  'recent-changes': recentChanges,
  'recent-edits': recentEdits,
  citations,
  risk,
  stats,
  default: stats,
};

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function getHelp(): string {
  return `
Query Domain - Query the wiki-server database

Uses the PostgreSQL database via wiki-server. Faster and more powerful
than grepping YAML files. Requires LONGTERMWIKI_SERVER_URL.

Commands:
  search <query>               Full-text search across all pages (ranked)
  entity <id>                  Structured entity data
  facts <entity-id>            Numeric facts for an entity
  related <page-id>            Related pages via graph query
  backlinks <page-id>          Pages that link here
  page <page-id>               Full page metadata
  recent-changes               Recent session page changes (default: last 7 days)
  recent-edits                 Recent edit log entries (default: last 7 days)
  citations <page-id>          Citation health for a page
  citations --broken           Wiki-wide broken citations
  risk [page-id]               Hallucination risk scores
  stats                        Wiki-wide statistics (default)

Options:
  --json                       Machine-readable JSON output
  --limit=N                    Number of results (default varies by command)
  --days=N                     Days to look back for recent-changes/recent-edits (default: 7)
  --measure=X                  Filter facts by measure name
  --level=high|medium|low      Filter risk by level
  --broken                     Show broken citations (for citations command)
  --summary                    Show LLM summary (for page command)

Examples:
  crux query search "compute governance"
  crux query search "MIRI funding" --limit=5
  crux query entity anthropic
  crux query entity anthropic --json
  crux query facts anthropic
  crux query facts openai --measure=employees
  crux query related scheming
  crux query backlinks rlhf
  crux query page scheming
  crux query recent-changes --days=7
  crux query recent-edits --days=3 --limit=50
  crux query citations scheming
  crux query citations --broken --limit=10
  crux query risk scheming
  crux query risk --level=high --limit=20
  crux query stats
`;
}
