// Parameter graph data loader
// Loads and validates the YAML data for the cause-effect visualization
// Ported from apps/longterm/src/data/parameter-graph-data.ts
// Uses fs.readFileSync instead of Vite ?raw imports, with lazy loading pattern

import fs from "fs";
import path from "path";
import yaml from "js-yaml";

// Source YAML data lives at the repo root
const DATA_DIR = path.resolve(process.cwd(), "../data");

// ============================================================================
// YAML FILE READING (lazy, cached)
// ============================================================================

function readYaml(relativePath: string): string {
  return fs.readFileSync(path.join(DATA_DIR, relativePath), "utf-8");
}

// ============================================================================
// RAW YAML TYPES
// ============================================================================

interface RawSubItemRatings {
  changeability?: number;
  xriskImpact?: number;
  trajectoryImpact?: number;
  uncertainty?: number;
}

interface RawKeyDebate {
  topic: string;
  description: string;
}

interface RawRelatedContentLink {
  path: string;
  title: string;
}

interface RawRelatedContent {
  risks?: RawRelatedContentLink[];
  responses?: RawRelatedContentLink[];
  models?: RawRelatedContentLink[];
  cruxes?: RawRelatedContentLink[];
  researchReports?: RawRelatedContentLink[];
}

// Current state tracking
interface RawCurrentAssessment {
  level: number;                    // 0-100 current level
  trend: 'improving' | 'stable' | 'declining' | 'unknown';
  confidence?: number;              // 0-1 confidence in assessment
  lastUpdated?: string;             // YYYY-MM format
  notes?: string;                   // Brief explanation
}

// Intervention mapping
interface RawAddressedBy {
  path: string;
  title?: string;
  effect: 'positive' | 'negative' | 'mixed';
  strength?: 'strong' | 'medium' | 'weak';
}

// Metrics linkage
interface RawMetricLink {
  path: string;
  title?: string;
  type?: 'leading' | 'lagging' | 'proxy';
}

// Expert estimates (primarily for scenarios)
interface RawEstimate {
  source: string;
  probability: number;              // 0-1
  confidence?: [number, number];    // 80% CI as [low, high]
  asOf?: string;                    // YYYY-MM format
  url?: string;
}

// Warning indicators for tracking status
interface RawWarningIndicator {
  indicator: string;
  status: string;
  trend?: 'improving' | 'stable' | 'worsening';
  concern?: 'low' | 'medium' | 'high';
}

interface RawSubItem {
  id?: string;           // Slug identifier
  label?: string;        // Display label (auto-derived from id if missing)
  description?: string;  // Full description
  probability?: string;  // Optional probability estimate (legacy)
  href?: string;         // Optional explicit href (auto-generated from id if missing)
  entityId?: string;     // Reference to entity in entities.yaml for full data
  ratings?: RawSubItemRatings;
  scope?: string;
  keyDebates?: RawKeyDebate[];
  relatedContent?: RawRelatedContent;
  // Extended fields
  currentAssessment?: RawCurrentAssessment;
  addressedBy?: RawAddressedBy[];
  metrics?: RawMetricLink[];
  estimates?: RawEstimate[];
  warningIndicators?: RawWarningIndicator[];
}

interface RawNode {
  id: string;
  label: string;
  description?: string;
  type: 'cause' | 'intermediate' | 'effect';
  order?: number;  // Manual ordering within layer (0 = leftmost)
  subgroup?: string;  // Cluster within layer (e.g., 'ai' vs 'society')
  subItems?: RawSubItem[];
  confidence?: number;
  confidenceLabel?: string;
  question?: string;  // For outcome nodes - the key question they address
}

interface RawEdge {
  id: string;
  source: string;
  target: string;
  label?: string;
  strength?: 'strong' | 'medium' | 'weak';
  effect?: 'increases' | 'decreases';
}

