// Gap analyzer — given an entity's current YAML state, produce a list of
// "missing fact slots" that the next research iteration should try to fill.
// Supported types: policy, organization.
// Returns gaps in priority order (highest-leverage gaps first).

export interface PolicyEntity {
  id: string;
  stableId?: string;
  wikiId?: string;
  type: string;
  title?: string;
  description?: string;
  introduced?: string;
  policyStatus?: string;
  author?: string;
  scope?: string;
  billNumber?: string;
  jurisdiction?: string;
  fullTextUrl?: string;
  provisions?: Array<{ title: string; description?: string; category?: string; source?: string }>;
  stakeholders?: Array<{
    name: string;
    position?: string;
    importance?: string;
    reason?: string;
    source?: string;
    entityId?: string;
  }>;
  relatedEntries?: Array<{ id: string; type: string }>;
  tags?: string[];
}

export interface OrganizationProduct {
  name: string;
  description?: string;
  source?: string;
}

export interface OrganizationKeyDate {
  date: string;
  description: string;
  source?: string;
}

export interface OrganizationKeyPersonObject {
  slug?: string;
  name?: string;
  role?: string;
  entityId?: string;
  source?: string;
}

/**
 * keyPeople in YAML is a flexible array: most existing entries are bare slug
 * strings (e.g. ["dario-amodei", "daniela-amodei"]), but the gap analyzer
 * may add richer object entries with role/source.
 */
export type OrganizationKeyPerson = string | OrganizationKeyPersonObject;

export interface OrganizationEntity {
  id: string;
  stableId?: string;
  wikiId?: string;
  type: string;
  title?: string;
  description?: string;
  website?: string;
  orgType?: string;
  founded?: string;
  headquarters?: string;
  employees?: string;
  funding?: string;
  parentOrg?: string;
  orgStatus?: string;
  safetyFocus?: string;
  products?: OrganizationProduct[];
  keyPeople?: OrganizationKeyPerson[];
  keyDates?: OrganizationKeyDate[];
  relatedEntries?: Array<{ id: string; type: string; relationship?: string }>;
  tags?: string[];
}

export interface Gap {
  /** A short slug for this gap, used in research topics and claim targetField. */
  key: string;
  /** Human-readable description for the LLM extractor. */
  description: string;
  /** What field this gap fills (top-level or array). */
  target:
    | "scalar"
    | "provision"
    | "stakeholder"
    | "relatedEntry"
    | "tag"
    | "product"
    | "keyPerson"
    | "keyDate"
    | "factbase";
  /** Priority — higher = filled first. */
  priority: number;
  /** Free-form research topic to feed to runResearch. */
  researchTopic: string;
}

export interface PolicyTargets {
  minProvisions: number;
  minStakeholders: number;
  minTags: number;
  minRelatedEntries: number;
}

export interface OrganizationTargets {
  minProducts: number;
  minKeyPeople: number;
  minKeyDates: number;
  minTags: number;
  minRelatedEntries: number;
}

const DEFAULT_POLICY_TARGETS: PolicyTargets = {
  minProvisions: 6,
  minStakeholders: 5,
  minTags: 3,
  minRelatedEntries: 3,
};

const DEFAULT_ORG_TARGETS: OrganizationTargets = {
  minProducts: 3,
  minKeyPeople: 3,
  minKeyDates: 2,
  minTags: 3,
  minRelatedEntries: 3,
};

const POLICY_TOP_LEVEL_FIELDS: Array<{ key: keyof PolicyEntity; topic: string; priority: number }> = [
  { key: "description", topic: "description and overview", priority: 100 },
  { key: "billNumber", topic: "bill number and statutory citation", priority: 90 },
  { key: "introduced", topic: "introduction or enactment date", priority: 85 },
  { key: "policyStatus", topic: "current legal status (enacted, pending, etc.)", priority: 80 },
  { key: "author", topic: "primary author or sponsor", priority: 70 },
  { key: "jurisdiction", topic: "jurisdiction and scope", priority: 70 },
  { key: "fullTextUrl", topic: "full statutory text URL", priority: 60 },
];

