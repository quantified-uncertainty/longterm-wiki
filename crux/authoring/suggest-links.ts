#!/usr/bin/env -S node --import tsx/esm --no-warnings

/**
 * Suggest Entity Cross-Links
 *
 * Analyzes entities to find missing relatedEntries by:
 * 1. Co-occurrence: entities mentioned on each other's pages (via EntityLink)
 * 2. Shared tags: entities with overlapping tags in YAML
 * 3. Transitive connections: if A→B and B→C, suggest A→C
 * 4. Reverse links: if A lists B in relatedEntries but B doesn't list A
 *
 * Usage:
 *   crux content suggest-links --type=organization     # Suggest for all orgs
 *   crux content suggest-links --entity=anthropic       # Suggest for one entity
 *   crux content suggest-links --type=organization --apply  # Write to YAML
 *   crux content suggest-links --type=organization --json   # JSON output
 *   crux content suggest-links --type=organization --min-score=3  # Filter by score
 */

import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { getColors } from '../lib/output.ts';
import { findMdxFiles } from '../lib/file-utils.ts';
import { ENTITY_LINK_RE } from '../lib/patterns.ts';
import { getContentBody } from '../lib/mdx-utils.ts';
import {
  PROJECT_ROOT,
  CONTENT_DIR_ABS,
  loadPathRegistry,
  type PathRegistry,
} from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const APPLY_MODE = args.includes('--apply');
const HELP_MODE = args.includes('--help');
const colors = getColors(JSON_MODE);

function getArg(name: string): string | undefined {
  const flag = `--${name}=`;
  const arg = args.find(a => a.startsWith(flag));
  if (arg) return arg.slice(flag.length);
  const idx = args.indexOf(`--${name}`);
  if (idx !== -1 && idx + 1 < args.length && !args[idx + 1].startsWith('--')) {
    return args[idx + 1];
  }
  return undefined;
}

const TYPE_FILTER = getArg('type');
const ENTITY_FILTER = getArg('entity');
const MIN_SCORE = parseInt(getArg('min-score') || '2', 10);
const LIMIT = parseInt(getArg('limit') || '0', 10);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface YamlEntity {
  id: string;
  type: string;
  title: string;
  tags?: string[];
  relatedEntries?: Array<{ id: string; type?: string; relationship?: string }>;
  description?: string;
  summaryPage?: string;
  numericId?: string;
}

export interface Suggestion {
  targetId: string;
  suggestedId: string;
  suggestedTitle: string;
  suggestedType: string;
  score: number;
  reasons: string[];
  relationship?: string;
}

export interface EntitySuggestions {
  entityId: string;
  entityTitle: string;
  existingCount: number;
  suggestions: Suggestion[];
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

function showHelp(): void {
  console.log(`
${colors.bold}Suggest Entity Cross-Links${colors.reset}

Analyzes entities to find missing relatedEntries using:
  1. Co-occurrence (EntityLink references across pages)
  2. Shared tags between entities
  3. Transitive connections (friend-of-friend)
  4. Reverse links (A→B exists but B→A missing)

${colors.bold}Usage:${colors.reset}
  crux content suggest-links --type=organization          Suggest for all organizations
  crux content suggest-links --entity=anthropic            Suggest for one entity
  crux content suggest-links --type=organization --apply   Write suggestions to YAML
  crux content suggest-links --type=organization --json    JSON output

${colors.bold}Options:${colors.reset}
  --type=<t>       Filter by entity type (organization, person, risk, etc.)
  --entity=<id>    Analyze a specific entity
  --min-score=<n>  Minimum suggestion score (default: 2)
  --limit=<n>      Limit number of entities to process (0=all)
  --apply          Write suggestions to YAML files
  --json           JSON output
  --help           Show this help

${colors.bold}Scoring:${colors.reset}
  +3  Co-occurrence (entities link to each other's pages)
  +2  Reverse link (A→B exists, B→A missing)
  +2  Shared tags (3+ overlapping tags)
  +1  Shared tags (1-2 overlapping tags)
  +1  Transitive connection (friend-of-friend)

${colors.bold}Examples:${colors.reset}
  crux content suggest-links --type=organization
  crux content suggest-links --type=organization --min-score=3 --apply
  crux content suggest-links --entity=mats
`);
}

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------

function loadAllEntitiesFromYaml(): YamlEntity[] {
  const entitiesDir = path.join(PROJECT_ROOT, 'data/entities');
  const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  const entities: YamlEntity[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(entitiesDir, file), 'utf-8');
      const parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as YamlEntity[] | null;
      if (Array.isArray(parsed)) {
        for (const entry of parsed) {
          if (entry?.id && entry?.title) {
            entities.push(entry);
          }
        }
      }
    } catch {
      // Skip malformed YAML files
    }
  }

  return entities;
}

