/**
 * Data Schema for LongtermWiki
 *
 * This file defines TypeScript types and Zod schemas for all structured data.
 * Data lives in YAML files in data/ and is validated at build time.
 */

import { z } from 'zod';

// =============================================================================
// CORE ENUMS
// =============================================================================

export const Confidence = z.enum(['low', 'medium', 'high']);
export type Confidence = z.infer<typeof Confidence>;

export const Importance = z.enum(['low', 'medium', 'high', 'critical']);
export type Importance = z.infer<typeof Importance>;

export const OrgType = z.enum([
  'frontier-lab',      // OpenAI, Anthropic, DeepMind
  'safety-org',        // MIRI, ARC, Redwood
  'academic',          // FHI, CHAI, CAIS
  'government',        // UK AISI, US AISI
  'funder',            // Open Phil, SFF
  'policy',            // GovAI, CSET
]);
export type OrgType = z.infer<typeof OrgType>;

export const RiskCategory = z.enum([
  'accident',          // Misalignment, mesa-optimization
  'misuse',            // Bioweapons, cyberweapons
  'structural',        // Racing dynamics, lock-in
  'epistemic',         // Trust erosion, sycophancy at scale
]);
export type RiskCategory = z.infer<typeof RiskCategory>;

// =============================================================================
// EXPERTS (People)
// =============================================================================

export const ExpertPosition = z.object({
  topic: z.string(),                    // e.g., "p-doom", "alignment-difficulty", "timelines"
  view: z.string(),                     // Their position in words
  estimate: z.string().optional(),      // Quantified if available (e.g., "10-20%", "2030s")
  confidence: Confidence.optional(),
  date: z.string().optional(),          // When they stated this
  source: z.string().optional(),        // Title of source
  sourceUrl: z.string().url().optional(),
  notes: z.string().optional(),
});
export type ExpertPosition = z.infer<typeof ExpertPosition>;

export const Expert = z.object({
  id: z.string(),                       // e.g., "paul-christiano"
  name: z.string(),
  affiliation: z.string().optional(),   // Org ID reference
  role: z.string().optional(),
  website: z.string().url().optional(),
  twitter: z.string().optional(),
  knownFor: z.array(z.string()).optional(),
  background: z.string().optional(),    // Brief bio
  positions: z.array(ExpertPosition).optional(),
});
export type Expert = z.infer<typeof Expert>;

// =============================================================================
// ORGANIZATIONS
// =============================================================================

export const Organization = z.object({
  id: z.string(),                       // e.g., "anthropic"
  name: z.string(),
  type: OrgType,
  founded: z.string().optional(),       // Year
  headquarters: z.string().optional(),
  website: z.string().url().optional(),
  description: z.string().optional(),
  keyPeople: z.array(z.string()).optional(),  // Expert ID references
  funding: z.string().optional(),       // e.g., "$7B+"
  employees: z.string().optional(),     // e.g., "~1000"
  safetyFocus: z.string().optional(),   // Brief description of safety work
  parentOrg: z.string().optional(),     // Org ID for subsidiaries
});
export type Organization = z.infer<typeof Organization>;

// =============================================================================
// ESTIMATES
// =============================================================================

export const EstimateSource = z.object({
  source: z.string(),                   // Who made the estimate (expert ID or org name)
  value: z.string(),                    // The estimate value
  date: z.string().optional(),
  url: z.string().url().optional(),
  notes: z.string().optional(),
  confidence: Confidence.optional(),
});
export type EstimateSource = z.infer<typeof EstimateSource>;

export const Estimate = z.object({
  id: z.string(),                       // e.g., "p-tai-2030"
  variable: z.string(),                 // What's being estimated
  description: z.string().optional(),
  unit: z.string().optional(),          // e.g., "%", "years"
  aggregateRange: z.string().optional(), // Summary range
  category: z.string().optional(),      // e.g., "timelines", "risk", "alignment"
  estimates: z.array(EstimateSource),
  lastUpdated: z.string().optional(),
});
export type Estimate = z.infer<typeof Estimate>;

