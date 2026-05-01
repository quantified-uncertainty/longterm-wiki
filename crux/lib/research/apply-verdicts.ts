// Apply verified claims back into an entity's YAML record.
// Pure functions: take an entity + verdicts and return an updated entity plus
// a writeback summary. The caller serializes back to YAML.
//
// Supported types:
//   - PolicyEntity  → applyVerdictsToPolicy
//     scalar.<field>, provision.<slug>, stakeholder.<slug>, tag.<value>, relatedEntry.<id>
//   - OrganizationEntity → applyVerdictsToOrganization
//     scalar.<field>, product.<slug>, keyPerson.<slug>, keyDate.<slug>, tag.<value>, relatedEntry.<id>
//
// factbase.* targetFields are surfaced by the gap analyzer for cross-base
// routing (separate ticket); the org applier records them as skipped
// rather than writing them into local YAML.

import type { OrganizationEntity, OrganizationKeyPerson, PolicyEntity } from "./gap-analyzer.ts";
import { canonicalSlug } from "./canonical-names.ts";

export type StakeholderPosition = "support" | "oppose" | "reform" | "neutral";

export interface VerifiedVerdict {
  /** The seed key — encodes target type + identifier. */
  targetField: string;
  /** Claim text (used as fallback when proposedValue is empty). */
  claimText: string;
  /** The value extracted by the verifier (ideal source for the field). */
  extractedValue: string | null;
  /** What the agent proposed before verification. */
  proposedValue?: string | null;
  /** The source URL the claim was verified against. */
  sourceUrl: string;
  /** The verdict (verified, partial). Only verified+partial are applied. */
  status: string;
  /** Optional: human display name of the stakeholder/provision (for new items). */
  displayHint?: string;
  /** For stakeholder claims: the position classified by the extractor. The
   *  apply step is the single source of truth for what lands in YAML — the
   *  hardcoded "reform" default is gone (QUA-875). When this is null or
   *  positionConfidence is below MIN_POSITION_CONFIDENCE, the new
   *  stakeholder is created with no position field, leaving it for human
   *  curation rather than guessing. */
  position?: StakeholderPosition | null;
  /** 0–1 confidence from the extractor; below MIN_POSITION_CONFIDENCE the
   *  position is treated as unset. */
  positionConfidence?: number | null;
}

/** Minimum extractor confidence required to commit a position to YAML.
 *  Below this we leave the field unset rather than guessing. Imported by
 *  research-improve-entity.ts (extractor prompt + plumbing); this file is
 *  the single source of truth. */
export const MIN_POSITION_CONFIDENCE = 0.6;

export interface ApplyResult<T> {
  entity: T;
  applied: Array<{ targetField: string; action: "added" | "updated" | "skipped"; reason?: string }>;
  warnings: string[];
}

const APPLIED_STATUSES = new Set(["verified", "partial"]);

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

const MONTH_NAMES: Record<string, string> = {
  jan: "01", january: "01",
  feb: "02", february: "02",
  mar: "03", march: "03",
  apr: "04", april: "04",
  may: "05",
  jun: "06", june: "06",
  jul: "07", july: "07",
  aug: "08", august: "08",
  sep: "09", sept: "09", september: "09",
  oct: "10", october: "10",
  nov: "11", november: "11",
  dec: "12", december: "12",
};

const MONTH_NAME_PATTERN = `(${Object.keys(MONTH_NAMES).join("|")})`;
const ISO_DATE_RE = /\b(\d{4})-(\d{2})-(\d{2})(?!\d)/;
const MONTH_DAY_RE = new RegExp(
  String.raw`\b${MONTH_NAME_PATTERN}\.?\s+(\d{1,2}),?\s+(\d{4})\b`,
  "i",
);
const MONTH_YEAR_RE = new RegExp(String.raw`\b${MONTH_NAME_PATTERN}\.?\s+(\d{4})\b`, "i");
const YYYY_MM_RE = /\b(\d{4})-(\d{2})\b/;
const BARE_YEAR_RE = /\b(1[89]|20)(\d{2})\b/;

// Older orgs (pre-1800) are out of scope for the wiki; "year 4 digits"
// matches like 0000 or 9999 are almost certainly false positives.
const MIN_YEAR = 1800;
const MAX_YEAR = 2099;

