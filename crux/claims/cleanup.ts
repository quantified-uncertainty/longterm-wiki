/**
 * Claims Cleanup — Identify and delete low-quality claims
 *
 * Detects claims that are beyond repair:
 *   - Exact within-entity duplicates (same entity_id + claim_text, keep newest)
 *   - Truncated claims (no terminal punctuation)
 *   - Very short claims (<20 chars) that lack any entity name
 *   - Wrong entity attribution (claim mentions entity Y but not entity X)
 *
 * Usage:
 *   crux claims cleanup                    Dry-run: show candidates
 *   crux claims cleanup --apply            Delete flagged claims
 *   crux claims cleanup --entity=kalshi    Restrict to one entity
 *   crux claims cleanup --json             JSON output (dry-run)
 */

import { apiRequest, BATCH_TIMEOUT_MS } from '../lib/wiki-server/client.ts';
import { deleteClaimsByIds, type ClaimRow } from '../lib/wiki-server/claims.ts';
import { loadEntities, type Entity } from '../lib/content-types.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ClaimCandidate {
  id: number;
  entityId: string;
  claimText: string;
  reason: string;
  detail?: string;
}

interface PaginatedClaimsResult {
  claims: ClaimRow[];
  total: number;
  limit: number;
  offset: number;
}

type DeletionReason =
  | 'exact-duplicate'
  | 'truncated'
  | 'too-short'
  | 'wrong-attribution';

// ---------------------------------------------------------------------------
// Entity name index — maps entity slug -> title (for attribution checks)
// Also builds a related-entities adjacency set for wrong-attribution filtering.
// ---------------------------------------------------------------------------

interface EntityNameIndex {
  /** slug -> display title */
  titles: Map<string, string>;
  /** slug -> set of related entity slugs (from relatedEntries in YAML) */
  related: Map<string, Set<string>>;
}

function buildEntityNameIndex(): EntityNameIndex {
  const entities: Entity[] = loadEntities();
  const titles = new Map<string, string>();
  const related = new Map<string, Set<string>>();

  for (const e of entities) {
    if (e.id && e.title) {
      titles.set(e.id, e.title);
    }
    if (e.id && e.relatedEntries) {
      const relSet = new Set<string>();
      for (const rel of e.relatedEntries) {
        if (rel.id) relSet.add(rel.id);
      }
      related.set(e.id, relSet);
    }
  }

  return { titles, related };
}

// ---------------------------------------------------------------------------
// Fetch all claims (paginated)
// ---------------------------------------------------------------------------

async function fetchAllClaims(entityFilter?: string): Promise<ClaimRow[]> {
  const PAGE_SIZE = 200;
  const allClaims: ClaimRow[] = [];
  let offset = 0;

  while (true) {
    const params = new URLSearchParams({
      limit: String(PAGE_SIZE),
      offset: String(offset),
    });
    if (entityFilter) {
      params.set('entityId', entityFilter);
    }

    const result = await apiRequest<PaginatedClaimsResult>(
      'GET',
      `/api/claims/all?${params.toString()}`,
      undefined,
      BATCH_TIMEOUT_MS,
    );

    if (!result.ok) {
      console.error(`\x1b[31mFailed to fetch claims: ${result.message}\x1b[0m`);
      process.exit(1);
    }

    allClaims.push(...result.data.claims);

    if (allClaims.length >= result.data.total || result.data.claims.length < PAGE_SIZE) {
      break;
    }
    offset += PAGE_SIZE;
  }

  return allClaims;
}

// ---------------------------------------------------------------------------
// Detection: Exact duplicates (same entity_id + normalized claim_text)
// ---------------------------------------------------------------------------