// =============================================================================
// CRUXES (Key Uncertainties)
// =============================================================================

export const CruxPosition = z.object({
  view: z.string(),
  probability: z.string().optional(),   // e.g., "40-60%"
  holders: z.array(z.string()).optional(), // Expert IDs or org names
  implications: z.string().optional(),
});
export type CruxPosition = z.infer<typeof CruxPosition>;

export const Crux = z.object({
  id: z.string(),                       // e.g., "alignment-difficulty"
  question: z.string(),
  domain: z.string().optional(),        // e.g., "Technical", "Governance"
  description: z.string().optional(),
  importance: Importance,
  resolvability: z.enum(['soon', 'years', 'decades', 'never']).optional(),
  currentState: z.string().optional(),
  positions: z.array(CruxPosition),
  wouldUpdateOn: z.array(z.string()).optional(),
  relatedCruxes: z.array(z.string()).optional(),  // Crux ID references
  relevantResearch: z.array(z.object({
    title: z.string(),
    url: z.string().url().optional(),
  })).optional(),
});
export type Crux = z.infer<typeof Crux>;

// =============================================================================
// RISKS (Failure Modes)
// =============================================================================

export const Risk = z.object({
  id: z.string(),                       // e.g., "deceptive-alignment"
  name: z.string(),
  category: RiskCategory,
  description: z.string().optional(),
  severity: Importance.optional(),
  likelihood: z.string().optional(),    // e.g., "medium", "high if no intervention"
  mechanisms: z.array(z.string()).optional(),
  prerequisites: z.array(z.string()).optional(),  // Risk IDs that must occur first
  mitigatedBy: z.array(z.string()).optional(),    // Intervention IDs
  relatedRisks: z.array(z.string()).optional(),
  keyPapers: z.array(z.string()).optional(),      // Source IDs
});
export type Risk = z.infer<typeof Risk>;

// =============================================================================
// INTERVENTIONS (Responses)
// =============================================================================

export const Intervention = z.object({
  id: z.string(),                       // e.g., "interpretability-research"
  name: z.string(),
  category: z.enum(['technical', 'governance', 'institutional', 'field-building', 'resilience']),
  subcategory: z.string().optional(),
  description: z.string().optional(),
  addressesRisks: z.array(z.string()).optional(),  // Risk IDs
  organizations: z.array(z.string()).optional(),   // Org IDs working on this
  tractability: Importance.optional(),
  neglectedness: Importance.optional(),
  importance: Importance.optional(),
  timeHorizon: z.string().optional(),   // e.g., "1-3 years", "5+ years"
});
export type Intervention = z.infer<typeof Intervention>;

// =============================================================================
// GLOSSARY
// =============================================================================

export const GlossaryTerm = z.object({
  id: z.string(),                       // e.g., "agi"
  term: z.string(),                     // Display name
  aliases: z.array(z.string()).optional(),
  definition: z.string(),
  related: z.array(z.string()).optional(),  // Other term IDs
  seeAlso: z.array(z.string()).optional(),  // Page slugs
});
export type GlossaryTerm = z.infer<typeof GlossaryTerm>;

// =============================================================================
// TIMELINE EVENTS
// =============================================================================

export const TimelineEvent = z.object({
  id: z.string(),
  date: z.string(),                     // ISO date or "YYYY" or "YYYY-MM"
  title: z.string(),
  description: z.string().optional(),
  category: z.enum([
    'capability',       // Model releases, benchmarks
    'safety',           // Safety research milestones
    'governance',       // Policy, regulation
    'incident',         // Near-misses, problems
    'organization',     // Org founded, key hires
  ]),
  importance: Importance.optional(),
  actors: z.array(z.string()).optional(),  // Expert or org IDs
  url: z.string().url().optional(),
});
export type TimelineEvent = z.infer<typeof TimelineEvent>;

