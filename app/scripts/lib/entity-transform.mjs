/**
 * Entity Transformation (Build-Time)
 *
 * Transforms raw database entities into typed entities at build time.
 * Ported from src/data/index.ts to eliminate runtime transformation.
 *
 * Handles:
 * - Old type name mapping (lab-*, researcher → organization, person)
 * - Expert/organization data merging
 * - CustomField extraction into typed fields
 * - Risk category assignment
 * - Entity type overrides (path-based and explicit)
 */

import { OLD_TYPE_MAP, OLD_LAB_TYPE_TO_ORG_TYPE } from './entity-type-mappings.mjs';

// ============================================================================
// RISK CATEGORIES
// ============================================================================

const RISK_CATEGORIES = {
  epistemic: [
    'authentication-collapse',
    'automation-bias',
    'consensus-manufacturing',
    'epistemic-collapse',
    'epistemic-sycophancy',
    'trust-cascade',
    'trust-decline',
  ],
  misuse: [
    'authoritarian-tools',
    'autonomous-weapons',
    'bioweapons',
    'cyberweapons',
    'deepfakes',
    'disinformation',
    'fraud',
    'surveillance',
  ],
  structural: [
    'concentration-of-power',
    'economic-disruption',
    'enfeeblement',
    'lock-in',
    'racing-dynamics',
    'winner-take-all',
  ],
};

function getRiskCategory(riskId) {
  if (RISK_CATEGORIES.epistemic.includes(riskId)) return 'epistemic';
  if (RISK_CATEGORIES.misuse.includes(riskId)) return 'misuse';
  if (RISK_CATEGORIES.structural.includes(riskId)) return 'structural';
  return 'accident';
}

// ============================================================================
// ENTITY TYPE OVERRIDES
// ============================================================================

/**
 * Path patterns that should be treated as "project" type.
 */
const PROJECT_PATH_PATTERNS = [
  '/knowledge-base/responses/epistemic-tools/tools/',
];

/**
 * Explicit entity ID → type overrides.
 */
const ENTITY_TYPE_OVERRIDES = {
  // Add individual overrides here as needed
};

/**
 * Apply entity overrides to raw entities based on page paths and explicit mappings.
 */
function applyEntityOverrides(entities, pages) {
  entities = entities || [];
  pages = pages || [];

  // Build a set of page IDs that match project path patterns
  const projectPageIds = new Set();
  for (const page of pages) {
    if (PROJECT_PATH_PATTERNS.some(pattern => page.path?.includes(pattern))) {
      projectPageIds.add(page.id);
    }
  }

  // Apply overrides to entities
  const overridden = entities.map(entity => {
    if (ENTITY_TYPE_OVERRIDES[entity.id]) {
      return { ...entity, type: ENTITY_TYPE_OVERRIDES[entity.id] };
    }
    if (projectPageIds.has(entity.id)) {
      return { ...entity, type: 'project' };
    }
    return entity;
  });

  // Create entities for pages in project paths that don't have entities yet
  const entityIds = new Set(overridden.map(e => e.id));
  const newEntities = [];
  for (const page of pages) {
    if (projectPageIds.has(page.id) && !entityIds.has(page.id)) {
      newEntities.push({
        id: page.id,
        type: 'project',
        title: page.title,
        description: page.llmSummary || page.description || undefined,
        tags: page.tags || [],
        lastUpdated: page.lastUpdated || undefined,
      });
    }
  }

  return [...overridden, ...newEntities];
}

// ============================================================================
// ENTITY TRANSFORMATION
// ============================================================================

/**
 * Transform a raw entity into a typed entity.
 */