const ORG_TOP_LEVEL_FIELDS: Array<{ key: keyof OrganizationEntity; topic: string; priority: number }> = [
  { key: "description", topic: "description and mission", priority: 100 },
  { key: "website", topic: "official website URL", priority: 95 },
  { key: "orgType", topic: "organization type (frontier-lab, safety-org, academic, government, funder, startup, generic, other)", priority: 90 },
  { key: "founded", topic: "year founded", priority: 85 },
  { key: "headquarters", topic: "headquarters location", priority: 80 },
  { key: "employees", topic: "approximate employee count", priority: 70 },
];

/** Compute gaps for a policy entity. */
export function analyzePolicyGaps(
  entity: PolicyEntity,
  targets: PolicyTargets = DEFAULT_POLICY_TARGETS,
): Gap[] {
  const gaps: Gap[] = [];
  const title = entity.title ?? entity.id;

  // Top-level scalars — only flag if missing.
  for (const f of POLICY_TOP_LEVEL_FIELDS) {
    if (!entity[f.key] || (typeof entity[f.key] === "string" && (entity[f.key] as string).length < 4)) {
      gaps.push({
        key: `scalar.${String(f.key)}`,
        description: `Provide the ${f.topic} for ${title}.`,
        target: "scalar",
        priority: f.priority,
        researchTopic: `${title} ${f.topic}`,
      });
    }
  }

  // Provisions — fill up to target.
  const provCount = entity.provisions?.length ?? 0;
  const provGap = Math.max(0, targets.minProvisions - provCount);
  if (provGap > 0) {
    const existing = (entity.provisions ?? []).map((p) => p.title).join(", ");
    gaps.push({
      key: "provisions",
      description: existing
        ? `Identify ${provGap} additional provisions of ${title} not already in: [${existing}].`
        : `Identify ${provGap} key provisions of ${title}.`,
      target: "provision",
      priority: 95,
      researchTopic: `${title} key provisions and legal authorities`,
    });
  }

  // Stakeholders — fill up to target.
  const stakeCount = entity.stakeholders?.length ?? 0;
  const stakeGap = Math.max(0, targets.minStakeholders - stakeCount);
  if (stakeGap > 0) {
    const existing = (entity.stakeholders ?? []).map((s) => s.name).join(", ");
    gaps.push({
      key: "stakeholders",
      description: existing
        ? `Identify ${stakeGap} additional stakeholders for ${title} not already in: [${existing}]. Include both supporters and opponents/reformers.`
        : `Identify ${stakeGap} key stakeholders for ${title}, including supporters and opponents.`,
      target: "stakeholder",
      priority: 92,
      researchTopic: `${title} stakeholders supporters opponents civil liberties advocates`,
    });
  }

  // Tags — light-touch.
  const tagCount = entity.tags?.length ?? 0;
  if (tagCount < targets.minTags) {
    gaps.push({
      key: "tags",
      description: `Suggest ${targets.minTags - tagCount} additional topical tags for ${title}.`,
      target: "tag",
      priority: 30,
      researchTopic: `${title} topic categories`,
    });
  }

  // Related entries — light-touch.
  const relCount = entity.relatedEntries?.length ?? 0;
  if (relCount < targets.minRelatedEntries) {
    gaps.push({
      key: "relatedEntries",
      description: `Identify ${targets.minRelatedEntries - relCount} related policies, analyses, or organizations.`,
      target: "relatedEntry",
      priority: 40,
      researchTopic: `${title} related legislation analysis policies`,
    });
  }

  // Sort by priority desc.
  return gaps.sort((a, b) => b.priority - a.priority);
}