// =============================================================================
// SOURCES (Publications, Papers)
// =============================================================================

export const Source = z.object({
  id: z.string(),                       // e.g., "superintelligence-2014"
  title: z.string(),
  authors: z.array(z.string()).optional(),  // Expert IDs or names
  year: z.string().optional(),
  type: z.enum(['book', 'paper', 'blog', 'report', 'talk', 'podcast']).optional(),
  url: z.string().url().optional(),
  abstract: z.string().optional(),
  significance: z.string().optional(),
});
export type Source = z.infer<typeof Source>;

// =============================================================================
// GRAPH RELATIONSHIPS (for RiskDependencyGraph)
// =============================================================================

export const GraphNode = z.object({
  id: z.string(),
  label: z.string(),
  category: z.enum(['crux', 'risk', 'outcome', 'capability', 'intervention']),
  description: z.string().optional(),
  entityRef: z.string().optional(),     // ID of the underlying entity
});
export type GraphNode = z.infer<typeof GraphNode>;

export const GraphEdge = z.object({
  from: z.string(),                     // Node ID
  to: z.string(),                       // Node ID
  type: z.enum(['causes', 'mitigates', 'requires', 'enables', 'blocks']),
  label: z.string().optional(),
  strength: Importance.optional(),
});
export type GraphEdge = z.infer<typeof GraphEdge>;

export const Graph = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  nodes: z.array(GraphNode),
  edges: z.array(GraphEdge),
});
export type Graph = z.infer<typeof Graph>;

// =============================================================================
// CAUSE-EFFECT GRAPHS (For factor/parameter analysis)
// =============================================================================

/**
 * A node in a cause-effect graph, representing a factor that influences
 * or is influenced by other factors.
 */
/**
 * Scoring dimensions for cause-effect graph nodes (all 1-10 scale)
 */
export const NodeScores = z.object({
  novelty: z.number().min(1).max(10).optional(),        // How novel/interesting to a recent reader (1=common knowledge, 10=very surprising)
  sensitivity: z.number().min(1).max(10).optional(),    // How much downstream nodes change if this changes (1=minimal impact, 10=huge cascading effects)
  changeability: z.number().min(1).max(10).optional(),  // How tractable/changeable is this factor (1=fixed, 10=highly malleable)
  certainty: z.number().min(1).max(10).optional(),      // How well understood/certain are we (1=highly uncertain, 10=well established)
});
export type NodeScores = z.infer<typeof NodeScores>;

export const CauseEffectNode = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  type: z.enum(['leaf', 'cause', 'intermediate', 'effect']),  // 'leaf' for upstream drivers
  confidence: z.number().min(0).max(1).optional(),  // 0-1 confidence in this factor
  details: z.string().optional(),                    // Extended explanation
  sources: z.array(z.string()).optional(),           // Source references
  relatedConcepts: z.array(z.string()).optional(),   // Related concept tags
  entityRef: z.string().optional(),                  // Link to entity ID
  scores: NodeScores.optional(),                     // Scoring dimensions for node
  color: z.string().optional(),                      // Tailwind color name (e.g., "rose", "violet", "teal")
});
export type CauseEffectNode = z.infer<typeof CauseEffectNode>;

/**
 * An edge in a cause-effect graph, representing a causal relationship.
 */
export const CauseEffectEdge = z.object({
  id: z.string().optional(),
  source: z.string(),                                // Source node ID
  target: z.string(),                                // Target node ID
  strength: z.enum(['weak', 'medium', 'strong']).optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  effect: z.enum(['increases', 'decreases', 'mixed']).optional(),
  label: z.string().optional(),                      // Optional edge label
});
export type CauseEffectEdge = z.infer<typeof CauseEffectEdge>;

/**
 * A complete cause-effect graph that can be embedded in entities.
 * Used for visualizing causal relationships around a factor/parameter.
 */
