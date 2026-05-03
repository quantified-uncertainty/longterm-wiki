/**
 * Pages Command Handlers
 *
 * Page-level analysis and prioritization tools.
 *
 * Usage:
 *   crux w pages next-action [--type=<entityType>] [--limit=20] [--all] [--ci]
 */

import type { CommandOptions as BaseOptions, CommandResult } from '../lib/command-types.ts';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';
import { computeNBABatch, type PageInput } from '../lib/next-best-action.ts';
import { truncate } from '../lib/text-utils.ts';

interface CommandOptions extends BaseOptions {
  type?: string;
  limit?: string;
  all?: boolean;
  ci?: boolean;
}

function loadPages(): PageInput[] {
  const dbPath = join(PROJECT_ROOT, 'apps/web/src/data/database.json');
  const db = JSON.parse(readFileSync(dbPath, 'utf-8'));
  const idRegistry = db.idRegistry ?? { bySlug: {} };
  return (db.pages || []).map((p: Record<string, unknown>) => ({
    id: p.id as string,
    wikiId: (idRegistry.bySlug[p.id as string] as string) || (p.id as string),
    title: p.title as string,
    entityType: (p.entityType as string) ?? null,
    quality: (p.quality as number) ?? null,
    readerImportance: (p.readerImportance as number) ?? null,
    researchImportance: (p.researchImportance as number) ?? null,
    lastUpdated: (p.lastUpdated as string) ?? null,
    hallucinationRisk: (p.hallucinationRisk as PageInput['hallucinationRisk']) ?? null,
    wordCount: (p.wordCount as number) ?? 0,
    contentFormat: (p.contentFormat as string) ?? 'article',
    subcategory: (p.subcategory as string) ?? null,
  }));
}

async function nextActionCommand(_args: string[], options: CommandOptions): Promise<CommandResult> {
  const pages = loadPages();
  const limit = options.limit ? parseInt(options.limit as string, 10) : 20;
  const includeNoImportance = !!options.all;
  const entityType = options.type as string | undefined;

  const scored = computeNBABatch(pages, { includeNoImportance, entityType });
  const limited = scored.slice(0, limit);

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(limited, null, 2) };
  }

  if (limited.length === 0) {
    return { exitCode: 0, output: 'No pages found matching criteria.' };
  }

  const lines: string[] = [
    `\x1b[1mNext Best Action: Top ${limited.length} pages needing attention\x1b[0m`,
    `\x1b[2m${scored.length} eligible pages scored\x1b[0m`,
    '',
    `${'Rank'.padStart(4)}  ${'Score'.padStart(6)}  ${'Page'.padEnd(40)}  ${'Reason'}`,
    `${'----'.padStart(4)}  ${'------'.padStart(6)}  ${'----'.padEnd(40)}  ${'------'}`,
  ];

  for (let i = 0; i < limited.length; i++) {
    const s = limited[i];
    const nid = s.wikiId !== s.id ? ` (${s.wikiId})` : '';
    const label = `${s.title}${nid}`;
    const truncLabel = truncate(label, 39, { ellipsis: '...' });
    const scoreStr = s.priority.toFixed(2);
    const color = s.priority >= 0.8 ? '\x1b[31m' : s.priority >= 0.4 ? '\x1b[33m' : '\x1b[32m';
    const reason = s.reasons.length > 0 ? s.reasons.join(', ') : 'marginal deficit';

    lines.push(
      `${String(i + 1).padStart(4)}  ${color}${scoreStr.padStart(6)}\x1b[0m  ${truncLabel.padEnd(40)}  ${reason}`
    );
  }

  lines.push('');
  lines.push(`\x1b[2mFormula: importance * qualityDeficit * stalenessFactor * riskFactor\x1b[0m`);
  lines.push(`\x1b[2mOptions: --type=<entityType> --limit=N --all (include 0-importance) --ci (JSON)\x1b[0m`);

  return { exitCode: 0, output: lines.join('\n') };
}

export const commands = {
  'next-action': nextActionCommand,
  default: nextActionCommand,
};

export function getHelp(): string {
  return `
Pages Domain — Page-level analysis and prioritization

Commands:
  next-action   Show pages ranked by "Next Best Action" priority score (default)

The NBA score combines:
  - importance = max(readerImportance, researchImportance) / 100
  - qualityDeficit = 1 - quality/100
  - stalenessFactor = 1 + min(daysSinceUpdate/365, 1.0)
  - hallucinationRiskFactor = 1 + (high: 0.5, medium: 0.25, low: 0)

  priority = importance * qualityDeficit * stalenessFactor * hallucinationRiskFactor

Options:
  --type=<entityType>   Filter to specific entity type (e.g. person, organization)
  --limit=N             Number of results (default: 20)
  --all                 Include pages with 0 importance scores
  --ci                  JSON output

Examples:
  crux w pages                                  # Top 20 pages needing attention
  crux w pages next-action --type=person        # Top person pages
  crux w pages next-action --limit=50           # Top 50
  crux w pages next-action --ci                 # JSON output
`;
}
