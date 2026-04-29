import type { MissingSourceRecord } from './types.ts';

/**
 * Lowercase search terms that should appear in a plausible source page.
 * These feed the search-query side of the pipeline; the LLM verification
 * downstream judges actual claim support, so this just needs decent recall.
 *
 * Returns an empty array for records that don't have anything to match on
 * (e.g. a fact with no value/label) — callers treat that as a skip.
 */
export function extractMatchTerms(record: MissingSourceRecord): string[] {
  const extractor = MATCH_TERM_EXTRACTORS[record.record_table];
  return extractor ? extractor(record) : [];
}

type Extractor = (r: MissingSourceRecord) => string[];

const MATCH_TERM_EXTRACTORS: Record<string, Extractor> = {
  facts: factsTerms,
  personnel: r => oneTerm(r.person_name),
  investments: r => oneTerm(r.company_name),
  equity_positions: r => oneTerm(r.holder_name, { hyphenToSpace: true }),
  policy_stakeholders: r => oneTerm(r.stakeholder_display_name),
  divisions: r => oneTerm(r.name),
  funding_programs: r => oneTerm(r.name),
  funding_rounds: r => oneTerm(r.name),
  publications: r => oneTerm(r.title, { minLength: 4 }),
  page_citations: r => {
    const note = String(r.note ?? '').trim();
    const title = String(r.cit_title ?? '').trim();
    return oneTerm(note || title, { minLength: 11, maxLength: 80 });
  },
};

/** Extract a single lowercased term from a string field, or [] if too short. */
function oneTerm(
  raw: unknown,
  opts: { minLength?: number; maxLength?: number; hyphenToSpace?: boolean } = {},
): string[] {
  const minLength = opts.minLength ?? 2;
  const trimmed = String(raw ?? '').trim();
  if (trimmed.length < minLength) return [];
  let term = trimmed.toLowerCase();
  if (opts.hyphenToSpace) term = term.replace(/-/g, ' ');
  if (opts.maxLength) term = term.slice(0, opts.maxLength);
  return [term];
}

/**
 * Facts return BOTH value-derived and label terms — the search query needs
 * recall, so an OR over (value, label) widens the gate so the LLM
 * verification can do the real filtering downstream.
 */
function factsTerms(r: MissingSourceRecord): string[] {
  const terms: string[] = [];
  const value = String(r.value ?? '').trim();
  if (value.length > 0 && value.length <= 40) {
    terms.push(value.toLowerCase());
  } else if (value.length > 40) {
    const firstPhrase = value.split(/[,;.]/)[0].trim();
    const seed = firstPhrase.length >= 10 ? firstPhrase : value;
    terms.push(seed.slice(0, 80).toLowerCase());
  }
  const label = String(r.label ?? '').trim();
  if (label.length > 3) terms.push(label.toLowerCase());
  return terms;
}