export const CauseEffectGraph = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  primaryNodeId: z.string().optional(),           // ID of the node representing this entity (highlighted)
  nodes: z.array(CauseEffectNode),
  edges: z.array(CauseEffectEdge),
});
export type CauseEffectGraph = z.infer<typeof CauseEffectGraph>;

// =============================================================================
// CONTENT SECTIONS (Rich content stored in YAML for entity pages)
// =============================================================================

/**
 * A table that can be rendered in content sections.
 * Headers and rows are simple string arrays for flexibility.
 */
export const ContentTable = z.object({
  headers: z.array(z.string()),
  rows: z.array(z.array(z.string())),
  caption: z.string().optional(),
});
export type ContentTable = z.infer<typeof ContentTable>;

/**
 * A section of content that can include prose, diagrams, and tables.
 * Used to store page content in YAML for portability.
 */
export const ContentSection = z.object({
  heading: z.string(),                            // Section heading (e.g., "## How This Happens")
  body: z.string().optional(),                    // Markdown prose content
  mermaid: z.string().optional(),                 // Mermaid diagram source
  table: ContentTable.optional(),                 // Structured table data
  component: z.string().optional(),               // Custom component to render (e.g., "PageCauseEffectGraph")
  componentProps: z.record(z.unknown()).optional(), // Props for custom component
});
export type ContentSection = z.infer<typeof ContentSection>;

/**
 * Rich content structure for entity pages.
 * Stores all prose content in YAML for framework portability.
 */
export const EntityContent = z.object({
  intro: z.string().optional(),                   // Opening paragraph(s) before any sections
  sections: z.array(ContentSection).optional(),   // Main content sections
  footer: z.string().optional(),                  // Closing content after sections
});
export type EntityContent = z.infer<typeof EntityContent>;

// =============================================================================
// ENTITIES (Generic knowledge base entries with InfoBox data)
// =============================================================================

// NOTE: This file is copied verbatim to app/src/data/schema.ts during build,
// so it cannot use relative imports to files outside data/.
// The canonical list of entity type names lives in app/src/data/entity-type-names.ts.
// If you add a type here, also add it there (and vice versa).
// The validate-entities test checks for drift.
export const EntityType = z.enum([
  // --- Canonical types ---
  'risk',
  'risk-factor',
  'capability',
  'safety-agenda',
  'approach',
  'project',
  'policy',
  'organization',
  'crux',
  'concept',
  'case-study',
  'person',
  'scenario',
  'resource',
  'funder',
  'historical',
  'analysis',
  'model',
  'parameter',
  'metric',
  'argument',
  'table',
  'diagram',
  'insight',
  'event',
  'debate',
  'intelligence-paradigm',
  // AI Transition Model specific types
  'ai-transition-model-parameter',
  'ai-transition-model-metric',
  'ai-transition-model-scenario',
  'ai-transition-model-factor',
  'ai-transition-model-subitem',
  // --- Aliases (legacy/plural forms kept for backward compat) ---
  'researcher',        // → person
  'lab',               // → organization
  'lab-frontier',      // → organization
  'lab-research',      // → organization
  'lab-startup',       // → organization
  'lab-academic',      // → organization
  'safety-approaches', // → safety-agenda
  'policies',          // → policy
  'concepts',          // → concept
  'events',            // → event
  'models',            // → model
]);
export type EntityType = z.infer<typeof EntityType>;