function isYearInRange(year: number): boolean {
  return year >= MIN_YEAR && year <= MAX_YEAR;
}

// Round-trip through Date.UTC rejects calendar-impossible values
// (Feb 31, Apr 31, non-leap Feb 29).
function validateFullDate(year: string, month: string, day: string): string | null {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isFinite(y) || !Number.isFinite(m) || !Number.isFinite(d)) return null;
  if (!isYearInRange(y)) return null;
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const utc = new Date(Date.UTC(y, m - 1, d));
  if (
    utc.getUTCFullYear() !== y ||
    utc.getUTCMonth() !== m - 1 ||
    utc.getUTCDate() !== d
  ) {
    return null;
  }
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

/**
 * Best-effort extraction of a structured date from prose. Returns the
 * tightest representation available (`YYYY-MM-DD` → `YYYY-MM` → `YYYY`),
 * or null when nothing parseable is found.
 *
 * Tries `primary` first, then each fallback in order — the keyDate applier
 * passes `proposedValue` first (where the extractor prompt requires ISO
 * format) and falls back to `extractedValue` and `claimText`.
 */
export function extractStructuredDate(
  primary: string | null | undefined,
  ...fallbacks: Array<string | null | undefined>
): string | null {
  for (const raw of [primary, ...fallbacks]) {
    if (!raw) continue;
    const s = raw.trim();
    if (!s) continue;

    // Trailing `(?!\d)` (rather than `\b`) lets us match the date prefix of
    // an ISO 8601 timestamp like "2024-06-15T10:30:00Z" — with `\b`, the
    // word-boundary between `5` and `T` (both word chars) doesn't fire.
    const iso = s.match(ISO_DATE_RE);
    if (iso) {
      const valid = validateFullDate(iso[1], iso[2], iso[3]);
      if (valid) return valid;
    }

    const monthDay = s.match(MONTH_DAY_RE);
    if (monthDay) {
      const month = MONTH_NAMES[monthDay[1].toLowerCase()];
      if (month) {
        const valid = validateFullDate(monthDay[3], month, monthDay[2]);
        if (valid) return valid;
      }
    }

    const monthYear = s.match(MONTH_YEAR_RE);
    if (monthYear) {
      const month = MONTH_NAMES[monthYear[1].toLowerCase()];
      if (month && isYearInRange(Number(monthYear[2]))) {
        return `${monthYear[2]}-${month}`;
      }
    }

    const ym = s.match(YYYY_MM_RE);
    if (ym && isYearInRange(Number(ym[1])) && Number(ym[2]) >= 1 && Number(ym[2]) <= 12) {
      return `${ym[1]}-${ym[2]}`;
    }

    const year = s.match(BARE_YEAR_RE);
    if (year) return `${year[1]}${year[2]}`;
  }
  return null;
}

// Verb stems used as a "is this a real sentence?" smoke test for product
// descriptions. The Haiku extractor sometimes emits noun phrases or fragments
// ("Claude large-language model", "the company's flagship product"); requiring
// at least one common verb lets us reject those without leaning on full NLP.
// This is a sanity floor, not a grammar checker — false negatives just leave
// the slot for re-extraction next iteration.
//
// Design notes:
//  - Auxiliaries / copulas are unambiguously verbs and listed bare.
//  - For lexical verbs, prefer inflected forms (-s, -ed, -ing) over bare
//    stems, because many bare stems double as common nouns ("a design",
//    "a release", "a target") and would let pure noun phrases pass the check.
//  - Bare forms are only included when the noun reading is uncommon
//    ("provide", "include", "develop").
const COMMON_VERBS = new Set([
  // auxiliaries / copulas
  "is", "are", "was", "were", "be", "been", "being", "am",
  "has", "have", "had", "having",
  "do", "does", "did", "doing", "done",
  "will", "would", "shall", "should", "can", "could", "may", "might", "must",
  // residues from contraction stripping (won't → wo, can't → ca, shan't → sha)
  // — included so the verb check still recognizes the modal stem.
  "wo", "ca", "sha",
  // lexical verbs — prefer inflected forms
  "provides", "provide", "provided", "providing",
  "offers", "offered", "offering",
  "supports", "supported", "supporting",
  "enables", "enable", "enabled", "enabling",
  "allows", "allow", "allowed", "allowing",
  "creates", "create", "created", "creating",
  "builds", "built", "building",
  "develops", "develop", "developed", "developing",
  "runs", "ran", "running",
  "designed", "designs", "designing",
  "used", "uses", "using",
  "called", "calls", "calling",
  "named", "names", "naming",
  "includes", "include", "included", "including",
  "focuses", "focused", "focusing",
  "makes", "made", "making",
  "lets", "letting",
  "helps", "helped", "helping",
  "generates", "generate", "generated", "generating",
  "produces", "produce", "produced", "producing",
  "performs", "performed", "performing",
  "processes", "processed", "processing",
  "trains", "trained", "training",
  "launched", "launches", "launching",
  "released", "releases", "releasing",
  "powers", "powered", "powering",
  "delivers", "deliver", "delivered", "delivering",
  "combines", "combine", "combined", "combining",
  "represents", "represent", "represented", "representing",
  "serves", "served", "serving",
  "operates", "operate", "operated", "operating",
  "worked", "working",
  "comprises", "comprise", "comprising",
  "consists", "consist", "consisting",
  "targets", "targeted", "targeting",
  "handled", "handling",
  "extends", "extend", "extended", "extending",
  "deploys", "deployed", "deploying",
]);

