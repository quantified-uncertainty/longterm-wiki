import type { MissingSourceRecord } from './types.ts';

/**
 * Render the record's claim as a natural-language sentence the LLM can verify.
 *
 * The raw `description` field uses cryptic shapes like "Y Combinator -> Ello"
 * which Sonnet can't reliably interpret as "YC invested in Ello". Per-table
 * rendering removes that ambiguity. Falls back to `description` when a
 * required field is missing (or has been stripped as a machine-id leak).
 */
export function humanizeClaim(record: MissingSourceRecord): string {
  return CLAIM_RENDERERS[record.record_table]?.(record) ?? field(record, 'description');
}

/**
 * Read a string field, trimming and dropping `sid_*` machine-id leaks.
 * Humanised claims with `sid_Playground` in them confuse the LLM, so we
 * treat such values as missing.
 */
function field(r: MissingSourceRecord, key: string): string {
  const v = String(r[key] ?? '').trim();
  return v.startsWith('sid_') ? '' : v;
}

type Renderer = (r: MissingSourceRecord) => string | null;

const CLAIM_RENDERERS: Record<string, Renderer> = {
  facts: r => {
    const entity = field(r, 'entity_name');
    const fieldName = field(r, 'field_name');
    if (!entity || !fieldName) return null;
    const value = field(r, 'value');
    return value
      ? `${entity}'s ${fieldName} is ${value}`
      : `${entity}'s ${fieldName}`;
  },

  page_citations: r => {
    // The "entity" of a page_citation is the wiki page itself ("Page #201"),
    // not a real-world entity. The claim text IS the citation content.
    return field(r, 'description') || null;
  },

  investments: r => {
    const investor = field(r, 'investor_name');
    const company = field(r, 'company_name');
    if (!investor || !company) return null;
    const round = field(r, 'round_name');
    return round
      ? `${investor} invested in ${company} (round: ${round})`
      : `${investor} invested in ${company}`;
  },

  equity_positions: r => {
    const holder = field(r, 'holder_name');
    const company = field(r, 'company_name');
    return holder && company ? `${holder} holds equity in ${company}` : null;
  },

  personnel: r => {
    const person = field(r, 'person_name');
    const org = field(r, 'org_name');
    if (!person || !org) return null;
    const role = field(r, 'role');
    return role
      ? `${person} works at ${org} as ${role}`
      : `${person} works at ${org}`;
  },

  divisions: r => {
    const parent = field(r, 'entity_name');
    const name = field(r, 'name');
    return parent && name ? `${parent} has a division called "${name}"` : null;
  },

  policy_stakeholders: r => {
    const stake = field(r, 'stakeholder_display_name') || field(r, 'entity_name');
    const position = field(r, 'position');
    if (!stake || !position) return null;
    const policy = field(r, 'policy_name');
    return policy
      ? `${stake} takes the "${position}" position on the policy "${policy}"`
      : `${stake} takes the "${position}" position on a policy`;
  },

  funding_rounds: r => {
    const company = field(r, 'company_name');
    const name = field(r, 'name');
    return company && name ? `${company} raised the "${name}" funding round` : null;
  },

  funding_programs: r => {
    const org = field(r, 'entity_name');
    const name = field(r, 'name');
    return org && name ? `${org} runs the "${name}" funding program` : null;
  },
};
