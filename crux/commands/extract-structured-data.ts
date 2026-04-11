/**
 * Extract Structured Data from Wiki Pages
 *
 * Extracts structured data from wiki page prose for any entity type and
 * optionally writes it to the YAML entity data layer after sourcing
 * against footnote sources.
 *
 * Supported entity types:
 *   person       — education, roles, publications, researchFocus, birthYear
 *   organization — foundedYear, headquarters, funding, keyPersonnel, products, parentOrg
 *   ai-model     — releaseDate, developer, parameterCount, contextWindow, capabilities,
 *                   benchmarkScores, pricing
 *   policy       — introducedDate, status, jurisdiction, sponsor, provisions, stakeholders
 *   (default)    — description, keyFacts, relatedEntities
 *
 * Subcommands:
 *   extract (default)   Extract structured data from an entity's wiki page
 *
 * Flags:
 *   --dry-run           Print extracted data as JSON, don't write anything (default)
 *   --apply             Write verified claims to YAML entity data
 *   --verify            Verify extracted claims against footnote source URLs
 *   --budget=<N>        Maximum LLM spend in dollars (default: 5)
 *   --entity-type=<T>   Process all entities of this type (e.g., person, organization)
 *   --limit=<N>         Max entities to process in batch mode (default: 10)
 *   --json              Output results as JSON
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join, relative } from 'path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { PROJECT_ROOT, CONTENT_DIR_ABS, loadIdRegistry } from '../lib/content-types.ts';
import { createLlmClient, callLlm, MODELS } from '../lib/llm.ts';
import { CostTracker } from '../lib/cost-tracker.ts';
import { fetchSource } from '../lib/search/source-fetcher.ts';
import { createLogger } from '../lib/output.ts';
import { parseIntOpt, type CommandResult } from '../lib/cli.ts';
import { parseFootnotes as parseFootnotesLib, type ParsedFootnote } from '../lib/footnote-parser.ts';

// ---------------------------------------------------------------------------
// Types — Person (original biographical extraction)
// ---------------------------------------------------------------------------

interface EducationEntry {
  degree: string;
  institution: string;
  year: number | null;
}

interface RoleEntry {
  title: string;
  organization: string;
  startYear: number | null;
  endYear: number | null;
  type: 'key-person' | 'advisory' | 'board';
}

interface PublicationEntry {
  title: string;
  year: number | null;
  venue: string;
  type: 'paper' | 'book';
}

interface PersonExtractedData {
  kind: 'person';
  education: EducationEntry[];
  roles: RoleEntry[];
  publications: PublicationEntry[];
  researchFocus: string[];
  birthYear: number | null;
}

// ---------------------------------------------------------------------------
// Types — Organization
// ---------------------------------------------------------------------------

interface FundingEntry {
  amount: string;
  source: string;
  year: number | null;
}

interface KeyPersonnelEntry {
  name: string;
  title: string;
}

interface ProductEntry {
  name: string;
  description: string;
}

interface OrganizationExtractedData {
  kind: 'organization';
  foundedYear: number | null;
  headquarters: string | null;
  funding: FundingEntry[];
  keyPersonnel: KeyPersonnelEntry[];
  products: ProductEntry[];
  parentOrg: string | null;
}

// ---------------------------------------------------------------------------
// Types — AI Model
// ---------------------------------------------------------------------------

interface BenchmarkScoreEntry {
  benchmark: string;
  score: string;
}

interface PricingInfo {
  input: string | null;
  output: string | null;
}

interface AiModelExtractedData {
  kind: 'ai-model';
  releaseDate: string | null;
  developer: string | null;
  parameterCount: string | null;
  contextWindow: string | null;
  capabilities: string[];
  benchmarkScores: BenchmarkScoreEntry[];
  pricing: PricingInfo;
}

// ---------------------------------------------------------------------------
// Types — Policy
// ---------------------------------------------------------------------------

interface ProvisionEntry {
  title: string;
  description: string;
}

interface StakeholderEntry {
  name: string;
  position: string;
  reason: string;
}

interface PolicyExtractedData {
  kind: 'policy';
  introducedDate: string | null;
  status: string | null;
  jurisdiction: string | null;
  sponsor: string | null;
  provisions: ProvisionEntry[];
  stakeholders: StakeholderEntry[];
}

// ---------------------------------------------------------------------------
// Types — Default (generic)
// ---------------------------------------------------------------------------

interface RelatedEntityEntry {
  name: string;
  relationship: string;
}

interface DefaultExtractedData {
  kind: 'default';
  description: string | null;
  keyFacts: string[];
  relatedEntities: RelatedEntityEntry[];
}

// ---------------------------------------------------------------------------
// Union type for all extracted data
// ---------------------------------------------------------------------------

type ExtractedData =
  | PersonExtractedData
  | OrganizationExtractedData
  | AiModelExtractedData
  | PolicyExtractedData
  | DefaultExtractedData;

// ---------------------------------------------------------------------------
// Common types
// ---------------------------------------------------------------------------

interface VerifiedClaim {
  field: string;
  value: unknown;
  footnoteRef: string | null;
  footnoteUrl: string | null;
  verified: boolean;
  confidence: number;
  sourcingNote: string;
}

interface ExtractionResult {
  entityId: string;
  entityTitle: string;
  entityType: string;
  mdxPath: string;
  extracted: ExtractedData;
  verifiedClaims: VerifiedClaim[];
  appliedFields: string[];
  costUsd: number;
}

// ---------------------------------------------------------------------------
// Entity YAML types (generic across all entity types)
// ---------------------------------------------------------------------------

interface EntityYamlEntry {
  id: string;
  stableId?: string;
  wikiId?: string;
  type: string;
  title: string;
  description?: string;
  website?: string;
  customFields?: Array<{ label: string; value: string }>;
  sources?: Array<{ title: string; url?: string }>;
  tags?: string[];
  relatedEntries?: Array<{ id: string; type: string; relationship?: string }>;
  lastUpdated?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Entity type → YAML file mapping
// ---------------------------------------------------------------------------

/**
 * Maps entity types to their YAML files and content directories.
 * When an entity type is not found here, we search all YAML files.
 */
const ENTITY_TYPE_CONFIG: Record<string, {
  yamlFile: string;
  contentDirs: string[];
  yamlHeader: string;
}> = {
  person: {
    yamlFile: 'people.yaml',
    contentDirs: ['knowledge-base/people'],
    yamlHeader: '# People Entities\n# Auto-generated from entities.yaml - edit this file directly\n',
  },
  organization: {
    yamlFile: 'organizations.yaml',
    contentDirs: ['knowledge-base/organizations'],
    yamlHeader: '# Organizations Entities\n# Auto-generated from entities.yaml - edit this file directly\n',
  },
  'ai-model': {
    yamlFile: 'ai-models.yaml',
    contentDirs: ['knowledge-base/models'],
    yamlHeader: '# AI Model Entities\n# Individual AI model versions with structured benchmark, pricing, and safety data.\n',
  },
  policy: {
    yamlFile: 'responses.yaml',
    contentDirs: ['knowledge-base/responses'],
    yamlHeader: '# Responses Entities\n# Auto-generated from entities.yaml - edit this file directly\n',
  },
  approach: {
    yamlFile: 'responses.yaml',
    contentDirs: ['knowledge-base/responses'],
    yamlHeader: '# Responses Entities\n# Auto-generated from entities.yaml - edit this file directly\n',
  },
  concept: {
    yamlFile: 'concepts.yaml',
    contentDirs: ['knowledge-base'],
    yamlHeader: '# Concepts Entities\n# Auto-generated from entities.yaml - edit this file directly\n',
  },
  risk: {
    yamlFile: 'risks.yaml',
    contentDirs: ['knowledge-base/risks'],
    yamlHeader: '# Risks Entities\n# Auto-generated from entities.yaml - edit this file directly\n',
  },
  capability: {
    yamlFile: 'capabilities.yaml',
    contentDirs: ['knowledge-base/capabilities', 'knowledge-base'],
    yamlHeader: '# Capabilities Entities\n# Auto-generated from entities.yaml - edit this file directly\n',
  },
  historical: {
    yamlFile: 'historical.yaml',
    contentDirs: ['knowledge-base/history', 'knowledge-base'],
    yamlHeader: '# Historical Entities\n# Auto-generated from entities.yaml - edit this file directly\n',
  },
};

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function getYamlPath(entityType: string): string {
  const config = ENTITY_TYPE_CONFIG[entityType];
  if (config) return join(PROJECT_ROOT, 'data/entities', config.yamlFile);
  // Fallback: for unknown types, search all YAML files
  return join(PROJECT_ROOT, 'data/entities/misc.yaml');
}

