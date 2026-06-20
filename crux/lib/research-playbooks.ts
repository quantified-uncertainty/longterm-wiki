/**
 * Research Playbooks
 *
 * Per-type guidance for entity research. Each playbook (e.g.
 * `data/research-playbooks/organization.yaml`) codifies generic research
 * recipes — recommended sources, reliability ratings, common pitfalls,
 * standard data points — so agents don't rediscover the same knowledge
 * every session.
 *
 * Consumed by:
 *   - `crux context for-entity` (injects playbook into the context bundle)
 *   - `crux content improve` analyze phase (injects playbook into the LLM
 *     prompt so generated researchNeeded topics are playbook-aware)
 *
 * See QUA-33 and discussion in PR #2997.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import path from 'path';
import { z } from 'zod';
import { parse as parseYaml } from 'yaml';
import { PROJECT_ROOT } from './content-types.ts';
import { ENTITY_TYPE_ALIASES } from '../../apps/web/src/data/entity-type-names.ts';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const Reliability = z.enum(['very-high', 'high', 'medium', 'low']);
export type Reliability = z.infer<typeof Reliability>;

export const PlaybookSourceSchema = z.object({
  name: z.string().min(1),
  reliability: Reliability,
  covers: z.array(z.string().min(1)).min(1),
  url_pattern: z.string().optional(),
  applies_when: z.string().optional(),
  pitfalls: z.array(z.string().min(1)).optional(),
});
export type PlaybookSource = z.infer<typeof PlaybookSourceSchema>;

export const ResearchPlaybookSchema = z.object({
  entityType: z.string().min(1),
  description: z.string().min(1),
  sources: z.array(PlaybookSourceSchema).min(1),
  checklist: z.array(z.string().min(1)).min(1),
  common_pitfalls: z.array(z.string().min(1)).default([]),
  research_order: z.array(z.string().min(1)).default([]),
});
export type ResearchPlaybook = z.infer<typeof ResearchPlaybookSchema>;

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export const PLAYBOOKS_DIR = path.join(PROJECT_ROOT, 'data/research-playbooks');

// Path-safe entity type: lowercase alphanumerics + hyphens only. Used as a
// filesystem guard against path traversal via crafted entityType values.
const SAFE_ENTITY_TYPE_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Normalize an entity type string to its canonical form.
 * Handles aliases like "researcher" → "person", "lab-frontier" → "organization".
 * Returns null for empty input or any value that isn't path-safe (prevents
 * filename traversal in loadPlaybook).
 */
export function canonicalizeEntityType(entityType: string | null | undefined): string | null {
  if (!entityType) return null;
  const trimmed = entityType.trim();
  if (!trimmed) return null;
  const canonical = ENTITY_TYPE_ALIASES[trimmed] ?? trimmed;
  if (!SAFE_ENTITY_TYPE_RE.test(canonical)) return null;
  return canonical;
}

/**
 * Load the research playbook for the given entity type, canonicalizing aliases.
 * Returns null if no playbook exists or the file is malformed.
 *
 * Validation errors are logged to stderr but do not throw — a broken playbook
 * should not break the pipeline; it should just be ignored.
 */
export function loadPlaybook(
  entityType: string | null | undefined,
  opts: { dir?: string } = {},
): ResearchPlaybook | null {
  const canonical = canonicalizeEntityType(entityType);
  if (!canonical) return null;
  const dir = opts.dir ?? PLAYBOOKS_DIR;
  const filePath = path.join(dir, `${canonical}.yaml`);
  if (!existsSync(filePath)) return null;

  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[research-playbooks] Failed to read ${filePath}: ${msg}`);
    return null;
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[research-playbooks] Malformed YAML in ${filePath}: ${msg}`);
    return null;
  }

  const validated = ResearchPlaybookSchema.safeParse(parsed);
  if (!validated.success) {
    console.warn(
      `[research-playbooks] Schema validation failed for ${filePath}: ${validated.error.message}`,
    );
    return null;
  }

  if (validated.data.entityType !== canonical) {
    console.warn(
      `[research-playbooks] entityType mismatch in ${filePath}: ` +
        `file declares "${validated.data.entityType}" but resolves to "${canonical}"`,
    );
  }

  return validated.data;
}

/**
 * List all entity types that have a playbook (reading from disk).
 * Returns canonical entity type names.
 */
export function listPlaybookTypes(opts: { dir?: string } = {}): string[] {
  const dir = opts.dir ?? PLAYBOOKS_DIR;
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}

// ---------------------------------------------------------------------------
// Formatters
// ---------------------------------------------------------------------------

/**
 * Format a playbook as a markdown section for the context bundle
 * (`.claude/wip-context.md`). Designed to be scannable by a human agent.
 */
export function formatPlaybookMarkdown(playbook: ResearchPlaybook): string {
  let md = `## Research Playbook: ${playbook.entityType}\n\n`;
  md += `${playbook.description}\n\n`;

  md += `### Standard Checklist\n\n`;
  for (const item of playbook.checklist) md += `- ${item}\n`;
  md += '\n';

  md += `### Recommended Sources\n\n`;
  md += '| Source | Reliability | Covers | Notes |\n';
  md += '|--------|-------------|--------|-------|\n';
  for (const s of playbook.sources) {
    const covers = s.covers.join(', ');
    const notes: string[] = [];
    if (s.applies_when) notes.push(`_when_: ${s.applies_when}`);
    if (s.pitfalls && s.pitfalls.length > 0) notes.push(`⚠ ${s.pitfalls[0]}`);
    md += `| ${escapeCell(s.name)} | ${s.reliability} | ${escapeCell(covers)} | ${escapeCell(notes.join('; '))} |\n`;
  }
  md += '\n';

  if (playbook.research_order.length > 0) {
    md += `### Recommended Research Order\n\n`;
    playbook.research_order.forEach((step, i) => {
      md += `${i + 1}. ${step}\n`;
    });
    md += '\n';
  }

  if (playbook.common_pitfalls.length > 0) {
    md += `### Common Pitfalls\n\n`;
    for (const p of playbook.common_pitfalls) md += `- ${p}\n`;
    md += '\n';
  }

  return md;
}

/**
 * Format a playbook as a compact prompt section for LLM consumption.
 * Intentionally more terse than the markdown variant to conserve tokens.
 */
export function formatPlaybookForPrompt(playbook: ResearchPlaybook): string {
  const lines: string[] = [];
  lines.push(`# Research Playbook: ${playbook.entityType}`);
  lines.push('');
  lines.push(playbook.description);
  lines.push('');

  lines.push('## Standard data points to gather');
  for (const item of playbook.checklist) lines.push(`- ${item}`);
  lines.push('');

  lines.push('## Recommended sources (in priority order)');
  for (const s of playbook.sources) {
    const coversStr = s.covers.join(', ');
    const when = s.applies_when ? ` [${s.applies_when}]` : '';
    lines.push(`- **${s.name}** (${s.reliability}) — covers: ${coversStr}${when}`);
    for (const p of s.pitfalls ?? []) lines.push(`  - pitfall: ${p}`);
  }
  lines.push('');

  if (playbook.research_order.length > 0) {
    lines.push('## Recommended research order');
    playbook.research_order.forEach((step, i) => lines.push(`${i + 1}. ${step}`));
    lines.push('');
  }

  if (playbook.common_pitfalls.length > 0) {
    lines.push('## Common pitfalls to avoid');
    for (const p of playbook.common_pitfalls) lines.push(`- ${p}`);
    lines.push('');
  }

  return lines.join('\n');
}

function escapeCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ');
}
