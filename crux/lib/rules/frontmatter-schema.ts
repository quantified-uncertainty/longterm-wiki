/**
 * Frontmatter Schema Validation Rule
 *
 * Validates MDX frontmatter against the content collection schema.
 */

import { z } from 'zod';
import { Severity, Issue, type ContentFile, type ValidationEngine } from '../validation/validation-engine.ts';
import { ALL_ENTITY_TYPE_NAMES } from '../../../apps/web/src/data/entity-type-names.ts';
import { VALID_SUBCATEGORIES } from '../valid-subcategories.ts';

// Mapping from entityType to subcategories that are typical for that type.
// Used for cross-field validation (WARNING, not ERROR — judgment-based).
// Entity types not listed here have no subcategory restrictions.
const SUBCATEGORY_BY_ENTITY_TYPE: Partial<Record<string, readonly string[]>> = {
  organization: ['funders', 'safety-orgs', 'epistemic-orgs', 'biosecurity-orgs', 'labs',
    'community-building', 'government', 'finance', 'venture-capital', 'industry'],
  person: ['safety-researchers', 'forecasters', 'lab-leadership', 'ea-figures',
    'track-records', 'policy-figures'],
  risk: ['accident', 'epistemic', 'structural', 'misuse'],
  approach: ['epistemic-platforms', 'alignment-evaluation', 'epistemic-approaches',
    'legislation', 'alignment-theoretical', 'alignment-training', 'governance',
    'alignment-deployment', 'field-building', 'compute-governance',
    'alignment-interpretability', 'alignment', 'international',
    'organizational-practices', 'alignment-policy', 'resilience',
    'institutions', 'biosecurity'],
  'safety-agenda': ['epistemic-platforms', 'alignment-evaluation', 'epistemic-approaches',
    'alignment-theoretical', 'alignment-training', 'alignment-deployment',
    'alignment-interpretability', 'alignment'],
  policy: ['legislation', 'governance', 'alignment-policy', 'compute-governance',
    'international', 'organizational-practices', 'resilience', 'institutions', 'biosecurity'],
  model: ['domain-models', 'analysis-models', 'risk-models', 'governance-models',
    'societal-models', 'timeline-models', 'safety-models', 'intervention-models',
    'dynamics-models', 'threshold-models', 'impact-models', 'framework-models',
    'economic-models', 'cascade-models', 'race-models'],
  'intelligence-paradigm': ['architectures', 'bio-hardware', 'scaffolding', 'other'],
  debate: ['formal-arguments', 'policy-debates'],
  capability: ['core', 'safety-relevant', 'agentic', 'applications'],
  historical: ['ea-history', 'ai-history'],
  concept: ['core', 'safety-relevant', 'agentic', 'ea-history', 'ai-history'],
};

// Mirror the schema from content.config.ts
const frontmatterSchema = z.object({
  title: z.string(),
  description: z.string().optional(),
  sidebar: z.object({
    label: z.string().optional(),
    order: z.number().optional(),
    hidden: z.boolean().optional(),
    badge: z.any().optional(),
  }).optional(),
  template: z.enum(['doc', 'splash']).optional(),
  hero: z.any().optional(),
  tableOfContents: z.any().optional(),
  editUrl: z.union([z.string(), z.boolean()]).optional(),
  head: z.array(z.any()).optional(),
  lastUpdated: z.union([z.date(), z.string(), z.boolean()]).optional(),
  prev: z.any().optional(),
  next: z.any().optional(),
  banner: z.any().optional(),
  draft: z.boolean().optional(),

  // Custom LongtermWiki fields
  pageType: z.enum(['content', 'stub', 'documentation']).optional(),
  contentFormat: z.enum(['article', 'table', 'diagram', 'index', 'dashboard']).optional(),
  quality: z.number().min(0).max(100).optional(),
  readerImportance: z.number().min(0).max(100).optional(),
  researchImportance: z.number().min(0).max(100).optional(),
  tacticalValue: z.number().min(0).max(100).optional(),
  tractability: z.number().min(0).max(100).optional(),
  neglectedness: z.number().min(0).max(100).optional(),
  uncertainty: z.number().min(0).max(100).optional(),
  llmSummary: z.string().optional(),
  lastEdited: z.string().optional(),
  todo: z.string().optional(),
  todos: z.array(z.string()).min(1).optional(),
  seeAlso: z.string().optional(),
  ratings: z.object({
    novelty: z.number().min(0).max(10).optional(),
    rigor: z.number().min(0).max(10).optional(),
    actionability: z.number().min(0).max(10).optional(),
    completeness: z.number().min(0).max(10).optional(),
    focus: z.number().min(0).max(10).optional(),
    concreteness: z.number().min(0).max(10).optional(),
    objectivity: z.number().min(0).max(10).optional(),
    changeability: z.number().min(0).max(100).optional(),
    xriskImpact: z.number().min(0).max(100).optional(),
    trajectoryImpact: z.number().min(0).max(100).optional(),
    uncertainty: z.number().min(0).max(100).optional(),
  }).optional(),
  // metrics (wordCount, citations, tables, diagrams) are computed at build time
  // by crux/lib/metrics-extractor.ts — not stored in frontmatter.
  balanceFlags: z.array(z.string()).optional(),
  maturity: z.string().optional(),
  fullWidth: z.boolean().optional(),
  update_frequency: z.number().positive().optional(),
  evergreen: z.literal(false).optional(),
  entityType: z.enum(ALL_ENTITY_TYPE_NAMES as unknown as [string, ...string[]]).optional(),
  entityId: z.string().optional(),
  numericId: z.string().regex(/^E\d+$/, 'numericId must match format "E" followed by digits (e.g. "E710")').optional(),
  subcategory: z.enum(VALID_SUBCATEGORIES).optional(),
  roles: z.array(z.string()).optional(),
  clusters: z.array(z.string()).optional(),
  causalLevel: z.string().optional(),
  hideSidebar: z.boolean().optional(),
  pageTemplate: z.string().optional(),
  createdAt: z.union([z.date(), z.string()]).optional(), // YAML parser returns dates as strings or Date objects
}).strict();