// Strip trailing contraction suffix ("isn't" → "isn", then "'t" stripped by
// the non-letter strip). Simpler: explicitly strip n't, 's, 're, 've, 'll, 'd
// before the lookup so the base verb is detectable.
const CONTRACTION_SUFFIX_RE = /(n['’]t|['’](?:s|re|ve|ll|d|m))$/i;

const PRODUCT_DESC_MAX_LENGTH = 300;
const PRODUCT_DESC_MIN_WORDS = 8;

// Reject descriptions that mix in launch-date or revenue/valuation content.
// These facts belong in keyDate.* and factbase.* respectively. "May" is
// intentionally excluded — it is also a common modal verb ("Claude may be
// used for...") and causes too many false positives.
const PRODUCT_DATE_REVENUE_RE =
  /\b(january|february|march|april|june|july|august|september|october|november|december)\b|\b(19|20)\d{2}\b|\$|\b(million|billion|run-rate|run rate|revenue|launched|made\s+available)\b/i;

/**
 * Normalize a Haiku-extracted product description before writing it to YAML.
 *
 * The Haiku extractor occasionally returns fragmentary excerpts (leading
 * `...`, embedded ellipses, multi-paragraph blobs) because it copy-pastes
 * the surrounding source instead of synthesizing a coherent sentence. This
 * normalizer is the apply-step safety net for that — it strips obvious
 * artifacts and rejects anything that still doesn't look like a sentence.
 *
 * Returns the cleaned description, or `null` if the input is too thin to
 * write (caller should mark the verdict skipped). Decisions:
 *   - Leading `[.,…\s]+` (extraction artifacts like "...exemplified by") → strip
 *   - Mid-text `...` or `…` (source omissions) → collapse to a single space
 *   - Length > 300 chars → keep up to the first sentence, else truncate
 *   - < 8 words OR no recognized verb → null (slot left for re-extraction)
 *
 * Exported for testing. See QUA-938.
 */