function loadEntityYaml(entityType: string): EntityYamlEntry[] {
  const yamlPath = getYamlPath(entityType);
  if (!existsSync(yamlPath)) {
    throw new Error(`Entity YAML not found at ${yamlPath}`);
  }
  const raw = readFileSync(yamlPath, 'utf-8');
  return (parseYaml(raw) ?? []) as EntityYamlEntry[];
}

function saveEntityYaml(entityType: string, entries: EntityYamlEntry[]): void {
  const yamlPath = getYamlPath(entityType);
  const config = ENTITY_TYPE_CONFIG[entityType];
  const header = config?.yamlHeader ?? `# ${entityType} Entities\n`;
  const yamlStr = stringifyYaml(entries, {
    lineWidth: 120,
    defaultStringType: 'PLAIN',
    defaultKeyType: 'PLAIN',
  });
  writeFileSync(yamlPath, `${header}\n${yamlStr}`);
}

/**
 * Load entities from ALL YAML files (for single-entity lookups when type is unknown).
 */
function loadAllEntityYamls(): { entries: EntityYamlEntry[]; fileByEntityId: Map<string, string> } {
  const entitiesDir = join(PROJECT_ROOT, 'data/entities');
  const entries: EntityYamlEntry[] = [];
  const fileByEntityId = new Map<string, string>();

  const files = readdirSync(entitiesDir).filter((f) => f.endsWith('.yaml'));
  for (const file of files) {
    const filePath = join(entitiesDir, file);
    try {
      const raw = readFileSync(filePath, 'utf-8');
      const parsed = (parseYaml(raw) ?? []) as EntityYamlEntry[];
      if (!Array.isArray(parsed)) continue;
      for (const entry of parsed) {
        if (entry.id) {
          entries.push(entry);
          fileByEntityId.set(entry.id, file);
        }
      }
    } catch (err: unknown) {
      console.warn(`Warning: Failed to parse YAML file ${file}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { entries, fileByEntityId };
}

/**
 * Find the MDX file for an entity by slug or wikiId.
 * Searches entity-type-specific directories first, then falls back to broader search.
 */
function findMdxFile(entityIdOrWikiId: string, entityType?: string): string | null {
  // Build list of directories to search (type-specific first, then fallbacks)
  const searchDirs: string[] = [];

  if (entityType && ENTITY_TYPE_CONFIG[entityType]) {
    for (const dir of ENTITY_TYPE_CONFIG[entityType].contentDirs) {
      searchDirs.push(dir);
    }
  }

  // Always add common fallback directories
  const fallbackDirs = [
    'knowledge-base/people',
    'knowledge-base/organizations',
    'knowledge-base/models',
    'knowledge-base/responses',
    'knowledge-base/risks',
    'knowledge-base/capabilities',
    'knowledge-base/history',
    'knowledge-base',
  ];
  for (const dir of fallbackDirs) {
    if (!searchDirs.includes(dir)) searchDirs.push(dir);
  }

  // Direct path check in each directory
  for (const subdir of searchDirs) {
    const directPath = join(CONTENT_DIR_ABS, subdir, `${entityIdOrWikiId}.mdx`);
    if (existsSync(directPath)) return directPath;
  }

  // If it looks like a wikiId (E-number), resolve via idRegistry
  if (/^E\d+$/i.test(entityIdOrWikiId)) {
    const registry = loadIdRegistry();
    const slug = registry.byWikiId[entityIdOrWikiId.toUpperCase()];
    if (slug) {
      for (const subdir of searchDirs) {
        const regPath = join(CONTENT_DIR_ABS, subdir, `${slug}.mdx`);
        if (existsSync(regPath)) return regPath;
      }
    }
  }

  // Broader search: scan directories for matching files
  for (const subdir of searchDirs) {
    const searchDir = join(CONTENT_DIR_ABS, subdir);
    if (!existsSync(searchDir)) continue;
    try {
      const files = readdirSync(searchDir);
      const match = files.find((f) => f === `${entityIdOrWikiId}.mdx`);
      if (match) return join(searchDir, match);
    } catch (err: unknown) {
      console.warn(`Warning: Failed to read directory ${searchDir}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return null;
}

/**
 * Find the entity in a set of entries by slug or wikiId.
 */
function findEntity(entries: EntityYamlEntry[], entityIdOrWikiId: string): EntityYamlEntry | null {
  // Match by id (slug)
  const byId = entries.find((e) => e.id === entityIdOrWikiId);
  if (byId) return byId;

  // Match by wikiId
  if (/^E\d+$/i.test(entityIdOrWikiId)) {
    const byWikiId = entries.find((e) => e.wikiId === entityIdOrWikiId.toUpperCase());
    if (byWikiId) return byWikiId;
  }

  return null;
}

/**
 * Determine the entity type from an entity entry.
 * Maps entity 'type' to the extraction schema type.
 */
function resolveEntityType(entity: EntityYamlEntry): string {
  const t = entity.type;
  // Map known types
  if (t === 'person' || t === 'researcher') return 'person';
  if (t === 'organization' || t === 'lab' || t === 'funder') return 'organization';
  if (t === 'ai-model') return 'ai-model';
  if (t === 'policy') return 'policy';
  return t;
}

// ---------------------------------------------------------------------------
// Footnote parsing — delegates to crux/lib/footnote-parser.ts
// ---------------------------------------------------------------------------

interface Footnote {
  id: string;
  text: string;
  url: string | null;
}

/**
 * Parse footnote definitions from MDX source.
 * Returns a map of footnote ID -> { text, url }.
 *
 * Uses the shared footnote-parser library for numeric footnotes ([^1], [^2]) and
 * supplements with a regex pass for named footnotes ([^ref-id], [^cheapcheck]) which
 * the library does not handle.
 */
function parseFootnoteMap(mdxContent: string): Map<string, Footnote> {
  const footnotes = new Map<string, Footnote>();

  // Use the shared library for numeric footnotes
  const libFootnotes: ParsedFootnote[] = parseFootnotesLib(mdxContent);
  for (const fn of libFootnotes) {
    const id = `^${fn.number}`;
    footnotes.set(id, { id, text: fn.rawText, url: fn.url });
  }

  // Supplement: capture named (non-numeric) footnotes the library doesn't handle
  const namedPattern = /^\[(\^[a-zA-Z][^\]]*)\]:\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = namedPattern.exec(mdxContent)) !== null) {
    const id = match[1];
    if (footnotes.has(id)) continue; // already captured
    const text = match[2].trim();
    const urlMatch = text.match(/(https?:\/\/[^\s)]+)/);
    const url = urlMatch ? urlMatch[1] : null;
    footnotes.set(id, { id, text, url });
  }

  return footnotes;
}

/**
 * Extract footnote references used in a specific section of text.
 * Returns footnote IDs like ["^rc-d679", "^rc-02ec", "^1"].
 */
function extractFootnoteRefs(text: string): string[] {
  const refs: string[] = [];
  const refPattern = /\[(\^[^\]]+)\]/g;
  let match: RegExpExecArray | null;
  while ((match = refPattern.exec(text)) !== null) {
    // Skip footnote definitions (which start with [^...]:)
    const afterMatch = text.slice(match.index + match[0].length);
    if (!afterMatch.startsWith(':')) {
      refs.push(match[1]);
    }
  }
  return [...new Set(refs)];
}

// ---------------------------------------------------------------------------
// Entity-type-specific extraction prompts
// ---------------------------------------------------------------------------

