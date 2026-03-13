/**
 * Person Mention Detector
 *
 * Scans MDX content to find plain-text mentions of person names that are
 * NOT already wrapped in <EntityLink> components. Used by the
 * `crux people suggest-links` command.
 *
 * Design principles:
 * - Conservative: only exact full-name matches (no fuzzy or partial)
 * - Skips frontmatter, code blocks, existing JSX components, and headings
 * - Handles diacritics (e.g. "Nuno Sempere" matches entity "Nuño Sempere")
 */

import { normalizeName } from '../commands/people.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PersonEntity {
  id: string;
  numericId?: string;
  title: string;
}

export interface PersonMention {
  /** Entity slug (e.g. "dario-amodei") */
  personId: string;
  /** Entity numeric ID (e.g. "E91") */
  numericId: string | undefined;
  /** Display name as found in the text */
  matchedText: string;
  /** Entity canonical name */
  canonicalName: string;
  /** 1-based line number in the file */
  line: number;
  /** Character offset within the line (0-based) */
  lineOffset: number;
  /** Whether this mention is in an excluded zone (EntityLink, heading, code, markdown link, etc.) */
  excluded: boolean;
}

export interface PageMentions {
  /** Relative path to the MDX file */
  filePath: string;
  /** All detected mentions */
  mentions: PersonMention[];
  /** Only unlinked mentions */
  unlinkedMentions: PersonMention[];
}

// ---------------------------------------------------------------------------
// Name lookup builder
// ---------------------------------------------------------------------------

/**
 * Build a lookup map from normalized name variants to person entities.
 * Each entry maps a normalized name string to the entity.
 *
 * Includes:
 * - Full name (cleaned of parentheticals)
 * - Diacritic-stripped variant (via normalizeName)
 */
export function buildPersonLookup(
  people: PersonEntity[],
): Map<string, PersonEntity> {
  const lookup = new Map<string, PersonEntity>();

  for (const person of people) {
    // Clean the title (some have parenthetical descriptions like "Sam Bankman-Fried (FTX)")
    const cleanName = person.title.replace(/\s*\(.*?\)\s*$/, '').trim();
    const normalized = normalizeName(cleanName);
    if (normalized.length > 0) {
      lookup.set(normalized, person);
    }
  }

  return lookup;
}

// ---------------------------------------------------------------------------
// Content zone classification
// ---------------------------------------------------------------------------

/**
 * Zones in MDX content where person names should NOT be linked.
 * We mark these ranges so the scanner can skip them.
 */
interface ExcludedZone {
  start: number;
  end: number;
}

/**
 * Find all character ranges in the content that should be excluded from linking:
 * - Frontmatter (between --- markers at the start)
 * - Fenced code blocks (``` ... ```)
 * - Inline code (`...`)
 * - JSX/MDX components (opening and self-closing tags, including their props)
 * - Headings (lines starting with #)
 * - MDX comments (curly-brace-slash-star blocks)
 * - Import/export statements
 * - Markdown links: inline `[text](url)`, images `![alt](url)`, reference `[text][ref]`
 */
