/**
 * Per-type Zod schemas for typed entities.
 *
 * The discriminated union on `entityType` replaces the old loose Entity interface.
 * Lab-* types are flattened into "organization" with an `orgType` discriminator.
 * customFields are mapped to typed per-entity fields.
 */
import { z } from "zod";

// ============================================================================
// BASE SCHEMA (shared by all entity types)
// ============================================================================

const RelatedEntry = z.object({
  id: z.string(),
  type: z.string(),
  relationship: z.string().optional(),
});

const Source = z.object({
  title: z.string(),
  url: z.string().optional(),
  author: z.string().optional(),
  date: z.string().optional(),
});

const CustomField = z.object({
  label: z.string(),
  value: z.string(),
  link: z.string().optional(),
});

const BaseEntity = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  tags: z.array(z.string()).default([]),
  clusters: z.array(z.string()).default([]),
  relatedEntries: z.array(RelatedEntry).default([]),
  sources: z.array(Source).default([]),
  lastUpdated: z.string().optional(),
  website: z.string().optional(),
  // Metadata fields carried from database.json
  numericId: z.string().optional(),
  path: z.string().optional(),
  status: z.string().optional(),
  customFields: z.array(CustomField).default([]),
  relatedTopics: z.array(z.string()).default([]),
  // Summary/overview page that this entity belongs to (entity or page ID)
  summaryPage: z.string().optional(),
});

// ============================================================================
// PER-TYPE SCHEMAS
// ============================================================================

const RiskEntitySchema = BaseEntity.extend({
  entityType: z.literal("risk"),
  severity: z
    .enum(["low", "medium", "medium-high", "high", "critical", "catastrophic"])
    .optional(),
  likelihood: z
    .union([
      z.string(),
      z.object({
        level: z.string(),
        status: z.string().optional(),
        display: z.string().optional(),
      }),
    ])
    .optional(),
  timeframe: z
    .union([
      z.string(),
      z.object({
        median: z.number(),
        earliest: z.number().optional(),
        latest: z.number().optional(),
        display: z.string().optional(),
      }),
    ])
    .optional(),
  maturity: z
    .enum(["Neglected", "Emerging", "Growing", "Mature"])
    .optional(),
  riskCategory: z
    .enum(["accident", "misuse", "structural", "epistemic"])
    .optional(),
});

const RiskFactorEntitySchema = BaseEntity.extend({
  entityType: z.literal("risk-factor"),
});

const PersonEntitySchema = BaseEntity.extend({
  entityType: z.literal("person"),
  role: z.string().optional(),
  affiliation: z.string().optional(),
  knownFor: z.array(z.string()).default([]),
});

const OrganizationEntitySchema = BaseEntity.extend({
  entityType: z.literal("organization"),
  orgType: z
    .enum([
      "frontier-lab",
      "safety-org",
      "academic",
      "government",
      "funder",
      "startup",
      "generic",
      "other",
    ])
    .optional(),
  founded: z.string().optional(),
  headquarters: z.string().optional(),
  employees: z.string().optional(),
  funding: z.string().optional(),
  // parentOrg = entity ID of a parent organization.
  // Use for legally separate entities that are part of a larger org
  // (e.g., CHAI → UC Berkeley, UK AISI → DSIT).
  // Distinct from "divisions" which are internal sub-units.
  parentOrg: z.string().optional(),
});

const PolicyStakeholder = z.object({
  name: z.string(),
  entityId: z.string().optional(),
  position: z.enum(["support", "oppose", "neutral", "mixed"]),
  reason: z.string().optional(),
  source: z.string().optional(),
});

const PolicyProvision = z.object({
  title: z.string(),
  description: z.string(),
  category: z.string().optional(),
});

const PolicyVote = z.object({
  chamber: z.string(),
  date: z.string().optional(),
  result: z.string(),
  ayes: z.number().optional(),
  noes: z.number().optional(),
  abstain: z.number().optional(),
});