export const RelationshipType = z.enum([
  'related',      // Generic relationship
  'causes',       // A causes B
  'cause',        // Alias for causes
  'mitigates',    // A reduces/prevents B
  'mitigated-by', // Inverse: A is mitigated by B
  'mitigation',   // A is a mitigation for B
  'requires',     // A needs B to work
  'enables',      // A makes B possible
  'blocks',       // A prevents B
  'supersedes',   // A replaces B (for deprecated entries)
  // Parameter-specific relationships
  'increases',    // Intervention increases parameter
  'decreases',    // Risk decreases parameter
  'supports',     // Intervention supports/stabilizes parameter
  'measures',     // Metric measures parameter
  'measured-by',  // Inverse of measures
  'analyzed-by',  // Entity is analyzed by a model/analysis
  'analyzes',     // Entity analyzes another
  // Structural relationships
  'child-of',     // A is a child/sub-item of B
  'composed-of',  // A is composed of B
  'component',    // A is a component of B
  // Causal/influence relationships
  'addresses',    // A addresses/deals with B
  'affects',      // A affects B
  'amplifies',    // A amplifies B
  'contributes-to', // A contributes to B
  'driven-by',    // A is driven by B
  'driver',       // A is a driver of B
  'drives',       // A drives B
  'leads-to',     // A leads to B
  'shaped-by',    // A is shaped by B
  // Classification relationships
  'consequence',  // A is a consequence of B
  'example',      // A is an example of B
  'key-factor',   // A is a key factor in B
  'manifestation', // A is a manifestation of B
  'mechanism',    // A is a mechanism for B
  'outcome',      // A is an outcome of B
  'prerequisite', // A is a prerequisite for B
  'research',     // A is research related to B
  'scenario',     // A is a scenario type
  'sub-scenario', // A is a sub-scenario of B
  'vulnerable-technique', // A is vulnerable to technique B
  'models',       // A models B
]);
export type RelationshipType = z.infer<typeof RelationshipType>;

export const RelatedEntry = z.object({
  id: z.string(),
  type: EntityType,
  relationship: RelationshipType.optional(),
  strength: z.enum(['weak', 'moderate', 'strong']).optional(),
});
export type RelatedEntry = z.infer<typeof RelatedEntry>;

export const CustomField = z.object({
  label: z.string(),
  value: z.string(),
});
export type CustomField = z.infer<typeof CustomField>;

export const EntitySource = z.object({
  title: z.string(),
  url: z.string().url().optional(),
  author: z.string().optional(),
  date: z.string().optional(),
});
export type EntitySource = z.infer<typeof EntitySource>;

// =============================================================================
// PARAMETER DISTINCTIONS (Clarifying related parameters)
// =============================================================================

export const ParameterDistinction = z.object({
  id: z.string(),                                // Target parameter ID
  theirFocus: z.string(),                        // Short phrase: what they measure
  relationship: z.string(),                      // How they relate to this parameter
});
export type ParameterDistinction = z.infer<typeof ParameterDistinction>;

export const ParameterDistinctions = z.object({
  focus: z.string(),                             // Short phrase: what this parameter measures
  summary: z.string().optional(),                // One sentence summary
  distinctFrom: z.array(ParameterDistinction),   // Related but distinct parameters
});
export type ParameterDistinctions = z.infer<typeof ParameterDistinctions>;

// =============================================================================
// PUBLICATIONS (Venues/Publishers)
// =============================================================================

export const PublicationType = z.enum([
  'academic_journal',   // Nature, Science, peer-reviewed journals
  'preprint_server',    // arXiv, bioRxiv, SSRN
  'think_tank',         // RAND, Brookings, CSET
  'company_blog',       // Anthropic, OpenAI technical blogs
  'government',         // NIST, UK Gov, EU, international orgs
  'encyclopedia',       // Wikipedia
  'blog_platform',      // LessWrong, Alignment Forum, EA Forum
  'news',               // MIT Tech Review, media outlets
  'organization',       // Nonprofits, advocacy groups
  'academic',           // University research centers
  'consulting',         // McKinsey, BCG, Edelman
  'academic_search',    // Google Scholar, Semantic Scholar
  'code_repository',    // GitHub
  'marketplace',        // Amazon (for book links)
]);
export type PublicationType = z.infer<typeof PublicationType>;