function getExtractionPrompt(entityType: string, entityTitle: string, mdxContent: string): string {
  const sourceBlock = `
IMPORTANT: Only extract claims that have footnote references in the source text. Each item you extract should correspond to information explicitly stated in the text with citations.

SOURCE TEXT:
${mdxContent.slice(0, 80_000)}`;

  const commonRules = `
RULES:
- Only include items with clear evidence in the text (preferably with footnote references)
- If a field has no data, use an empty array or null as appropriate
- Do NOT fabricate or infer data not present in the text`;

  switch (entityType) {
    case 'person':
      return `You are extracting structured biographical data from a wiki page about "${entityTitle}".
${sourceBlock}

Extract the following structured data. Respond with ONLY valid JSON (no markdown fencing, no explanation):

{
  "education": [
    { "degree": "string (e.g. 'Ph.D., Computer Science')", "institution": "string", "year": number_or_null }
  ],
  "roles": [
    { "title": "string", "organization": "string", "startYear": number_or_null, "endYear": number_or_null, "type": "key-person|advisory|board" }
  ],
  "publications": [
    { "title": "string", "year": number_or_null, "venue": "string (e.g. 'ICLR 2021', 'arXiv')", "type": "paper|book" }
  ],
  "researchFocus": ["string", "string"],
  "birthYear": number_or_null
}
${commonRules}
- For roles, "type" should be "key-person" for executive/leadership, "advisory" for advisor roles, "board" for board memberships
- For publications, only include the most notable ones (max 10)
- For education, include degree level, field, institution, and graduation year
- For researchFocus, list 3-7 concise topic areas (e.g., "mechanistic interpretability", "out-of-distribution detection")`;

    case 'organization':
      return `You are extracting structured organizational data from a wiki page about "${entityTitle}".
${sourceBlock}

Extract the following structured data. Respond with ONLY valid JSON (no markdown fencing, no explanation):

{
  "foundedYear": number_or_null,
  "headquarters": "string_or_null (e.g. 'San Francisco, CA')",
  "funding": [
    { "amount": "string (e.g. '\\$10M', '\\$2.5B')", "source": "string", "year": number_or_null }
  ],
  "keyPersonnel": [
    { "name": "string", "title": "string (e.g. 'CEO', 'Chief Scientist')" }
  ],
  "products": [
    { "name": "string", "description": "string (brief, max 100 chars)" }
  ],
  "parentOrg": "string_or_null"
}
${commonRules}
- For funding, include notable rounds, grants, or donations with amounts when available
- For keyPersonnel, include current leadership (max 10)
- For products, include major products, services, or research outputs (max 10)
- parentOrg is the parent company/organization if this is a subsidiary or division`;

    case 'ai-model':
      return `You are extracting structured model data from a wiki page about "${entityTitle}".
${sourceBlock}

Extract the following structured data. Respond with ONLY valid JSON (no markdown fencing, no explanation):

{
  "releaseDate": "string_or_null (e.g. '2024-03-14', 'March 2024')",
  "developer": "string_or_null (e.g. 'Anthropic', 'OpenAI')",
  "parameterCount": "string_or_null (e.g. '175B', '70B')",
  "contextWindow": "string_or_null (e.g. '200K tokens', '128K')",
  "capabilities": ["string"],
  "benchmarkScores": [
    { "benchmark": "string (e.g. 'MMLU', 'HumanEval')", "score": "string (e.g. '86.8%', '92.0')" }
  ],
  "pricing": {
    "input": "string_or_null (e.g. '\\$3.00/1M tokens')",
    "output": "string_or_null (e.g. '\\$15.00/1M tokens')"
  }
}
${commonRules}
- For capabilities, list key capabilities or modalities (e.g., "code generation", "vision", "tool use")
- For benchmarkScores, only include scores explicitly mentioned with citations (max 15)
- For pricing, use the format as listed in the source (per-token or per-request)`;

    case 'policy':
      return `You are extracting structured policy/legislation data from a wiki page about "${entityTitle}".
${sourceBlock}

Extract the following structured data. Respond with ONLY valid JSON (no markdown fencing, no explanation):

{
  "introducedDate": "string_or_null (e.g. '2024-01-15', 'January 2024')",
  "status": "string_or_null (e.g. 'enacted', 'proposed', 'in committee', 'withdrawn')",
  "jurisdiction": "string_or_null (e.g. 'United States', 'European Union', 'California')",
  "sponsor": "string_or_null (e.g. 'Sen. Smith')",
  "provisions": [
    { "title": "string (short title for the provision)", "description": "string (brief description, max 200 chars)" }
  ],
  "stakeholders": [
    { "name": "string", "position": "string (support|oppose|neutral)", "reason": "string (brief reason, max 150 chars)" }
  ]
}
${commonRules}
- For provisions, include major sections or requirements of the policy (max 10)
- For stakeholders, include organizations or individuals who have publicly stated positions
- status should reflect the current legislative state`;

    default:
      return `You are extracting structured data from a wiki page about "${entityTitle}".
${sourceBlock}

Extract the following structured data. Respond with ONLY valid JSON (no markdown fencing, no explanation):

{
  "description": "string_or_null (1-2 sentence summary)",
  "keyFacts": ["string (concise factual statement)"],
  "relatedEntities": [
    { "name": "string", "relationship": "string (e.g. 'developed by', 'part of', 'related to')" }
  ]
}
${commonRules}
- For keyFacts, extract 3-10 notable factual claims from the text
- For relatedEntities, include organizations, people, or concepts mentioned in relation to this entity (max 10)`;
  }
}

// ---------------------------------------------------------------------------
// Entity-type-specific validation functions
// ---------------------------------------------------------------------------

function validateOrganizationData(parsed: Record<string, unknown>): OrganizationExtractedData {
  return {
    kind: 'organization',
    foundedYear: typeof parsed.foundedYear === 'number' ? parsed.foundedYear : null,
    headquarters: typeof parsed.headquarters === 'string' && parsed.headquarters.length > 0 ? parsed.headquarters : null,
    funding: validateFunding(parsed.funding),
    keyPersonnel: validateKeyPersonnel(parsed.keyPersonnel),
    products: validateProducts(parsed.products),
    parentOrg: typeof parsed.parentOrg === 'string' && parsed.parentOrg.length > 0 ? parsed.parentOrg : null,
  };
}

function validateFunding(raw: unknown): FundingEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      amount: String(item.amount ?? ''),
      source: String(item.source ?? ''),
      year: typeof item.year === 'number' ? item.year : null,
    }))
    .filter((f) => f.amount.length > 0 && f.source.length > 0);
}

function validateKeyPersonnel(raw: unknown): KeyPersonnelEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      name: String(item.name ?? ''),
      title: String(item.title ?? ''),
    }))
    .filter((p) => p.name.length > 0 && p.title.length > 0)
    .slice(0, 10);
}

function validateProducts(raw: unknown): ProductEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      name: String(item.name ?? ''),
      description: String(item.description ?? '').slice(0, 100),
    }))
    .filter((p) => p.name.length > 0)
    .slice(0, 10);
}

function validateAiModelData(parsed: Record<string, unknown>): AiModelExtractedData {
  const pricing = parsed.pricing as Record<string, unknown> | undefined;
  return {
    kind: 'ai-model',
    releaseDate: typeof parsed.releaseDate === 'string' && parsed.releaseDate.length > 0 ? parsed.releaseDate : null,
    developer: typeof parsed.developer === 'string' && parsed.developer.length > 0 ? parsed.developer : null,
    parameterCount: typeof parsed.parameterCount === 'string' && parsed.parameterCount.length > 0 ? parsed.parameterCount : null,
    contextWindow: typeof parsed.contextWindow === 'string' && parsed.contextWindow.length > 0 ? parsed.contextWindow : null,
    capabilities: validateStringArray(parsed.capabilities),
    benchmarkScores: validateBenchmarkScores(parsed.benchmarkScores),
    pricing: {
      input: pricing && typeof pricing.input === 'string' && pricing.input.length > 0 ? pricing.input : null,
      output: pricing && typeof pricing.output === 'string' && pricing.output.length > 0 ? pricing.output : null,
    },
  };
}

function validateBenchmarkScores(raw: unknown): BenchmarkScoreEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      benchmark: String(item.benchmark ?? ''),
      score: String(item.score ?? ''),
    }))
    .filter((b) => b.benchmark.length > 0 && b.score.length > 0)
    .slice(0, 15);
}

function validatePolicyData(parsed: Record<string, unknown>): PolicyExtractedData {
  return {
    kind: 'policy',
    introducedDate: typeof parsed.introducedDate === 'string' && parsed.introducedDate.length > 0 ? parsed.introducedDate : null,
    status: typeof parsed.status === 'string' && parsed.status.length > 0 ? parsed.status : null,
    jurisdiction: typeof parsed.jurisdiction === 'string' && parsed.jurisdiction.length > 0 ? parsed.jurisdiction : null,
    sponsor: typeof parsed.sponsor === 'string' && parsed.sponsor.length > 0 ? parsed.sponsor : null,
    provisions: validateProvisions(parsed.provisions),
    stakeholders: validateStakeholders(parsed.stakeholders),
  };
}

