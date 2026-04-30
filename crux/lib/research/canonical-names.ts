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
//   2. Look each candidate up in STAKEHOLDER_ALIASES.
//   3. Return the canonical slug if any candidate matches; else the first candidate.
//
// The dictionary is a hand-curated allowlist, seeded from common federal
// agencies, civil-liberties orgs, and major intelligence/justice bodies that
// recur in policy stakeholder lists. Extend it over time as new aliases are
// observed in pipeline runs.

import { slugify } from "./apply-verdicts.ts";

/**
 * Map of canonical slug → list of accepted aliases (already in slug form).
 * The canonical slug should match the wiki entity slug when one exists,
 * so we can also use this dictionary for cross-base entityId linking.
 *
 * Always include the canonical slug itself in its own alias list for
 * symmetry — we look up by `aliases.includes(candidate)`.
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
  senate: ["senate", "us-senate", "u-s-senate", "united-states-senate"],
  congress: ["congress", "us-congress", "u-s-congress", "united-states-congress"],
};

/**
 * Generate slug candidates from a name. Tries:
 *  - The full slug.
 *  - Parenthetical split: "FBI (Federal Bureau of Investigation)" yields "fbi" and "federal-bureau-of-investigation".
 *  - Prefix-stripped variants: "U.S. Department of Justice" yields "department-of-justice".
 *
 * Used by canonicalSlug() to widen the alias-lookup search.
 */
export function generateSlugCandidates(input: string): string[] {
  if (!input) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (s: string | undefined | null) => {
    if (!s) return;
    const slug = slugify(s);
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
 * returns the first candidate slug, or the slugified input as a last resort.
 */
export function canonicalSlug(input: string): string {
  if (!input) return "";
  const candidates = generateSlugCandidates(input);
  for (const candidate of candidates) {
    for (const [canonical, aliases] of Object.entries(STAKEHOLDER_ALIASES)) {
      if (canonical === candidate || aliases.includes(candidate)) {
        return canonical;
      }
    }
  }
  return candidates[0] ?? slugify(input);
}