export const Publication = z.object({
  id: z.string(),                               // e.g., "nature", "arxiv"
  domains: z.array(z.string()),                 // Domains that map to this publication
  name: z.string(),                             // Display name
  type: PublicationType,
  credibility: z.number().min(1).max(5),        // 1-5, 5 = gold standard
  peer_reviewed: z.boolean().optional(),
  description: z.string().optional(),
});
export type Publication = z.infer<typeof Publication>;

// =============================================================================
// RESOURCES (External References with Summaries)
// =============================================================================

export const ResourceType = z.enum([
  'paper',      // Academic papers, arxiv, etc.
  'blog',       // Blog posts, LessWrong, etc.
  'report',     // Technical reports, PDFs
  'book',       // Books
  'talk',       // Presentations, videos
  'podcast',    // Podcast episodes
  'government', // Government documents
  'reference',  // Wikipedia, documentation
  'web',        // Generic web pages
]);
export type ResourceType = z.infer<typeof ResourceType>;

export const Resource = z.object({
  id: z.string(),                               // Human-readable slug or hash
  url: z.string().url(),
  title: z.string(),
  authors: z.array(z.string()).optional(),
  published_date: z.string().optional(),        // "2024" or "2024-03-15"
  type: ResourceType,
  local_filename: z.string().optional(),        // Path relative to .cache/sources/
  importance: z.number().min(0).max(100).optional(), // 0-100, determines review depth
  // Original content
  abstract: z.string().optional(),              // Original abstract from source
  // AI-generated fields
  summary: z.string().optional(),               // Short 1-2 sentence summary
  review: z.string().optional(),                // Longer 1-4 paragraph review
  key_points: z.array(z.string()).optional(),
  // Metadata
  cited_by: z.array(z.string()).nullable().optional(), // Entity IDs that cite this
  fetched_at: z.string().optional(),
  // Publication & credibility
  publication_id: z.string().optional(),        // Reference to publications.yaml
  tags: z.array(z.string()).optional(),         // Topic tags (alignment, governance, etc.)
  credibility_override: z.number().min(1).max(5).optional(), // Override publication default
});
export type Resource = z.infer<typeof Resource>;

export const EntityStatus = z.enum(['stub', 'draft', 'published', 'verified']);
export type EntityStatus = z.infer<typeof EntityStatus>;

// Structured likelihood for risks
export const LikelihoodLevel = z.enum(['low', 'medium', 'medium-high', 'high', 'very-high', 'near-certain']);
export type LikelihoodLevel = z.infer<typeof LikelihoodLevel>;

export const LikelihoodStatus = z.enum(['theoretical', 'emerging', 'occurring', 'established']);
export type LikelihoodStatus = z.infer<typeof LikelihoodStatus>;

export const StructuredLikelihood = z.object({
  level: LikelihoodLevel,
  status: LikelihoodStatus.optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  notes: z.string().optional(),
});
export type StructuredLikelihood = z.infer<typeof StructuredLikelihood>;

// Structured timeframe for risks
export const StructuredTimeframe = z.object({
  median: z.number(),                           // Year number (e.g., 2030)
  earliest: z.number().optional(),
  latest: z.number().optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  notes: z.string().optional(),
});
export type StructuredTimeframe = z.infer<typeof StructuredTimeframe>;

// Maturity of research on a topic
export const ResearchMaturity = z.enum(['Neglected', 'Emerging', 'Growing', 'Mature']);
export type ResearchMaturity = z.infer<typeof ResearchMaturity>;

// =============================================================================
// CONTENT FRESHNESS TRACKING
// =============================================================================

/**
 * Freshness tracking for content pages.
 * These fields appear in MDX frontmatter to track content staleness.
 *
 * Usage in frontmatter:
 * ---
 * reviewBy: "2026-06-26"          # When content should be reviewed
 * contentDependencies:             # Entity IDs that affect this content
 *   - deceptive-alignment
 *   - mesa-optimization
 * lastReviewed: "2025-12-26"       # When last reviewed (optional)
 * reviewedBy: "ozzie"              # Who reviewed it (optional)
 * stalenessRisk: "low"             # How quickly this content might become stale
 * ---
 */