function validateProvisions(raw: unknown): ProvisionEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      title: String(item.title ?? ''),
      description: String(item.description ?? '').slice(0, 200),
    }))
    .filter((p) => p.title.length > 0 && p.description.length > 0)
    .slice(0, 10);
}

function validateStakeholders(raw: unknown): StakeholderEntry[] {
  if (!Array.isArray(raw)) return [];
  const validPositions = new Set(['support', 'oppose', 'neutral']);
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      name: String(item.name ?? ''),
      position: validPositions.has(String(item.position)) ? String(item.position) : 'neutral',
      reason: String(item.reason ?? '').slice(0, 150),
    }))
    .filter((s) => s.name.length > 0)
    .slice(0, 10);
}

function validateDefaultData(parsed: Record<string, unknown>): DefaultExtractedData {
  return {
    kind: 'default',
    description: typeof parsed.description === 'string' && parsed.description.length > 0 ? parsed.description : null,
    keyFacts: validateStringArray(parsed.keyFacts),
    relatedEntities: validateRelatedEntities(parsed.relatedEntities),
  };
}

function validateRelatedEntities(raw: unknown): RelatedEntityEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      name: String(item.name ?? ''),
      relationship: String(item.relationship ?? ''),
    }))
    .filter((r) => r.name.length > 0 && r.relationship.length > 0)
    .slice(0, 10);
}

// ---------------------------------------------------------------------------
// LLM extraction
// ---------------------------------------------------------------------------

async function extractStructuredData(
  client: ReturnType<typeof createLlmClient>,
  tracker: CostTracker,
  mdxContent: string,
  entityTitle: string,
  entityType: string,
): Promise<ExtractedData> {
  const prompt = getExtractionPrompt(entityType, entityTitle, mdxContent);

  const result = await callLlm(client, prompt, {
    model: MODELS.haiku,
    maxTokens: 4000,
    temperature: 0,
    tracker,
    label: `extract-${entityType}`,
    retryLabel: `extract-${entityType}`,
  });

  try {
    let text = result.text.trim();
    // Strip markdown code fences if present
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    const parsed = JSON.parse(text) as Record<string, unknown>;

    return validateExtractedData(parsed, entityType);
  } catch (parseErr: unknown) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    throw new Error(`Failed to parse LLM extraction response: ${msg}`);
  }
}

/**
 * Validate and type-narrow the parsed LLM response based on entity type.
 */
function validateExtractedData(parsed: Record<string, unknown>, entityType: string): ExtractedData {
  switch (entityType) {
    case 'person':
      return {
        kind: 'person' as const,
        education: validateEducation(parsed.education),
        roles: validateRoles(parsed.roles),
        publications: validatePublications(parsed.publications),
        researchFocus: validateStringArray(parsed.researchFocus),
        birthYear: typeof parsed.birthYear === 'number' ? parsed.birthYear : null,
      };
    case 'organization':
      return validateOrganizationData(parsed);
    case 'ai-model':
      return validateAiModelData(parsed);
    case 'policy':
      return validatePolicyData(parsed);
    default:
      return validateDefaultData(parsed);
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

function validateEducation(raw: unknown): EducationEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      degree: String(item.degree ?? ''),
      institution: String(item.institution ?? ''),
      year: typeof item.year === 'number' ? item.year : null,
    }))
    .filter((e) => e.degree.length > 0 && e.institution.length > 0);
}

function validateRoles(raw: unknown): RoleEntry[] {
  if (!Array.isArray(raw)) return [];
  const validTypes = new Set(['key-person', 'advisory', 'board']);
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      title: String(item.title ?? ''),
      organization: String(item.organization ?? ''),
      startYear: typeof item.startYear === 'number' ? item.startYear : null,
      endYear: typeof item.endYear === 'number' ? item.endYear : null,
      type: (validTypes.has(String(item.type)) ? String(item.type) : 'key-person') as RoleEntry['type'],
    }))
    .filter((r) => r.title.length > 0 && r.organization.length > 0);
}

function validatePublications(raw: unknown): PublicationEntry[] {
  if (!Array.isArray(raw)) return [];
  const validTypes = new Set(['paper', 'book']);
  return raw
    .filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object')
    .map((item) => ({
      title: String(item.title ?? ''),
      year: typeof item.year === 'number' ? item.year : null,
      venue: String(item.venue ?? ''),
      type: (validTypes.has(String(item.type)) ? String(item.type) : 'paper') as PublicationEntry['type'],
    }))
    .filter((p) => p.title.length > 0)
    .slice(0, 10);
}

function validateStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((item): item is string => typeof item === 'string' && item.length > 0)
    .slice(0, 7);
}

// ---------------------------------------------------------------------------
// Source-Check
// ---------------------------------------------------------------------------

async function verifyClaim(
  client: ReturnType<typeof createLlmClient>,
  tracker: CostTracker,
  claim: string,
  sourceContent: string,
  sourceUrl: string,
): Promise<{ verified: boolean; confidence: number; note: string }> {
  const prompt = `You are verifying a biographical claim against a source document.

CLAIM TO VERIFY:
${claim}

SOURCE CONTENT (from ${sourceUrl}):
${sourceContent.slice(0, 50_000)}

INSTRUCTIONS:
Does this source confirm the claim above? Respond in exactly this JSON format (no markdown fencing):

{
  "verified": true_or_false,
  "confidence": <number between 0.0 and 1.0>,
  "note": "<brief explanation, max 200 chars>"
}

RULES:
- "verified": true if the source clearly supports the claim
- "verified": false if the source contradicts or doesn't mention the claim
- "confidence": how certain you are (0.0 = no information, 1.0 = perfectly confirmed)
- Be conservative: if the source doesn't clearly mention the claim, set verified=false and confidence < 0.5`;

  const result = await callLlm(client, prompt, {
    model: MODELS.haiku,
    maxTokens: 500,
    temperature: 0,
    tracker,
    label: 'verify-claim',
    retryLabel: 'verify-claim',
  });

  try {
    let text = result.text.trim();
    if (text.startsWith('```')) {
      text = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    }
    const parsed = JSON.parse(text) as { verified?: boolean; confidence?: number; note?: string };

    return {
      verified: parsed.verified === true,
      confidence: typeof parsed.confidence === 'number'
        ? Math.max(0, Math.min(1, parsed.confidence))
        : 0.5,
      note: String(parsed.note ?? '').slice(0, 200),
    };
  } catch (parseErr: unknown) {
    const msg = parseErr instanceof Error ? parseErr.message : String(parseErr);
    return {
      verified: false,
      confidence: 0,
      note: `LLM response parsing failed: ${msg.slice(0, 150)}`,
    };
  }
}

/**
 * Build sourcing claims from extracted data based on entity type.
 * Returns a list of claims to verify, each with a description and search keyword for footnotes.
 */
