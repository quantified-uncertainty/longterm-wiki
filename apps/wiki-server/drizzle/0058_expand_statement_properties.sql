-- Phase 1 Property Vocabulary Expansion (#1657)
-- Adds ~30 new properties covering people, safety, governance, products, attribution.
-- Uses INSERT ... ON CONFLICT to be idempotent.

-- === People & Leadership ===
INSERT INTO "properties" ("id", "label", "category", "description", "entity_types", "value_type", "default_unit", "staleness_cadence")
VALUES
  ('team-size', 'Team Size', 'organizational', 'Size of a specific team or division within an organization', '{organization}', 'number', 'count', NULL),
  ('chief-scientist', 'Chief Scientist', 'relation', 'Chief scientist or head of research at an organization', '{organization}', 'entity', NULL, NULL),
  ('education', 'Education', 'people', 'Educational background, degrees, or institutional affiliations', '{person}', 'string', NULL, NULL),
  ('research-group-lead', 'Research Group Lead', 'relation', 'Leader of a specific research group or team', '{organization}', 'entity', NULL, NULL),
  ('employer', 'Employer', 'relation', 'Organization where a person is currently employed', '{person}', 'entity', NULL, NULL),
  ('position', 'Position / Role', 'people', 'Job title or role held by a person at an organization', '{person}', 'string', NULL, NULL),
  ('h-index', 'h-index', 'research', 'h-index measuring research impact', '{person}', 'number', 'count', NULL),
  ('publication-count', 'Publication Count', 'research', 'Number of academic or technical publications authored', '{person}', 'number', 'count', NULL)
ON CONFLICT ("id") DO UPDATE SET
  "label" = EXCLUDED."label",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "entity_types" = EXCLUDED."entity_types",
  "value_type" = EXCLUDED."value_type",
  "default_unit" = EXCLUDED."default_unit",
  "updated_at" = now();

-- === Products ===
INSERT INTO "properties" ("id", "label", "category", "description", "entity_types", "value_type", "default_unit", "staleness_cadence")
VALUES
  ('pricing', 'Pricing', 'products', 'Pricing model, tier structure, or specific price point', '{organization}', 'string', NULL, NULL),
  ('api-volume', 'API Volume', 'products', 'Number of API calls, requests, or tokens processed', '{organization}', 'number', 'count', NULL),
  ('product-name', 'Product Name', 'products', 'Name of a product or service offered by the entity', '{organization}', 'string', NULL, NULL)
ON CONFLICT ("id") DO UPDATE SET
  "label" = EXCLUDED."label",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "entity_types" = EXCLUDED."entity_types",
  "value_type" = EXCLUDED."value_type",
  "default_unit" = EXCLUDED."default_unit",
  "updated_at" = now();

-- === Safety & Research (expanded) ===
INSERT INTO "properties" ("id", "label", "category", "description", "entity_types", "value_type", "default_unit", "staleness_cadence")
VALUES
  ('interpretability-finding', 'Interpretability Finding', 'safety', 'Specific finding from interpretability or mechanistic interpretability research', '{organization}', 'string', NULL, NULL),
  ('safety-incident', 'Safety Incident', 'safety', 'AI safety incident, failure, or concerning behavior observed in deployment', '{organization}', 'string', NULL, NULL),
  ('red-team-result', 'Red Team Result', 'safety', 'Finding from red-teaming or adversarial testing of AI systems', '{organization}', 'string', NULL, NULL),
  ('alignment-technique', 'Alignment Technique', 'safety', 'AI alignment method, approach, or training technique (e.g., RLHF, constitutional AI)', '{organization}', 'string', NULL, NULL),
  ('safety-evaluation', 'Safety Evaluation', 'safety', 'Formal safety evaluation result or assessment (e.g., model card findings)', '{organization}', 'string', NULL, NULL),
  ('responsible-scaling-level', 'Responsible Scaling Level', 'safety', 'ASL or RSP tier classification for AI system capabilities', '{organization}', 'string', NULL, NULL),
  ('biosecurity-finding', 'Biosecurity Finding', 'safety', 'Finding related to biosecurity risks from AI systems', '{organization}', 'string', NULL, NULL),
  ('safety-team-size', 'Safety Team Size', 'safety', 'Number of people on the safety or alignment team', '{organization}', 'number', 'count', 'annually')
ON CONFLICT ("id") DO UPDATE SET
  "label" = EXCLUDED."label",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "entity_types" = EXCLUDED."entity_types",
  "value_type" = EXCLUDED."value_type",
  "default_unit" = EXCLUDED."default_unit",
  "staleness_cadence" = EXCLUDED."staleness_cadence",
  "updated_at" = now();

-- === Governance & Policy (expanded) ===
INSERT INTO "properties" ("id", "label", "category", "description", "entity_types", "value_type", "default_unit", "staleness_cadence")
VALUES
  ('compliance-standard', 'Compliance Standard', 'governance', 'Regulatory or industry compliance standard adopted (e.g., ISO 42001, NIST AI RMF)', '{organization}', 'string', NULL, NULL),
  ('transparency-report', 'Transparency Report', 'governance', 'Published transparency report or disclosure document', '{organization}', 'string', NULL, NULL),
  ('voluntary-commitment', 'Voluntary Commitment', 'governance', 'Voluntary commitment or pledge related to AI safety or ethics', '{organization}', 'string', NULL, NULL),
  ('international-agreement', 'International Agreement', 'governance', 'International agreement, treaty, or multi-party commitment', '{organization}', 'string', NULL, NULL),
  ('board-composition', 'Board Composition', 'governance', 'Description of board structure and key members', '{organization}', 'string', NULL, NULL),
  ('policy-commitment', 'Policy Commitment', 'governance', 'Public policy commitment or voluntary agreement related to AI safety', '{organization}', 'string', NULL, NULL)
ON CONFLICT ("id") DO UPDATE SET
  "label" = EXCLUDED."label",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "entity_types" = EXCLUDED."entity_types",
  "value_type" = EXCLUDED."value_type",
  "default_unit" = EXCLUDED."default_unit",
  "updated_at" = now();

-- === Attribution ===
INSERT INTO "properties" ("id", "label", "category", "description", "entity_types", "value_type", "default_unit", "staleness_cadence")
VALUES
  ('prediction', 'Prediction', 'attribution', 'Forward-looking prediction or forecast attributed to a person', '{person,organization}', 'string', NULL, NULL),
  ('public-statement', 'Public Statement', 'attribution', 'Notable public statement, quote, or position expressed publicly', '{person,organization}', 'string', NULL, NULL),
  ('interview-quote', 'Interview Quote', 'attribution', 'Notable quote from an interview, podcast, or testimony', '{person}', 'string', NULL, NULL)
ON CONFLICT ("id") DO UPDATE SET
  "label" = EXCLUDED."label",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "entity_types" = EXCLUDED."entity_types",
  "value_type" = EXCLUDED."value_type",
  "default_unit" = EXCLUDED."default_unit",
  "updated_at" = now();

-- === Additional properties that may already exist but need category/metadata updates ===
INSERT INTO "properties" ("id", "label", "category", "description", "entity_types", "value_type", "default_unit", "staleness_cadence")
VALUES
  ('compute-budget', 'Compute Budget', 'financial', 'Estimated or reported compute expenditure', '{organization}', 'number', 'USD', NULL),
  ('release-date', 'Release Date', 'milestone', 'Date a product, model, or version was released', '{organization}', 'date', NULL, NULL),
  ('announced-date', 'Announced Date', 'milestone', 'Date an announcement was made', '{organization}', 'date', NULL, NULL)
ON CONFLICT ("id") DO UPDATE SET
  "label" = EXCLUDED."label",
  "category" = EXCLUDED."category",
  "description" = EXCLUDED."description",
  "entity_types" = EXCLUDED."entity_types",
  "value_type" = EXCLUDED."value_type",
  "default_unit" = EXCLUDED."default_unit",
  "updated_at" = now();
