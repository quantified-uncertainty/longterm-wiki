import { orgNameVariants } from './entity-mention.ts';
import { SEARCH_QUERY_MAX_LENGTH } from './config.ts';
import type { MissingSourceRecord } from './types.ts';

/**
 * Build the search-engine query for one record.
 *
 * Two prior failure modes drove this rewrite:
 *   1. The entity name appeared twice — once from `entity_name`, again
 *      embedded inside `description`. Search engines penalize duplicates.
 *   2. Parenthetical aliases (e.g. "QURI (Quantified Uncertainty Research
 *      Institute)") were passed verbatim, with parens, to the search engine,
 *      which fails to surface QURI's own pages.
 *
 * Per-table builders compose a clean focused query from the structured
 * fields the missing-sources endpoint already returns.
 */
export function buildSearchQuery(record: MissingSourceRecord): string {
  const builder = BUILDERS[record.record_table] ?? defaultBuilder;
  const raw = builder(record).filter(p => p.length > 0).join(' ').replace(/\s+/g, ' ').trim();
  return raw.slice(0, SEARCH_QUERY_MAX_LENGTH);
}

type Builder = (r: MissingSourceRecord) => string[];

const BUILDERS: Record<string, Builder> = {
  personnel: (r) => {
    const person = String(r.person_name ?? '').trim();
    const org = preferShortVariant(String(r.org_name ?? r.entity_name ?? '').trim());
    const role = String(r.role ?? '').trim();
    return [person, org, role];
  },
  investments: (r) => {
    const investor = preferShortVariant(String(r.investor_name ?? r.entity_name ?? '').trim());
    const company = preferShortVariant(String(r.company_name ?? '').trim());
    const round = String(r.round_name ?? '').trim();
    // No verb in the query — press uses "invested", "backed", "funded",
    // "portfolio" interchangeably, and AND-style search engines drop
    // pages that don't match the verb we picked. Sonnet's entailment
    // check confirms the relationship.
    return [investor, company, round];
  },
  equity_positions: (r) => {
    const holder = preferShortVariant(String(r.holder_name ?? '').trim());
    const company = preferShortVariant(String(r.company_name ?? r.entity_name ?? '').trim());
    return [holder, 'stake in', company];
  },
  policy_stakeholders: (r) => {
    const stakeholder = preferShortVariant(String(r.stakeholder_display_name ?? r.entity_name ?? '').trim());
    const policy = preferShortVariant(String(r.policy_name ?? '').trim());
    // No position word — press almost never says "X support Y", they
    // say "signed", "endorsed", "joined", etc. Pinning a verb in the
    // query causes AND-style search engines to drop matching pages.
    // Sonnet's entailment check confirms the actual position.
    return [stakeholder, policy];
  },
  facts: (r) => {
    const entity = preferShortVariant(String(r.entity_name ?? '').trim());
    const label = String(r.label ?? '').trim();
    const value = String(r.value ?? '').trim().slice(0, 80);
    return [entity, label, value];
  },
  page_citations: (r) => {
    // The "entity" of a page_citation is a wiki page label like "Page #201",
    // useless to a search engine. The description IS the claim.
    return [String(r.description ?? '').trim()];
  },
  divisions: (r) => {
    const parent = preferShortVariant(String(r.entity_name ?? '').trim());
    const name = String(r.name ?? r.description ?? '').trim();
    return [parent, name];
  },
  funding_rounds: (r) => {
    const company = preferShortVariant(String(r.company_name ?? r.entity_name ?? '').trim());
    const round = String(r.name ?? '').trim();
    return [company, round, 'funding round'];
  },
  funding_programs: (r) => {
    const org = preferShortVariant(String(r.entity_name ?? '').trim());
    const name = String(r.name ?? '').trim();
    return [org, name, 'funding program'];
  },
};

function defaultBuilder(r: MissingSourceRecord): string[] {
  const entity = preferShortVariant(String(r.entity_name ?? '').trim());
  const description = String(r.description ?? '').trim();
  // If description embeds the entity name, drop the duplicate copy.
  const cleanedDesc = entity && description.toLowerCase().includes(entity.toLowerCase())
    ? description
    : description;
  return [entity, dedupeEntityFromDescription(cleanedDesc, r.entity_name ?? '')];
}

/**
 * For an org name with a parenthetical alias (e.g. "QURI (Quantified
 * Uncertainty Research Institute)"), pick the shortest variant — usually
 * the alias — for the search query. Pages on the org's own domain typically
 * use the alias, not the registered long form.
 */
function preferShortVariant(name: string): string {
  if (!name) return '';
  const variants = orgNameVariants(name);
  if (variants.length <= 1) return name;
  return variants.reduce((best, v) => v.length < best.length ? v : best, variants[0]);
}

function dedupeEntityFromDescription(description: string, entityName: string): string {
  const e = entityName.trim();
  if (!e) return description;
  // Remove the literal entity-name string (and parenthesized form variants) once.
  const escaped = e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return description.replace(new RegExp(escaped, 'i'), '').replace(/\s+/g, ' ').trim();
}