function buildClaimsToVerify(
  extracted: ExtractedData,
  _entityType: string,
  mdxContent: string,
  footnotes: Map<string, Footnote>,
): Array<{
  field: string;
  description: string;
  footnoteRef: string | null;
  footnoteUrl: string | null;
  value: unknown;
}> {
  const claimsToVerify: Array<{
    field: string;
    description: string;
    footnoteRef: string | null;
    footnoteUrl: string | null;
    value: unknown;
  }> = [];

  const addClaim = (field: string, desc: string, keyword: string, value: unknown) => {
    const relevantRefs = findRelevantFootnotes(mdxContent, footnotes, keyword);
    claimsToVerify.push({
      field,
      description: desc,
      footnoteRef: relevantRefs[0]?.id ?? null,
      footnoteUrl: relevantRefs[0]?.url ?? null,
      value,
    });
  };

  switch (extracted.kind) {
    case 'person': {
      for (const edu of extracted.education) {
        const desc = `${edu.degree} from ${edu.institution}${edu.year ? ` (${edu.year})` : ''}`;
        addClaim('education', desc, edu.institution, edu);
      }
      for (const role of extracted.roles) {
        const desc = `${role.title} at ${role.organization}${role.startYear ? ` (${role.startYear}${role.endYear ? `-${role.endYear}` : '+'})` : ''}`;
        addClaim('roles', desc, role.organization, role);
      }
      if (extracted.birthYear !== null) {
        addClaim('birthYear', `Born in ${extracted.birthYear}`, 'born', extracted.birthYear);
      }
      break;
    }

    case 'organization': {
      if (extracted.foundedYear !== null) {
        addClaim('foundedYear', `Founded in ${extracted.foundedYear}`, 'founded', extracted.foundedYear);
      }
      if (extracted.headquarters) {
        addClaim('headquarters', `Headquarters: ${extracted.headquarters}`, 'headquarters', extracted.headquarters);
      }
      for (const fund of extracted.funding) {
        addClaim('funding', `${fund.amount} from ${fund.source}${fund.year ? ` (${fund.year})` : ''}`, fund.source, fund);
      }
      for (const person of extracted.keyPersonnel) {
        addClaim('keyPersonnel', `${person.name} as ${person.title}`, person.name, person);
      }
      break;
    }

    case 'ai-model': {
      if (extracted.developer) {
        addClaim('developer', `Developed by ${extracted.developer}`, extracted.developer, extracted.developer);
      }
      if (extracted.releaseDate) {
        addClaim('releaseDate', `Released ${extracted.releaseDate}`, 'release', extracted.releaseDate);
      }
      if (extracted.parameterCount) {
        addClaim('parameterCount', `${extracted.parameterCount} parameters`, 'parameter', extracted.parameterCount);
      }
      for (const score of extracted.benchmarkScores) {
        addClaim('benchmarkScores', `${score.benchmark}: ${score.score}`, score.benchmark, score);
      }
      break;
    }

    case 'policy': {
      if (extracted.status) {
        addClaim('status', `Status: ${extracted.status}`, 'status', extracted.status);
      }
      if (extracted.sponsor) {
        addClaim('sponsor', `Sponsored by ${extracted.sponsor}`, extracted.sponsor, extracted.sponsor);
      }
      for (const stakeholder of extracted.stakeholders) {
        addClaim('stakeholders', `${stakeholder.name}: ${stakeholder.position}`, stakeholder.name, stakeholder);
      }
      break;
    }

    case 'default': {
      for (const fact of extracted.keyFacts) {
        // Use first 3 words as keyword for footnote search
        const keyword = fact.split(/\s+/).slice(0, 3).join(' ');
        addClaim('keyFacts', fact, keyword, fact);
      }
      break;
    }
  }

  return claimsToVerify;
}

/**
 * Run sourcing on extracted data against footnote sources.
 */
async function verifyExtractedData(
  client: ReturnType<typeof createLlmClient>,
  tracker: CostTracker,
  extracted: ExtractedData,
  entityType: string,
  mdxContent: string,
  budgetUsd: number,
  log: ReturnType<typeof createLogger>,
): Promise<VerifiedClaim[]> {
  const c = log.colors;
  const footnotes = parseFootnoteMap(mdxContent);
  const claims: VerifiedClaim[] = [];

  // Build claims to verify based on entity type
  const claimsToVerify = buildClaimsToVerify(extracted, entityType, mdxContent, footnotes);

  // Verify each claim that has a source URL
  let sourcingCount = 0;
  for (const claim of claimsToVerify) {
    // Check budget
    if (tracker.totalCost >= budgetUsd) {
      console.log(`  ${c.yellow}Budget limit reached ($${tracker.totalCost.toFixed(4)} / $${budgetUsd}), skipping remaining sourcing${c.reset}`);
      claims.push({
        field: claim.field,
        value: claim.value,
        footnoteRef: claim.footnoteRef,
        footnoteUrl: claim.footnoteUrl,
        verified: false,
        confidence: 0,
        sourcingNote: 'Skipped: budget limit reached',
      });
      continue;
    }

    if (!claim.footnoteUrl) {
      claims.push({
        field: claim.field,
        value: claim.value,
        footnoteRef: claim.footnoteRef,
        footnoteUrl: null,
        verified: false,
        confidence: 0,
        sourcingNote: 'No source URL found for sourcing',
      });
      continue;
    }

    console.log(`  ${c.dim}Verifying:${c.reset} ${claim.description}`);
    console.log(`    ${c.dim}Source:${c.reset} ${claim.footnoteUrl}`);

    try {
      const fetched = await fetchSource({
        url: claim.footnoteUrl,
        extractMode: 'relevant',
        query: claim.description,
      });

      if (fetched.status !== 'ok' || !fetched.content || fetched.content.length < 50) {
        claims.push({
          field: claim.field,
          value: claim.value,
          footnoteRef: claim.footnoteRef,
          footnoteUrl: claim.footnoteUrl,
          verified: false,
          confidence: 0,
          sourcingNote: `Source fetch failed: ${fetched.status}`,
        });
        console.log(`    ${c.yellow}Source unavailable (${fetched.status})${c.reset}`);
        continue;
      }

      const sourcingResult = await verifyClaim(
        client,
        tracker,
        claim.description,
        fetched.content,
        claim.footnoteUrl,
      );

      claims.push({
        field: claim.field,
        value: claim.value,
        footnoteRef: claim.footnoteRef,
        footnoteUrl: claim.footnoteUrl,
        verified: sourcingResult.verified,
        confidence: sourcingResult.confidence,
        sourcingNote: sourcingResult.note,
      });

      const color = sourcingResult.verified ? c.green : sourcingResult.confidence > 0.3 ? c.yellow : c.red;
      console.log(`    ${color}${sourcingResult.verified ? 'VERIFIED' : 'UNVERIFIED'} (${(sourcingResult.confidence * 100).toFixed(0)}%)${c.reset} ${sourcingResult.note}`);
      sourcingCount++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      claims.push({
        field: claim.field,
        value: claim.value,
        footnoteRef: claim.footnoteRef,
        footnoteUrl: claim.footnoteUrl,
        verified: false,
        confidence: 0,
        sourcingNote: `Error: ${msg.slice(0, 150)}`,
      });
      console.log(`    ${c.red}Error: ${msg.slice(0, 100)}${c.reset}`);
    }
  }

  console.log(`  ${c.dim}Verified ${sourcingCount} claims${c.reset}`);
  return claims;
}

/**
 * Find footnotes relevant to a given keyword by searching the MDX text
 * around occurrences of that keyword for footnote references.
 */
function findRelevantFootnotes(
  mdxContent: string,
  footnotes: Map<string, Footnote>,
  keyword: string,
): Footnote[] {
  const results: Footnote[] = [];
  const lower = mdxContent.toLowerCase();
  const keyLower = keyword.toLowerCase();

  // Find positions of the keyword in the text
  let pos = 0;
  while ((pos = lower.indexOf(keyLower, pos)) !== -1) {
    // Look at surrounding 500 characters for footnote refs
    const start = Math.max(0, pos - 50);
    const end = Math.min(mdxContent.length, pos + keyword.length + 500);
    const surroundingText = mdxContent.slice(start, end);

    const refs = extractFootnoteRefs(surroundingText);
    for (const ref of refs) {
      const footnote = footnotes.get(ref);
      if (footnote && footnote.url && !results.some((r) => r.id === footnote.id)) {
        results.push(footnote);
      }
    }

    pos += keyword.length;
  }

  return results;
}

// ---------------------------------------------------------------------------
// Apply extracted data to YAML
// ---------------------------------------------------------------------------

/**
 * Set a custom field on an entity, creating the customFields array if needed.
 */
function setCustomField(entity: EntityYamlEntry, label: string, value: string): void {
  if (!entity.customFields) entity.customFields = [];
  const existing = entity.customFields.find((f) => f.label === label);
  if (existing) {
    existing.value = value;
  } else {
    entity.customFields.push({ label, value });
  }
}

