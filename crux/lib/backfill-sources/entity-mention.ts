import { SELF_DOMAINS } from './config.ts';
import type { MissingSourceRecord } from './types.ts';

// ---------------------------------------------------------------------------
// Self-domain detection
// ---------------------------------------------------------------------------

/**
 * True if `url` lives on a longtermwiki domain (or a subdomain). Self-sourcing
 * a longtermwiki fact against longtermwiki content is circular, so callers
 * skip these. Returns false for unparseable URLs.
 */
export function isSelfDomain(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\./, '');
    return SELF_DOMAINS.some(d => host === d || host.endsWith('.' + d));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cheap pre-LLM mention check
// ---------------------------------------------------------------------------

/**
 * Cheap pre-LLM filter: `content` (or `url`) must mention `entityName`.
 * Skips any LLM call when the article isn't even about the entity.
 *
 * Accepts a match when ANY of these are present:
 *   - The literal entity name in the content (case-insensitive).
 *   - A slug-to-words variant ("center-for-ai-safety" → "center for ai safety").
 *   - An accent-stripped variant in either direction.
 *   - The entity name (alphanumeric) inside the URL host or path — a page
 *     on the org's own domain is obviously about the org even when the body
 *     uses "we" / "our program".
 *
 * Defers to the LLM (returns true) when the name is shorter than 3 chars.
 */
export function contentMentionsEntity(content: string, entityName: string, url?: string): boolean {
  const entity = (entityName ?? '').trim();
  if (entity.length < 3) return true;

  const lowerContent = content.toLowerCase();
  const lowerEntity = entity.toLowerCase();

  if (lowerContent.includes(lowerEntity)) return true;

  const slugWords = lowerEntity.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (slugWords !== lowerEntity && lowerContent.includes(slugWords)) return true;

  const entityNoAccents = stripAccents(lowerEntity);
  const contentNoAccents = stripAccents(lowerContent);
  if (entityNoAccents !== lowerEntity && contentNoAccents.includes(entityNoAccents)) return true;
  if (contentNoAccents.includes(lowerEntity)) return true;

  if (url && entityInUrl(entityNoAccents, url)) return true;

  return false;
}

function stripAccents(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '');
}

function entityInUrl(entityNoAccents: string, url: string): boolean {
  try {
    const u = new URL(url);
    const urlNorm = `${u.hostname}${u.pathname}`.toLowerCase().replace(/[^a-z0-9]/g, '');
    const entityNorm = entityNoAccents.replace(/[^a-z0-9]/g, '');
    return entityNorm.length >= 5 && urlNorm.includes(entityNorm);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Name-variant generation (used to widen the mention check)
// ---------------------------------------------------------------------------

/**
 * For a personal name like "Natalia Perez-Campanero Antolin", produce a
 * short list of progressively-relaxed variants (full, first+last, surname).
 * Many profile pages use a shortened form rather than the full name.
 *
 * Surname-only is risky for short/common names — only emitted when the
 * surname is at least 5 chars long.
 */
export function personNameVariants(fullName: string): string[] {
  const trimmed = fullName.trim();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed]);
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);
  if (words.length >= 3) {
    variants.add(`${words[0]} ${words[words.length - 1]}`);
  }
  if (words.length >= 2) {
    const last = words[words.length - 1];
    if (last.length >= 5) variants.add(last);
  }
  return [...variants];
}

/**
 * For an org name like "Andreessen Horowitz (a16z)", split out the
 * parenthetical alias as its own variant. Pages on a16z.com don't usually
 * write the full registered name, so the alias survives as a separate option.
 */
export function orgNameVariants(fullName: string): string[] {
  const trimmed = fullName.trim();
  if (!trimmed) return [];
  const variants = new Set<string>([trimmed]);
  const m = trimmed.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (m) {
    variants.add(m[1].trim());
    variants.add(m[2].trim());
  }
  return [...variants].filter(s => s.length >= 2);
}

// ---------------------------------------------------------------------------
// Required-mention slot computation per record table
// ---------------------------------------------------------------------------

/**
 * Pick the names that MUST all appear in an article for it to be a plausible
 * source. Each slot is a list of OR'd variants; ALL slots must match.
 *
 * For personnel, both the person AND the org must appear (an article about
 * someone's PhD work alone shouldn't pass as evidence of an unrelated role).
 * For everything else, the entity alone is enough. page_citations don't have
 * a real-world entity (the entity_name is a wiki page id), so the check is
 * skipped and Haiku/Sonnet judge claim support directly.
 */
export function entitiesToMention(record: MissingSourceRecord): string[][] {
  if (record.record_table === 'page_citations') return [];

  if (record.record_table === 'personnel') {
    const person = stripMachineId(String(record.person_name ?? '').trim());
    const org = stripMachineId(String(record.org_name ?? record.entity_name ?? '').trim());
    const slots: string[][] = [];
    if (person) slots.push(personNameVariants(person));
    if (org) slots.push(orgNameVariants(org));
    return slots;
  }

  const entity = stripMachineId((record.entity_name ?? '').trim());
  return entity ? [orgNameVariants(entity)] : [];
}

/**
 * Drop name strings that are obviously machine IDs leaking through from
 * unjoined entity references (e.g. `sid_Playground` in the company column).
 * Returns null so callers treat the slot as missing rather than chasing a
 * meaningless string.
 */
function stripMachineId(name: string): string | null {
  if (!name) return null;
  if (name.startsWith('sid_')) return null;
  return name;
}
