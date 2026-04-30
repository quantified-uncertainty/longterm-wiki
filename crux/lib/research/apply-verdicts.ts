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
 *  Below this we leave the field unset rather than guessing. Mirrored in
 *  research-improve-entity.ts as MIN_POSITION_CONFIDENCE — they MUST stay
 *  in sync. */
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
      if (existing) {
        if (!existing.description || existing.description.length < value.length) {
          existing.description = value;
          if (!existing.source) existing.source = v.sourceUrl;
          applied.push({ targetField: tf, action: "updated" });
        } else {
          applied.push({ targetField: tf, action: "skipped", reason: "existing description longer" });
        }
        continue;
      }
      next.products.push({ name, description: value, source: v.sourceUrl });
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
      // displayHint is the human description; extractedValue/claimText carries the date.
      const description = v.displayHint ?? titleCase(slug);
      const date = (v.extractedValue?.trim() || v.proposedValue?.trim() || "").trim();
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
        applied.push({
          targetField: tf,
          action: updated ? "updated" : "skipped",
          reason: updated ? undefined : "duplicate keyDate",
        });
        continue;
      }
      if (!date) {
        applied.push({ targetField: tf, action: "skipped", reason: "no date value" });
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
