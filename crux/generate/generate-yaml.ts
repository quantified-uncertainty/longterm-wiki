/**
 * YAML Generator Script
 *
 * Converts extracted JSON data to YAML files.
 * Run this after reviewing/deduplicating the extracted JSON.
 *
 * Usage: node crux/generate/generate-yaml.ts
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { stringify } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const EXTRACTED_DIR = join(ROOT, 'crux/extracted');
const OUTPUT_DIR = join(ROOT, 'data');

interface Mention {
  context: string;
  position?: string;
  estimate?: string;
  confidence?: string;
  source?: string;
  url?: string;
  affiliation?: string;
  role?: string;
  website?: string;
  knownFor?: string | string[];
}

interface RawExpert {
  id: string;
  name: string;
  mentions: Mention[];
}

interface ExpertPosition {
  topic: string;
  view?: string;
  estimate?: string;
  confidence?: string;
  source?: string;
  sourceUrl?: string;
}

interface TransformedExpert {
  id: string;
  name: string;
  affiliation?: string;
  role?: string;
  website?: string;
  knownFor?: string[];
  positions?: ExpertPosition[];
}

interface RawEstimate {
  variable: string;
  source: string;
  value: string;
  date?: string;
  url?: string;
  notes?: string;
}

interface EstimateEntry {
  source: string;
  value: string;
  date?: string;
  url?: string;
  notes?: string;
}

interface TransformedEstimate {
  id: string;
  variable: string;
  category: string;
  estimates: EstimateEntry[];
}

interface RawCrux {
  id?: string;
  question: string;
  domain?: string;
  description?: string;
  importance?: number;
  resolvability?: string;
  currentState?: string;
  positions?: unknown[];
  wouldUpdateOn?: unknown[];
  relatedCruxes?: unknown[];
  relevantResearch?: unknown[];
}

interface TransformedCrux {
  id: string;
  question: string;
  domain?: string;
  description?: string;
  importance?: number;
  resolvability?: string;
  currentState?: string;
  positions?: unknown[];
  wouldUpdateOn?: unknown[];
  relatedCruxes?: unknown[];
  relevantResearch?: unknown[];
}

// =============================================================================
// LOAD EXTRACTED DATA
// =============================================================================

function loadJson<T>(filename: string): T[] {
  const filepath = join(EXTRACTED_DIR, filename);
  if (!existsSync(filepath)) {
    console.warn(`File not found: ${filepath}`);
    return [];
  }
  return JSON.parse(readFileSync(filepath, 'utf-8'));
}

// =============================================================================
// TRANSFORM EXPERTS
// =============================================================================

function transformExperts(rawExperts: RawExpert[]): TransformedExpert[] {
  return rawExperts.map((expert) => {
    // Find InfoBox mention for biographical data
    const infoBoxMention = expert.mentions.find((m) => m.context === 'InfoBox');

    // Collect all positions from DisagreementMap mentions
    const positions: ExpertPosition[] = expert.mentions
      .filter((m) => m.context.startsWith('DisagreementMap:'))
      .map((m) => {
        const topic = m.context.replace('DisagreementMap: ', '');
        return {
          topic: normalizeTopic(topic),
          view: m.position,
          estimate: m.estimate,
          confidence: m.confidence,
          source: m.source,
          sourceUrl: m.url,
        };
      })
      // Deduplicate by topic (keep most detailed)
      .reduce<ExpertPosition[]>((acc, pos) => {
        const existing = acc.find((p) => p.topic === pos.topic);
        if (!existing) {
          acc.push(pos);
        } else if (pos.source && !existing.source) {
          // Replace with more detailed version
          acc[acc.indexOf(existing)] = pos;
        }
        return acc;
      }, []);

    return {
      id: expert.id,
      name: expert.name,
      affiliation: normalizeOrgName(infoBoxMention?.affiliation),
      role: infoBoxMention?.role,
      website: infoBoxMention?.website,
      knownFor: parseKnownFor(infoBoxMention?.knownFor),
      positions: positions.length > 0 ? positions : undefined,
    };
  });
}

function normalizeTopic(topic: string): string {
  // Normalize topic names for consistency
  const mappings: Record<string, string> = {
    'When will AGI/TAI arrive?': 'timelines',
    'When Will Transformative AI Arrive?': 'timelines',
    'Probability of AI Catastrophe': 'p-doom',
    'Will Current Alignment Approaches Scale?': 'current-approaches-scale',
    'Primary Source of AI Catastrophic Risk': 'primary-risk-source',
    'How Difficult is Alignment?': 'alignment-difficulty',
  };
  return mappings[topic] || topic.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function normalizeOrgName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const mappings: Record<string, string> = {
    'Anthropic': 'anthropic',
    'OpenAI': 'openai',
    'Google DeepMind': 'deepmind',
    'DeepMind': 'deepmind',
    'MIRI': 'miri',
    'Machine Intelligence Research Institute': 'miri',
    'Alignment Research Center (ARC)': 'arc',
    'ARC': 'arc',
  };
  return mappings[name] || name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

function parseKnownFor(knownFor: string | string[] | undefined): string[] | undefined {
  if (!knownFor) return undefined;
  if (Array.isArray(knownFor)) return knownFor;
  if (typeof knownFor === 'string') {
    return knownFor.split(',').map((s) => s.trim());
  }
  return undefined;
}

// =============================================================================
// TRANSFORM ESTIMATES
// =============================================================================

function transformEstimates(rawEstimates: RawEstimate[]): TransformedEstimate[] {
  // Group by variable
  const grouped = new Map<string, TransformedEstimate>();

  for (const est of rawEstimates) {
    const varId = normalizeEstimateVariable(est.variable);
    if (!grouped.has(varId)) {
      grouped.set(varId, {
        id: varId,
        variable: est.variable,
        category: inferCategory(est.variable),
        estimates: [],
      });
    }

    grouped.get(varId)!.estimates.push({
      source: est.source,
      value: est.value,
      date: est.date,
      url: est.url,
      notes: est.notes,
    });
  }

  // Deduplicate estimates within each variable
  return Array.from(grouped.values()).map((est) => ({
    ...est,
    estimates: deduplicateEstimates(est.estimates),
  }));
}

function normalizeEstimateVariable(variable: string): string {
  return variable
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

function inferCategory(variable: string): string {
  const v = variable.toLowerCase();
  if (v.includes('timeline') || v.includes('agi') || v.includes('2030') || v.includes('2040')) {
    return 'timelines';
  }
  if (v.includes('doom') || v.includes('catastrophe') || v.includes('risk')) {
    return 'risk';
  }
  if (v.includes('alignment') || v.includes('scale')) {
    return 'alignment';
  }
  return 'other';
}

function deduplicateEstimates(estimates: EstimateEntry[]): EstimateEntry[] {
  const seen = new Map<string, EstimateEntry>();
  for (const est of estimates) {
    const key = `${est.source}::${est.value}`;
    if (!seen.has(key) || (est.date && !seen.get(key)!.date)) {
      seen.set(key, est);
    }
  }
  return Array.from(seen.values());
}

// =============================================================================
// TRANSFORM CRUXES
// =============================================================================

function transformCruxes(rawCruxes: RawCrux[]): TransformedCrux[] {
  // Deduplicate by ID or question
  const seen = new Map<string, TransformedCrux>();

  for (const crux of rawCruxes) {
    const id = crux.id || normalizeEstimateVariable(crux.question);
    if (!seen.has(id) || (crux.positions?.length ?? 0) > (seen.get(id)!.positions?.length ?? 0)) {
      seen.set(id, {
        id,
        question: crux.question,
        domain: crux.domain,
        description: crux.description,
        importance: crux.importance,
        resolvability: crux.resolvability,
        currentState: crux.currentState,
        positions: crux.positions,
        wouldUpdateOn: crux.wouldUpdateOn?.length ? crux.wouldUpdateOn : undefined,
        relatedCruxes: crux.relatedCruxes?.length ? crux.relatedCruxes : undefined,
        relevantResearch: crux.relevantResearch?.length ? crux.relevantResearch : undefined,
      });
    }
  }

  return Array.from(seen.values());
}

// =============================================================================
// WRITE YAML
// =============================================================================

function writeYaml(filename: string, data: unknown[], comment?: string): void {
  if (!existsSync(OUTPUT_DIR)) {
    mkdirSync(OUTPUT_DIR, { recursive: true });
  }

  const yamlContent = stringify(data, {
    lineWidth: 100,
    defaultStringType: 'QUOTE_DOUBLE',
    defaultKeyType: 'PLAIN',
  });

  const header = comment ? `# ${comment}\n\n` : '';
  writeFileSync(join(OUTPUT_DIR, filename), header + yamlContent);
  console.log(`Written: ${OUTPUT_DIR}/${filename} (${data.length} entries)`);
}

// =============================================================================
// MAIN
// =============================================================================

function main(): void {
  console.log('Loading extracted data...\n');

  // Load extracted data
  const rawExperts = loadJson<RawExpert>('experts-extracted.json');
  const rawEstimates = loadJson<RawEstimate>('estimates-extracted.json');
  const rawCruxes = loadJson<RawCrux>('cruxes-extracted.json');
  const rawPositions = loadJson<unknown>('positions-extracted.json');

  console.log(`Loaded: ${rawExperts.length} experts, ${rawEstimates.length} estimates, ${rawCruxes.length} cruxes\n`);

  // Transform data
  const experts = transformExperts(rawExperts);
  const estimates = transformEstimates(rawEstimates);
  const cruxes = transformCruxes(rawCruxes);

  console.log(`Transformed: ${experts.length} experts, ${estimates.length} estimate variables, ${cruxes.length} cruxes\n`);

  // Write YAML files
  writeYaml('experts-generated.yaml', experts, 'Auto-generated from MDX extraction - review before using');
  writeYaml('estimates-generated.yaml', estimates, 'Auto-generated from MDX extraction - review before using');
  writeYaml('cruxes-generated.yaml', cruxes, 'Auto-generated from MDX extraction - review before using');

  // Write positions as a reference (for merging into experts)
  writeYaml('positions-reference.yaml', rawPositions, 'Reference: all positions extracted (already merged into experts)');

  console.log('\n✓ YAML generation complete!');
  console.log('\nNext steps:');
  console.log('1. Review generated YAML files in data/');
  console.log('2. Merge with existing manually-created YAML files');
  console.log('3. Run validation to check references');
  console.log('4. Update components to use data loader');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