const PolicyAmendment = z.object({
  date: z.string(),
  description: z.string(),
  author: z.string().optional(),
});

const PolicyEntitySchema = BaseEntity.extend({
  entityType: z.literal("policy"),
  introduced: z.string().optional(),
  policyStatus: z.string().optional(),
  author: z.string().optional(),
  scope: z.string().optional(),
  billNumber: z.string().optional(),
  jurisdiction: z.string().optional(),
  session: z.string().optional(),
  fullTextUrl: z.string().optional(),
  vetoReason: z.string().optional(),
  stakeholders: z.array(PolicyStakeholder).default([]),
  provisions: z.array(PolicyProvision).default([]),
  votes: z.array(PolicyVote).default([]),
  amendments: z.array(PolicyAmendment).default([]),
  keyPoliticians: z.array(z.object({
    name: z.string(),
    entityId: z.string().optional(),
    role: z.string(),
  })).default([]),
});

const ApproachEntitySchema = BaseEntity.extend({
  entityType: z.literal("approach"),
});

const SafetyAgendaEntitySchema = BaseEntity.extend({
  entityType: z.literal("safety-agenda"),
  goal: z.string().optional(),
});

const ConceptEntitySchema = BaseEntity.extend({
  entityType: z.literal("concept"),
});

const CruxEntitySchema = BaseEntity.extend({
  entityType: z.literal("crux"),
});

const ModelEntitySchema = BaseEntity.extend({
  entityType: z.literal("model"),
});

const CapabilityEntitySchema = BaseEntity.extend({
  entityType: z.literal("capability"),
});

const ProjectEntitySchema = BaseEntity.extend({
  entityType: z.literal("project"),
});

const AnalysisEntitySchema = BaseEntity.extend({
  entityType: z.literal("analysis"),
});

const HistoricalEntitySchema = BaseEntity.extend({
  entityType: z.literal("historical"),
});

const ArgumentEntitySchema = BaseEntity.extend({
  entityType: z.literal("argument"),
});

const ScenarioEntitySchema = BaseEntity.extend({
  entityType: z.literal("scenario"),
});

const CaseStudyEntitySchema = BaseEntity.extend({
  entityType: z.literal("case-study"),
});

// FunderEntitySchema removed — "funder" is now an alias for "organization"
// with orgType: "funder". See entity-type-names.ts ENTITY_TYPE_ALIASES.

const ResourceEntitySchema = BaseEntity.extend({
  entityType: z.literal("resource"),
});

const ParameterEntitySchema = BaseEntity.extend({
  entityType: z.literal("parameter"),
});

const MetricEntitySchema = BaseEntity.extend({
  entityType: z.literal("metric"),
});

const OverviewEntitySchema = BaseEntity.extend({
  entityType: z.literal("overview"),
});

const InternalEntitySchema = BaseEntity.extend({
  entityType: z.literal("internal"),
});

const EventEntitySchema = BaseEntity.extend({
  entityType: z.literal("event"),
});

const DebateEntitySchema = BaseEntity.extend({
  entityType: z.literal("debate"),
});

const TableEntitySchema = BaseEntity.extend({
  entityType: z.literal("table"),
});

const DiagramEntitySchema = BaseEntity.extend({
  entityType: z.literal("diagram"),
});

const IntelligenceParadigmEntitySchema = BaseEntity.extend({
  entityType: z.literal("intelligence-paradigm"),
});

const BenchmarkResult = z.object({
  name: z.string(),
  score: z.number(),
  unit: z.string().optional(),
  date: z.string().optional(),
});

const BenchmarkEntitySchema = BaseEntity.extend({
  entityType: z.literal("benchmark"),
  category: z
    .enum([
      "coding",
      "reasoning",
      "math",
      "knowledge",
      "multimodal",
      "safety",
      "agentic",
      "general",
    ])
    .optional(),
  scoringMethod: z
    .enum(["percentage", "elo", "accuracy", "pass_at_1", "points"])
    .optional(),
  higherIsBetter: z.boolean().default(true),
  introducedDate: z.string().optional(),
  maintainer: z.string().optional(),
});