export interface ImpactGridEntry {
  source: string;
  target: string;
  impact: number;
  direction: 'increases' | 'decreases' | 'mixed';
  notes: string;
}

interface RawGraphData {
  nodes: RawNode[];
  edges: RawEdge[];
  impactGrid?: ImpactGridEntry[];
}

// Parse entities YAML for description lookups
interface RawEntity {
  id: string;
  title?: string;
  description?: string;
  [key: string]: unknown;
}

// ============================================================================
// LAZY-LOADED CACHED DATA
// ============================================================================

let _rawData: RawGraphData | null = null;
let _rawEntities: RawEntity[] | null = null;
let _entityDescriptionMap: Map<string, string> | null = null;
let _entityPathMap: Map<string, string> | null = null;

function getRawData(): RawGraphData {
  if (_rawData) return _rawData;

  const graphYaml = readYaml("parameter-graph.yaml");
  _rawData = yaml.load(graphYaml) as RawGraphData;

  // Run validation
  const validationErrors = validateGraph(_rawData);
  if (validationErrors.length > 0) {
    console.error('Parameter graph validation errors:');
    validationErrors.forEach(err => console.error(`  - ${err}`));
    // In development, throw to make errors visible
    if (process.env.NODE_ENV === 'development') {
      throw new Error(`Parameter graph has ${validationErrors.length} validation error(s)`);
    }
  }

  return _rawData;
}

function getRawEntities(): RawEntity[] {
  if (_rawEntities) return _rawEntities;

  const factorsYaml = readYaml("entities/ai-transition-model-factors.yaml");
  const scenariosYaml = readYaml("entities/ai-transition-model-scenarios.yaml");
  const metricsYaml = readYaml("entities/ai-transition-model-metrics.yaml");
  const parametersYaml = readYaml("entities/ai-transition-model-parameters.yaml");
  const contentYaml = readYaml("entities/ai-transition-model-content.yaml");
  const subitemsAiCapabilities = readYaml("entities/ai-transition-model-subitems-ai-capabilities.yaml");
  const subitemsAiOwnership = readYaml("entities/ai-transition-model-subitems-ai-ownership.yaml");
  const subitemsAiTakeover = readYaml("entities/ai-transition-model-subitems-ai-takeover.yaml");
  const subitemsAiUses = readYaml("entities/ai-transition-model-subitems-ai-uses.yaml");
  const subitemsCivilizationalCompetence = readYaml("entities/ai-transition-model-subitems-civilizational-competence.yaml");
  const subitemsHumanCatastrophe = readYaml("entities/ai-transition-model-subitems-human-catastrophe.yaml");
  const subitemsLongTermLockin = readYaml("entities/ai-transition-model-subitems-long-term-lockin.yaml");
  const subitemsMisalignmentPotential = readYaml("entities/ai-transition-model-subitems-misalignment-potential.yaml");
  const subitemsMisusePotential = readYaml("entities/ai-transition-model-subitems-misuse-potential.yaml");

  _rawEntities = [
    ...(yaml.load(factorsYaml) as RawEntity[] || []),
    ...(yaml.load(scenariosYaml) as RawEntity[] || []),
    ...(yaml.load(metricsYaml) as RawEntity[] || []),
    ...(yaml.load(parametersYaml) as RawEntity[] || []),
    ...(yaml.load(contentYaml) as RawEntity[] || []),
    // Split subitem files
    ...(yaml.load(subitemsAiCapabilities) as RawEntity[] || []),
    ...(yaml.load(subitemsAiOwnership) as RawEntity[] || []),
    ...(yaml.load(subitemsAiTakeover) as RawEntity[] || []),
    ...(yaml.load(subitemsAiUses) as RawEntity[] || []),
    ...(yaml.load(subitemsCivilizationalCompetence) as RawEntity[] || []),
    ...(yaml.load(subitemsHumanCatastrophe) as RawEntity[] || []),
    ...(yaml.load(subitemsLongTermLockin) as RawEntity[] || []),
    ...(yaml.load(subitemsMisalignmentPotential) as RawEntity[] || []),
    ...(yaml.load(subitemsMisusePotential) as RawEntity[] || []),
  ];

  return _rawEntities;
}