/** Compute gaps for an organization entity. */
export function analyzeOrganizationGaps(
  entity: OrganizationEntity,
  targets: OrganizationTargets = DEFAULT_ORG_TARGETS,
): Gap[] {
  const gaps: Gap[] = [];
  const title = entity.title ?? entity.id;

  // Top-level scalars — only flag if missing/too-short.
  for (const f of ORG_TOP_LEVEL_FIELDS) {
    const v = entity[f.key];
    const missing = !v || (typeof v === "string" && v.length < 4);
    if (missing) {
      gaps.push({
        key: `scalar.${String(f.key)}`,
        description: `Provide the ${f.topic} for ${title}.`,
        target: "scalar",
        priority: f.priority,
        researchTopic: `${title} ${f.topic}`,
      });
    }
  }

  // Products — fill up to target.
  const productCount = entity.products?.length ?? 0;
  const productGap = Math.max(0, targets.minProducts - productCount);
  if (productGap > 0) {
    const existing = (entity.products ?? []).map((p) => p.name).join(", ");
    gaps.push({
      key: "products",
      description: existing
        ? `Identify ${productGap} additional products, models, or tools released by ${title} not already in: [${existing}].`
        : `Identify ${productGap} key products, models, or tools released by ${title}.`,
      target: "product",
      priority: 88,
      researchTopic: `${title} products models tools released`,
    });
  }

  // Key people — fill up to target. Existing entries may be bare slugs or objects.
  const peopleCount = entity.keyPeople?.length ?? 0;
  const peopleGap = Math.max(0, targets.minKeyPeople - peopleCount);
  if (peopleGap > 0) {
    const existing = (entity.keyPeople ?? [])
      .map((p) => (typeof p === "string" ? p : p.name ?? p.slug ?? ""))
      .filter((s) => s.length > 0)
      .join(", ");
    gaps.push({
      key: "keyPeople",
      description: existing
        ? `Identify ${peopleGap} additional founders, executives, or notable researchers at ${title} not already in: [${existing}].`
        : `Identify ${peopleGap} founders, executives, or notable researchers at ${title}.`,
      target: "keyPerson",
      priority: 90,
      researchTopic: `${title} founders CEO executives notable researchers`,
    });
  }

  // Key dates — fill up to target.
  const datesCount = entity.keyDates?.length ?? 0;
  const datesGap = Math.max(0, targets.minKeyDates - datesCount);
  if (datesGap > 0) {
    const existing = (entity.keyDates ?? []).map((d) => `${d.date}: ${d.description}`).join("; ");
    gaps.push({
      key: "keyDates",
      description: existing
        ? `Identify ${datesGap} additional milestone dates for ${title} not already in: [${existing}].`
        : `Identify ${datesGap} milestone dates (founding, major launches, funding rounds, leadership changes) for ${title}.`,
      target: "keyDate",
      priority: 75,
      researchTopic: `${title} history milestones founding major events`,
    });
  }

  // Tags — light-touch.
  const tagCount = entity.tags?.length ?? 0;
  if (tagCount < targets.minTags) {
    gaps.push({
      key: "tags",
      description: `Suggest ${targets.minTags - tagCount} additional topical tags for ${title}.`,
      target: "tag",
      priority: 30,
      researchTopic: `${title} research focus topic categories`,
    });
  }

  // Related entries — light-touch.
  const relCount = entity.relatedEntries?.length ?? 0;
  if (relCount < targets.minRelatedEntries) {
    gaps.push({
      key: "relatedEntries",
      description: `Identify ${targets.minRelatedEntries - relCount} related organizations, key partners, or competitors.`,
      target: "relatedEntry",
      priority: 40,
      researchTopic: `${title} partner organizations competitors collaborators`,
    });
  }

  // Cross-base FactBase facts — flag for follow-up routing (separate ticket).
  // We surface these as gaps so that downstream pipelines (FactBase fact
  // extraction, separate ticket) can pick them up. The applier will skip
  // factbase.* targetFields gracefully — they're not written into the local
  // YAML.
  gaps.push({
    key: "factbase.revenue",
    description: `Find recent revenue or annual recurring revenue figure for ${title} (will be routed to FactBase).`,
    target: "factbase",
    priority: 20,
    researchTopic: `${title} revenue annual recurring revenue financials`,
  });
  gaps.push({
    key: "factbase.valuation",
    description: `Find most recent valuation or post-money valuation for ${title} (will be routed to FactBase).`,
    target: "factbase",
    priority: 20,
    researchTopic: `${title} valuation funding round post-money`,
  });

  return gaps.sort((a, b) => b.priority - a.priority);
}

export interface CoverageScore {
  score: number;       // 0 to 1
  components: Record<string, number>;
  facts_in_yaml: Record<string, number>;
}