export function normalizeProductDescription(input: string | null | undefined): string | null {
  let s = (input ?? "").trim();
  if (!s) return null;
  // Strip leading extraction artifacts: dots, commas, ellipses, semicolons,
  // colons, dashes, bullet markers ("- ", "* ", "• "), question/exclamation
  // marks, and whitespace. Catches "...exemplified by...", ",and the company",
  // "- Claude is...", "* Claude is...", "• Claude is..." etc.
  s = s.replace(/^[-—*•:;?!.,\s…]+/u, "").trim();
  if (!s) return null;
  // Collapse mid-text ellipses (`...` or `…`) — these are almost always
  // signals that the extractor stitched two non-adjacent source snippets.
  // Replacing with a single space keeps the surrounding tokens but removes
  // the visual "this was cut" tell.
  s = s.replace(/\s*\.{3,}\s*/g, " ").replace(/\s*…\s*/g, " ");
  // Strip trailing comma/fragment punctuation (e.g. "...the leading model,").
  s = s.replace(/,\s*$/u, "").trim();
  if (!s) return null;
  // Normalize whitespace.
  s = s.replace(/\s+/g, " ").trim();
  if (!s) return null;
  // If overly long, prefer the first sentence; otherwise truncate at the
  // last word boundary within 300 chars and append `…` so the YAML reader
  // can see the value was cut. Avoids mid-word truncation like "...mode".
  if (s.length > PRODUCT_DESC_MAX_LENGTH) {
    const firstSentence = s.match(/^[^.!?]+[.!?]/);
    if (firstSentence) {
      s = firstSentence[0].trim();
    } else {
      const truncated = s.slice(0, PRODUCT_DESC_MAX_LENGTH).replace(/\s+\S*$/, "").trim();
      s = truncated ? `${truncated}…` : "";
    }
  }
  if (!s) return null;
  const words = s.split(/\s+/).filter(Boolean);
  if (words.length < PRODUCT_DESC_MIN_WORDS) return null;
  const hasVerb = words.some((raw) => {
    // Lowercase, strip leading/trailing punctuation, then peel off any
    // contraction suffix ("isn't" → "is", "claude's" → "claude") before
    // looking up against COMMON_VERBS.
    let w = raw.toLowerCase().replace(/^[^a-z]+|[^a-z'’]+$/g, "");
    w = w.replace(CONTRACTION_SUFFIX_RE, "");
    // Final strip of any remaining apostrophes (e.g. unmatched curly quote).
    w = w.replace(/['’]/g, "");
    return COMMON_VERBS.has(w);
  });
  if (!hasVerb) return null;
  // Reject descriptions that mix in launch-date or revenue/valuation content.
  // Aligns the write-path enforcement with the extraction-prompt guidance so
  // a mixed blurb can never land in product.* even if the LLM ignores the prompt.
  if (PRODUCT_DATE_REVENUE_RE.test(s)) return null;
  return s;
}

/**
 * Canonical comparison key for a person's display name. Strips suffixes
 * (Jr., Sr., III, PhD, MD), lowercases, and slugifies. Used for keyPerson
 * dedup so "Sam Altman" and "sam-altman" and "Sam Altman, PhD" canonicalize
 * to the same key.
 */
export function canonicalizePersonKey(input: string): string {
  if (!input) return "";
  let s = input.trim();
  // Strip trailing suffix tokens (degrees, generational suffixes).
  s = s.replace(/[,\s]+(Jr\.?|Sr\.?|III|II|IV|PhD\.?|Ph\.?D\.?|MD\.?|M\.?D\.?)\b\.?$/i, "");
  return slugify(s);
}

/**
 * Resolves a stakeholder canonical slug + display name to a wiki entityId
 * (stableId or slug). Called once per added/updated stakeholder. Return null
 * if no match. The applier stores the result on the stakeholder's `entityId`
 * field when matched.
 *
 * Parameter is named `canonical` (not `canonicalSlug`) to avoid shadowing
 * the imported `canonicalSlug` function in callers.
 */
export type StakeholderEntityResolver = (canonical: string, displayName: string) => string | null;

export interface ApplyPolicyOptions {
  resolveStakeholderEntity?: StakeholderEntityResolver;
}

/** Apply a batch of verdicts to a PolicyEntity. Returns updated entity + change log. */
export function applyVerdictsToPolicy(
  entity: PolicyEntity,
  verdicts: VerifiedVerdict[],
  options: ApplyPolicyOptions = {},
): ApplyResult<PolicyEntity> {
  // Deep-clone the parts we mutate.
  const next: PolicyEntity = {
    ...entity,
    provisions: entity.provisions ? entity.provisions.map((p) => ({ ...p })) : [],
    stakeholders: entity.stakeholders ? entity.stakeholders.map((s) => ({ ...s })) : [],
    tags: entity.tags ? [...entity.tags] : [],
    relatedEntries: entity.relatedEntries ? entity.relatedEntries.map((r) => ({ ...r })) : [],
  };
  const applied: ApplyResult<PolicyEntity>["applied"] = [];
  const warnings: string[] = [];

  for (const v of verdicts) {
    if (!APPLIED_STATUSES.has(v.status)) continue;

    const tf = v.targetField;
    const value = (v.extractedValue?.trim() || v.proposedValue?.trim() || v.claimText).trim();

    // ── scalar.<field> ──────────────────────────────────────────────────
    if (tf.startsWith("scalar.")) {
      const field = tf.slice("scalar.".length) as keyof PolicyEntity;
      const allowed = new Set([
        "description",
        "billNumber",
        "introduced",
        "policyStatus",
        "author",
        "scope",
        "jurisdiction",
        "fullTextUrl",
      ]);
      if (!allowed.has(field as string)) {
        warnings.push(`unknown scalar field: ${field as string}`);
        applied.push({ targetField: tf, action: "skipped", reason: "unknown field" });
        continue;
      }
      if (next[field]) {
        applied.push({ targetField: tf, action: "skipped", reason: "already filled" });
        continue;
      }
      // String fields only.
      (next as unknown as Record<string, unknown>)[field as string] = value;
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── provision.<slug> ────────────────────────────────────────────────
    if (tf.startsWith("provision.")) {
      const slug = tf.slice("provision.".length);
      const title = v.displayHint ?? titleCase(slug);
      next.provisions ??= [];
      const titleSlug = slugify(title);
      const existing = next.provisions.find(
        (p) => slugify(p.title) === slug || slugify(p.title) === titleSlug,
      );
      if (existing) {
        // Update description if fuller.
        if (!existing.description || existing.description.length < value.length) {
          existing.description = value;
          if (!existing.source) existing.source = v.sourceUrl;
          applied.push({ targetField: tf, action: "updated" });
        } else {
          applied.push({ targetField: tf, action: "skipped", reason: "existing description longer" });
        }
        continue;
      }
      next.provisions.push({ title, description: value, source: v.sourceUrl });
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── stakeholder.<slug> ──────────────────────────────────────────────
    if (tf.startsWith("stakeholder.")) {
      const slug = tf.slice("stakeholder.".length);
      const name = v.displayHint ?? titleCase(slug);
      next.stakeholders ??= [];
      // Canonicalize both the targetField slug and the display name. This
      // collapses aliases like "fbi" + "federal-bureau-of-investigation"
      // and "FBI (Federal Bureau of Investigation)" + "FBI" + "Federal Bureau
      // of Investigation" to a single canonical slug, so the LLM extractor
      // can no longer produce duplicates by varying the surface form.
      const canonFromSlug = canonicalSlug(slug);
      const canonFromName = canonicalSlug(name);
      const matchKey = (existingName: string) => {
        const c = canonicalSlug(existingName);
        if (!c) return false; // an existing entry with empty name shouldn't gobble new entries
        return c === canonFromSlug || c === canonFromName;
      };
      const existing = next.stakeholders.find((s) => matchKey(s.name));
      // Decide whether the extractor gave us a confident-enough position to
      // commit. Below the threshold (or if null), leave the field unset so
      // a human can curate. The extractor is the single source of truth —
      // the apply step never invents a default.
      const confidentPosition: StakeholderPosition | null =
        v.position && (v.positionConfidence ?? 0) >= MIN_POSITION_CONFIDENCE
          ? v.position
          : null;
      if (existing) {
        // Position backfill is independent of reason replacement: a long
        // human-curated reason should still receive a missing position from
        // a confident extractor verdict. (Hostile-review HIGH #1, QUA-875.)
        // Never overwrite an existing position — first-write-wins by design,
        // since YAML carries no confidence to compare against.
        let positionBackfilled = false;
        if (!existing.position && confidentPosition) {
          existing.position = confidentPosition;
          positionBackfilled = true;
        }
        let reasonUpdated = false;
        if (!existing.reason || existing.reason.length < value.length) {
          existing.reason = value;
          if (!existing.source) existing.source = v.sourceUrl;
          reasonUpdated = true;
        }
        // Backfill entityId on the existing entry when a resolver is supplied.
        let entityBackfilled = false;
        if (!existing.entityId && options.resolveStakeholderEntity) {
          const eid = options.resolveStakeholderEntity(canonFromName || canonFromSlug, name);
          if (eid) {
            existing.entityId = eid;
            entityBackfilled = true;
          }
        }
        if (reasonUpdated) {
          applied.push({ targetField: tf, action: "updated" });
        } else if (positionBackfilled || entityBackfilled) {
          const reason = positionBackfilled
            ? entityBackfilled
              ? "position + entityId backfilled"
              : "position backfilled"
            : "entityId backfilled";
          applied.push({ targetField: tf, action: "updated", reason });
        } else {
          applied.push({ targetField: tf, action: "skipped", reason: "existing reason longer" });
        }
        continue;
      }
      // New stakeholder: omit `position` entirely when the extractor is
      // unsure. The YAML field is optional; downstream consumers must
      // tolerate stakeholders without a position. Previously this defaulted
      // to "reform", which produced obviously-wrong values like NSA marked
      // "reform" — see QUA-875.
      const newStakeholder: NonNullable<PolicyEntity["stakeholders"]>[number] = {
        name,
        importance: "medium",
        reason: value,
        source: v.sourceUrl,
      };
      if (confidentPosition) newStakeholder.position = confidentPosition;
      if (options.resolveStakeholderEntity) {
        const eid = options.resolveStakeholderEntity(canonFromName || canonFromSlug, name);
        if (eid) newStakeholder.entityId = eid;
      }
      next.stakeholders.push(newStakeholder);
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── tag.<value> ─────────────────────────────────────────────────────
    if (tf.startsWith("tag.")) {
      const tag = slugify(tf.slice("tag.".length));
      next.tags ??= [];
      if (next.tags.includes(tag)) {
        applied.push({ targetField: tf, action: "skipped", reason: "duplicate tag" });
        continue;
      }
      next.tags.push(tag);
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── relatedEntry.<entityId> ─────────────────────────────────────────
    if (tf.startsWith("relatedEntry.")) {
      const id = tf.slice("relatedEntry.".length);
      next.relatedEntries ??= [];
      if (next.relatedEntries.find((r) => r.id === id)) {
        applied.push({ targetField: tf, action: "skipped", reason: "duplicate relatedEntry" });
        continue;
      }
      // Type unknown at this stage — caller should backfill, default to 'analysis'.
      next.relatedEntries.push({ id, type: "analysis" });
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    warnings.push(`unrecognized targetField: ${tf}`);
    applied.push({ targetField: tf, action: "skipped", reason: "unrecognized targetField" });
  }

  return { entity: next, applied, warnings };
}

/** Existing keyPerson display name for dedup — handles both string and object form. */
function keyPersonDisplay(p: OrganizationKeyPerson): string {
  return typeof p === "string" ? p : p.name ?? p.slug ?? "";
}

/** Optional resolver for cross-referencing keyPerson names against existing
 *  PG entities. The pure function does not perform IO; the caller may pass
 *  a synchronous resolver derived from a pre-fetched search.
 */
export type PersonEntityResolver = (canonicalKey: string, displayName: string) => string | null;

export interface ApplyOrganizationOptions {
  /**
   * Resolves a keyPerson to a wiki entityId (either slug like "sam-altman" or
   * `sid_*`). Called once per added keyPerson to enable cross-ref. Return null
   * if no match. The applier stores the result on the keyPerson object's
   * `entityId` field when matched.
   */
  resolvePersonEntity?: PersonEntityResolver;
}

/** Apply a batch of verdicts to an OrganizationEntity. */
export function applyVerdictsToOrganization(
  entity: OrganizationEntity,
  verdicts: VerifiedVerdict[],
  options: ApplyOrganizationOptions = {},
): ApplyResult<OrganizationEntity> {
  const next: OrganizationEntity = {
    ...entity,
    products: entity.products ? entity.products.map((p) => ({ ...p })) : [],
    keyPeople: entity.keyPeople ? entity.keyPeople.map((p) => (typeof p === "string" ? p : { ...p })) : [],
    keyDates: entity.keyDates ? entity.keyDates.map((d) => ({ ...d })) : [],
    tags: entity.tags ? [...entity.tags] : [],
    relatedEntries: entity.relatedEntries ? entity.relatedEntries.map((r) => ({ ...r })) : [],
  };
  const applied: ApplyResult<OrganizationEntity>["applied"] = [];
  const warnings: string[] = [];

  const ALLOWED_SCALARS = new Set([
    "description",
    "website",
    "orgType",
    "founded",
    "headquarters",
    "employees",
    "funding",
    "parentOrg",
    "orgStatus",
    "safetyFocus",
  ]);

  for (const v of verdicts) {
    if (!APPLIED_STATUSES.has(v.status)) continue;

    const tf = v.targetField;
    const value = (v.extractedValue?.trim() || v.proposedValue?.trim() || v.claimText).trim();

    // ── scalar.<field> ──────────────────────────────────────────────────
    if (tf.startsWith("scalar.")) {
      const field = tf.slice("scalar.".length);
      if (!ALLOWED_SCALARS.has(field)) {
        warnings.push(`unknown scalar field: ${field}`);
        applied.push({ targetField: tf, action: "skipped", reason: "unknown field" });
        continue;
      }
      if ((next as unknown as Record<string, unknown>)[field]) {
        applied.push({ targetField: tf, action: "skipped", reason: "already filled" });
        continue;
      }
      (next as unknown as Record<string, unknown>)[field] = value;
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── product.<slug> ──────────────────────────────────────────────────
    if (tf.startsWith("product.")) {
      const slug = tf.slice("product.".length);
      const name = v.displayHint ?? titleCase(slug);
      next.products ??= [];
      const nameSlug = slugify(name);
      const existing = next.products.find(
        (p) => slugify(p.name) === slug || slugify(p.name) === nameSlug,
      );
      // Normalize the candidate description before comparison/write — strips
      // leading "..." extraction artifacts, collapses mid-text ellipses, and
      // returns null for fragments under 8 words or without a verb. QUA-938.
      //
      // Intentional: this floor runs BEFORE the existing-product comparison.
      // A thin candidate is skipped even when the existing description is
      // even thinner — the slot is left for a later iteration to extract
      // something coherent. Replacing a 3-char placeholder with a 7-word
      // fragment is a pyrrhic victory we don't want.
      const cleaned = normalizeProductDescription(value);
      if (!cleaned) {
        applied.push({ targetField: tf, action: "skipped", reason: "description too thin" });
        continue;
      }
      if (existing) {
        // Compare against the *normalized* existing description so a dirty
        // legacy entry ("...exemplified by Claude...", 89 chars) cannot block
        // a cleaner replacement just because the leading-artifact bytes
        // inflated its length. If the existing description doesn't normalize
        // (i.e. it's itself a fragment), treat it as length 0 so any clean
        // candidate wins. QUA-938 review fix.
        const existingClean = existing.description
          ? normalizeProductDescription(existing.description)
          : null;
        const existingLen = existingClean?.length ?? 0;
        if (existingLen < cleaned.length) {
          existing.description = cleaned;
          if (!existing.source) existing.source = v.sourceUrl;
          applied.push({ targetField: tf, action: "updated" });
        } else {
          applied.push({ targetField: tf, action: "skipped", reason: "existing description longer" });
        }
        continue;
      }
      next.products.push({ name, description: cleaned, source: v.sourceUrl });
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── keyPerson.<slug> ────────────────────────────────────────────────
    if (tf.startsWith("keyPerson.")) {
      const slug = tf.slice("keyPerson.".length);
      const name = v.displayHint ?? titleCase(slug);
      next.keyPeople ??= [];
      // Canonical key handles "Sam Altman" vs "sam-altman" vs "Sam Altman, PhD".
      const canon = canonicalizePersonKey(name);
      const slugCanon = canonicalizePersonKey(slug);
      const matchKey = (display: string) =>
        canonicalizePersonKey(display) === canon || canonicalizePersonKey(display) === slugCanon;

      const existingIdx = next.keyPeople.findIndex((p) => matchKey(keyPersonDisplay(p)));
      if (existingIdx !== -1) {
        const existing = next.keyPeople[existingIdx];
        // If existing is a bare string and we now have a richer object, upgrade it.
        if (typeof existing === "string") {
          const obj: import("./gap-analyzer.ts").OrganizationKeyPersonObject = { slug: existing, name };
          // Resolver gets first crack at attaching entityId.
          if (options.resolvePersonEntity) {
            const eid = options.resolvePersonEntity(canon, name);
            if (eid) obj.entityId = eid;
          }
          if (v.sourceUrl) obj.source = v.sourceUrl;
          // If the existing string is already a clean slug, keep it as a string when no resolver fires.
          if (!obj.entityId && !obj.source) {
            applied.push({ targetField: tf, action: "skipped", reason: "duplicate keyPerson" });
            continue;
          }
          next.keyPeople[existingIdx] = obj;
          applied.push({ targetField: tf, action: "updated" });
          continue;
        }
        // Existing object — only update if we add new info.
        let updated = false;
        if (!existing.name) {
          existing.name = name;
          updated = true;
        }
        if (!existing.entityId && options.resolvePersonEntity) {
          const eid = options.resolvePersonEntity(canon, name);
          if (eid) {
            existing.entityId = eid;
            updated = true;
          }
        }
        if (!existing.source && v.sourceUrl) {
          existing.source = v.sourceUrl;
          updated = true;
        }
        applied.push({
          targetField: tf,
          action: updated ? "updated" : "skipped",
          reason: updated ? undefined : "duplicate keyPerson",
        });
        continue;
      }
      // New keyPerson: prefer object form so we can carry entityId + source.
      const obj: import("./gap-analyzer.ts").OrganizationKeyPersonObject = {
        slug: slugify(name),
        name,
      };
      if (options.resolvePersonEntity) {
        const eid = options.resolvePersonEntity(canon, name);
        if (eid) obj.entityId = eid;
      }
      if (v.sourceUrl) obj.source = v.sourceUrl;
      next.keyPeople.push(obj);
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── keyDate.<slug> ──────────────────────────────────────────────────
    if (tf.startsWith("keyDate.")) {
      const slug = tf.slice("keyDate.".length);
      const description = v.displayHint ?? titleCase(slug);
      const date = extractStructuredDate(v.proposedValue, v.extractedValue, v.claimText);
      next.keyDates ??= [];
      const existing = next.keyDates.find((d) => slugify(d.description) === slug);
      if (existing) {
        let updated = false;
        if (!existing.date && date) {
          existing.date = date;
          updated = true;
        }
        if (!existing.source && v.sourceUrl) {
          existing.source = v.sourceUrl;
          updated = true;
        }
        // Symmetric with the new-entry branch: warn whenever date is still
        // missing, independent of source backfill (which would set `updated`).
        if (!existing.date && !date) {
          warnings.push(
            `keyDate.${slug}: no parseable date in proposedValue/extractedValue/claimText — existing entry left unfilled`,
          );
        }
        applied.push({
          targetField: tf,
          action: updated ? "updated" : "skipped",
          reason: updated ? undefined : "duplicate keyDate",
        });
        continue;
      }
      if (!date) {
        warnings.push(
          `keyDate.${slug}: no parseable date in proposedValue/extractedValue/claimText — entry dropped`,
        );
        applied.push({ targetField: tf, action: "skipped", reason: "no parseable date" });
        continue;
      }
      next.keyDates.push({ date, description, source: v.sourceUrl });
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── tag.<value> ─────────────────────────────────────────────────────
    if (tf.startsWith("tag.")) {
      const tag = slugify(tf.slice("tag.".length));
      next.tags ??= [];
      if (next.tags.includes(tag)) {
        applied.push({ targetField: tf, action: "skipped", reason: "duplicate tag" });
        continue;
      }
      next.tags.push(tag);
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── relatedEntry.<entityId> ─────────────────────────────────────────
    if (tf.startsWith("relatedEntry.")) {
      const id = tf.slice("relatedEntry.".length);
      next.relatedEntries ??= [];
      if (next.relatedEntries.find((r) => r.id === id)) {
        applied.push({ targetField: tf, action: "skipped", reason: "duplicate relatedEntry" });
        continue;
      }
      next.relatedEntries.push({ id, type: "organization" });
      applied.push({ targetField: tf, action: "added" });
      continue;
    }

    // ── factbase.<field> ────────────────────────────────────────────────
    // Cross-base routing happens in a separate pipeline. Skip with a clear
    // reason rather than warning, so the verdict isn't lost — downstream
    // FactBase tooling can pick these up.
    if (tf.startsWith("factbase.")) {
      applied.push({
        targetField: tf,
        action: "skipped",
        reason: "factbase routing (out of scope for org loop)",
      });
      continue;
    }

    warnings.push(`unrecognized targetField: ${tf}`);
    applied.push({ targetField: tf, action: "skipped", reason: "unrecognized targetField" });
  }

  return { entity: next, applied, warnings };
}
