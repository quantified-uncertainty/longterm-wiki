// Apply verified claims back into a policy entity's YAML record.
// v1: handles `provision.<title-slug>`, `stakeholder.<name-slug>`,
// scalar top-level fields, tag.<value>, and relatedEntry.<id>.
//
// Pure functions: takes a (PolicyEntity, verdicts[]) and returns an updated
// PolicyEntity plus a writeback summary. The caller serializes back to YAML.

import type { PolicyEntity } from "./gap-analyzer.ts";

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
}

export interface ApplyResult {
  entity: PolicyEntity;
  applied: Array<{ targetField: string; action: "added" | "updated" | "skipped"; reason?: string }>;
  warnings: string[];
}

const APPLIED_STATUSES = new Set(["verified", "partial"]);

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function titleCase(slug: string): string {
  return slug
    .split("-")
    .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join(" ");
}

/** Apply a batch of verdicts to a PolicyEntity. Returns updated entity + change log. */
export function applyVerdictsToPolicy(
  entity: PolicyEntity,
  verdicts: VerifiedVerdict[],
): ApplyResult {
  // Deep-clone the parts we mutate.
  const next: PolicyEntity = {
    ...entity,
    provisions: entity.provisions ? entity.provisions.map((p) => ({ ...p })) : [],
    stakeholders: entity.stakeholders ? entity.stakeholders.map((s) => ({ ...s })) : [],
    tags: entity.tags ? [...entity.tags] : [],
    relatedEntries: entity.relatedEntries ? entity.relatedEntries.map((r) => ({ ...r })) : [],
  };
  const applied: ApplyResult["applied"] = [];
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
      (next as Record<string, unknown>)[field as string] = value;
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
      // Dedupe by both targetField slug AND displayHint slug — the LLM
      // sometimes produces different targetField slugs ("foreign-intelligence-surveillance-court"
      // vs "...-fisc") that map to the same display name.
      const nameSlug = slugify(name);
      const existing = next.stakeholders.find(
        (s) => slugify(s.name) === slug || slugify(s.name) === nameSlug,
      );
      if (existing) {
        if (!existing.reason || existing.reason.length < value.length) {
          existing.reason = value;
          if (!existing.source) existing.source = v.sourceUrl;
          applied.push({ targetField: tf, action: "updated" });
        } else {
          applied.push({ targetField: tf, action: "skipped", reason: "existing reason longer" });
        }
        continue;
      }
      // Default to position=reform when unknown — least-controversial.
      next.stakeholders.push({
        name,
        position: "reform",
        importance: "medium",
        reason: value,
        source: v.sourceUrl,
      });
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