export const FreshnessConfig = z.object({
  reviewBy: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(),
  contentDependencies: z.array(z.string()).optional(),
  lastReviewed: z.string().regex(/^\d{4}-\d{2}(-\d{2})?$/).optional(),
  reviewedBy: z.string().optional(),
  stalenessRisk: z.enum(['low', 'medium', 'high']).optional(),
});
export type FreshnessConfig = z.infer<typeof FreshnessConfig>;

export const Entity = z.object({
  id: z.string(),
  type: EntityType,
  title: z.string(),
  // Core content fields
  description: z.string().optional(),           // 1-3 sentence summary
  aliases: z.array(z.string()).optional(),      // Alternative names for search
  content: EntityContent.optional(),            // Rich content sections (YAML-first architecture)
  // Metadata
  status: EntityStatus.optional(),              // Content maturity level
  lastUpdated: z.string().optional(),           // ISO date "2024-12"
  tags: z.array(z.string()).optional(),         // Standardized tags for filtering
  // Topic clusters for explore page filtering (can have multiple)
  clusters: z.array(z.enum([
    'ai-safety',    // Relevant for AI safety/alignment (default)
    'biorisks',     // Relevant for biosecurity, pandemics, bioweapons
    'cyber',        // Relevant for cybersecurity, hacking, digital threats
    'epistemics',   // Relevant for forecasting, truth, deception, worldviews
    'governance',   // Relevant for policy, regulation, international coordination
    'community',    // Relevant for field-building, funding, careers, orgs
  ])).optional(),
  // InfoBox fields
  severity: z.enum([
    'low', 'medium', 'medium-high', 'high', 'critical', 'catastrophic',
    // Case variants found in data
    'Low', 'Medium', 'High', 'Catastrophic',
  ]).optional(),
  // Likelihood can be string (legacy) or structured object
  likelihood: z.union([z.string(), StructuredLikelihood]).optional(),
  // Timeframe can be string (legacy) or structured object
  timeframe: z.union([z.string(), StructuredTimeframe]).optional(),
  maturity: ResearchMaturity.optional(),
  website: z.string().url().optional(),
  customFields: z.array(CustomField).optional(),
  // Relationships
  relatedTopics: z.array(z.string()).optional(),
  relatedEntries: z.array(RelatedEntry).optional(),
  // Sources (legacy inline format)
  sources: z.array(EntitySource).optional(),
  // Resources (semantic references by ID)
  resources: z.array(z.string()).optional(),      // Resource IDs from data/resources/
  // Parameter distinctions (for parameter-type entities)
  parameterDistinctions: ParameterDistinctions.optional(),
  // Summary/overview page this entity belongs to (entity or page ID)
  summaryPage: z.string().optional(),
});
export type Entity = z.infer<typeof Entity>;

// =============================================================================
// FULL DATABASE SCHEMA
// =============================================================================

export const Database = z.object({
  experts: z.array(Expert),
  organizations: z.array(Organization),
  estimates: z.array(Estimate),
  cruxes: z.array(Crux),
  risks: z.array(Risk),
  interventions: z.array(Intervention),
  glossary: z.array(GlossaryTerm),
  timeline: z.array(TimelineEvent),
  sources: z.array(Source),
  graphs: z.array(Graph),
  entities: z.array(Entity),
  resources: z.array(Resource),
  publications: z.array(Publication),
});
export type Database = z.infer<typeof Database>;

// =============================================================================
// MASTER GRAPH (Unified causal model with subgraph extraction)
// =============================================================================

/**
 * Node in the master graph. Unlike entity-embedded graphs, these nodes
 * can specify which entity "owns" them for page-specific highlighting.
 */
