/**
 * Rule: Detect Unlinked Entity Mentions
 *
 * Scans content for mentions of known entities that aren't wrapped in EntityLink.
 * This helps improve cross-referencing by identifying places where links should be added.
 *
 * The rule uses:
 * - MDX frontmatter titles (from content files)
 * - Entity names from database.json (experts, organizations)
 * - Configurable aliases for common variations
 *
 * Reports as INFO severity (suggestions, not errors) since some unlinked mentions
 * may be intentional (e.g., when an entity is mentioned many times on one page).
 */

import { createRule, Issue, Severity, ContentFile, ValidationEngine } from '../validation-engine.ts';
import { isInCodeBlock, isInComment, getLineNumber, shouldSkipValidation } from '../mdx-utils.ts';
import { loadDatabase } from '../content-types.ts';

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

interface DatabaseEntity {
  id: string;
  title: string;
  type: string;
}

interface EntityLookupEntry {
  id: string;
  title: string;
  source: string;
}

interface MentionInfo {
  position: number;
  matchedText: string;
  line: number;
}

interface MentionWithEntity extends MentionInfo {
  entity: EntityLookupEntry;
}

// ---------------------------------------------------------------------------
// Database entity loading
// ---------------------------------------------------------------------------

/**
 * Load entity titles from database.json
 */