export const frontmatterSchemaRule = {
  id: 'frontmatter-schema',
  name: 'Frontmatter Schema',
  description: 'Validate MDX frontmatter against content collection schema',
  severity: Severity.ERROR,

  check(contentFile: ContentFile, engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];
    const frontmatter = contentFile.frontmatter;
    const rawContent = contentFile.raw;

    // Check for quoted lastUpdated dates in raw content
    const quotedLastUpdatedMatch = rawContent.match(/lastUpdated:\s*["'](\d{4}-\d{2}-\d{2})/);
    if (quotedLastUpdatedMatch) {
      issues.push(new Issue({
        rule: 'frontmatter-schema',
        file: contentFile.path,
        line: 1,
        message: `lastUpdated should be unquoted YAML date (lastUpdated: ${quotedLastUpdatedMatch[1]}, not lastUpdated: "${quotedLastUpdatedMatch[1]}")`,
        severity: Severity.ERROR,
      }));
    }

    // Cross-field: graded content formats (table, diagram) should have update tracking
    const gradedFormats = ['table', 'diagram'];
    if (gradedFormats.includes(frontmatter.contentFormat) && !frontmatter.update_frequency && frontmatter.evergreen !== false) {
      issues.push(new Issue({
        rule: 'frontmatter-schema',
        file: contentFile.path,
        line: 1,
        message: `Pages with contentFormat: "${frontmatter.contentFormat}" should have update_frequency set`,
        severity: Severity.WARNING,
      }));
    }

    // Cross-field: evergreen: false is incompatible with update_frequency
    if (frontmatter.evergreen === false && frontmatter.update_frequency) {
      issues.push(new Issue({
        rule: 'frontmatter-schema',
        file: contentFile.path,
        line: 1,
        message: `Pages with evergreen: false should not have update_frequency (non-evergreen pages are excluded from the update schedule)`,
        severity: Severity.ERROR,
      }));
    }

    // Deprecated fields — flag as errors to prevent regression
    if (frontmatter.importance !== undefined) {
      issues.push(new Issue({
        rule: 'frontmatter-schema',
        file: contentFile.path,
        line: 1,
        message: 'importance: is deprecated — use readerImportance: or researchImportance: instead',
        severity: Severity.ERROR,
      }));
    }
    if (frontmatter.todo !== undefined) {
      issues.push(new Issue({
        rule: 'frontmatter-schema',
        file: contentFile.path,
        line: 1,
        message: 'todo: is deprecated — use todos: (array) instead',
        severity: Severity.ERROR,
      }));
    }
    if (frontmatter.entityId !== undefined) {
      issues.push(new Issue({
        rule: 'frontmatter-schema',
        file: contentFile.path,
        line: 1,
        message: 'entityId: is deprecated — remove it; entity linking is handled via numericId: or filename-based ID',
        severity: Severity.ERROR,
      }));
    }

    // Validate against Zod schema
    const result = frontmatterSchema.safeParse(frontmatter);

    if (!result.success) {
      for (const error of result.error.errors) {
        const field = error.path.join('.');
        issues.push(new Issue({
          rule: 'frontmatter-schema',
          file: contentFile.path,
          line: 1,
          message: `${field}: ${error.message}${'received' in error && error.received !== undefined ? ` (got: ${error.received})` : ''}`,
          severity: Severity.ERROR,
        }));
      }
    }

    // Cross-field: subcategory must be appropriate for entityType (WARNING — judgment-based)
    if (frontmatter.subcategory && frontmatter.entityType) {
      const validForType = SUBCATEGORY_BY_ENTITY_TYPE[frontmatter.entityType];
      if (validForType && !validForType.includes(frontmatter.subcategory)) {
        issues.push(new Issue({
          rule: 'frontmatter-schema',
          file: contentFile.path,
          line: 1,
          message: `subcategory "${frontmatter.subcategory}" is not typical for entityType "${frontmatter.entityType}"`,
          severity: Severity.WARNING,
        }));
      }
    }

    // Cross-field: entityType in frontmatter is redundant when numericId is set
    // (YAML entity.type is canonical for entity pages; frontmatter entityType can drift)
    if (frontmatter.entityType !== undefined && frontmatter.numericId !== undefined) {
      issues.push(new Issue({
        rule: 'frontmatter-schema',
        file: contentFile.path,
        line: 1,
        message: 'entityType: is redundant when numericId: is set — remove it (entity type is sourced from YAML entity.type)',
        severity: Severity.ERROR,
      }));
    }

    return issues;
  },
};