export function findExcludedZones(content: string): ExcludedZone[] {
  const zones: ExcludedZone[] = [];

  // Frontmatter: must be at the very start of the file
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n/);
  if (frontmatterMatch) {
    zones.push({ start: 0, end: frontmatterMatch[0].length });
  }

  // Fenced code blocks (``` or ~~~)
  const codeBlockRegex = /^(```|~~~).*\n[\s\S]*?\n\1\s*$/gm;
  for (const match of content.matchAll(codeBlockRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // Inline code: `...`
  const inlineCodeRegex = /`[^`]+`/g;
  for (const match of content.matchAll(inlineCodeRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // JSX/MDX component tags (opening, closing, self-closing)
  // Match <ComponentName ... > or <ComponentName ... /> or </ComponentName>
  // This catches <EntityLink id="...">...</EntityLink> and similar
  const jsxTagRegex = /<\/?[A-Z][A-Za-z0-9]*(?:\s[^>]*)?\/?>/g;
  for (const match of content.matchAll(jsxTagRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // EntityLink content (between opening and closing tags)
  // This ensures the text *inside* <EntityLink>Name</EntityLink> is also excluded
  const entityLinkRegex = /<EntityLink\s[^>]*>[\s\S]*?<\/EntityLink>/g;
  for (const match of content.matchAll(entityLinkRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // Heading lines (# ... or ## ... etc.)
  const headingRegex = /^#{1,6}\s+.*$/gm;
  for (const match of content.matchAll(headingRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // MDX comments: {/* ... */}
  const commentRegex = /\{\/\*[\s\S]*?\*\/\}/g;
  for (const match of content.matchAll(commentRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // Import/export lines
  const importExportRegex = /^(import|export)\s+.*$/gm;
  for (const match of content.matchAll(importExportRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // Footnote reference definitions: [^...]: ...
  const footnoteDefRegex = /^\[\^[^\]]+\]:\s+.*$/gm;
  for (const match of content.matchAll(footnoteDefRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // Markdown inline links: [text](url)
  const inlineLinkRegex = /\[([^\]]*)\]\([^)]*\)/g;
  for (const match of content.matchAll(inlineLinkRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // Markdown images: ![alt](url)
  const imageRegex = /!\[([^\]]*)\]\([^)]*\)/g;
  for (const match of content.matchAll(imageRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // Markdown reference links: [text][ref]
  const refLinkRegex = /\[([^\]]*)\]\[[^\]]*\]/g;
  for (const match of content.matchAll(refLinkRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  // URL patterns (http://..., https://...) — avoid matching names inside URLs
  const urlRegex = /https?:\/\/[^\s)>\]]+/g;
  for (const match of content.matchAll(urlRegex)) {
    zones.push({
      start: match.index!,
      end: match.index! + match[0].length,
    });
  }

  return zones;
}

/**
 * Check if a character position falls within any excluded zone.
 */
function isInExcludedZone(
  pos: number,
  length: number,
  zones: ExcludedZone[],
): boolean {
  const end = pos + length;
  return zones.some((zone) => pos < zone.end && end > zone.start);
}

/**
 * Normalize content for searching: lowercase and strip diacritics, but preserve
 * whitespace structure (unlike normalizeName which also trims).
 */
function normalizeContent(content: string): string {
  return content
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // strip diacritics
    .toLowerCase();
}

// ---------------------------------------------------------------------------
// Core detection
// ---------------------------------------------------------------------------

/**
 * Scan MDX content for person name mentions.
 *
 * Returns all matches, flagging whether each is already inside an EntityLink.
 */
export function detectPersonMentions(
  content: string,
  lookup: Map<string, PersonEntity>,
): PersonMention[] {
  const mentions: PersonMention[] = [];
  const excludedZones = findExcludedZones(content);

  // Build a list of names to search for, sorted longest-first to prefer longer matches
  const nameEntries = Array.from(lookup.entries()).sort(
    (a, b) => b[0].length - a[0].length,
  );

  // Pre-compute normalized content and position map ONCE for the entire file
  const normalizedContent = normalizeContent(content);
  const posMap = buildPositionMap(content);

  // Pre-compute line start positions for fast line-number lookups
  const lineStarts: number[] = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') lineStarts.push(i + 1);
  }

  // Track which character positions have already been matched (to avoid overlapping matches)
  const matchedPositions = new Set<number>();

  for (const [normalizedName, person] of nameEntries) {
    // Skip very short names (single word under 4 chars) to avoid false positives
    if (normalizedName.length < 4) continue;

    // Build regex that matches the name with word boundaries
    const escapedName = normalizedName.replace(
      /[.*+?^${}()|[\]\\]/g,
      '\\$&',
    );

    const regex = new RegExp(`\\b${escapedName}\\b`, 'g');
    let match: RegExpExecArray | null;

    while ((match = regex.exec(normalizedContent)) !== null) {
      const normPos = match.index;
      const origPos = posMap[normPos];
      if (origPos === undefined) continue;

      // Find the end position in original text
      const normEnd = normPos + match[0].length;
      const origEnd = posMap[normEnd] ?? origPos + match[0].length;
      const origLength = origEnd - origPos;

      // Check if this position overlaps with an already-matched mention
      let overlaps = false;
      for (let i = origPos; i < origPos + origLength; i++) {
        if (matchedPositions.has(i)) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;

      // Extract the original text at this position
      const matchedText = content.substring(origPos, origEnd);

      // Determine line number using binary search on lineStarts
      let lineNum = 1;
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= origPos) {
          lineNum = mid + 1;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }

      // Check if in excluded zone
      const inExcluded = isInExcludedZone(origPos, origLength, excludedZones);

      // Compute character offset within the line
      const lineStartPos = lineStarts[lineNum - 1];
      const lineOffset = origPos - lineStartPos;

      // Mark positions as matched
      for (let i = origPos; i < origPos + origLength; i++) {
        matchedPositions.add(i);
      }

      mentions.push({
        personId: person.id,
        numericId: person.numericId,
        matchedText,
        canonicalName: person.title.replace(/\s*\(.*?\)\s*$/, '').trim(),
        line: lineNum,
        lineOffset,
        excluded: inExcluded,
      });
    }
  }

  // Sort by line number
  mentions.sort((a, b) => a.line - b.line);

  return mentions;
}

/**
 * Build a mapping from positions in the normalized (diacritic-stripped, lowercased)
 * string back to positions in the original string.
 *
 * NFD normalization can expand a single character (e.g., "ñ") into two code units
 * (base + combining mark). When we strip combining marks, the normalized string
 * is shorter. This map lets us translate positions correctly.
 *
 * The map is an array where map[normalizedIndex] = originalIndex.
 * A sentinel entry at the end maps to original.length for end-of-string lookups.
 *
 * IMPORTANT: JavaScript strings use UTF-16 code units. NFD normalization and
 * combining mark removal both operate on code units. This function carefully
 * tracks code-unit positions (not codepoint positions) to ensure the map
 * aligns with JS string indexing.
 */
export function buildPositionMap(original: string): number[] {
  const nfd = original.normalize('NFD');
  const map: number[] = [];

  // Build a mapping from NFD code-unit positions to original code-unit positions.
  // NFD expansion can turn 1 original code unit into multiple NFD code units.
  // We walk through the original string codepoint-by-codepoint, tracking both
  // the original position and the NFD position.
  const nfdToOrig: number[] = new Array(nfd.length);
  let origPos = 0;
  let nfdPos = 0;

  for (const origChar of original) {
    const charNfd = origChar.normalize('NFD');
    for (let j = 0; j < charNfd.length; j++) {
      nfdToOrig[nfdPos + j] = origPos;
    }
    origPos += origChar.length; // UTF-16 code units in original
    nfdPos += charNfd.length; // UTF-16 code units in NFD
  }

  // Now build the stripped-to-original mapping.
  // Walk through the NFD string code-unit by code-unit, skipping combining marks.
  // Each non-combining code unit produces one entry in the map.
  const combiningMarkRegex = /[\u0300-\u036f]/;
  for (let i = 0; i < nfd.length; i++) {
    if (!combiningMarkRegex.test(nfd[i])) {
      map.push(nfdToOrig[i]);
    }
  }

  // Sentinel for end-of-string lookups
  map.push(original.length);

  return map;
}

// ---------------------------------------------------------------------------
// Apply logic — wrap first occurrence of each person in EntityLink
// ---------------------------------------------------------------------------

/**
 * Apply EntityLink wrapping to the first unlinked occurrence of each person
 * in the given content.
 */
export function applyEntityLinks(
  content: string,
  mentions: PersonMention[],
): { content: string; appliedCount: number; linkedPersons: string[] } {
  // Group by personId, take only unlinked, and pick the first occurrence
  const firstByPerson = new Map<string, PersonMention>();
  for (const m of mentions) {
    if (m.excluded) continue;
    if (!firstByPerson.has(m.personId)) {
      firstByPerson.set(m.personId, m);
    }
  }

  if (firstByPerson.size === 0) {
    return { content, appliedCount: 0, linkedPersons: [] };
  }

  // Sort replacements by position (line number) descending so we can replace
  // from the end of the file without invalidating earlier positions
  const replacements = Array.from(firstByPerson.values()).sort(
    (a, b) => b.line - a.line,
  );

  let result = content;
  const linkedPersons: string[] = [];

  for (const mention of replacements) {
    const idAttr = mention.numericId || mention.personId;
    const nameAttr = mention.personId;
    const replacement = `<EntityLink id="${idAttr}" name="${nameAttr}">${mention.matchedText}</EntityLink>`;

    // Find the exact position of this mention in the content
    // We search line by line, starting from the stored lineOffset to find the right occurrence
    const lines = result.split('\n');
    const targetLine = mention.line - 1; // 0-indexed
    if (targetLine >= 0 && targetLine < lines.length) {
      const line = lines[targetLine];
      // Use lineOffset as the starting search position to avoid matching
      // an earlier occurrence that might be inside an excluded zone (e.g., EntityLink)
      const idx = line.indexOf(mention.matchedText, mention.lineOffset);
      if (idx !== -1) {
        // Verify this position is not inside an excluded zone in the current content
        const excludedZones = findExcludedZones(result);
        let charPos = 0;
        for (let i = 0; i < targetLine; i++) {
          charPos += lines[i].length + 1; // +1 for newline
        }
        charPos += idx;

        if (!isInExcludedZone(charPos, mention.matchedText.length, excludedZones)) {
          lines[targetLine] =
            line.substring(0, idx) +
            replacement +
            line.substring(idx + mention.matchedText.length);
          result = lines.join('\n');
          linkedPersons.push(mention.personId);
        }
      }
    }
  }

  return { content: result, appliedCount: linkedPersons.length, linkedPersons };
}
