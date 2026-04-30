// Canonical-name resolution for stakeholders.
//
// The closed-loop entity improver (apply-verdicts.ts) needs to dedupe array
// entries when the LLM extractor proposes multiple targetField slugs that
// map to the same real-world entity:
//
//   - "fbi" + "federal-bureau-of-investigation" → both → "federal-bureau-of-investigation"
//   - "doj" + "u.s. department of justice" + "department of justice" → all three → "department-of-justice"
//
// The strategy:
//   1. Generate slug candidates from the input (full slug, parenthetical
//      splits like "FBI (Federal Bureau of Investigation)" → "fbi" + "federal-bureau-of-investigation",
//      and prefix-stripped variants like "U.S. Department of Justice" → "department-of-justice").
//   2. Look each candidate up in STAKEHOLDER_ALIASES (via a reverse-index Map
//      built once at module load — O(1) lookups).
//   3. Return the canonical slug if any candidate matches; else the first candidate.
//
// The dictionary is a hand-curated allowlist scoped to **U.S. federal**
// agencies, civil-liberties orgs, and major intelligence/justice bodies that
// recur in U.S. policy stakeholder lists. Extend it over time as new aliases
// are observed in pipeline runs. Bare aliases like "senate", "treasury",
// "congress" mean the U.S. ones — non-US institutions should not use this
// module without scoping (see comment on STAKEHOLDER_ALIASES below).