function applyToEntity(
  entity: EntityYamlEntry,
  extracted: ExtractedData,
  _entityType: string,
  verifiedClaims: VerifiedClaim[],
  requireSourcing: boolean,
): string[] {
  const applied: string[] = [];

  // Build a set of verified fields for quick lookup
  const verifiedFields = new Map<string, VerifiedClaim[]>();
  for (const claim of verifiedClaims) {
    const existing = verifiedFields.get(claim.field) ?? [];
    existing.push(claim);
    verifiedFields.set(claim.field, existing);
  }

  // Helper: is a field's data usable?
  const isUsable = (field: string): boolean => {
    if (!requireSourcing) return true;
    const fieldClaims = verifiedFields.get(field);
    if (!fieldClaims || fieldClaims.length === 0) return false;
    // At least one claim must be verified with confidence >= 0.7
    return fieldClaims.some((c) => c.verified && c.confidence >= 0.7);
  };

  switch (extracted.kind) {
    case 'person': {
      // Update education in customFields
      if (extracted.education.length > 0 && isUsable('education')) {
        const educationStr = extracted.education
          .map((e) => `${e.degree}, ${e.institution}${e.year ? ` (${e.year})` : ''}`)
          .join('; ');
        setCustomField(entity, 'Education', educationStr);
        applied.push('education');
      }

      // Update Known For from research focus
      if (extracted.researchFocus.length > 0 && isUsable('researchFocus')) {
        setCustomField(entity, 'Known For', extracted.researchFocus.join(', '));
        applied.push('researchFocus');
      }

      // Update tags from research focus areas
      if (extracted.researchFocus.length > 0 && isUsable('researchFocus')) {
        const newTags = extracted.researchFocus.map((focus) =>
          focus.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, ''),
        );
        const existingTags = new Set(entity.tags ?? []);
        const addedTags = newTags.filter((t) => t.length > 0 && !existingTags.has(t));
        if (addedTags.length > 0) {
          entity.tags = [...(entity.tags ?? []), ...addedTags];
          applied.push('tags');
        }
      }
      break;
    }

    case 'organization': {
      if (extracted.foundedYear !== null && isUsable('foundedYear')) {
        setCustomField(entity, 'Founded', String(extracted.foundedYear));
        applied.push('foundedYear');
      }
      if (extracted.headquarters && isUsable('headquarters')) {
        setCustomField(entity, 'Headquarters', extracted.headquarters);
        applied.push('headquarters');
      }
      if (extracted.keyPersonnel.length > 0 && isUsable('keyPersonnel')) {
        const personnelStr = extracted.keyPersonnel.map((p) => `${p.name} (${p.title})`).join('; ');
        setCustomField(entity, 'Key Personnel', personnelStr);
        applied.push('keyPersonnel');
      }
      if (extracted.products.length > 0 && isUsable('products')) {
        const productsStr = extracted.products.map((p) => p.name).join(', ');
        setCustomField(entity, 'Products', productsStr);
        applied.push('products');
      }
      if (extracted.parentOrg && isUsable('parentOrg')) {
        setCustomField(entity, 'Parent Organization', extracted.parentOrg);
        applied.push('parentOrg');
      }
      break;
    }

    case 'ai-model': {
      if (extracted.developer && isUsable('developer')) {
        setCustomField(entity, 'Developer', extracted.developer);
        applied.push('developer');
      }
      if (extracted.releaseDate && isUsable('releaseDate')) {
        setCustomField(entity, 'Release Date', extracted.releaseDate);
        applied.push('releaseDate');
      }
      if (extracted.parameterCount && isUsable('parameterCount')) {
        setCustomField(entity, 'Parameters', extracted.parameterCount);
        applied.push('parameterCount');
      }
      if (extracted.contextWindow && isUsable('contextWindow')) {
        setCustomField(entity, 'Context Window', extracted.contextWindow);
        applied.push('contextWindow');
      }
      if (extracted.capabilities.length > 0 && isUsable('capabilities')) {
        setCustomField(entity, 'Capabilities', extracted.capabilities.join(', '));
        applied.push('capabilities');
      }
      break;
    }

    case 'policy': {
      if (extracted.status && isUsable('status')) {
        setCustomField(entity, 'Status', extracted.status);
        applied.push('status');
      }
      if (extracted.jurisdiction && isUsable('jurisdiction')) {
        setCustomField(entity, 'Jurisdiction', extracted.jurisdiction);
        applied.push('jurisdiction');
      }
      if (extracted.sponsor && isUsable('sponsor')) {
        setCustomField(entity, 'Sponsor', extracted.sponsor);
        applied.push('sponsor');
      }
      if (extracted.introducedDate && isUsable('introducedDate')) {
        setCustomField(entity, 'Introduced', extracted.introducedDate);
        applied.push('introducedDate');
      }
      break;
    }

    case 'default': {
      if (extracted.description && !entity.description && isUsable('description')) {
        entity.description = extracted.description;
        applied.push('description');
      }
      if (extracted.keyFacts.length > 0 && isUsable('keyFacts')) {
        // Add key facts as tags
        const newTags = extracted.keyFacts
          .slice(0, 5)
          .map((f) => f.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').slice(0, 40))
          .filter((t) => t.length > 2);
        const existingTags = new Set(entity.tags ?? []);
        const addedTags = newTags.filter((t) => !existingTags.has(t));
        if (addedTags.length > 0) {
          entity.tags = [...(entity.tags ?? []), ...addedTags];
          applied.push('keyFacts');
        }
      }
      break;
    }
  }

  // Update lastUpdated
  if (applied.length > 0) {
    entity.lastUpdated = new Date().toISOString().slice(0, 7); // YYYY-MM format
  }

  return applied;
}

// ---------------------------------------------------------------------------
// Main extraction pipeline
// ---------------------------------------------------------------------------

interface ExtractOptions {
  dryRun?: boolean;
  apply?: boolean;
  verify?: boolean;
  budget?: string | number;
  entityType?: string;
  limit?: string | number;
  json?: boolean;
  ci?: boolean;
  [key: string]: unknown;
}

