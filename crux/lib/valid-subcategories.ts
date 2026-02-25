/**
 * Canonical list of valid subcategory values for MDX frontmatter.
 *
 * When adding a new subcategory, add it here first — that makes it a deliberate,
 * reviewable choice visible in the PR diff rather than a silent typo.
 */
export const VALID_SUBCATEGORIES = [
  // organizations
  'funders',
  'safety-orgs',
  'epistemic-orgs',
  'biosecurity-orgs',
  'labs',
  'community-building',
  'government',
  'finance',
  'venture-capital',
  'industry',

  // people
  'safety-researchers',
  'forecasters',
  'lab-leadership',
  'ea-figures',
  'track-records',
  'policy-figures',

  // risks
  'accident',
  'epistemic',
  'structural',
  'misuse',

  // responses
  'epistemic-platforms',
  'alignment-evaluation',
  'epistemic-approaches',
  'legislation',
  'alignment-theoretical',
  'alignment-training',
  'governance',
  'alignment-deployment',
  'field-building',
  'compute-governance',
  'alignment-interpretability',
  'alignment',
  'international',
  'organizational-practices',
  'alignment-policy',
  'resilience',
  'institutions',
  'biosecurity',

  // intelligence-paradigms
  'architectures',
  'bio-hardware',
  'scaffolding',
  'other',

  // debates
  'formal-arguments',
  'policy-debates',

  // models
  'domain-models',
  'analysis-models',
  'risk-models',
  'governance-models',
  'societal-models',
  'timeline-models',
  'safety-models',
  'intervention-models',
  'dynamics-models',
  'threshold-models',
  'impact-models',
  'framework-models',
  'economic-models',
  'cascade-models',
  'race-models',

  // other sections
  'core',
  'safety-relevant',
  'agentic',
  'ea-history',
  'ai-history',
  'applications',
] as const;

export type ValidSubcategory = typeof VALID_SUBCATEGORIES[number];