function transformEntity(raw, expertMap, orgMap) {
  const oldType = raw.type;
  const canonicalType = OLD_TYPE_MAP[oldType] || oldType;

  // Build base fields shared across all types
  const base = {
    id: raw.id,
    title: raw.title,
    description: raw.description,
    tags: raw.tags || [],
    clusters: raw.clusters || [],
    relatedEntries: raw.relatedEntries || [],
    sources: raw.sources || [],
    lastUpdated: raw.lastUpdated,
    website: raw.website,
    numericId: raw.numericId,
    path: raw.path,
    status: raw.status,
    customFields: raw.customFields || [],
    relatedTopics: raw.relatedTopics || [],
    summaryPage: raw.summaryPage,
  };

  // Helper to find a customField value
  const cf = (label) =>
    raw.customFields?.find(f => f.label === label)?.value;

  // Remove extracted customFields from the passthrough list
  const filterCustomFields = (...labels) => {
    const labelSet = new Set(labels);
    return (raw.customFields || []).filter(f => !labelSet.has(f.label));
  };

  switch (canonicalType) {
    case 'risk':
      return {
        ...base,
        entityType: 'risk',
        severity: raw.severity,
        likelihood: raw.likelihood,
        timeframe: raw.timeframe,
        maturity: raw.maturity,
        riskCategory: getRiskCategory(raw.id),
      };

    case 'person': {
      const expert = expertMap.get(raw.id);
      const org = expert?.affiliation ? orgMap.get(expert.affiliation) : null;
      const role = expert?.role || cf('Role');
      const knownForStr = cf('Known For');
      const knownFor = expert?.knownFor ||
        (knownForStr ? knownForStr.split(',').map(s => s.trim()).filter(Boolean) : []);
      const affiliation = org?.name || expert?.affiliation || cf('Affiliation');

      return {
        ...base,
        entityType: 'person',
        title: expert?.name || raw.title,
        website: expert?.website || raw.website,
        role,
        affiliation,
        knownFor,
        customFields: filterCustomFields('Role', 'Known For', 'Affiliation'),
      };
    }

    case 'organization': {
      const orgType = OLD_LAB_TYPE_TO_ORG_TYPE[oldType] || undefined;
      const orgData = orgMap.get(raw.id);
      return {
        ...base,
        entityType: 'organization',
        orgType: orgType || orgData?.type || undefined,
        founded: orgData?.founded || cf('Founded') || cf('Established'),
        headquarters: orgData?.headquarters || cf('Location') || cf('Headquarters'),
        employees: orgData?.employees || cf('Employees'),
        funding: orgData?.funding || cf('Funding'),
        website: orgData?.website || raw.website,
        title: orgData?.name || raw.title,
        customFields: filterCustomFields('Founded', 'Established', 'Location', 'Headquarters', 'Employees', 'Funding'),
      };
    }

    case 'policy':
      return {
        ...base,
        entityType: 'policy',
        introduced: cf('Introduced') || cf('Established'),
        policyStatus: cf('Status'),
        author: cf('Author'),
        scope: cf('Scope'),
        customFields: filterCustomFields('Introduced', 'Established', 'Status', 'Author', 'Scope'),
      };

    case 'safety-agenda':
      return { ...base, entityType: 'safety-agenda', goal: cf('Goal') };

    case 'approach':
    case 'concept':
    case 'crux':
    case 'model':
    case 'capability':
    case 'project':
    case 'analysis':
    case 'historical':
    case 'argument':
    case 'scenario':
    case 'case-study':
    case 'funder':
    case 'resource':
    case 'parameter':
    case 'metric':
    case 'risk-factor':
      return { ...base, entityType: canonicalType };

    default: {
      // Unknown types (ai-transition-model-* etc.) — preserve all raw fields
      // so entities keep content, currentAssessment, ratings, causeEffectGraph, etc.
      const { type: _type, ...rawRest } = raw;
      return { ...rawRest, ...base, entityType: canonicalType };
    }
  }
}

// ============================================================================
// ORCHESTRATOR
// ============================================================================

/**
 * Transform all raw entities into typed entities.
 *
 * @param {Array} rawEntities - Raw entities from database.json
 * @param {Array} pages - Pages registry (for type overrides)
 * @param {Array} experts - Expert records
 * @param {Array} organizations - Organization records
 * @returns {Array} Typed entities ready for database.json
 */
export function transformEntities(rawEntities, pages, experts, organizations) {
  // Apply overrides first
  const entities = applyEntityOverrides(rawEntities, pages);

  // Build lookup maps
  const expertMap = new Map(experts.map(e => [e.id, e]));
  const orgMap = new Map(organizations.map(o => [o.id, o]));

  // Transform each entity
  const typedEntities = [];
  for (const raw of entities) {
    const typed = transformEntity(raw, expertMap, orgMap);
    if (typed) {
      typedEntities.push(typed);
    }
  }

  return typedEntities;
}