function getEntityDescriptionMap(): Map<string, string> {
  if (_entityDescriptionMap) return _entityDescriptionMap;

  _entityDescriptionMap = new Map<string, string>();
  for (const entity of getRawEntities()) {
    if (entity.id && entity.description) {
      _entityDescriptionMap.set(entity.id, entity.description);
    }
  }
  return _entityDescriptionMap;
}

function getEntityPathMap(): Map<string, string> {
  if (_entityPathMap) return _entityPathMap;

  _entityPathMap = new Map<string, string>();
  for (const entity of getRawEntities()) {
    if (entity.id && (entity as any).path) {
      _entityPathMap.set(entity.id, (entity as any).path);
    }
  }
  return _entityPathMap;
}

// ============================================================================
// COLOR SCHEMES
// ============================================================================

// Color schemes for subgroups and special types
// These override the default type-based colors in config.ts
export const SUBGROUP_COLORS: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  // AI System Factors - blue tones
  ai: {
    bg: '#dbeafe',           // blue-100
    border: 'rgba(59, 130, 246, 0.35)',  // blue-500
    text: '#1e40af',         // blue-800
    accent: '#3b82f6',       // blue-500
  },
  // Societal Factors - green tones
  society: {
    bg: '#dcfce7',           // green-100
    border: 'rgba(34, 197, 94, 0.35)',   // green-500
    text: '#166534',         // green-800
    accent: '#22c55e',       // green-500
  },
};

// Colors for intermediate type (scenarios) - purple tones
export const INTERMEDIATE_COLORS = {
  bg: '#ede9fe',             // violet-100
  border: 'rgba(139, 92, 246, 0.35)',   // violet-500
  text: '#5b21b6',           // violet-800
  accent: '#8b5cf6',         // violet-500
};

// Helper to get node colors based on type and subgroup
export function getNodeColors(type: string, subgroup?: string): { bg: string; border: string; text: string; accent: string } | undefined {
  // For cause nodes, use subgroup-based colors if available
  if (type === 'cause' && subgroup && SUBGROUP_COLORS[subgroup]) {
    return SUBGROUP_COLORS[subgroup];
  }
  // For intermediate nodes (scenarios), use purple
  if (type === 'intermediate') {
    return INTERMEDIATE_COLORS;
  }
  // For effect nodes and others, use default config colors (no override)
  return undefined;
}

// ============================================================================
// VALIDATION
// ============================================================================

// Validate edges reference valid node IDs
function validateGraph(data: RawGraphData): string[] {
  const errors: string[] = [];
  const nodeIds = new Set(data.nodes.map(n => n.id));

  for (const edge of data.edges) {
    if (!nodeIds.has(edge.source)) {
      errors.push(`Edge "${edge.id}": source "${edge.source}" not found in nodes`);
    }
    if (!nodeIds.has(edge.target)) {
      errors.push(`Edge "${edge.id}": target "${edge.target}" not found in nodes`);
    }
  }

  // Check for duplicate node IDs
  const seenIds = new Set<string>();
  for (const node of data.nodes) {
    if (seenIds.has(node.id)) {
      errors.push(`Duplicate node ID: "${node.id}"`);
    }
    seenIds.add(node.id);
  }

  // Check for duplicate edge IDs
  const seenEdgeIds = new Set<string>();
  for (const edge of data.edges) {
    if (seenEdgeIds.has(edge.id)) {
      errors.push(`Duplicate edge ID: "${edge.id}"`);
    }
    seenEdgeIds.add(edge.id);
  }

  return errors;
}

// ============================================================================
// ENRICHMENT HELPERS
// ============================================================================