function findExactDuplicates(claims: ClaimRow[]): ClaimCandidate[] {
  const candidates: ClaimCandidate[] = [];

  // Group by entity_id + normalized text
  const groups = new Map<string, ClaimRow[]>();
  for (const claim of claims) {
    const key = `${claim.entityId}|||${claim.claimText.trim().toLowerCase()}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(claim);
  }

  for (const [, group] of groups) {
    if (group.length <= 1) continue;

    // Sort by id desc (newest first) — keep the newest
    group.sort((a, b) => b.id - a.id);
    const kept = group[0];
    for (let i = 1; i < group.length; i++) {
      candidates.push({
        id: group[i].id,
        entityId: group[i].entityId,
        claimText: group[i].claimText,
        reason: 'exact-duplicate',
        detail: `duplicate of claim #${kept.id}`,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Detection: Truncated claims (no terminal punctuation)
// ---------------------------------------------------------------------------

/** Terminal punctuation that indicates a complete sentence. */
const TERMINAL_PUNCT = /[.!?'")\u2019\u201D]$/;

/**
 * Detect truncated claims.
 *
 * A claim is considered truncated when it appears to be cut off mid-sentence.
 * We do NOT flag claims that simply omit a trailing period — many valid claims
 * are complete thoughts without terminal punctuation (e.g. "AI could be misused
 * for social control").
 *
 * Positive signals of truncation:
 *   - Ends with a hyphen or dash (mid-word break)
 *   - Ends with a comma, semicolon, or colon (mid-sentence break)
 *   - Ends with common articles/prepositions ("the", "a", "of", "in", "to", etc.)
 *   - Contains markdown table syntax (pipe characters) — table rows got stored as claims
 */
function findTruncated(claims: ClaimRow[]): ClaimCandidate[] {
  const candidates: ClaimCandidate[] = [];

  // Words that strongly suggest truncation when they appear at the end
  const DANGLING_WORDS = /\b(the|a|an|of|in|to|for|and|or|but|with|from|by|at|on|is|are|was|were|that|this|which|its|their|has|have|had)\s*$/i;

  // Endings that indicate mid-sentence truncation
  const MID_SENTENCE_END = /[-–—,;:]\s*$/;

  for (const claim of claims) {
    const text = claim.claimText.trim();
    // Skip very short claims — those are caught by the too-short check
    if (text.length < 10) continue;
    // Claims with terminal punctuation are fine
    if (TERMINAL_PUNCT.test(text)) continue;
    // Claims ending with a digit or percent are fine
    if (/[\d%]$/.test(text)) continue;

    let isTruncated = false;
    let detail = '';

    // Check for table fragments (pipe-delimited content)
    if (text.includes('|') && (text.startsWith('|') || text.endsWith('|'))) {
      isTruncated = true;
      detail = 'table fragment';
    }
    // Check for mid-sentence ending (comma, semicolon, colon, dash)
    else if (MID_SENTENCE_END.test(text)) {
      isTruncated = true;
      detail = `ends with: "${text.slice(-10)}"`;
    }
    // Check for dangling articles/prepositions at end
    else if (DANGLING_WORDS.test(text)) {
      isTruncated = true;
      const match = text.match(DANGLING_WORDS);
      detail = `ends with dangling word: "${match ? match[1] : ''}"`;
    }

    if (isTruncated) {
      candidates.push({
        id: claim.id,
        entityId: claim.entityId,
        claimText: text,
        reason: 'truncated',
        detail,
      });
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Detection: Very short claims (<20 chars) with no entity name
// ---------------------------------------------------------------------------

function findTooShort(
  claims: ClaimRow[],
  entityIndex: EntityNameIndex,
): ClaimCandidate[] {
  const MIN_LENGTH = 20;
  const candidates: ClaimCandidate[] = [];

  for (const claim of claims) {
    const text = claim.claimText.trim();
    if (text.length >= MIN_LENGTH) continue;

    // Check if the claim contains its own entity name (could still be useful)
    const entityTitle = entityIndex.titles.get(claim.entityId);
    if (entityTitle) {
      const textLower = text.toLowerCase();
      if (textLower.includes(entityTitle.toLowerCase())) continue;
      if (textLower.includes(claim.entityId.replace(/-/g, ' '))) continue;
    }

    candidates.push({
      id: claim.id,
      entityId: claim.entityId,
      claimText: text,
      reason: 'too-short',
      detail: `${text.length} chars`,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Detection: Wrong entity attribution
// ---------------------------------------------------------------------------

/**
 * A claim is flagged as wrong-attribution when:
 *   1. The claim text prominently mentions another known entity name (full title match)
 *   2. The claim text does NOT mention the assigned entity's title at all
 *   3. The assigned entity is NOT in the claim's relatedEntities array
 *   4. The mentioned entity is NOT a known related entity of the assigned entity
 *      (from relatedEntries in YAML — e.g. Dario Amodei is related to Anthropic)
 *
 * This is conservative — it only flags when another entity is the clear subject
 * and the assigned entity is not mentioned anywhere, and the two entities have
 * no known relationship.
 */
function findWrongAttribution(
  claims: ClaimRow[],
  entityIndex: EntityNameIndex,
): ClaimCandidate[] {
  const candidates: ClaimCandidate[] = [];

  // Build a reverse index: lowercase title -> entity id
  // Only include entities with titles >= 4 chars to avoid false positives
  const titleToId = new Map<string, string>();
  for (const [id, title] of entityIndex.titles) {
    if (title.length >= 4) {
      titleToId.set(title.toLowerCase(), id);
    }
  }

  // Sorted by title length desc so longer matches take priority
  const titlesDesc = [...titleToId.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );

  // Build bidirectional related-entities set
  // If A lists B as related, B is also related to A for attribution purposes
  const biRelated = new Map<string, Set<string>>();
  for (const [entityId, relSet] of entityIndex.related) {
    if (!biRelated.has(entityId)) biRelated.set(entityId, new Set());
    for (const relId of relSet) {
      biRelated.get(entityId)!.add(relId);
      if (!biRelated.has(relId)) biRelated.set(relId, new Set());
      biRelated.get(relId)!.add(entityId);
    }
  }

  for (const claim of claims) {
    const assignedId = claim.entityId;
    const assignedTitle = entityIndex.titles.get(assignedId);
    if (!assignedTitle) continue; // Unknown entity — skip

    const textLower = claim.claimText.toLowerCase();
    const assignedTitleLower = assignedTitle.toLowerCase();

    // Check if the assigned entity is mentioned in the claim text
    // Also check partial name matches (e.g. last name for people like "Russell", "Bengio")
    const assignedSlugWords = assignedId.replace(/-/g, ' ');
    const titleWords = assignedTitle.split(/\s+/).filter((w) => w.length >= 4);
    const assignedMentioned =
      textLower.includes(assignedTitleLower) ||
      textLower.includes(assignedSlugWords) ||
      titleWords.some((word) => textLower.includes(word.toLowerCase()));

    if (assignedMentioned) continue; // Assigned entity IS mentioned — fine

    // Check if the assigned entity is in relatedEntities (claim might be about a relationship)
    const claimRelated = (claim.relatedEntities as string[] | null) ?? [];
    // If there are related entities, this is a relationship claim — skip
    if (claimRelated.length > 0) continue;

    // Find which other entity is most prominently mentioned
    let bestMatch: { id: string; title: string } | null = null;
    for (const [titleLower, entityId] of titlesDesc) {
      if (entityId === assignedId) continue;
      if (textLower.includes(titleLower)) {
        bestMatch = { id: entityId, title: entityIndex.titles.get(entityId)! };
        break;
      }
    }

    if (!bestMatch) continue; // No other entity prominently mentioned

    // Check if the mentioned entity is a known related entity of the assigned entity
    const assignedRelated = biRelated.get(assignedId);
    if (assignedRelated && assignedRelated.has(bestMatch.id)) {
      continue; // Related entity — claim is likely valid on this page
    }

    candidates.push({
      id: claim.id,
      entityId: claim.entityId,
      claimText: claim.claimText,
      reason: 'wrong-attribution',
      detail: `mentions "${bestMatch.title}" (${bestMatch.id}) but not "${assignedTitle}" (${assignedId})`,
    });
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Deduplication across reasons (a claim may match multiple rules)
// ---------------------------------------------------------------------------

function deduplicateCandidates(candidates: ClaimCandidate[]): ClaimCandidate[] {
  const seen = new Set<number>();
  const result: ClaimCandidate[] = [];
  for (const c of candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    result.push(c);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

const c = {
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
};

function truncateText(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 3) + '...';
}

function printCandidatesByReason(
  candidates: ClaimCandidate[],
  reason: DeletionReason,
  label: string,
): void {
  const filtered = candidates.filter((c) => c.reason === reason);
  if (filtered.length === 0) return;

  console.log(`\n${c.bold}${label}${c.reset} (${filtered.length})`);
  console.log(`${c.dim}${'─'.repeat(70)}${c.reset}`);

  for (const item of filtered) {
    console.log(
      `  ${c.cyan}#${item.id}${c.reset} ${c.dim}[${item.entityId}]${c.reset} ${truncateText(item.claimText, 60)}`,
    );
    if (item.detail) {
      console.log(`    ${c.dim}${item.detail}${c.reset}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const applyMode = args.includes('--apply');
  const jsonOutput = args.includes('--json');

  // Parse --entity=X
  const entityArg = args.find((a) => a.startsWith('--entity='));
  const entityFilter = entityArg ? entityArg.split('=')[1] : undefined;

  if (!jsonOutput) {
    console.log(`${c.bold}Claims Cleanup${c.reset}`);
    console.log(`${c.dim}Mode: ${applyMode ? 'APPLY (will delete)' : 'dry-run (preview only)'}${c.reset}`);
    if (entityFilter) {
      console.log(`${c.dim}Entity filter: ${entityFilter}${c.reset}`);
    }
    console.log();
  }

  // 1. Load entity name index
  const entityIndex = buildEntityNameIndex();
  if (!jsonOutput) {
    console.log(`${c.dim}Loaded ${entityIndex.titles.size} entity names${c.reset}`);
  }

  // 2. Fetch all claims
  if (!jsonOutput) {
    process.stdout.write(`${c.dim}Fetching claims...${c.reset}`);
  }
  const claims = await fetchAllClaims(entityFilter);
  if (!jsonOutput) {
    console.log(` ${claims.length} claims loaded`);
  }

  if (claims.length === 0) {
    if (jsonOutput) {
      console.log(JSON.stringify({ candidates: [], total: 0 }));
    } else {
      console.log(`${c.green}No claims found. Nothing to clean up.${c.reset}`);
    }
    return;
  }

  // 3. Run detection rules
  const allCandidates: ClaimCandidate[] = [];

  allCandidates.push(...findExactDuplicates(claims));
  allCandidates.push(...findTruncated(claims));
  allCandidates.push(...findTooShort(claims, entityIndex));
  allCandidates.push(...findWrongAttribution(claims, entityIndex));

  // Deduplicate (a claim might match multiple rules — keep first match)
  const candidates = deduplicateCandidates(allCandidates);

  // 4. Output results
  if (jsonOutput && !applyMode) {
    const grouped: Record<string, ClaimCandidate[]> = {};
    for (const cand of candidates) {
      if (!grouped[cand.reason]) grouped[cand.reason] = [];
      grouped[cand.reason].push(cand);
    }
    console.log(
      JSON.stringify(
        {
          totalClaims: claims.length,
          candidates: candidates.length,
          byReason: Object.fromEntries(
            Object.entries(grouped).map(([reason, items]) => [reason, items.length]),
          ),
          items: candidates,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (!jsonOutput) {
    printCandidatesByReason(candidates, 'exact-duplicate', 'Exact Duplicates');
    printCandidatesByReason(candidates, 'truncated', 'Truncated Claims');
    printCandidatesByReason(candidates, 'too-short', 'Too Short');
    printCandidatesByReason(candidates, 'wrong-attribution', 'Wrong Entity Attribution');

    console.log();
    console.log(
      `${c.bold}Summary:${c.reset} ${candidates.length} candidates for deletion out of ${claims.length} total claims`,
    );

    // Per-reason breakdown
    const reasons: DeletionReason[] = ['exact-duplicate', 'truncated', 'too-short', 'wrong-attribution'];
    for (const reason of reasons) {
      const count = candidates.filter((x) => x.reason === reason).length;
      if (count > 0) {
        console.log(`  ${reason}: ${count}`);
      }
    }
  }

  // 5. Apply deletions if --apply
  if (applyMode && candidates.length > 0) {
    console.log();
    console.log(`${c.yellow}Deleting ${candidates.length} claims...${c.reset}`);

    const idsToDelete = candidates.map((x) => x.id);

    // Batch in chunks of 200 to stay within API limits
    const CHUNK_SIZE = 200;
    let totalDeleted = 0;

    for (let i = 0; i < idsToDelete.length; i += CHUNK_SIZE) {
      const chunk = idsToDelete.slice(i, i + CHUNK_SIZE);
      const result = await deleteClaimsByIds(chunk);

      if (!result.ok) {
        console.error(
          `${c.red}Failed to delete batch ${Math.floor(i / CHUNK_SIZE) + 1}: ${result.message}${c.reset}`,
        );
        process.exit(1);
      }

      totalDeleted += result.data.deleted;
    }

    console.log(`${c.green}Deleted ${totalDeleted} claims.${c.reset}`);

    // Per-reason breakdown
    const reasons: DeletionReason[] = ['exact-duplicate', 'truncated', 'too-short', 'wrong-attribution'];
    for (const reason of reasons) {
      const count = candidates.filter((x) => x.reason === reason).length;
      if (count > 0) {
        console.log(`  ${reason}: ${count}`);
      }
    }
  } else if (!applyMode && candidates.length > 0 && !jsonOutput) {
    console.log();
    console.log(`${c.dim}Run with --apply to delete these claims.${c.reset}`);
  }
}

main().catch((err) => {
  console.error('Claims cleanup failed:', err);
  process.exit(1);
});
