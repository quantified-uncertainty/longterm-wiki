// Parameter graph data loader
// Loads and validates the YAML data for the cause-effect visualization
// Ported from apps/longterm/src/data/parameter-graph-data.ts
// Uses fs.readFileSync instead of Vite ?raw imports, with lazy loading pattern

import fs from "fs";
import path from "path";
import { loadYaml } from "@lib/yaml";

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

interface ImpactGridEntry {
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
  _rawData = loadYaml<RawGraphData>(graphYaml);

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
    ...(loadYaml<RawEntity[]>(factorsYaml) || []),
    ...(loadYaml<RawEntity[]>(scenariosYaml) || []),
    ...(loadYaml<RawEntity[]>(metricsYaml) || []),
    ...(loadYaml<RawEntity[]>(parametersYaml) || []),
    ...(loadYaml<RawEntity[]>(contentYaml) || []),
    // Split subitem files
    ...(loadYaml<RawEntity[]>(subitemsAiCapabilities) || []),
    ...(loadYaml<RawEntity[]>(subitemsAiOwnership) || []),
    ...(loadYaml<RawEntity[]>(subitemsAiTakeover) || []),
    ...(loadYaml<RawEntity[]>(subitemsAiUses) || []),
    ...(loadYaml<RawEntity[]>(subitemsCivilizationalCompetence) || []),
    ...(loadYaml<RawEntity[]>(subitemsHumanCatastrophe) || []),
    ...(loadYaml<RawEntity[]>(subitemsLongTermLockin) || []),
    ...(loadYaml<RawEntity[]>(subitemsMisalignmentPotential) || []),
    ...(loadYaml<RawEntity[]>(subitemsMisusePotential) || []),
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
// COLOR SCHEMES (used by getRawGraphData)
// ============================================================================

const SUBGROUP_COLORS: Record<string, { bg: string; border: string; text: string; accent: string }> = {
  ai: {
    bg: '#dbeafe',
    border: 'rgba(59, 130, 246, 0.35)',
    text: '#1e40af',
    accent: '#3b82f6',
  },
  society: {
    bg: '#dcfce7',
    border: 'rgba(34, 197, 94, 0.35)',
    text: '#166534',
    accent: '#22c55e',
  },
};

const INTERMEDIATE_COLORS = {
  bg: '#ede9fe',
  border: 'rgba(139, 92, 246, 0.35)',
  text: '#5b21b6',
  accent: '#8b5cf6',
};

function getNodeColors(type: string, subgroup?: string): { bg: string; border: string; text: string; accent: string } | undefined {
  if (type === 'cause' && subgroup && SUBGROUP_COLORS[subgroup]) {
    return SUBGROUP_COLORS[subgroup];
  }
  if (type === 'intermediate') {
    return INTERMEDIATE_COLORS;
  }
  return undefined;
}

// ============================================================================
// VALIDATION
// ============================================================================

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

  const seenIds = new Set<string>();
  for (const node of data.nodes) {
    if (seenIds.has(node.id)) {
      errors.push(`Duplicate node ID: "${node.id}"`);
    }
    seenIds.add(node.id);
  }

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

function idToLabel(id: string): string {
  return id
    .split('-')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

function generateSubItemHref(nodeType: string, nodeId: string, itemId: string): string {
  const typePathMap: Record<string, string> = {
    cause: 'factors',
    intermediate: 'scenarios',
    effect: 'outcomes',
  };
  const typePath = typePathMap[nodeType] || 'factors';
  return `/ai-transition-model/${typePath}/${nodeId}/${itemId}/`;
}

function getEntityDescription(itemId: string): string | undefined {
  const descMap = getEntityDescriptionMap();
  const tmcId = `tmc-${itemId}`;
  if (descMap.has(tmcId)) {
    return descMap.get(tmcId);
  }
  return descMap.get(itemId);
}

function getEntityPathFromYaml(entityId: string): string | undefined {
  return getEntityPathMap().get(entityId);
}

function enrichSubItem(item: RawSubItem, nodeType: string, nodeId: string): SubItem {
  const itemId = item.id || item.label?.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || '';
  const entityId = item.entityId || `tmc-${itemId}`;
  const description = item.description || getEntityDescription(itemId);
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

interface SubItemRatings {
  changeability?: number;
  xriskImpact?: number;
  trajectoryImpact?: number;
  uncertainty?: number;
}

interface KeyDebate {
  topic: string;
  description: string;
}

interface RelatedContentLink {
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

interface MetricLink {
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

interface RelatedContent {
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
  entityId?: string;
  ratings?: SubItemRatings;
  scope?: string;
  keyDebates?: KeyDebate[];
  relatedContent?: RelatedContent;
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
  question?: string;
}

// ============================================================================
// QUERY FUNCTIONS
// ============================================================================

export function getRootFactors(): RootFactor[] {
  const rawData = getRawData();
  return rawData.nodes
    .filter(node => node.type === 'cause')
    .sort((a, b) => {
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

function getAllNodes(): RootFactor[] {
  return [...getRootFactors(), ...getScenarios(), ...getOutcomes()];
}

export function getNodeById(nodeId: string): RootFactor | undefined {
  const allNodes = getAllNodes();
  return allNodes.find(n => n.id === nodeId);
}

// ============================================================================
// RELATIONSHIP QUERY HELPERS
// ============================================================================

interface ScenarioInfluence {
  scenarioId: string;
  scenarioLabel: string;
  effect: 'increases' | 'decreases' | undefined;
  strength: 'strong' | 'medium' | 'weak' | undefined;
}

interface FactorInfluence {
  factorId: string;
  factorLabel: string;
  effect: 'increases' | 'decreases' | undefined;
  strength: 'strong' | 'medium' | 'weak' | undefined;
}

interface OutcomeConnection {
  outcomeId: string;
  outcomeLabel: string;
  effect: 'increases' | 'decreases' | undefined;
}

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

// ============================================================================
// RAW GRAPH DATA EXPORT (for React Flow integration)
// ============================================================================

export function getRawGraphData() {
  const rawData = getRawData();

  const nodes = rawData.nodes.map(node => ({
    id: node.id,
    label: node.label,
    description: node.description,
    type: node.type,
    order: node.order,
    subgroup: node.subgroup,
    href: (node as any).href as string | undefined,
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