// Slug helper, intentionally separate from apply-verdicts.ts::slugify which
// truncates at 60 chars. Truncation can silently break alias lookups when
// long compound names are run through this module, so we use the full slug.
function fullSlug(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Map of canonical slug → list of accepted aliases (already in slug form).
 * The canonical slug should match the wiki entity slug when one exists,
 * so we can also use this dictionary for cross-base entityId linking.
 *
 * Always include the canonical slug itself in its own alias list for
 * symmetry — we look up via the reverse index built below, which seeds
 * itself from each (canonical, alias) pair.
 *
 * **Scope: U.S. federal institutions only.** Bare aliases like "senate",
 * "congress", "treasury" are interpreted as the U.S. ones. Do not extend
 * this dictionary with non-U.S. institutions sharing those names without
 * also re-scoping the existing entries (e.g. rename "senate" → "us-senate").
 */
export const STAKEHOLDER_ALIASES: Record<string, string[]> = {
  // ── Intelligence community ────────────────────────────────────────────────
  "national-security-agency": ["nsa", "national-security-agency"],
  "central-intelligence-agency": ["cia", "central-intelligence-agency"],
  "federal-bureau-of-investigation": [
    "fbi",
    "federal-bureau-of-investigation",
    "fbi-federal-bureau-of-investigation",
    "federal-bureau-of-investigation-fbi",
  ],
  "office-of-the-director-of-national-intelligence": [
    "odni",
    "dni",
    "office-of-the-director-of-national-intelligence",
    "director-of-national-intelligence",
  ],
  "defense-intelligence-agency": ["dia", "defense-intelligence-agency"],
  "national-geospatial-intelligence-agency": ["nga", "national-geospatial-intelligence-agency"],
  "national-reconnaissance-office": ["nro", "national-reconnaissance-office"],

  // ── Justice / law enforcement ─────────────────────────────────────────────
  "department-of-justice": [
    "doj",
    "department-of-justice",
    "us-department-of-justice",
    "u-s-department-of-justice",
    "united-states-department-of-justice",
  ],
  "department-of-homeland-security": [
    "dhs",
    "department-of-homeland-security",
    "us-department-of-homeland-security",
  ],
  "drug-enforcement-administration": ["dea", "drug-enforcement-administration"],

  // ── Surveillance courts / oversight ───────────────────────────────────────
  "foreign-intelligence-surveillance-court": [
    "fisc",
    "fisa-court",
    "foreign-intelligence-surveillance-court",
    "fisa-c",
  ],
  "privacy-and-civil-liberties-oversight-board": [
    "pclob",
    "privacy-and-civil-liberties-oversight-board",
  ],

  // ── Civil-liberties organizations ─────────────────────────────────────────
  "american-civil-liberties-union": [
    "aclu",
    "american-civil-liberties-union",
    "aclu-american-civil-liberties-union",
  ],
  "electronic-frontier-foundation": [
    "eff",
    "electronic-frontier-foundation",
    "eff-electronic-frontier-foundation",
  ],
  "center-for-democracy-and-technology": [
    "cdt",
    "center-for-democracy-and-technology",
  ],
  "electronic-privacy-information-center": [
    "epic",
    "electronic-privacy-information-center",
  ],

  // ── Executive / state / regulatory ────────────────────────────────────────
  "department-of-state": ["dos", "department-of-state", "us-department-of-state", "state-department"],
  "department-of-defense": [
    "dod",
    "department-of-defense",
    "us-department-of-defense",
    "u-s-department-of-defense",
  ],
  "department-of-the-treasury": [
    "treasury",
    "department-of-the-treasury",
    "us-department-of-the-treasury",
    "u-s-department-of-the-treasury",
    "treasury-department",
  ],
  "federal-trade-commission": ["ftc", "federal-trade-commission"],
  "federal-communications-commission": ["fcc", "federal-communications-commission"],
  "securities-and-exchange-commission": ["sec", "securities-and-exchange-commission"],

  // ── Legislative ───────────────────────────────────────────────────────────
  "house-of-representatives": [
    "house-of-representatives",
    "us-house-of-representatives",
    "u-s-house-of-representatives",
  ],
  "senate": ["senate", "us-senate", "u-s-senate", "united-states-senate"],
  "congress": ["congress", "us-congress", "u-s-congress", "united-states-congress"],
};

/**
 * Reverse index: alias slug → canonical slug. Built once at module load,
 * so canonicalSlug() does an O(1) Map lookup instead of an O(N×M) scan.
 *
 * Throws on duplicate alias (two canonicals claiming the same alias) — the
 * dictionary integrity test enforces this, but the runtime check provides
 * a second line of defense.
 */
const ALIAS_INDEX: Map<string, string> = (() => {
  const index = new Map<string, string>();
  for (const [canonical, aliases] of Object.entries(STAKEHOLDER_ALIASES)) {
    for (const alias of aliases) {
      const prev = index.get(alias);
      if (prev !== undefined && prev !== canonical) {
        throw new Error(
          `STAKEHOLDER_ALIASES: alias "${alias}" claimed by both "${prev}" and "${canonical}"`,
        );
      }
      index.set(alias, canonical);
    }
    // Also ensure canonical maps to itself.
    if (!index.has(canonical)) index.set(canonical, canonical);
  }
  return index;
})();

/**
 * Generate slug candidates from a name. Tries:
 *  - The full slug.
 *  - Parenthetical split: "FBI (Federal Bureau of Investigation)" yields "fbi" and "federal-bureau-of-investigation".
 *  - Prefix-stripped variants: "U.S. Department of Justice" yields "department-of-justice".
 *
 * Used by canonicalSlug() to widen the alias-lookup search. Uses fullSlug
 * (no truncation) so long compound names match correctly.
 */
export function generateSlugCandidates(input: string): string[] {
  if (!input) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string | undefined | null) => {
    if (!s) return;
    const slug = fullSlug(s);
    if (slug && !seen.has(slug)) {
      seen.add(slug);
      out.push(slug);
    }
  };
  add(input);
  // Parenthetical: "FBI (Federal Bureau)" -> "FBI" and "Federal Bureau".
  const parenMatch = input.match(/^(.+?)\s*\(([^)]+)\)\s*$/);
  if (parenMatch) {
    add(parenMatch[1]);
    add(parenMatch[2]);
  }
  // Strip leading "U.S." / "United States" / "U.S.A." qualifiers.
  const stripped = input.replace(
    /^(U\.S\.A?\.?|U\s*\.\s*S\.?|United\s+States(?:\s+of\s+America)?)\s+/i,
    "",
  );
  if (stripped !== input) add(stripped);
  return out;
}

/**
 * Resolve a name (display string or slug) to a canonical slug. Returns the
 * canonical slug if any candidate (full slug, parenthetical split, prefix-
 * stripped variant) matches an alias in STAKEHOLDER_ALIASES; otherwise
 * returns the first candidate slug, or the full slug as a last resort.
 *
 * Returns "" only when the input is empty/whitespace-only.
 */
export function canonicalSlug(input: string): string {
  if (!input) return "";
  const candidates = generateSlugCandidates(input);
  for (const candidate of candidates) {
    const canonical = ALIAS_INDEX.get(candidate);
    if (canonical) return canonical;
  }
  return candidates[0] ?? fullSlug(input);
}