export const MasterGraphNode = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  type: z.enum(['leaf', 'cause', 'intermediate', 'effect']),
  // Which entity page "owns" this node (for highlighting on that page)
  ownerEntityId: z.string().optional(),
  // Link to entity for navigation
  entityRef: z.string().optional(),
  // Grouping for visual organization
  group: z.string().optional(),
  // Metadata
  confidence: z.number().min(0).max(1).optional(),
  details: z.string().optional(),
  sources: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
export type MasterGraphNode = z.infer<typeof MasterGraphNode>;

/**
 * Edge in the master graph.
 */
export const MasterGraphEdge = z.object({
  id: z.string().optional(),
  source: z.string(),
  target: z.string(),
  strength: z.enum(['weak', 'medium', 'strong']).optional(),
  effect: z.enum(['increases', 'decreases', 'mixed']).optional(),
  confidence: z.enum(['low', 'medium', 'high']).optional(),
  label: z.string().optional(),
  // Optional: hide this edge in certain contexts
  hideInSubgraphs: z.array(z.string()).optional(),
});
export type MasterGraphEdge = z.infer<typeof MasterGraphEdge>;

/**
 * Subgraph definition - specifies how to extract a subgraph for a specific page.
 */
export const SubgraphSpec = z.object({
  // Which entity this subgraph is for
  entityId: z.string(),
  // Center node for the subgraph (typically the node this page is about)
  centerNode: z.string(),
  // How many hops from center to include (default: 2)
  depth: z.number().min(1).max(5).optional(),
  // Explicit list of nodes to include (overrides depth if provided)
  includeNodes: z.array(z.string()).optional(),
  // Nodes to exclude even if within depth
  excludeNodes: z.array(z.string()).optional(),
  // Custom title for this subgraph view
  title: z.string().optional(),
  // Custom description
  description: z.string().optional(),
});
export type SubgraphSpec = z.infer<typeof SubgraphSpec>;

/**
 * A complete master graph that can be used to generate subgraphs for entity pages.
 */
// =============================================================================
// FACTS (Canonical facts store)
// =============================================================================

export const Fact = z.object({
  value: z.string().optional(),                // Display value (auto-generated for computed facts)
  numeric: z.number().optional(),              // Machine-readable numeric value
  asOf: z.string().optional(),
  source: z.string().optional(),
  note: z.string().optional(),
  noCompute: z.boolean().optional(),           // If true, numeric value cannot be referenced in compute expressions
  // Computed fact fields
  compute: z.string().optional(),              // Expression: "{anthropic.valuation} * {jaan-tallinn.anthropic-ownership-low}"
  format: z.string().optional(),               // Display format: "$%.1f billion"
  formatDivisor: z.number().optional(),        // Divide numeric result before formatting (e.g., 1e9 for billions)
  // Fields added at build time (not in YAML source)
  entity: z.string().optional(),               // Entity ID this fact belongs to
  factId: z.string().optional(),               // Fact key within the entity
  computed: z.boolean().optional(),            // Whether this fact was computed from an expression
});
export type Fact = z.infer<typeof Fact>;

export const FactsFile = z.object({
  entity: z.string(),
  facts: z.record(z.string(), Fact),
});
export type FactsFile = z.infer<typeof FactsFile>;

// =============================================================================
// MASTER GRAPH
// =============================================================================

export const MasterGraph = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  version: z.string().optional(),
  lastUpdated: z.string().optional(),
  // All nodes in the unified graph
  nodes: z.array(MasterGraphNode),
  // All edges in the unified graph
  edges: z.array(MasterGraphEdge),
  // Subgraph definitions for each entity page
  subgraphs: z.array(SubgraphSpec).optional(),
  // Node groups for visual organization
  groups: z.array(z.object({
    id: z.string(),
    label: z.string(),
    color: z.string().optional(),
  })).optional(),
});
export type MasterGraph = z.infer<typeof MasterGraph>;
