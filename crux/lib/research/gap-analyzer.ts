// Gap analyzer — given an entity's current YAML state, produce a list of
// "missing fact slots" that the next research iteration should try to fill.
// v1: only handles type=policy.
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

export interface Gap {
  /** A short slug for this gap, used in research topics and claim targetField. */
  key: string;
  /** Human-readable description for the LLM extractor. */
  description: string;
  /** What field this gap fills (top-level or array). */
  target: "scalar" | "provision" | "stakeholder" | "relatedEntry" | "tag";
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

const DEFAULT_POLICY_TARGETS: PolicyTargets = {
  minProvisions: 6,
  minStakeholders: 5,
  minTags: 3,
  minRelatedEntries: 3,
};

const TOP_LEVEL_FIELDS: Array<{ key: keyof PolicyEntity; topic: string; priority: number }> = [
  { key: "description", topic: "description and overview", priority: 100 },
  { key: "billNumber", topic: "bill number and statutory citation", priority: 90 },
  { key: "introduced", topic: "introduction or enactment date", priority: 85 },
  { key: "policyStatus", topic: "current legal status (enacted, pending, etc.)", priority: 80 },
  { key: "author", topic: "primary author or sponsor", priority: 70 },
  { key: "jurisdiction", topic: "jurisdiction and scope", priority: 70 },
  { key: "fullTextUrl", topic: "full statutory text URL", priority: 60 },
];

/** Compute gaps for a policy entity. */
export function analyzePolicyGaps(
  entity: PolicyEntity,
  targets: PolicyTargets = DEFAULT_POLICY_TARGETS,
): Gap[] {
  const gaps: Gap[] = [];
  const title = entity.title ?? entity.id;

  // Top-level scalars — only flag if missing.
  for (const f of TOP_LEVEL_FIELDS) {
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
  for (const f of TOP_LEVEL_FIELDS) {
    const v = entity[f.key];
    if (v && (typeof v !== "string" || v.length >= 4)) topLevelFilled++;
  }
  components.top_level = topLevelFilled / TOP_LEVEL_FIELDS.length;

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