async function extract(args: string[], options: ExtractOptions): Promise<CommandResult> {
  const log = createLogger(Boolean(options.ci));
  const c = log.colors;
  const doApply = Boolean(options.apply);
  const doVerify = Boolean(options.verify);
  const budgetUsd = parseFloat(String(options.budget ?? '5'));
  const entityLimit = parseIntOpt(options.limit, 10);

  // Determine mode: single entity or batch
  const entityIdArg = args.find((a) => !a.startsWith('-'));
  const entityTypeFilter = options.entityType as string | undefined;

  if (!entityIdArg && !entityTypeFilter) {
    return {
      output: 'Usage: pnpm crux w extract-structured-data <entity-id> [--verify] [--apply]\n'
        + '       pnpm crux w extract-structured-data --entity-type=person --limit=10\n'
        + '       pnpm crux w extract-structured-data --entity-type=organization --limit=5\n\n'
        + 'Use --help for full options.',
      exitCode: 1,
    };
  }

  // Load entities based on mode
  let allEntries: EntityYamlEntry[];
  let effectiveEntityType: string | undefined = entityTypeFilter;

  if (entityIdArg) {
    // Single entity mode: search across all YAML files
    const { entries } = loadAllEntityYamls();
    allEntries = entries;
  } else if (entityTypeFilter) {
    // Batch mode: load type-specific YAML file
    try {
      allEntries = loadEntityYaml(entityTypeFilter);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return { output: `Failed to load entity YAML for type '${entityTypeFilter}': ${msg}`, exitCode: 1 };
    }
  } else {
    allEntries = [];
  }

  // Determine which entities to process
  const entitiesToProcess: Array<{ entity: EntityYamlEntry; mdxPath: string; entityType: string }> = [];

  if (entityIdArg) {
    // Single entity mode
    const entity = findEntity(allEntries, entityIdArg);
    if (!entity) {
      return { output: `Entity not found: ${entityIdArg}`, exitCode: 1 };
    }
    const resolvedType = resolveEntityType(entity);
    const mdxPath = findMdxFile(entity.id, resolvedType);
    if (!mdxPath) {
      return { output: `MDX file not found for entity: ${entity.id}`, exitCode: 1 };
    }
    entitiesToProcess.push({ entity, mdxPath, entityType: resolvedType });
    effectiveEntityType = resolvedType;
  } else {
    // Batch mode
    const filterType = entityTypeFilter ?? 'person';
    let candidates = allEntries.filter((e) => {
      const resolved = resolveEntityType(e);
      return resolved === filterType || e.type === filterType;
    });

    // Cache findMdxFile results to avoid calling it twice per entity
    const mdxPathCache = new Map<string, string | null>();
    for (const e of candidates) {
      mdxPathCache.set(e.id, findMdxFile(e.id, filterType));
    }

    // Only include entities that have wiki pages
    candidates = candidates.filter((e) => mdxPathCache.get(e.id) !== null);

    // Limit
    candidates = candidates.slice(0, entityLimit);

    for (const entity of candidates) {
      const mdxPath = mdxPathCache.get(entity.id)!;
      entitiesToProcess.push({ entity, mdxPath, entityType: filterType });
    }
  }

  if (entitiesToProcess.length === 0) {
    return { output: 'No entities with wiki pages found to process.', exitCode: 0 };
  }

  const typeLabel = effectiveEntityType ?? 'mixed';
  console.log(`${c.bold}Extract Structured Data${c.reset} (${typeLabel})`);
  console.log(`${c.dim}Processing ${entitiesToProcess.length} entit${entitiesToProcess.length === 1 ? 'y' : 'ies'}${c.reset}`);
  console.log(`${c.dim}Mode: ${doApply ? 'apply' : 'dry-run'} | Verify: ${doVerify ? 'yes' : 'no'} | Budget: $${budgetUsd}${c.reset}\n`);

  // Create LLM client
  let client: ReturnType<typeof createLlmClient>;
  try {
    client = createLlmClient();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { output: `Failed to create LLM client: ${msg}`, exitCode: 1 };
  }
  const tracker = new CostTracker();

  // Process each entity
  const results: ExtractionResult[] = [];

  for (let i = 0; i < entitiesToProcess.length; i++) {
    const { entity, mdxPath, entityType } = entitiesToProcess[i];

    // Check budget
    if (tracker.totalCost >= budgetUsd) {
      console.log(`${c.yellow}Budget limit reached ($${tracker.totalCost.toFixed(4)} / $${budgetUsd}), stopping.${c.reset}`);
      break;
    }

    console.log(`${c.bold}[${i + 1}/${entitiesToProcess.length}] ${entity.title}${c.reset} (${entity.id}) [${entityType}]`);
    console.log(`  ${c.dim}MDX: ${relative(PROJECT_ROOT, mdxPath)}${c.reset}`);

    // Read MDX content
    const mdxContent = readFileSync(mdxPath, 'utf-8');

    // Step 2: LLM extraction
    let extracted: ExtractedData;
    try {
      extracted = await extractStructuredData(client, tracker, mdxContent, entity.title, entityType);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  ${c.red}Extraction failed: ${msg.slice(0, 200)}${c.reset}`);
      continue;
    }

    console.log(`  ${c.green}Extracted:${c.reset} ${formatExtractionSummary(extracted, entityType)}`);

    // Step 3: Source-check (optional)
    let verifiedClaims: VerifiedClaim[] = [];
    if (doVerify) {
      console.log(`  ${c.dim}Running sourcing...${c.reset}`);
      verifiedClaims = await verifyExtractedData(
        client,
        tracker,
        extracted,
        entityType,
        mdxContent,
        budgetUsd,
        log,
      );
    }

    // Step 4: Apply or dry-run
    let appliedFields: string[] = [];
    if (doApply) {
      appliedFields = applyToEntity(entity, extracted, entityType, verifiedClaims, doVerify);
      if (appliedFields.length > 0) {
        console.log(`  ${c.green}Applied:${c.reset} ${appliedFields.join(', ')}`);
      } else {
        console.log(`  ${c.dim}No fields applied${doVerify ? ' (none met sourcing threshold)' : ''}${c.reset}`);
      }
    }

    results.push({
      entityId: entity.id,
      entityTitle: entity.title,
      entityType,
      mdxPath: relative(PROJECT_ROOT, mdxPath),
      extracted,
      verifiedClaims,
      appliedFields,
      costUsd: tracker.totalCost,
    });

    console.log('');
  }

  // Write YAML if applying
  if (doApply && results.some((r) => r.appliedFields.length > 0)) {
    if (entityIdArg) {
      // Single-entity mode: load the entity's specific YAML file, update in-place, save back.
      // This avoids data corruption from filtering allEntries by resolved type (which could
      // drop entities with aliased types like 'researcher' → 'person').
      const { fileByEntityId } = loadAllEntityYamls();
      for (const { entity } of entitiesToProcess) {
        const yamlFilename = fileByEntityId.get(entity.id);
        if (!yamlFilename) {
          console.log(`${c.red}Cannot find YAML file for entity ${entity.id}${c.reset}`);
          continue;
        }
        try {
          const yamlPath = join(PROJECT_ROOT, 'data/entities', yamlFilename);
          const raw = readFileSync(yamlPath, 'utf-8');
          const fileEntries = (parseYaml(raw) ?? []) as EntityYamlEntry[];
          if (!Array.isArray(fileEntries)) continue;

          // Find and replace the entity in-place
          const idx = fileEntries.findIndex((e) => e.id === entity.id);
          if (idx === -1) {
            console.log(`${c.red}Entity ${entity.id} not found in ${yamlFilename}${c.reset}`);
            continue;
          }
          fileEntries[idx] = entity;

          // Determine header from config or use a generic one
          const entityType = resolveEntityType(entity);
          const config = ENTITY_TYPE_CONFIG[entityType];
          const header = config?.yamlHeader ?? `# Entities\n`;
          const yamlStr = stringifyYaml(fileEntries, {
            lineWidth: 120,
            defaultStringType: 'PLAIN',
            defaultKeyType: 'PLAIN',
          });
          writeFileSync(yamlPath, `${header}\n${yamlStr}`);
          console.log(`${c.green}Saved changes to ${yamlFilename}${c.reset}`);
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(`${c.red}Failed to save YAML for ${entity.id}: ${msg}${c.reset}`);
        }
      }
    } else {
      // Batch mode: all entities come from the same type-specific YAML file, save all at once
      const eType = entityTypeFilter ?? 'person';
      try {
        saveEntityYaml(eType, allEntries);
        const yamlFile = ENTITY_TYPE_CONFIG[eType]?.yamlFile ?? 'misc.yaml';
        console.log(`${c.green}Saved changes to ${yamlFile}${c.reset}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(`${c.red}Failed to save YAML for ${eType}: ${msg}${c.reset}`);
      }
    }
  }

  // Summary
  const totalExtracted = results.length;
  const totalApplied = results.filter((r) => r.appliedFields.length > 0).length;
  const totalVerified = results.reduce(
    (sum, r) => sum + r.verifiedClaims.filter((vc) => vc.verified).length,
    0,
  );

  let output = `\n${c.bold}Summary${c.reset}\n`;
  output += `${c.dim}${'─'.repeat(50)}${c.reset}\n`;
  output += `  Entities processed:  ${totalExtracted}\n`;
  if (doVerify) {
    output += `  Claims verified:     ${totalVerified}\n`;
  }
  if (doApply) {
    output += `  Entities updated:    ${totalApplied}\n`;
  }
  output += `  Cost: $${tracker.totalCost.toFixed(4)}\n`;
  output += `  Tokens: ${tracker.totalTokens.input} in / ${tracker.totalTokens.output} out\n`;

  if (options.json) {
    return {
      output: JSON.stringify({ results, cost: tracker.toJSON() }, null, 2),
      exitCode: 0,
    };
  }

  // In dry-run mode, also print extracted data summary
  if (!doApply) {
    output += `\n${c.dim}Dry-run mode — no changes written. Use --apply to write changes.${c.reset}\n`;

    for (const result of results) {
      output += `\n${c.bold}${result.entityTitle}${c.reset} (${result.entityId}) [${result.entityType}]:\n`;
      output += formatExtractedDataDisplay(result.extracted, result.entityType, c);

      if (result.verifiedClaims.length > 0) {
        const verified = result.verifiedClaims.filter((vc) => vc.verified).length;
        const total = result.verifiedClaims.length;
        output += `  ${c.cyan}Source-Check:${c.reset} ${verified}/${total} claims verified\n`;
      }
    }
  }

  return { output, exitCode: 0 };
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

/**
 * Format a one-line extraction summary for console output.
 */
function formatExtractionSummary(extracted: ExtractedData, _entityType: string): string {
  switch (extracted.kind) {
    case 'person':
      return `${extracted.education.length} education, ${extracted.roles.length} roles, ${extracted.publications.length} publications, ${extracted.researchFocus.length} focus areas`;
    case 'organization':
      return `${extracted.funding.length} funding, ${extracted.keyPersonnel.length} personnel, ${extracted.products.length} products`;
    case 'ai-model':
      return `${extracted.capabilities.length} capabilities, ${extracted.benchmarkScores.length} benchmarks`;
    case 'policy':
      return `${extracted.provisions.length} provisions, ${extracted.stakeholders.length} stakeholders`;
    case 'default':
      return `${extracted.keyFacts.length} key facts, ${extracted.relatedEntities.length} related entities`;
  }
}

/**
 * Format extracted data for detailed dry-run display.
 */
function formatExtractedDataDisplay(
  extracted: ExtractedData,
  _entityType: string,
  c: ReturnType<typeof createLogger>['colors'],
): string {
  let output = '';

  switch (extracted.kind) {
    case 'person': {
      if (extracted.education.length > 0) {
        output += `  ${c.cyan}Education:${c.reset}\n`;
        for (const edu of extracted.education) {
          output += `    - ${edu.degree}, ${edu.institution}${edu.year ? ` (${edu.year})` : ''}\n`;
        }
      }

      if (extracted.roles.length > 0) {
        output += `  ${c.cyan}Roles:${c.reset}\n`;
        for (const role of extracted.roles) {
          output += `    - ${role.title} at ${role.organization}${role.startYear ? ` (${role.startYear}${role.endYear ? `-${role.endYear}` : '+'})` : ''} [${role.type}]\n`;
        }
      }

      if (extracted.publications.length > 0) {
        output += `  ${c.cyan}Publications:${c.reset} ${extracted.publications.length} items\n`;
        for (const pub of extracted.publications.slice(0, 5)) {
          output += `    - ${pub.title} (${pub.venue}, ${pub.year ?? '?'}) [${pub.type}]\n`;
        }
        if (extracted.publications.length > 5) {
          output += `    ... and ${extracted.publications.length - 5} more\n`;
        }
      }

      if (extracted.researchFocus.length > 0) {
        output += `  ${c.cyan}Research Focus:${c.reset} ${extracted.researchFocus.join(', ')}\n`;
      }

      if (extracted.birthYear !== null) {
        output += `  ${c.cyan}Birth Year:${c.reset} ${extracted.birthYear}\n`;
      }
      break;
    }

    case 'organization': {
      if (extracted.foundedYear !== null) {
        output += `  ${c.cyan}Founded:${c.reset} ${extracted.foundedYear}\n`;
      }
      if (extracted.headquarters) {
        output += `  ${c.cyan}Headquarters:${c.reset} ${extracted.headquarters}\n`;
      }
      if (extracted.parentOrg) {
        output += `  ${c.cyan}Parent Org:${c.reset} ${extracted.parentOrg}\n`;
      }

      if (extracted.keyPersonnel.length > 0) {
        output += `  ${c.cyan}Key Personnel:${c.reset}\n`;
        for (const person of extracted.keyPersonnel) {
          output += `    - ${person.name} (${person.title})\n`;
        }
      }

      if (extracted.funding.length > 0) {
        output += `  ${c.cyan}Funding:${c.reset}\n`;
        for (const fund of extracted.funding) {
          output += `    - ${fund.amount} from ${fund.source}${fund.year ? ` (${fund.year})` : ''}\n`;
        }
      }

      if (extracted.products.length > 0) {
        output += `  ${c.cyan}Products:${c.reset}\n`;
        for (const product of extracted.products) {
          output += `    - ${product.name}: ${product.description}\n`;
        }
      }
      break;
    }

    case 'ai-model': {
      if (extracted.developer) output += `  ${c.cyan}Developer:${c.reset} ${extracted.developer}\n`;
      if (extracted.releaseDate) output += `  ${c.cyan}Release Date:${c.reset} ${extracted.releaseDate}\n`;
      if (extracted.parameterCount) output += `  ${c.cyan}Parameters:${c.reset} ${extracted.parameterCount}\n`;
      if (extracted.contextWindow) output += `  ${c.cyan}Context Window:${c.reset} ${extracted.contextWindow}\n`;

      if (extracted.capabilities.length > 0) {
        output += `  ${c.cyan}Capabilities:${c.reset} ${extracted.capabilities.join(', ')}\n`;
      }

      if (extracted.benchmarkScores.length > 0) {
        output += `  ${c.cyan}Benchmarks:${c.reset}\n`;
        for (const score of extracted.benchmarkScores.slice(0, 10)) {
          output += `    - ${score.benchmark}: ${score.score}\n`;
        }
        if (extracted.benchmarkScores.length > 10) {
          output += `    ... and ${extracted.benchmarkScores.length - 10} more\n`;
        }
      }

      if (extracted.pricing.input || extracted.pricing.output) {
        output += `  ${c.cyan}Pricing:${c.reset} Input: ${extracted.pricing.input ?? 'N/A'} | Output: ${extracted.pricing.output ?? 'N/A'}\n`;
      }
      break;
    }

    case 'policy': {
      if (extracted.status) output += `  ${c.cyan}Status:${c.reset} ${extracted.status}\n`;
      if (extracted.jurisdiction) output += `  ${c.cyan}Jurisdiction:${c.reset} ${extracted.jurisdiction}\n`;
      if (extracted.sponsor) output += `  ${c.cyan}Sponsor:${c.reset} ${extracted.sponsor}\n`;
      if (extracted.introducedDate) output += `  ${c.cyan}Introduced:${c.reset} ${extracted.introducedDate}\n`;

      if (extracted.provisions.length > 0) {
        output += `  ${c.cyan}Provisions:${c.reset}\n`;
        for (const prov of extracted.provisions) {
          output += `    - ${prov.title}: ${prov.description}\n`;
        }
      }

      if (extracted.stakeholders.length > 0) {
        output += `  ${c.cyan}Stakeholders:${c.reset}\n`;
        for (const sh of extracted.stakeholders) {
          output += `    - ${sh.name} (${sh.position}): ${sh.reason}\n`;
        }
      }
      break;
    }

    case 'default': {
      if (extracted.description) {
        output += `  ${c.cyan}Description:${c.reset} ${extracted.description}\n`;
      }

      if (extracted.keyFacts.length > 0) {
        output += `  ${c.cyan}Key Facts:${c.reset}\n`;
        for (const fact of extracted.keyFacts) {
          output += `    - ${fact}\n`;
        }
      }

      if (extracted.relatedEntities.length > 0) {
        output += `  ${c.cyan}Related Entities:${c.reset}\n`;
        for (const rel of extracted.relatedEntities) {
          output += `    - ${rel.name} (${rel.relationship})\n`;
        }
      }
      break;
    }
  }

  return output;
}

// ── Command Registry ────────────────────────────────────────────────────────

export const commands = {
  default: extract,
  extract,
};

export function getHelp(): string {
  return `
Extract Structured Data from Wiki Pages

Extracts structured data from wiki page prose for any entity type and
optionally writes to the YAML entity data layer after sourcing
against footnote sources.

Supported entity types:
  person         education, roles, publications, researchFocus, birthYear
  organization   foundedYear, headquarters, funding, keyPersonnel, products, parentOrg
  ai-model       releaseDate, developer, parameterCount, contextWindow, capabilities,
                 benchmarkScores, pricing
  policy         introducedDate, status, jurisdiction, sponsor, provisions, stakeholders
  (default)      description, keyFacts, relatedEntities

Commands:
  extract (default)   Extract structured data from an entity's wiki page

Options:
  --dry-run            Print extracted data as JSON, don't write anything (default behavior)
  --apply              Write verified claims to the appropriate YAML entity file
  --verify             Verify claims against footnote source URLs before writing
  --budget=<N>         Maximum LLM spend in dollars (default: 5)
  --entity-type=<T>    Process all entities of this type in batch mode (e.g., person, organization)
  --limit=<N>          Max entities to process in batch mode (default: 10)
  --json               Output results as JSON

Examples:
  pnpm crux w extract-structured-data dan-hendrycks
  pnpm crux w extract-structured-data dan-hendrycks --verify
  pnpm crux w extract-structured-data dan-hendrycks --verify --apply
  pnpm crux w extract-structured-data E89 --dry-run
  pnpm crux w extract-structured-data --entity-type=person --budget=20 --limit=5
  pnpm crux w extract-structured-data --entity-type=organization --limit=10
  pnpm crux w extract-structured-data --entity-type=ai-model --limit=5
`;
}
