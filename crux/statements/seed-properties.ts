/**
 * Seed missing property definitions for coverage target categories.
 *
 * The coverage targets (coverage-targets.ts) define categories like
 * governance, technical, research, products, people — but the database
 * may not have properties for all of them. This script ensures each
 * target category has a reasonable set of properties.
 *
 * Usage:
 *   pnpm crux statements seed-properties
 *   pnpm crux statements seed-properties --dry-run
 */

import { getProperties, upsertProperties, type UpsertPropertyInput } from '../lib/wiki-server/statements.ts';

// ---------------------------------------------------------------------------
// Property definitions by category
// ---------------------------------------------------------------------------

const PROPERTY_SEEDS: UpsertPropertyInput[] = [
  // ---- governance ----
  {
    id: 'board-structure',
    label: 'Board Structure',
    category: 'governance',
    description: 'Composition and structure of the board of directors',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'governance-policy',
    label: 'Governance Policy',
    category: 'governance',
    description: 'Key governance policies, charters, or commitments',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'corporate-structure',
    label: 'Corporate Structure',
    category: 'governance',
    description: 'Legal entity type, benefit corp status, ownership structure',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'leadership-decision',
    label: 'Leadership Decision',
    category: 'governance',
    description: 'Significant decisions by leadership affecting company direction',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'transparency-practice',
    label: 'Transparency Practice',
    category: 'governance',
    description: 'Public reporting, disclosure, or transparency commitments',
    entityTypes: ['organization'],
    valueType: 'string',
  },

  // ---- technical ----
  {
    id: 'model-architecture',
    label: 'Model Architecture',
    category: 'technical',
    description: 'Technical architecture, parameters, or design of AI models',
    entityTypes: ['organization', 'model'],
    valueType: 'string',
  },
  {
    id: 'training-infrastructure',
    label: 'Training Infrastructure',
    category: 'technical',
    description: 'Compute infrastructure, GPU clusters, training setup',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'benchmark-score',
    label: 'Benchmark Score',
    category: 'technical',
    description: 'Performance on standardized benchmarks',
    entityTypes: ['organization', 'model'],
    valueType: 'number',
  },
  {
    id: 'context-window',
    label: 'Context Window',
    category: 'technical',
    description: 'Maximum context length in tokens',
    entityTypes: ['model'],
    valueType: 'number',
    defaultUnit: 'tokens',
  },
  {
    id: 'technical-capability',
    label: 'Technical Capability',
    category: 'technical',
    description: 'Specific technical capabilities or features',
    entityTypes: ['organization', 'model'],
    valueType: 'string',
  },
  {
    id: 'compute-capacity',
    label: 'Compute Capacity',
    category: 'technical',
    description: 'Total compute resources available (GPUs, TPUs, etc.)',
    entityTypes: ['organization'],
    valueType: 'string',
  },

  // ---- research ----
  {
    id: 'research-publication',
    label: 'Research Publication',
    category: 'research',
    description: 'Significant research papers, preprints, or technical reports',
    entityTypes: ['organization', 'person'],
    valueType: 'string',
  },
  {
    id: 'research-area',
    label: 'Research Area',
    category: 'research',
    description: 'Active research domains or focus areas',
    entityTypes: ['organization', 'person'],
    valueType: 'string',
  },
  {
    id: 'research-team-size',
    label: 'Research Team Size',
    category: 'research',
    description: 'Number of researchers or research staff',
    entityTypes: ['organization'],
    valueType: 'number',
    defaultUnit: 'count',
  },
  {
    id: 'research-contribution',
    label: 'Research Contribution',
    category: 'research',
    description: 'Notable contributions to the field, techniques, or frameworks',
    entityTypes: ['organization', 'person'],
    valueType: 'string',
  },
  {
    id: 'research-collaboration',
    label: 'Research Collaboration',
    category: 'research',
    description: 'Collaborative research projects or partnerships',
    entityTypes: ['organization'],
    valueType: 'string',
  },

  // ---- products ----
  {
    id: 'product-name',
    label: 'Product',
    category: 'products',
    description: 'Products, services, or platforms offered',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'product-launch',
    label: 'Product Launch',
    category: 'products',
    description: 'Product launches, releases, or significant updates',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'api-offering',
    label: 'API Offering',
    category: 'products',
    description: 'API products, developer tools, or platform services',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'product-pricing',
    label: 'Product Pricing',
    category: 'products',
    description: 'Pricing models, tiers, or cost structure',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'product-adoption',
    label: 'Product Adoption',
    category: 'products',
    description: 'Usage statistics, customer adoption, or market traction',
    entityTypes: ['organization'],
    valueType: 'string',
  },

  // ---- people ----
  {
    id: 'key-person',
    label: 'Key Person',
    category: 'people',
    description: 'Important individuals in leadership, research, or engineering',
    entityTypes: ['organization'],
    valueType: 'entity',
  },
  {
    id: 'team-composition',
    label: 'Team Composition',
    category: 'people',
    description: 'Team size, structure, or notable composition facts',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'hiring-practice',
    label: 'Hiring Practice',
    category: 'people',
    description: 'Hiring practices, growth, or notable talent movements',
    entityTypes: ['organization'],
    valueType: 'string',
  },
  {
    id: 'role',
    label: 'Role',
    category: 'people',
    description: 'Role or position held at an organization',
    entityTypes: ['person'],
    valueType: 'string',
  },
  {
    id: 'affiliation',
    label: 'Affiliation',
    category: 'people',
    description: 'Organizational affiliations or memberships',
    entityTypes: ['person'],
    valueType: 'entity',
  },

  // ---- financial (supplements) ----
  {
    id: 'executive-compensation',
    label: 'Executive Compensation',
    category: 'financial',
    description: 'Compensation figures for executives and key personnel',
    entityTypes: ['organization'],
    valueType: 'number',
    defaultUnit: 'USD',
  },
  {
    id: 'operating-expenses',
    label: 'Operating Expenses',
    category: 'financial',
    description: 'Total or itemized operating expenses',
    entityTypes: ['organization'],
    valueType: 'number',
    defaultUnit: 'USD',
  },
  {
    id: 'net-income',
    label: 'Net Income / Loss',
    category: 'financial',
    description: 'Net income or net loss for a period',
    entityTypes: ['organization'],
    valueType: 'number',
    defaultUnit: 'USD',
  },
  {
    id: 'net-assets',
    label: 'Net Assets',
    category: 'financial',
    description: 'Total net assets or equity',
    entityTypes: ['organization'],
    valueType: 'number',
    defaultUnit: 'USD',
  },

  // ---- safety (supplements) ----
  {
    id: 'risk-assessment',
    label: 'Risk Assessment',
    category: 'safety',
    description: 'Assessed risk level or risk category for an entity or activity',
    entityTypes: ['organization'],
    valueType: 'string',
  },

  // ---- milestone (supplements) ----
  {
    id: 'award',
    label: 'Award / Recognition',
    category: 'milestone',
    description: 'Awards, prizes, or notable recognition received',
    entityTypes: ['organization', 'person'],
    valueType: 'string',
  },
];

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');

  // Check what properties already exist
  const existing = await getProperties();
  if (!existing.ok) {
    console.error(`Failed to fetch existing properties: ${existing.message}`);
    process.exit(1);
  }

  const existingIds = new Set(existing.data.properties.map((p) => p.id));
  const newProps = PROPERTY_SEEDS.filter((p) => !existingIds.has(p.id));
  const updateProps = PROPERTY_SEEDS.filter((p) => existingIds.has(p.id));

  console.log(`Existing properties: ${existingIds.size}`);
  console.log(`New properties to create: ${newProps.length}`);
  console.log(`Existing properties to update: ${updateProps.length}`);

  if (newProps.length > 0) {
    console.log('\nNew properties:');
    for (const p of newProps) {
      console.log(`  + ${p.id} (${p.category}): ${p.label}`);
    }
  }

  if (dryRun) {
    console.log('\n(dry run — no changes made)');
    return;
  }

  if (PROPERTY_SEEDS.length === 0) {
    console.log('\nNo properties to upsert.');
    return;
  }

  const result = await upsertProperties(PROPERTY_SEEDS);
  if (!result.ok) {
    console.error(`Failed to upsert properties: ${result.message}`);
    process.exit(1);
  }

  console.log(`\nDone: ${result.data.created} created, ${result.data.updated} updated`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