/** Build a map of entityId → set of EntityLink ids found on that entity's page */
function buildPageLinkMap(pathRegistry: PathRegistry): Map<string, Set<string>> {
  const linkMap = new Map<string, Set<string>>();
  const files = findMdxFiles(CONTENT_DIR_ABS);

  // Build reverse map: file path → entity id
  const pathToEntityId = new Map<string, string>();
  for (const [entityId, urlPath] of Object.entries(pathRegistry)) {
    const relativePath = urlPath.replace(/^\//, '').replace(/\/$/, '');
    const possiblePaths = [
      path.join(CONTENT_DIR_ABS, relativePath + '.mdx'),
      path.join(CONTENT_DIR_ABS, relativePath, 'index.mdx'),
    ];
    for (const p of possiblePaths) {
      pathToEntityId.set(p, entityId);
    }
  }

  for (const file of files) {
    const entityId = pathToEntityId.get(file);
    if (!entityId) continue;

    try {
      const content = fs.readFileSync(file, 'utf-8');
      const body = getContentBody(content);
      const links = new Set<string>();

      for (const match of body.matchAll(ENTITY_LINK_RE)) {
        links.add(match[1]);
      }

      if (links.size > 0) {
        linkMap.set(entityId, links);
      }
    } catch {
      // Skip files that can't be read
    }
  }

  return linkMap;
}

// ---------------------------------------------------------------------------
// Analysis signals
// ---------------------------------------------------------------------------

/** Signal 1: Co-occurrence — entities that reference each other via EntityLink on pages */
export function findCoOccurrences(
  entityId: string,
  pageLinkMap: Map<string, Set<string>>,
  entityIndex: Map<string, YamlEntity>,
): Map<string, string[]> {
  const suggestions = new Map<string, string[]>();
  const myPageLinks = pageLinkMap.get(entityId) || new Set();

  // Entities whose pages link TO this entity
  for (const [otherId, otherLinks] of pageLinkMap) {
    if (otherId === entityId) continue;
    if (!entityIndex.has(otherId)) continue;

    if (otherLinks.has(entityId)) {
      const reasons = suggestions.get(otherId) || [];
      reasons.push(`${otherId}'s page links to ${entityId}`);
      suggestions.set(otherId, reasons);
    }
  }

  // Entities that this entity's page links TO
  for (const linkedId of myPageLinks) {
    if (linkedId === entityId) continue;
    if (!entityIndex.has(linkedId)) continue;

    const reasons = suggestions.get(linkedId) || [];
    reasons.push(`${entityId}'s page links to ${linkedId}`);
    suggestions.set(linkedId, reasons);
  }

  return suggestions;
}

/** Signal 2: Shared tags between entities */
export function findSharedTags(
  entity: YamlEntity,
  allEntities: YamlEntity[],
): Map<string, { count: number; tags: string[] }> {
  const results = new Map<string, { count: number; tags: string[] }>();
  const myTags = new Set(entity.tags || []);
  if (myTags.size === 0) return results;

  for (const other of allEntities) {
    if (other.id === entity.id) continue;
    const otherTags = other.tags || [];
    const shared = otherTags.filter(t => myTags.has(t));
    if (shared.length > 0) {
      results.set(other.id, { count: shared.length, tags: shared });
    }
  }

  return results;
}

/** Signal 3: Transitive connections — friend-of-friend */
export function findTransitive(
  entityId: string,
  allEntities: YamlEntity[],
  entityIndex: Map<string, YamlEntity>,
): Map<string, string[]> {
  const results = new Map<string, string[]>();
  const entity = entityIndex.get(entityId);
  if (!entity?.relatedEntries) return results;

  const directLinks = new Set(entity.relatedEntries.map(r => r.id));

  for (const related of entity.relatedEntries) {
    const neighbor = entityIndex.get(related.id);
    if (!neighbor?.relatedEntries) continue;

    for (const neighborRelated of neighbor.relatedEntries) {
      if (neighborRelated.id === entityId) continue;
      if (directLinks.has(neighborRelated.id)) continue;
      if (!entityIndex.has(neighborRelated.id)) continue;

      const reasons = results.get(neighborRelated.id) || [];
      reasons.push(`via ${related.id}`);
      results.set(neighborRelated.id, reasons);
    }
  }

  return results;
}

/** Signal 4: Reverse links — A→B exists in YAML but B→A doesn't */
export function findReverseLinks(
  entityId: string,
  allEntities: YamlEntity[],
  entityIndex: Map<string, YamlEntity>,
): Map<string, string[]> {
  const results = new Map<string, string[]>();
  const entity = entityIndex.get(entityId);
  const directLinks = new Set(
    (entity?.relatedEntries || []).map(r => r.id),
  );

  for (const other of allEntities) {
    if (other.id === entityId) continue;
    if (directLinks.has(other.id)) continue;

    const otherRelated = other.relatedEntries || [];
    if (otherRelated.some(r => r.id === entityId)) {
      results.set(other.id, [`${other.id} already links to ${entityId}`]);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Scoring and suggestion generation
// ---------------------------------------------------------------------------

export function generateSuggestions(
  entity: YamlEntity,
  allEntities: YamlEntity[],
  entityIndex: Map<string, YamlEntity>,
  pageLinkMap: Map<string, Set<string>>,
): Suggestion[] {
  const existingRelated = new Set(
    (entity.relatedEntries || []).map(r => r.id),
  );

  // Accumulate scores and reasons per candidate
  const candidates = new Map<string, { score: number; reasons: string[]; relationship?: string }>();

  function addSignal(id: string, score: number, reason: string, relationship?: string) {
    if (existingRelated.has(id)) return;
    if (id === entity.id) return;
    const existing = candidates.get(id) || { score: 0, reasons: [], relationship: undefined };
    existing.score += score;
    existing.reasons.push(reason);
    if (relationship && !existing.relationship) {
      existing.relationship = relationship;
    }
    candidates.set(id, existing);
  }

  // 1. Co-occurrence (highest signal)
  const coOccurrences = findCoOccurrences(entity.id, pageLinkMap, entityIndex);
  for (const [id, reasons] of coOccurrences) {
    addSignal(id, 3, `co-occurrence: ${reasons[0]}`);
  }

  // 2. Reverse links
  const reverseLinks = findReverseLinks(entity.id, allEntities, entityIndex);
  for (const [id, reasons] of reverseLinks) {
    addSignal(id, 2, `reverse-link: ${reasons[0]}`);
  }

  // 3. Shared tags
  const sharedTags = findSharedTags(entity, allEntities);
  for (const [id, info] of sharedTags) {
    if (info.count >= 3) {
      addSignal(id, 2, `shared-tags(${info.count}): ${info.tags.slice(0, 5).join(', ')}`);
    } else if (info.count >= 1) {
      addSignal(id, 1, `shared-tags(${info.count}): ${info.tags.join(', ')}`);
    }
  }

  // 4. Transitive connections
  const transitive = findTransitive(entity.id, allEntities, entityIndex);
  for (const [id, reasons] of transitive) {
    addSignal(id, 1, `transitive: ${reasons.slice(0, 3).join(', ')}`);
  }

  // Convert to sorted suggestions
  const suggestions: Suggestion[] = [];
  for (const [id, data] of candidates) {
    const target = entityIndex.get(id);
    if (!target) continue;

    suggestions.push({
      targetId: entity.id,
      suggestedId: id,
      suggestedTitle: target.title,
      suggestedType: target.type,
      score: data.score,
      reasons: data.reasons,
      relationship: data.relationship,
    });
  }

  // Sort by score descending, then alphabetically
  suggestions.sort((a, b) => b.score - a.score || a.suggestedId.localeCompare(b.suggestedId));

  return suggestions;
}

// ---------------------------------------------------------------------------
// YAML writing
// ---------------------------------------------------------------------------

function applyToYaml(allSuggestions: EntitySuggestions[]): { applied: number; files: string[] } {
  const entitiesDir = path.join(PROJECT_ROOT, 'data/entities');
  const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  let applied = 0;
  const modifiedFiles: string[] = [];

  // Build a map of entityId → suggestions to apply
  const suggestionsByEntity = new Map<string, Suggestion[]>();
  for (const es of allSuggestions) {
    const filtered = es.suggestions.filter(s => s.score >= MIN_SCORE);
    if (filtered.length > 0) {
      // Take top 5 suggestions per entity
      suggestionsByEntity.set(es.entityId, filtered.slice(0, 5));
    }
  }

  if (suggestionsByEntity.size === 0) return { applied: 0, files: [] };

  for (const file of files) {
    const filePath = path.join(entitiesDir, file);
    const raw = fs.readFileSync(filePath, 'utf-8');
    let parsed: YamlEntity[];
    try {
      parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as YamlEntity[];
      if (!Array.isArray(parsed)) continue;
    } catch {
      continue;
    }

    let modified = false;

    for (const entity of parsed) {
      const toApply = suggestionsByEntity.get(entity.id);
      if (!toApply) continue;

      if (!entity.relatedEntries) {
        entity.relatedEntries = [];
      }

      const existingIds = new Set(entity.relatedEntries.map(r => r.id));

      for (const suggestion of toApply) {
        if (existingIds.has(suggestion.suggestedId)) continue;

        const entry: { id: string; type: string; relationship?: string } = {
          id: suggestion.suggestedId,
          type: suggestion.suggestedType,
        };

        entity.relatedEntries.push(entry);
        existingIds.add(suggestion.suggestedId);
        applied++;
        modified = true;
      }
    }

    if (modified) {
      const yamlStr = yaml.dump(parsed, {
        lineWidth: 120,
        noRefs: true,
        quotingType: '"',
        forceQuotes: false,
        flowLevel: -1,
      });
      // js-yaml outputs array items without the leading `- ` prefix matching
      // the original YAML format. We need to re-serialize carefully.
      // Instead, let's use a surgical approach: modify the raw YAML text.
      // Actually, the file uses a specific YAML format. Let's use the
      // round-trip approach with the original text.
      modifiedFiles.push(file);
      // We'll write the re-serialized version and add a comment header
      const header = parsed.length > 0 && raw.startsWith('#')
        ? raw.slice(0, raw.indexOf('\n') + 1) + '\n'
        : '';
      fs.writeFileSync(filePath, header + yamlStr);
    }
  }

  return { applied, files: modifiedFiles };
}

// ---------------------------------------------------------------------------
// Surgical YAML editing (preserves original formatting)
// ---------------------------------------------------------------------------

/**
 * Apply suggestions by surgically inserting relatedEntries into the raw YAML text.
 * This preserves the original formatting, comments, and structure.
 */
function applySurgically(allSuggestions: EntitySuggestions[]): { applied: number; files: string[] } {
  const entitiesDir = path.join(PROJECT_ROOT, 'data/entities');
  const files = fs.readdirSync(entitiesDir).filter(f => f.endsWith('.yaml'));
  let applied = 0;
  const modifiedFiles: string[] = [];

  // Build a map of entityId → suggestions to apply
  const suggestionsByEntity = new Map<string, Suggestion[]>();
  for (const es of allSuggestions) {
    const filtered = es.suggestions.filter(s => s.score >= MIN_SCORE);
    if (filtered.length > 0) {
      suggestionsByEntity.set(es.entityId, filtered.slice(0, 5));
    }
  }

  if (suggestionsByEntity.size === 0) return { applied: 0, files: [] };

  for (const file of files) {
    const filePath = path.join(entitiesDir, file);
    let raw = fs.readFileSync(filePath, 'utf-8');
    let parsed: YamlEntity[];
    try {
      parsed = yaml.load(raw, { schema: yaml.JSON_SCHEMA }) as YamlEntity[];
      if (!Array.isArray(parsed)) continue;
    } catch {
      continue;
    }

    let modified = false;

    for (const entity of parsed) {
      const toApply = suggestionsByEntity.get(entity.id);
      if (!toApply) continue;

      const existingIds = new Set(
        (entity.relatedEntries || []).map(r => r.id),
      );

      // Filter out already-existing
      const newEntries = toApply.filter(s => !existingIds.has(s.suggestedId));
      if (newEntries.length === 0) continue;

      // Build YAML text for new entries
      const newYaml = newEntries
        .map(s => {
          let entry = `    - id: ${s.suggestedId}\n      type: ${s.suggestedType}`;
          return entry;
        })
        .join('\n');

      if (entity.relatedEntries && entity.relatedEntries.length > 0) {
        // Find the last relatedEntries item and insert after it
        // Look for the pattern: relatedEntries:\n    - id: ...\n      type: ...
        const entityBlockStart = raw.indexOf(`\n- id: ${entity.id}\n`);
        if (entityBlockStart === -1 && !raw.startsWith(`- id: ${entity.id}\n`)) continue;

        const blockStart = entityBlockStart === -1 ? 0 : entityBlockStart + 1;
        const nextEntityMatch = raw.indexOf('\n- id: ', blockStart + 5);
        const blockEnd = nextEntityMatch === -1 ? raw.length : nextEntityMatch;
        const entityBlock = raw.slice(blockStart, blockEnd);

        // Find the last relatedEntries item in this block
        const relatedStart = entityBlock.indexOf('relatedEntries:');
        if (relatedStart === -1) continue;

        // Find where relatedEntries section ends (next top-level field at 2-space indent)
        const relatedSection = entityBlock.slice(relatedStart);
        const lines = relatedSection.split('\n');
        let insertAfterLine = 0;
        for (let i = 1; i < lines.length; i++) {
          const line = lines[i];
          // A line starting with exactly 2 spaces (not 4+) and having content
          // marks the end of relatedEntries
          if (line.match(/^  [a-zA-Z]/) || line.match(/^- /)) {
            break;
          }
          if (line.trim().length > 0) {
            insertAfterLine = i;
          }
        }

        // Calculate the exact position to insert
        const linesBeforeInsert = lines.slice(0, insertAfterLine + 1).join('\n');
        const insertPos = blockStart + relatedStart + linesBeforeInsert.length;

        raw = raw.slice(0, insertPos) + '\n' + newYaml + raw.slice(insertPos);
      } else {
        // Entity has no relatedEntries — need to add the section
        const entityBlockStart = raw.indexOf(`\n- id: ${entity.id}\n`);
        const isFirst = raw.startsWith(`- id: ${entity.id}\n`);
        if (entityBlockStart === -1 && !isFirst) continue;

        const blockStart = isFirst ? 0 : entityBlockStart + 1;

        // Find a good insertion point — before 'sources:' or 'description:' or 'tags:'
        const nextEntityMatch = raw.indexOf('\n- id: ', blockStart + 5);
        const blockEnd = nextEntityMatch === -1 ? raw.length : nextEntityMatch;
        const entityBlock = raw.slice(blockStart, blockEnd);

        // Insert before 'sources:' if it exists, otherwise before 'description:'
        let insertBefore = 'sources:';
        let insertIdx = entityBlock.indexOf('\n  ' + insertBefore);
        if (insertIdx === -1) {
          insertBefore = 'description:';
          insertIdx = entityBlock.indexOf('\n  ' + insertBefore);
        }
        if (insertIdx === -1) {
          insertBefore = 'tags:';
          insertIdx = entityBlock.indexOf('\n  ' + insertBefore);
        }
        if (insertIdx === -1) {
          insertBefore = 'clusters:';
          insertIdx = entityBlock.indexOf('\n  ' + insertBefore);
        }

        if (insertIdx !== -1) {
          const absoluteInsertPos = blockStart + insertIdx;
          const relatedBlock = `\n  relatedEntries:\n${newYaml}`;
          raw = raw.slice(0, absoluteInsertPos) + relatedBlock + raw.slice(absoluteInsertPos);
        }
      }

      applied += newEntries.length;
      modified = true;
    }

    if (modified) {
      fs.writeFileSync(filePath, raw);
      modifiedFiles.push(file);
    }
  }

  return { applied, files: modifiedFiles };
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function formatSuggestions(allSuggestions: EntitySuggestions[]): void {
  const withSuggestions = allSuggestions.filter(
    es => es.suggestions.filter(s => s.score >= MIN_SCORE).length > 0,
  );

  if (withSuggestions.length === 0) {
    console.log(`${colors.green}No suggestions above threshold (min-score=${MIN_SCORE}).${colors.reset}`);
    return;
  }

  console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}`);
  console.log(`${colors.bold}  Cross-Link Suggestions${colors.reset}`);
  console.log(`${colors.bold}${colors.blue}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${colors.reset}\n`);

  let totalSuggestions = 0;

  for (const es of withSuggestions) {
    const filtered = es.suggestions.filter(s => s.score >= MIN_SCORE);
    if (filtered.length === 0) continue;

    const existingLabel = es.existingCount > 0
      ? `${colors.dim}(${es.existingCount} existing)${colors.reset}`
      : `${colors.yellow}(none)${colors.reset}`;

    console.log(`${colors.bold}${es.entityTitle}${colors.reset} ${colors.dim}(${es.entityId})${colors.reset} ${existingLabel}`);

    for (const s of filtered.slice(0, 8)) {
      const scoreColor = s.score >= 4 ? colors.green : s.score >= 3 ? colors.yellow : colors.dim;
      console.log(`  ${scoreColor}[${s.score}]${colors.reset} ${s.suggestedTitle} ${colors.dim}(${s.suggestedId}, ${s.suggestedType})${colors.reset}`);
      for (const reason of s.reasons.slice(0, 2)) {
        console.log(`      ${colors.dim}${reason}${colors.reset}`);
      }
      totalSuggestions++;
    }

    if (filtered.length > 8) {
      console.log(`  ${colors.dim}... and ${filtered.length - 8} more${colors.reset}`);
      totalSuggestions += filtered.length - 8;
    }
    console.log();
  }

  console.log(`${colors.bold}Summary:${colors.reset} ${totalSuggestions} suggestions for ${withSuggestions.length} entities (min-score=${MIN_SCORE})`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  if (HELP_MODE) {
    showHelp();
    process.exit(0);
    return;
  }

  if (!TYPE_FILTER && !ENTITY_FILTER) {
    console.error(`${colors.red}Error: Must specify --type=<type> or --entity=<id>${colors.reset}`);
    console.log(`${colors.dim}Run with --help for usage.${colors.reset}`);
    process.exit(1);
    return;
  }

  // Load all entities from YAML
  const allEntities = loadAllEntitiesFromYaml();
  const entityIndex = new Map(allEntities.map(e => [e.id, e]));

  // Filter to target entities
  let targetEntities: YamlEntity[];
  if (ENTITY_FILTER) {
    const entity = entityIndex.get(ENTITY_FILTER);
    if (!entity) {
      console.error(`${colors.red}Entity not found: ${ENTITY_FILTER}${colors.reset}`);
      process.exit(1);
      return;
    }
    targetEntities = [entity];
  } else {
    // Filter by type — match entities from the organizations.yaml or by type field
    targetEntities = allEntities.filter(e => {
      if (TYPE_FILTER === 'organization') {
        // Organization types include: lab, lab-academic, lab-research, organization
        return ['organization', 'lab', 'lab-academic', 'lab-research'].includes(e.type);
      }
      return e.type === TYPE_FILTER;
    });
  }

  if (LIMIT > 0) {
    targetEntities = targetEntities.slice(0, LIMIT);
  }

  if (targetEntities.length === 0) {
    console.error(`${colors.red}No entities found for type: ${TYPE_FILTER}${colors.reset}`);
    process.exit(1);
    return;
  }

  if (!JSON_MODE) {
    console.log(`${colors.dim}Loading page links...${colors.reset}`);
  }

  const pathRegistry = loadPathRegistry();
  const pageLinkMap = buildPageLinkMap(pathRegistry);

  if (!JSON_MODE) {
    console.log(`${colors.dim}Analyzing ${targetEntities.length} entities...${colors.reset}\n`);
  }

  // Generate suggestions for each target entity
  const allSuggestions: EntitySuggestions[] = [];

  for (const entity of targetEntities) {
    const suggestions = generateSuggestions(entity, allEntities, entityIndex, pageLinkMap);

    allSuggestions.push({
      entityId: entity.id,
      entityTitle: entity.title,
      existingCount: (entity.relatedEntries || []).length,
      suggestions,
    });
  }

  if (JSON_MODE) {
    const output = allSuggestions
      .filter(es => es.suggestions.filter(s => s.score >= MIN_SCORE).length > 0)
      .map(es => ({
        ...es,
        suggestions: es.suggestions.filter(s => s.score >= MIN_SCORE),
      }));
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  formatSuggestions(allSuggestions);

  if (APPLY_MODE) {
    console.log(`\n${colors.bold}Applying suggestions...${colors.reset}`);
    const result = applySurgically(allSuggestions);
    console.log(`${colors.green}Applied ${result.applied} links across ${result.files.length} files.${colors.reset}`);
    if (result.files.length > 0) {
      console.log(`${colors.dim}Modified files: ${result.files.join(', ')}${colors.reset}`);
    }
  } else {
    const totalApplicable = allSuggestions.reduce(
      (sum, es) => sum + es.suggestions.filter(s => s.score >= MIN_SCORE).length,
      0,
    );
    if (totalApplicable > 0) {
      console.log(`\n${colors.dim}Run with --apply to write suggestions to YAML files.${colors.reset}`);
    }
  }
}

// Only run when executed directly (not when imported for testing)
import { fileURLToPath as _fileURLToPath } from 'url';
if (process.argv[1] === _fileURLToPath(import.meta.url)) {
  main();
}