function loadDatabaseEntities(): Map<string, DatabaseEntity> {
  try {
    const db = loadDatabase();
    const entities = new Map<string, DatabaseEntity>();

    // Load experts (people)
    if (db.experts) {
      for (const expert of db.experts) {
        if (expert.name && expert.id) {
          entities.set(expert.name.toLowerCase(), {
            id: expert.id,
            title: expert.name,
            type: 'person',
          });
        }
      }
    }

    // Load organizations
    if (db.organizations) {
      for (const org of db.organizations) {
        if (org.name && org.id) {
          entities.set(org.name.toLowerCase(), {
            id: org.id,
            title: org.name,
            type: 'organization',
          });
          // Also add short names/acronyms if present
          if (org.shortName) {
            entities.set(org.shortName.toLowerCase(), {
              id: org.id,
              title: org.shortName,
              type: 'organization',
            });
          }
        }
      }
    }

    return entities;
  } catch {
    return new Map<string, DatabaseEntity>();
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Common aliases and variations for entities
 * Maps alias -> canonical entity ID
 */
const ENTITY_ALIASES: Record<string, string> = {
  // Organizations
  'open philanthropy': 'open-philanthropy',
  'openphil': 'open-philanthropy',
  'machine intelligence research institute': 'miri',
  'center for ai safety': 'cais',
  'centre for ai safety': 'cais',
  'future of humanity institute': 'fhi',
  'centre for the governance of ai': 'govai',
  'center for the governance of ai': 'govai',
  'center for security and emerging technology': 'cset',
  'alignment research center': 'arc',
  'arc evals': 'arc',
  'metr': 'metr',
  'redwood research': 'redwood',
  'conjecture': 'conjecture',
  'anthropic': 'anthropic',
  'openai': 'openai',
  'deepmind': 'deepmind',
  'google deepmind': 'deepmind',

  // Concepts - common ways people refer to them
  'deceptive alignment': 'scheming',
  'mesa-optimization': 'mesa-optimization',
  'mesa optimization': 'mesa-optimization',
  'inner alignment': 'mesa-optimization',
  'reward hacking': 'reward-hacking',
  'specification gaming': 'reward-hacking',
  'goal misgeneralization': 'distributional-shift',
  'constitutional ai': 'constitutional-ai',
  'rlhf': 'rlhf',
  'reinforcement learning from human feedback': 'rlhf',
  'interpretability': 'interpretability',
  'mechanistic interpretability': 'mech-interp',
  'mech interp': 'mech-interp',
  'scalable oversight': 'scalable-oversight',
  'iterated amplification': 'scalable-oversight',

  // Risks
  'bioweapons': 'bioweapons',
  'biological weapons': 'bioweapons',
  'autonomous weapons': 'autonomous-weapons',
  'lethal autonomous weapons': 'autonomous-weapons',
  // Note: 'laws' removed - too generic, matches legal contexts

  // People - common name variations
  'yudkowsky': 'eliezer-yudkowsky',
  'eliezer': 'eliezer-yudkowsky',
  'paul christiano': 'paul-christiano',
  'christiano': 'paul-christiano',
  'holden karnofsky': 'holden-karnofsky',
  'karnofsky': 'holden-karnofsky',
  'nick bostrom': 'nick-bostrom',
  'bostrom': 'nick-bostrom',
  'stuart russell': 'stuart-russell',
  'sam altman': 'sam-altman',
  'altman': 'sam-altman',
  'dario amodei': 'dario-amodei',
  'demis hassabis': 'demis-hassabis',
  'jan leike': 'jan-leike',
  'geoffrey hinton': 'geoffrey-hinton',
  'hinton': 'geoffrey-hinton',
};

/**
 * Words/phrases to skip - common terms that happen to match entity names
 * but are used in generic contexts
 */
const SKIP_TERMS = new Set<string>([
  // Common words
  'ai',
  'ml',
  'llm',
  'agi',
  'asi',
  'the',
  'and',
  'for',
  'with',
  'this',
  'that',
  'from',
  'are',
  'was',
  'will',
  'can',
  'may',
  'should',
  'would',
  'could',
  // Generic AI/tech terms that might match entity names
  'risk',
  'risks',
  'safety',
  'model',
  'models',
  'system',
  'systems',
  'research',
  'alignment',
  'capabilities',
  'compute',
  'data',
  'training',
  'policy',
  'policies',
  'lock-in',  // Too generic in many contexts
  'governance',
  'regulation',
  'overview',
  'analysis',
  'impact',
  'control',
  'power',
  'trust',
  // Section headers and common markdown
  'related',
  'summary',
  'background',
  'introduction',
  'conclusion',
  'references',
  'sources',
]);

/**
 * Minimum word length for entity matching (to avoid false positives)
 */
const MIN_ENTITY_LENGTH = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a comprehensive entity lookup from multiple sources
 */
function buildEntityLookup(engine: ValidationEngine, contentFiles: ContentFile[]): Map<string, EntityLookupEntry> {
  const lookup = new Map<string, EntityLookupEntry>();

  // 1. Add aliases
  for (const [alias, id] of Object.entries(ENTITY_ALIASES)) {
    if (engine.pathRegistry[id]) {
      lookup.set(alias, {
        id,
        title: alias,
        source: 'alias',
      });
    }
  }

  // 2. Add database entities (people, orgs)
  const dbEntities = loadDatabaseEntities();
  for (const [name, entity] of dbEntities) {
    if (engine.pathRegistry[entity.id]) {
      lookup.set(name, {
        id: entity.id,
        title: entity.title,
        source: 'database',
      });
    }
  }

  // 3. Add page titles from content files
  for (const content of contentFiles) {
    const title = content.frontmatter?.title;
    if (title && title.length >= MIN_ENTITY_LENGTH) {
      // Extract entity ID from path
      const slug = content.slug;
      const possibleIds = [
        slug,
        slug.split('/').pop(), // Last segment
      ];

      for (const id of possibleIds) {
        if (id && engine.pathRegistry[id]) {
          const normalizedTitle = title.toLowerCase();
          // Don't overwrite more specific sources
          if (!lookup.has(normalizedTitle)) {
            lookup.set(normalizedTitle, {
              id,
              title,
              source: 'frontmatter',
            });
          }
          break;
        }
      }
    }
  }

  return lookup;
}

/**
 * Check if a position is inside an EntityLink component
 */
function isInEntityLink(content: string, position: number): boolean {
  const before = content.slice(0, position);

  // Check if we're inside <EntityLink ...>...</EntityLink>
  const lastEntityLinkOpen = before.lastIndexOf('<EntityLink');
  if (lastEntityLinkOpen === -1) return false;

  const lastEntityLinkClose = before.lastIndexOf('</EntityLink>');
  const lastSelfClose = before.slice(lastEntityLinkOpen).indexOf('/>');

  // If we found an opening tag and haven't closed it yet
  if (lastEntityLinkOpen > lastEntityLinkClose) {
    // Check if it's self-closing before our position
    if (lastSelfClose !== -1 && lastEntityLinkOpen + lastSelfClose < position) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Check if a position is inside any JSX component (between < and >)
 */
function isInJsxTag(content: string, position: number): boolean {
  const before = content.slice(0, position);
  const lastOpen = before.lastIndexOf('<');
  const lastClose = before.lastIndexOf('>');
  return lastOpen > lastClose;
}

/**
 * Check if a position is inside a markdown link
 */
function isInMarkdownLink(content: string, position: number): boolean {
  // Check for [text](url) pattern
  const before = content.slice(0, position);
  const lastBracketOpen = before.lastIndexOf('[');
  const lastBracketClose = before.lastIndexOf(']');
  const lastParenClose = before.lastIndexOf(')');

  // Inside link text [here]
  if (lastBracketOpen > lastBracketClose) return true;

  // Inside link URL (url)
  const afterBracket = before.slice(lastBracketClose);
  if (afterBracket.match(/\]\([^)]*$/)) return true;

  return false;
}

/**
 * Find all mentions of an entity in content
 */
function findMentions(content: string, entityTitle: string, entityId: string): MentionInfo[] {
  const mentions: MentionInfo[] = [];
  const normalizedTitle = entityTitle.toLowerCase();

  // Skip very short or common terms
  if (normalizedTitle.length < MIN_ENTITY_LENGTH || SKIP_TERMS.has(normalizedTitle)) {
    return mentions;
  }

  // Create regex that matches whole words only
  // Escape special regex characters
  const escaped = normalizedTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const regex = new RegExp(`\\b${escaped}\\b`, 'gi');

  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const position = match.index;

    // Skip if in special context
    if (
      isInCodeBlock(content, position) ||
      isInComment(content, position) ||
      isInEntityLink(content, position) ||
      isInJsxTag(content, position) ||
      isInMarkdownLink(content, position)
    ) {
      continue;
    }

    mentions.push({
      position,
      matchedText: match[0],
      line: getLineNumber(content, position),
    });
  }

  return mentions;
}

// ---------------------------------------------------------------------------
// Rule export
// ---------------------------------------------------------------------------

export const entityMentionsRule = createRule({
  id: 'entity-mentions',
  name: 'Unlinked Entity Mentions',
  description: 'Detects mentions of known entities that could be converted to EntityLink',
  scope: 'global', // Need all content to build lookup

  check(contentFiles: ContentFile[], engine: ValidationEngine): Issue[] {
    const issues: Issue[] = [];

    // Build entity lookup from all sources
    const entityLookup = buildEntityLookup(engine, contentFiles);

    // Track mentions per file to avoid duplicate warnings
    const mentionsByFile = new Map<string, Map<string, MentionWithEntity>>();

    for (const content of contentFiles) {
      // Skip documentation, stubs, and internal pages
      if (shouldSkipValidation(content.frontmatter) ||
          content.relativePath.includes('/internal/')) {
        continue;
      }

      const body = content.body;
      const fileMentions = new Map<string, MentionWithEntity>(); // entityId -> first mention

      // Check each entity
      for (const [normalizedTitle, entity] of entityLookup) {
        // Don't flag mentions of the entity on its own page
        const pageEntityId = content.slug.split('/').pop();
        if (entity.id === pageEntityId) continue;

        const mentions = findMentions(body, normalizedTitle, entity.id);

        for (const mention of mentions) {
          // Only report first mention of each entity per file
          if (!fileMentions.has(entity.id)) {
            fileMentions.set(entity.id, {
              ...mention,
              entity,
            });
          }
        }
      }

      // Convert to issues (limit per file to avoid noise)
      const sortedMentions = [...fileMentions.values()].sort((a, b) => a.line - b.line);
      const maxMentionsPerFile = 5;

      for (const mention of sortedMentions.slice(0, maxMentionsPerFile)) {
        issues.push(
          new Issue({
            rule: this.id,
            file: content.path,
            line: mention.line,
            message: `"${mention.matchedText}" could be linked: <EntityLink id="${mention.entity.id}">${mention.matchedText}</EntityLink>`,
            severity: Severity.INFO,
          })
        );
      }

      if (sortedMentions.length > maxMentionsPerFile) {
        issues.push(
          new Issue({
            rule: this.id,
            file: content.path,
            message: `... and ${sortedMentions.length - maxMentionsPerFile} more unlinked entity mentions`,
            severity: Severity.INFO,
          })
        );
      }
    }

    return issues;
  },
});

export default entityMentionsRule;