/** A simple coverage score: weighted average of slot-fill ratios. */
export function policyCoverageScore(
  entity: PolicyEntity,
  targets: PolicyTargets = DEFAULT_POLICY_TARGETS,
): CoverageScore {
  const components: Record<string, number> = {};

  // Top-level fields
  let topLevelFilled = 0;
  for (const f of POLICY_TOP_LEVEL_FIELDS) {
    const v = entity[f.key];
    if (v && (typeof v !== "string" || v.length >= 4)) topLevelFilled++;
  }
  components.top_level = topLevelFilled / POLICY_TOP_LEVEL_FIELDS.length;

  components.provisions = Math.min(1, (entity.provisions?.length ?? 0) / targets.minProvisions);
  components.stakeholders = Math.min(1, (entity.stakeholders?.length ?? 0) / targets.minStakeholders);
  components.tags = Math.min(1, (entity.tags?.length ?? 0) / targets.minTags);
  components.relatedEntries = Math.min(
    1,
    (entity.relatedEntries?.length ?? 0) / targets.minRelatedEntries,
  );

  // Weighted: top-level + provisions + stakeholders dominate.
  const weights = { top_level: 0.3, provisions: 0.3, stakeholders: 0.25, tags: 0.05, relatedEntries: 0.1 };
  let score = 0;
  for (const [k, w] of Object.entries(weights)) {
    score += (components[k] ?? 0) * w;
  }

  return {
    score: Math.round(score * 100) / 100,
    components,
    facts_in_yaml: {
      provisions: entity.provisions?.length ?? 0,
      stakeholders: entity.stakeholders?.length ?? 0,
      tags: entity.tags?.length ?? 0,
      relatedEntries: entity.relatedEntries?.length ?? 0,
      top_level_filled: topLevelFilled,
    },
  };
}

/** Coverage score for an organization. Weights per QUA-876:
 *  top-level 0.4, products 0.2, keyPeople 0.2, keyDates 0.1, factbase 0.1.
 *  factbase coverage is currently 0 (out-of-scope for this loop) but is
 *  tracked so the score is comparable across pipeline upgrades.
 */
export function organizationCoverageScore(
  entity: OrganizationEntity,
  targets: OrganizationTargets = DEFAULT_ORG_TARGETS,
): CoverageScore {
  const components: Record<string, number> = {};

  let topLevelFilled = 0;
  for (const f of ORG_TOP_LEVEL_FIELDS) {
    const v = entity[f.key];
    if (v && (typeof v !== "string" || v.length >= 4)) topLevelFilled++;
  }
  components.top_level = topLevelFilled / ORG_TOP_LEVEL_FIELDS.length;
  components.products = Math.min(1, (entity.products?.length ?? 0) / targets.minProducts);
  components.keyPeople = Math.min(1, (entity.keyPeople?.length ?? 0) / targets.minKeyPeople);
  components.keyDates = Math.min(1, (entity.keyDates?.length ?? 0) / targets.minKeyDates);
  // FactBase routing is out-of-scope in this loop — placeholder until separate ticket.
  components.factbase = 0;

  const weights = { top_level: 0.4, products: 0.2, keyPeople: 0.2, keyDates: 0.1, factbase: 0.1 };
  let score = 0;
  for (const [k, w] of Object.entries(weights)) {
    score += (components[k] ?? 0) * w;
  }

  return {
    score: Math.round(score * 100) / 100,
    components,
    facts_in_yaml: {
      products: entity.products?.length ?? 0,
      keyPeople: entity.keyPeople?.length ?? 0,
      keyDates: entity.keyDates?.length ?? 0,
      tags: entity.tags?.length ?? 0,
      relatedEntries: entity.relatedEntries?.length ?? 0,
      top_level_filled: topLevelFilled,
    },
  };
}

/** Entity types that have a coverage scorer registered. */
export const SUPPORTED_COVERAGE_TYPES = ["policy", "organization"] as const;
export type SupportedCoverageType = (typeof SUPPORTED_COVERAGE_TYPES)[number];

export function isSupportedCoverageType(t: string): t is SupportedCoverageType {
  return (SUPPORTED_COVERAGE_TYPES as readonly string[]).includes(t);
}

/**
 * Dispatch a coverage score based on `entity.type`. Returns `null` for
 * types without a registered scorer — callers decide whether to surface
 * that as a hard error or a `unsupported_type` status.
 *
 * Input is the union of supported entity shapes; the `entity.type ===` checks
 * narrow within each branch. Loaded-from-YAML entities are passed in here —
 * PolicyEntity and OrganizationEntity both have all-optional fields beyond
 * `{id, type}`, so a YAML record is structurally assignable.
 */
export function coverageScoreForEntity(
  entity: PolicyEntity | OrganizationEntity,
): CoverageScore | null {
  if (entity.type === "policy") return policyCoverageScore(entity as PolicyEntity);
  if (entity.type === "organization")
    return organizationCoverageScore(entity as OrganizationEntity);
  return null;
}