// Convert kebab-case id to Title Case label
function idToLabel(id: string): string {
  return id
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

// Generate href for sub-item based on node type and id
function generateSubItemHref(nodeType: string, nodeId: string, itemId: string): string {
  const typePathMap: Record<string, string> = {
    cause: 'factors',
    intermediate: 'scenarios',
    effect: 'outcomes',
  };
  const typePath = typePathMap[nodeType] || 'factors';
  return `/ai-transition-model/${typePath}/${nodeId}/${itemId}/`;
}

// Look up description from entity definitions (single source of truth)
// Entity IDs use 'tmc-' prefix for TransitionModelContent entities
function getEntityDescription(itemId: string): string | undefined {
  const descMap = getEntityDescriptionMap();
  // Try with tmc- prefix first (standard convention)
  const tmcId = `tmc-${itemId}`;
  if (descMap.has(tmcId)) {
    return descMap.get(tmcId);
  }
  // Fall back to direct ID lookup
  return descMap.get(itemId);
}

// Look up path from entity definitions
function getEntityPathFromYaml(entityId: string): string | undefined {
  return getEntityPathMap().get(entityId);
}

// Enrich a sub-item with metadata from entity definitions
function enrichSubItem(item: RawSubItem, nodeType: string, nodeId: string): SubItem {
  // Get ID from item (new DRY format) or derive from label (legacy format)
  const itemId = item.id || item.label?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '';

  // Entity ID: use explicit entityId from YAML, or generate with tmc- prefix
  const entityId = item.entityId || `tmc-${itemId}`;

  // Description priority: inline YAML > entity lookup
  // This allows entity definitions to be the single source of truth
  const description = item.description || getEntityDescription(itemId);

  // Href priority: explicit href > entity path lookup > auto-generated
  const href = item.href || getEntityPathFromYaml(entityId) || generateSubItemHref(nodeType, nodeId, itemId);

  return {
    label: item.label || idToLabel(itemId),
    description,
    href,
    entityId,
    ratings: item.ratings,
    scope: item.scope,
    keyDebates: item.keyDebates,
    relatedContent: item.relatedContent,
    // Extended schema fields
    currentAssessment: item.currentAssessment,
    addressedBy: item.addressedBy,
    metrics: item.metrics,
    estimates: item.estimates,
    warningIndicators: item.warningIndicators,
  };
}

// ============================================================================
// EXPORTED TYPES
// ============================================================================

export interface SubItemRatings {
  changeability?: number;
  xriskImpact?: number;
  trajectoryImpact?: number;
  uncertainty?: number;
}

export interface KeyDebate {
  topic: string;
  description: string;
}

export interface RelatedContentLink {
  path: string;
  title: string;
}

export interface CurrentAssessment {
  level: number;
  trend: 'improving' | 'stable' | 'declining' | 'unknown';
  confidence?: number;
  lastUpdated?: string;
  notes?: string;
}

export interface AddressedBy {
  path: string;
  title?: string;
  effect: 'positive' | 'negative' | 'mixed';
  strength?: 'strong' | 'medium' | 'weak';
}

export interface MetricLink {
  path: string;
  title?: string;
  type?: 'leading' | 'lagging' | 'proxy';
}

export interface Estimate {
  source: string;
  probability: number;
  confidence?: [number, number];
  asOf?: string;
  url?: string;
}

export interface WarningIndicator {
  indicator: string;
  status: string;
  trend?: 'improving' | 'stable' | 'worsening';
  concern?: 'low' | 'medium' | 'high';
}

export interface RelatedContent {
  risks?: RelatedContentLink[];
  responses?: RelatedContentLink[];
  models?: RelatedContentLink[];
  cruxes?: RelatedContentLink[];
  researchReports?: RelatedContentLink[];
}

export interface SubItem {
  label: string;
  description?: string;
  href?: string;
  entityId?: string;  // Entity ID for rich tooltip lookups (e.g., 'tmc-compute')
  ratings?: SubItemRatings;
  scope?: string;
  keyDebates?: KeyDebate[];
  relatedContent?: RelatedContent;
  // Extended schema fields
  currentAssessment?: CurrentAssessment;
  addressedBy?: AddressedBy[];
  metrics?: MetricLink[];
  estimates?: Estimate[];
  warningIndicators?: WarningIndicator[];
}

export interface RootFactor {
  id: string;
  label: string;
  description?: string;
  href?: string;
  subgroup?: string;
  order?: number;
  subItems?: SubItem[];
  question?: string;  // For outcome nodes - the key question they address
}

// ============================================================================
// IMPACT GRID
// ============================================================================

// Export impact grid data
export function getImpactGrid(): ImpactGridEntry[] {
  return getRawData().impactGrid || [];
}

/** @deprecated Use getImpactGrid() for lazy loading */
export const impactGrid: ImpactGridEntry[] = [];
// Note: impactGrid is kept as an empty array for backward compat.
// Consumers should migrate to getImpactGrid().

// Helper to get all impacts where this node is the source (what it affects)
export function getImpactsFrom(nodeId: string): ImpactGridEntry[] {
  return getImpactGrid().filter(entry => entry.source === nodeId);
}

// Helper to get all impacts where this node is the target (what affects it)
export function getImpactsTo(nodeId: string): ImpactGridEntry[] {
  return getImpactGrid().filter(entry => entry.target === nodeId);
}

// Helper to get node label by ID
export function getNodeLabel(nodeId: string): string {
  const rawData = getRawData();
  const node = rawData.nodes.find(n => n.id === nodeId);
  return node?.label || nodeId;
}

// ============================================================================
// QUERY FUNCTIONS
// ============================================================================

// Get all root factors (cause nodes) with their sub-items
export function getRootFactors(): RootFactor[] {
  const rawData = getRawData();
  return rawData.nodes
    .filter(node => node.type === 'cause')
    .sort((a, b) => {
      // Sort by subgroup first (ai before society), then by order
      if (a.subgroup !== b.subgroup) {
        return a.subgroup === 'ai' ? -1 : 1;
      }
      return (a.order || 0) - (b.order || 0);
    })
    .map(node => ({
      id: node.id,
      label: node.label,
      description: node.description,
      href: (node as any).href,
      subgroup: node.subgroup,
      order: node.order,
      subItems: node.subItems?.map(item => enrichSubItem(item, node.type, node.id)),
    }));
}

// Get scenarios (intermediate nodes)
export function getScenarios(): RootFactor[] {
  const rawData = getRawData();
  return rawData.nodes
    .filter(node => node.type === 'intermediate')
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(node => ({
      id: node.id,
      label: node.label,
      description: node.description,
      href: (node as any).href,
      subItems: node.subItems?.map(item => enrichSubItem(item, node.type, node.id)),
    }));
}

// Get outcomes (effect nodes)
export function getOutcomes(): RootFactor[] {
  const rawData = getRawData();
  return rawData.nodes
    .filter(node => node.type === 'effect')
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map(node => ({
      id: node.id,
      label: node.label,
      description: node.description,
      href: (node as any).href,
      question: node.question,
    }));
}

// Get edges for a specific source node
export function getEdgesFrom(sourceId: string) {
  const rawData = getRawData();
  return rawData.edges.filter(e => e.source === sourceId);
}

// Get edges for a specific target node
export function getEdgesTo(targetId: string) {
  const rawData = getRawData();
  return rawData.edges.filter(e => e.target === targetId);
}

// Get all nodes (root factors + scenarios + outcomes)
function getAllNodes(): RootFactor[] {
  return [...getRootFactors(), ...getScenarios(), ...getOutcomes()];
}

// Get a specific sub-item by node ID and label
export function getSubItem(nodeId: string, subItemLabel: string): SubItem | undefined {
  const allNodes = getAllNodes();
  const node = allNodes.find(n => n.id === nodeId);
  if (!node?.subItems) return undefined;
  return node.subItems.find(item => item.label === subItemLabel);
}

// Get key debates for a sub-item
export function getSubItemDebates(nodeId: string, subItemLabel: string): KeyDebate[] {
  const subItem = getSubItem(nodeId, subItemLabel);
  return subItem?.keyDebates || [];
}

// Get ratings for a sub-item
export function getSubItemRatings(nodeId: string, subItemLabel: string): SubItemRatings | undefined {
  const subItem = getSubItem(nodeId, subItemLabel);
  return subItem?.ratings;
}

// Get related content for a sub-item
export function getSubItemRelatedContent(nodeId: string, subItemLabel: string): RelatedContent | undefined {
  const subItem = getSubItem(nodeId, subItemLabel);
  return subItem?.relatedContent;
}

// Get scope for a sub-item
export function getSubItemScope(nodeId: string, subItemLabel: string): string | undefined {
  const subItem = getSubItem(nodeId, subItemLabel);
  return subItem?.scope;
}

// ============================================================================
// RELATIONSHIP QUERY HELPERS
// These derive relationships from the YAML edges instead of hardcoding them
// ============================================================================

export interface ScenarioInfluence {
  scenarioId: string;
  scenarioLabel: string;
  effect: 'increases' | 'decreases' | undefined;
  strength: 'strong' | 'medium' | 'weak' | undefined;
}

export interface FactorInfluence {
  factorId: string;
  factorLabel: string;
  effect: 'increases' | 'decreases' | undefined;
  strength: 'strong' | 'medium' | 'weak' | undefined;
}

export interface OutcomeConnection {
  outcomeId: string;
  outcomeLabel: string;
  effect: 'increases' | 'decreases' | undefined;
}

// Get all scenarios that a root factor influences (with direction)
export function getFactorScenarioInfluences(factorId: string): ScenarioInfluence[] {
  const rawData = getRawData();
  const edges = rawData.edges.filter(e => e.source === factorId);
  const scenarios = getScenarios();

  return edges
    .map(edge => {
      const scenario = scenarios.find(s => s.id === edge.target);
      if (!scenario) return null;
      return {
        scenarioId: edge.target,
        scenarioLabel: scenario.label,
        effect: edge.effect,
        strength: edge.strength,
      };
    })
    .filter((s): s is ScenarioInfluence => s !== null);
}

// Get formatted scenario influences as a string array (for display)
export function getFactorScenarioLabels(factorId: string): string[] {
  const influences = getFactorScenarioInfluences(factorId);

  if (influences.length === 0) return ['—'];

  // Check if this factor affects all scenarios
  const scenarios = getScenarios();
  if (influences.length === scenarios.length) {
    return ['All scenarios'];
  }

  return influences.map(inf => {
    const arrow = inf.effect === 'increases' ? '\u2191' : inf.effect === 'decreases' ? '\u2193' : '';
    return `${inf.scenarioLabel} ${arrow}`.trim();
  });
}

// Get all factors that influence a scenario (with direction)
export function getScenarioFactorInfluences(scenarioId: string): FactorInfluence[] {
  const rawData = getRawData();
  const edges = rawData.edges.filter(e => e.target === scenarioId);
  const factors = getRootFactors();

  return edges
    .map(edge => {
      const factor = factors.find(f => f.id === edge.source);
      if (!factor) return null;
      return {
        factorId: edge.source,
        factorLabel: factor.label,
        effect: edge.effect,
        strength: edge.strength,
      };
    })
    .filter((f): f is FactorInfluence => f !== null);
}

// Get formatted factor influences for a scenario as a string
export function getScenarioFactorLabels(scenarioId: string): string {
  const influences = getScenarioFactorInfluences(scenarioId);

  if (influences.length === 0) return '—';

  return influences.map(inf => {
    const arrow = inf.effect === 'increases' ? '\u2191' : inf.effect === 'decreases' ? '\u2193' : '';
    return `${inf.factorLabel} ${arrow}`.trim();
  }).join(', ');
}

// Get all outcomes that a scenario leads to
export function getScenarioOutcomeConnections(scenarioId: string): OutcomeConnection[] {
  const rawData = getRawData();
  const edges = rawData.edges.filter(e => e.source === scenarioId);
  const outcomes = getOutcomes();

  return edges
    .map(edge => {
      const outcome = outcomes.find(o => o.id === edge.target);
      if (!outcome) return null;
      return {
        outcomeId: edge.target,
        outcomeLabel: outcome.label,
        effect: edge.effect,
      };
    })
    .filter((o): o is OutcomeConnection => o !== null);
}

// Get formatted outcome labels for a scenario as a string
export function getScenarioOutcomeLabels(scenarioId: string): string {
  const connections = getScenarioOutcomeConnections(scenarioId);

  if (connections.length === 0) return '—';

  return connections.map(c => c.outcomeLabel).join(', ');
}

// Get all scenarios that lead to an outcome
export function getOutcomeScenarioConnections(outcomeId: string): { scenarioId: string; scenarioLabel: string }[] {
  const rawData = getRawData();
  const edges = rawData.edges.filter(e => e.target === outcomeId);
  const scenarios = getScenarios();

  return edges
    .map(edge => {
      const scenario = scenarios.find(s => s.id === edge.source);
      if (!scenario) return null;
      return {
        scenarioId: edge.source,
        scenarioLabel: scenario.label,
      };
    })
    .filter((s): s is { scenarioId: string; scenarioLabel: string } => s !== null);
}

// Get formatted scenario labels for an outcome as a string
export function getOutcomeScenarioLabels(outcomeId: string): string {
  const connections = getOutcomeScenarioConnections(outcomeId);

  if (connections.length === 0) return '—';

  return connections.map(c => c.scenarioLabel).join(', ');
}

// Get a node by ID (any type)
export function getNodeById(nodeId: string): RootFactor | undefined {
  const allNodes = getAllNodes();
  return allNodes.find(n => n.id === nodeId);
}

// ============================================================================
// RAW GRAPH DATA EXPORT (for Phase 4 React Flow integration)
// ============================================================================

export interface RawGraphDataExport {
  nodes: Array<{
    id: string;
    label: string;
    description?: string;
    type: 'cause' | 'intermediate' | 'effect';
    order?: number;
    subgroup?: string;
    subItems?: SubItem[];
    confidence?: number;
    confidenceLabel?: string;
    question?: string;
    nodeColors?: { bg: string; border: string; text: string; accent: string };
  }>;
  edges: Array<{
    id: string;
    source: string;
    target: string;
    label?: string;
    strength?: 'strong' | 'medium' | 'weak';
    effect?: 'increases' | 'decreases';
  }>;
}

/**
 * Export the raw graph data structure (nodes and edges) with enriched sub-items
 * and computed node colors. This is intended for Phase 4 React Flow integration
 * to build React Flow Node/Edge objects from.
 */
export function getRawGraphData(): RawGraphDataExport {
  const rawData = getRawData();

  const nodes = rawData.nodes.map(node => ({
    id: node.id,
    label: node.label,
    description: node.description,
    type: node.type,
    order: node.order,
    subgroup: node.subgroup,
    subItems: node.subItems?.map(item => enrichSubItem(item, node.type, node.id)),
    confidence: node.confidence,
    confidenceLabel: node.confidenceLabel,
    question: node.question,
    nodeColors: getNodeColors(node.type, node.subgroup),
  }));

  const edges = rawData.edges.map(edge => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    label: edge.label,
    strength: edge.strength,
    effect: edge.effect,
  }));

  return { nodes, edges };
}