const AiModelEntitySchema = BaseEntity.extend({
  entityType: z.literal("ai-model"),
  modelFamily: z.string().optional(),
  modelTier: z.string().optional(),
  generation: z.string().optional(),
  releaseDate: z.string().optional(),
  developer: z.string().optional(),
  inputPrice: z.number().optional(),
  outputPrice: z.number().optional(),
  contextWindow: z.number().optional(),
  safetyLevel: z.string().optional(),
  benchmarks: z.array(BenchmarkResult).default([]),
  capabilities: z.array(z.string()).default([]),
  modality: z.array(z.string()).default([]),
  openWeight: z.boolean().optional(),
  parameterCount: z.string().optional(),
  trainingCutoff: z.string().optional(),
});

// Catch-all for entity types we haven't explicitly modeled
const GenericEntitySchema = BaseEntity.extend({
  entityType: z.string(),
});

// ============================================================================
// DISCRIMINATED UNION
// ============================================================================

/**
 * All explicitly modeled entity schemas.
 * The discriminated union validates based on `entityType`.
 */
export const TypedEntitySchema = z.discriminatedUnion("entityType", [
  RiskEntitySchema,
  RiskFactorEntitySchema,
  PersonEntitySchema,
  OrganizationEntitySchema,
  PolicyEntitySchema,
  ApproachEntitySchema,
  SafetyAgendaEntitySchema,
  ConceptEntitySchema,
  CruxEntitySchema,
  ModelEntitySchema,
  CapabilityEntitySchema,
  ProjectEntitySchema,
  AnalysisEntitySchema,
  HistoricalEntitySchema,
  ArgumentEntitySchema,
  ScenarioEntitySchema,
  CaseStudyEntitySchema,
  ResourceEntitySchema,
  ParameterEntitySchema,
  MetricEntitySchema,
  OverviewEntitySchema,
  InternalEntitySchema,
  EventEntitySchema,
  DebateEntitySchema,
  TableEntitySchema,
  DiagramEntitySchema,
  IntelligenceParadigmEntitySchema,
  AiModelEntitySchema,
  BenchmarkEntitySchema,
]);

// ============================================================================
// INFERRED TYPES
// ============================================================================

export type TypedEntity = z.infer<typeof TypedEntitySchema>;
export type RiskEntity = z.infer<typeof RiskEntitySchema>;
export type PersonEntity = z.infer<typeof PersonEntitySchema>;
export type OrganizationEntity = z.infer<typeof OrganizationEntitySchema>;
export type PolicyEntity = z.infer<typeof PolicyEntitySchema>;
export type OverviewEntity = z.infer<typeof OverviewEntitySchema>;
export type AiModelEntity = z.infer<typeof AiModelEntitySchema>;
export type BenchmarkEntity = z.infer<typeof BenchmarkEntitySchema>;
export type GenericEntity = z.infer<typeof GenericEntitySchema>;

// ============================================================================
// TYPE GUARDS
// ============================================================================

export function isRisk(e: TypedEntity | GenericEntity): e is RiskEntity {
  return e.entityType === "risk";
}

export function isPerson(e: TypedEntity | GenericEntity): e is PersonEntity {
  return e.entityType === "person";
}

export function isOrganization(e: TypedEntity | GenericEntity): e is OrganizationEntity {
  return e.entityType === "organization";
}

export function isPolicy(e: TypedEntity | GenericEntity): e is PolicyEntity {
  return e.entityType === "policy";
}

export function isAiModel(e: TypedEntity | GenericEntity): e is AiModelEntity {
  return e.entityType === "ai-model";
}

export function isBenchmark(e: TypedEntity | GenericEntity): e is BenchmarkEntity {
  return e.entityType === "benchmark";
}

