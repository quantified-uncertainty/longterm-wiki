/**
 * Risk-domain alias loader (QUA-691 Phase 4).
 *
 * Loads data/frameworks/risk-domain-aliases.yaml and provides lookup
 * helpers for (1) normalizing a verbatim lab label to a canonical enum
 * value and (2) rendering the alias map into the extractor prompt.
 */

import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

const DEFAULT_PATH = join(process.cwd(), 'data/frameworks/risk-domain-aliases.yaml');

/**
 * Canonical enum — must stay in sync with migration 0206's
 * `chk_fct_risk_domain_canonical` CHECK constraint.
 */
export const CANONICAL_DOMAINS = [
  'cbrn',
  'bio',
  'chem',
  'nuclear',
  'radiological',
  'cyber',
  'autonomy_replication',
  'ai_rd',
  'scheming',
  'persuasion',
  'loss_of_control',
  'other',
] as const;

export type CanonicalDomain = (typeof CANONICAL_DOMAINS)[number];

export interface DomainAliases {
  description?: string;
  aliases: string[];
}

export interface AliasFile {
  version: number;
  domains: Record<string, DomainAliases>;
}

let _cache: AliasFile | null = null;
let _cachePath: string | null = null;

/**
 * Load the alias map. Caches per path. Missing or malformed files return
 * an empty map so callers don't have to guard each call.
 */
export function loadRiskDomainAliases(path: string = DEFAULT_PATH): AliasFile {
  if (_cache && _cachePath === path) return _cache;

  const empty: AliasFile = { version: 1, domains: {} };
  if (!existsSync(path)) {
    _cache = empty;
    _cachePath = path;
    return _cache;
  }

  const raw = readFileSync(path, 'utf-8');
  const parsed = parseYaml(raw) as AliasFile | null;
  if (!parsed || typeof parsed !== 'object' || !parsed.domains) {
    _cache = empty;
  } else {
    _cache = parsed;
  }
  _cachePath = path;
  return _cache;
}

/** Reset the in-memory cache. For tests. */
export function resetAliasCache(): void {
  _cache = null;
  _cachePath = null;
}

/**
 * Map a verbatim lab label to a canonical enum value. Case-insensitive.
 * Returns `null` if no match — callers should default to `"other"` with
 * a warning rather than silently bucketing to a specific domain.
 *
 * Matches against:
 *  - the canonical key itself (exact, case-insensitive)
 *  - each alias under every canonical domain (exact, case-insensitive)
 */
export function normalizeRiskDomain(
  label: string,
  file: AliasFile = loadRiskDomainAliases(),
): CanonicalDomain | null {
  if (!label || typeof label !== 'string') return null;
  const lower = label.trim().toLowerCase();
  if (lower.length === 0) return null;

  // 1. Canonical key match.
  if ((CANONICAL_DOMAINS as readonly string[]).includes(lower)) {
    return lower as CanonicalDomain;
  }

  // 2. Alias match. Iterate to preserve first-match wins.
  for (const [canonical, info] of Object.entries(file.domains)) {
    if (!(CANONICAL_DOMAINS as readonly string[]).includes(canonical)) continue;
    if (canonical === lower) return canonical as CanonicalDomain;
    for (const alias of info.aliases ?? []) {
      if (alias.trim().toLowerCase() === lower) return canonical as CanonicalDomain;
    }
  }

  return null;
}

/**
 * Render the alias map as a compact block for inclusion in the extractor
 * prompt. One line per canonical domain, with a comma-separated alias
 * list. Skipping the `other` catch-all since it has no aliases.
 */
export function renderAliasesForPrompt(file: AliasFile = loadRiskDomainAliases()): string {
  const lines: string[] = [];
  for (const [canonical, info] of Object.entries(file.domains)) {
    if (!(CANONICAL_DOMAINS as readonly string[]).includes(canonical)) continue;
    if (canonical === 'other') continue;
    const aliases = (info.aliases ?? []).filter((a) => a && a.length > 0);
    if (aliases.length === 0) {
      lines.push(`- ${canonical}`);
    } else {
      lines.push(`- ${canonical}: ${aliases.join(', ')}`);
    }
  }
  return lines.join('\n');
}
