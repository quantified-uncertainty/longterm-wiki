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
});

const PolicyEntitySchema = BaseEntity.extend({
  entityType: z.literal("policy"),
  introduced: z.string().optional(),
  policyStatus: z.string().optional(),
  author: z.string().optional(),
  scope: z.string().optional(),
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

const FunderEntitySchema = BaseEntity.extend({
  entityType: z.literal("funder"),
});

const ResourceEntitySchema = BaseEntity.extend({
  entityType: z.literal("resource"),
});

const ParameterEntitySchema = BaseEntity.extend({
  entityType: z.literal("parameter"),
});

const MetricEntitySchema = BaseEntity.extend({
  entityType: z.literal("metric"),
});

// Catch-all for entity types we haven't explicitly modeled
// (e.g., ai-transition-model-* types)
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
  FunderEntitySchema,
  ResourceEntitySchema,
  ParameterEntitySchema,
  MetricEntitySchema,
]);

// ============================================================================
// INFERRED TYPES
// ============================================================================

export type TypedEntity = z.infer<typeof TypedEntitySchema>;
export type RiskEntity = z.infer<typeof RiskEntitySchema>;
export type PersonEntity = z.infer<typeof PersonEntitySchema>;
export type OrganizationEntity = z.infer<typeof OrganizationEntitySchema>;
export type PolicyEntity = z.infer<typeof PolicyEntitySchema>;
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

