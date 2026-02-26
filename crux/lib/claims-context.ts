/**
 * Claims Context Builder for Improve Pipeline
 *
 * Fetches claims from wiki-server for a page's entity and formats them
 * into context for the LLM improve prompt. Parallel to entity-lookup.ts
 * and fact-lookup.ts — those provide entity/fact reference tables; this
 * provides the structured claims store as trusted context.
 *
 * Usage:
 *   const ctx = await buildClaimsContextForContent(pageId, content);
 *   // Include `ctx` in the LLM prompt as the "Claims Context" section
 */

import { getClaimsByEntity, type ClaimRow } from './wiki-server/claims.ts';
import { isServerAvailable } from './wiki-server/client.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ClaimsContext {
  /** Formatted string for the LLM prompt */
  promptText: string;
  /** Summary stats for logging */
  stats: {
    total: number;
    verified: number;
    disputed: number;
    unsupported: number;
    unverified: number;
    withSources: number;
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatClaimForPrompt(claim: ClaimRow, index: number): string {
  const parts: string[] = [];

  // Claim text with index
  parts.push(`${index + 1}. "${claim.claimText}"`);

  // Metadata line
  const meta: string[] = [];
  if (claim.claimType) meta.push(`type: ${claim.claimType}`);
  if (claim.claimMode) meta.push(`mode: ${claim.claimMode}`);
  if (claim.claimVerdict) meta.push(`verdict: ${claim.claimVerdict}`);
  if (claim.claimVerdictScore != null) meta.push(`score: ${Math.round(claim.claimVerdictScore * 100)}%`);
  if (claim.confidence && claim.confidence !== 'unverified') meta.push(`confidence: ${claim.confidence}`);
  if (claim.asOf) meta.push(`as_of: ${claim.asOf}`);
  if (claim.valueNumeric != null) meta.push(`value: ${claim.valueNumeric}`);
  if (claim.section) meta.push(`section: "${claim.section}"`);
  if (meta.length > 0) parts.push(`   [${meta.join(', ')}]`);

  // Source evidence
  if (claim.sources && claim.sources.length > 0) {
    const primarySource = claim.sources.find(s => s.isPrimary) || claim.sources[0];
    if (primarySource.sourceQuote) {
      const quote = primarySource.sourceQuote.length > 150
        ? primarySource.sourceQuote.slice(0, 147) + '...'
        : primarySource.sourceQuote;
      parts.push(`   Source: "${quote}"`);
    }
  } else if (claim.sourceQuote) {
    const quote = claim.sourceQuote.length > 150
      ? claim.sourceQuote.slice(0, 147) + '...'
      : claim.sourceQuote;
    parts.push(`   Source: "${quote}"`);
  }

  // Verdict issues (for disputed/unsupported claims)
  if (claim.claimVerdictIssues && claim.claimVerdict !== 'verified') {
    parts.push(`   Issues: ${claim.claimVerdictIssues.slice(0, 200)}`);
  }

  return parts.join('\n');
}

function categorizeClaims(claims: ClaimRow[]): {
  verified: ClaimRow[];
  disputed: ClaimRow[];
  unsupported: ClaimRow[];
  unverified: ClaimRow[];
} {
  const verified: ClaimRow[] = [];
  const disputed: ClaimRow[] = [];
  const unsupported: ClaimRow[] = [];
  const unverified: ClaimRow[] = [];

  for (const c of claims) {
    switch (c.claimVerdict) {
      case 'verified': verified.push(c); break;
      case 'disputed': disputed.push(c); break;
      case 'unsupported': unsupported.push(c); break;
      default: unverified.push(c); break;
    }
  }

  return { verified, disputed, unsupported, unverified };
}

// ---------------------------------------------------------------------------
// Main builder
// ---------------------------------------------------------------------------

/**
 * Build claims context for the improve pipeline.
 *
 * Fetches claims from wiki-server, categorizes by verdict, and formats
 * into sections the LLM can use:
 * - Verified claims: trusted facts to reference
 * - Disputed/unsupported claims: flagged for rewriting or removal
 * - Unverified claims with sources: additional context
 */
export async function buildClaimsContextForContent(
  pageId: string,
): Promise<ClaimsContext | null> {
  // Check server availability first
  const available = await isServerAvailable();
  if (!available) return null;

  const result = await getClaimsByEntity(pageId, { includeSources: true });
  if (!result.ok || !result.data?.claims?.length) return null;

  const claims = result.data.claims;
  const { verified, disputed, unsupported, unverified } = categorizeClaims(claims);

  const withSources = claims.filter(
    c => (c.sources && c.sources.length > 0) || c.sourceQuote,
  ).length;

  const sections: string[] = [];

  // Header
  sections.push(`### Claims Store for "${pageId}"`);
  sections.push(`${claims.length} claims total: ${verified.length} verified, ${disputed.length} disputed, ${unsupported.length} unsupported, ${unverified.length} unverified. ${withSources} have source evidence.`);
  sections.push('');

  // Verified claims — trusted context
  if (verified.length > 0) {
    sections.push('#### Verified Claims (trusted — use these as authoritative facts)');
    sections.push('These claims have been verified against their source material. Reference them when making factual assertions.');
    sections.push('');
    verified.forEach((c, i) => sections.push(formatClaimForPrompt(c, i)));
    sections.push('');
  }

  // Disputed claims — flag for attention
  if (disputed.length > 0) {
    sections.push('#### Disputed Claims (need attention — may need rewriting or better sources)');
    sections.push('These claims have issues with their source evidence. Consider rewriting with better sourcing or removing unsupported assertions.');
    sections.push('');
    disputed.forEach((c, i) => sections.push(formatClaimForPrompt(c, i)));
    sections.push('');
  }

  // Unsupported claims — flag for removal
  if (unsupported.length > 0) {
    sections.push('#### Unsupported Claims (no source evidence found — consider removing or flagging)');
    sections.push('These claims could not be verified against any source. If they appear in the page, consider adding {/* NEEDS CITATION */} or removing them.');
    sections.push('');
    unsupported.forEach((c, i) => sections.push(formatClaimForPrompt(c, i)));
    sections.push('');
  }

  // Top unverified claims with sources — additional context (cap at 30 to avoid prompt bloat)
  const unverifiedWithSources = unverified
    .filter(c => (c.sources && c.sources.length > 0) || c.sourceQuote)
    .slice(0, 30);
  if (unverifiedWithSources.length > 0) {
    sections.push('#### Unverified Claims with Sources (additional context — not yet reviewed)');
    sections.push('These claims have source evidence but have not been formally verified. Use as supplementary context.');
    sections.push('');
    unverifiedWithSources.forEach((c, i) => sections.push(formatClaimForPrompt(c, i)));
    sections.push('');
  }

  const promptText = sections.join('\n');

  return {
    promptText,
    stats: {
      total: claims.length,
      verified: verified.length,
      disputed: disputed.length,
      unsupported: unsupported.length,
      unverified: unverified.length,
      withSources,
    },
  };
}
