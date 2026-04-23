/**
 * Import IRS Form 990 financial data from the ProPublica Nonprofit Explorer API.
 *
 * Fetches revenue, expenses, and net assets for US nonprofit entities and
 * writes/updates FactBase YAML facts with `asOf` year and source URLs.
 *
 * Usage:
 *   crux fb import-990 <entity-slug>           Import 990 data for one entity
 *   crux fb import-990 <entity-slug> --dry-run  Preview without writing
 *   crux fb import-990 --discover <query>       Search ProPublica by name
 *
 * The command looks up the entity's EIN by:
 *   1. Checking for an existing `legal-identifier` fact in the entity's YAML
 *   2. Searching ProPublica by the entity's name if no EIN is found
 *   3. Prompting the user to confirm the match (or use --ein=XXXXXXXXX)
 */

import type { CommandOptions, CommandResult } from '../lib/command-types.ts';
import { loadGraphFull, resolveEntity, FACTBASE_DATA_DIR } from '../lib/factbase-loader.ts';
import {
  readEntityDocument,
  appendFact,
  updateFact,
  writeEntityDocument,
  findEntityFilePath,
} from '../lib/factbase-writer.ts';
import type { RawFactInput } from '../lib/factbase-writer.ts';
import type { Entity, Fact } from '../../packages/factbase/src/types.ts';
import type { Graph } from '../../packages/factbase/src/graph.ts';

// ── Types ─────────────────────────────────────────────────────────────

interface Import990Options extends CommandOptions {
  dryRun?: boolean;
  'dry-run'?: boolean;
  ein?: string;
  discover?: boolean;
  force?: boolean;
  ci?: boolean;
}

interface ProPublicaSearchResult {
  ein: number;
  strein: string;
  name: string;
  city: string;
  state: string;
  ntee_code: string;
  score: number;
}

interface ProPublicaFiling {
  tax_prd: number;
  tax_prd_yr: number;
  formtype: number;
  totrevenue: number;
  totfuncexpns: number;
  totassetsend: number;
  totliabend: number;
  totnetassetend: number;
  ein: number;
}

interface ProPublicaOrg {
  organization: {
    ein: number;
    name: string;
    city: string;
    state: string;
    sort_name: string;
  };
  filings_with_data: ProPublicaFiling[];
  filings_without_data: Array<{
    tax_prd: number;
    tax_prd_yr: number;
    formtype: number;
    formtype_str: string;
    pdf_url: string | null;
  }>;
}

interface FinancialFact {
  property: string;
  value: number;
  asOf: string;
  source: string;
  notes: string;
}

// ── Constants ─────────────────────────────────────────────────────────

const PROPUBLICA_API_BASE = 'https://projects.propublica.org/nonprofits/api/v2';
const PROPUBLICA_PAGE_BASE = 'https://projects.propublica.org/nonprofits/organizations';

const USER_AGENT = 'LongtermWiki/1.0 (https://www.longtermwiki.com; bot@longtermwiki.com)';

/** Minimum milliseconds between API requests to be a good citizen */
const RATE_LIMIT_MS = 500;

let lastRequestTime = 0;

// ── API helpers ───────────────────────────────────────────────────────

async function rateLimitedFetch(url: string): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastRequestTime;
  if (elapsed < RATE_LIMIT_MS) {
    await new Promise((r) => setTimeout(r, RATE_LIMIT_MS - elapsed));
  }
  lastRequestTime = Date.now();

  return fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: 'application/json',
    },
  });
}

async function searchProPublica(query: string): Promise<ProPublicaSearchResult[]> {
  const url = `${PROPUBLICA_API_BASE}/search.json?q=${encodeURIComponent(query)}`;
  const resp = await rateLimitedFetch(url);
  if (!resp.ok) {
    throw new Error(`ProPublica search failed (${resp.status}): ${resp.statusText}`);
  }
  const data = (await resp.json()) as { organizations: ProPublicaSearchResult[] };
  return data.organizations ?? [];
}

async function fetchOrganization(ein: string): Promise<ProPublicaOrg> {
  // Validate and strip hyphens from EIN
  const cleanEin = ein.replace(/-/g, '');
  if (!/^\d{9}$/.test(cleanEin)) {
    throw new Error(`Invalid EIN "${ein}" — must be 9 digits (with or without hyphen, e.g. 58-2565917)`);
  }
  const url = `${PROPUBLICA_API_BASE}/organizations/${cleanEin}.json`;
  const resp = await rateLimitedFetch(url);
  if (!resp.ok) {
    throw new Error(`ProPublica org fetch failed (${resp.status}): ${resp.statusText}`);
  }
  return (await resp.json()) as ProPublicaOrg;
}

// ── Fact extraction ───────────────────────────────────────────────────

function extractFinancialFacts(
  _entityId: string,
  org: ProPublicaOrg,
): FinancialFact[] {
  const ein = String(org.organization.ein);
  const sourceUrl = `${PROPUBLICA_PAGE_BASE}/${ein}`;
  const facts: FinancialFact[] = [];

  // Detect years with multiple filings (e.g. amended returns, fiscal-year
  // transitions). For single-filing years, keep the simpler `YYYY` asOf to
  // match existing data conventions; for multi-filing years, disambiguate
  // with `YYYY-MM` derived from `tax_prd` so each filing gets a unique key.
  const yearCounts = new Map<number, number>();
  for (const f of org.filings_with_data) {
    yearCounts.set(f.tax_prd_yr, (yearCounts.get(f.tax_prd_yr) ?? 0) + 1);
  }

  for (const filing of org.filings_with_data) {
    const einFormatted = formatEin(ein);
    const year = String(filing.tax_prd_yr);
    const asOf = (yearCounts.get(filing.tax_prd_yr) ?? 1) > 1
      ? formatTaxPeriod(filing.tax_prd)
      : year;
    const periodNote = asOf === year
      ? `tax year ${year}`
      : `tax year ${year}, period ending ${asOf}`;

    // Revenue
    if (filing.totrevenue != null && filing.totrevenue !== 0) {
      facts.push({
        property: 'revenue',
        value: filing.totrevenue,
        asOf,
        source: sourceUrl,
        notes: `From IRS Form 990 (EIN ${einFormatted}). Total revenue for ${periodNote}.`,
      });
    }

    // Expenses
    if (filing.totfuncexpns != null && filing.totfuncexpns !== 0) {
      facts.push({
        property: 'annual-expenses',
        value: filing.totfuncexpns,
        asOf,
        source: sourceUrl,
        notes: `From IRS Form 990 (EIN ${einFormatted}). Total functional expenses for ${periodNote}.`,
      });
    }

    // Net assets
    if (filing.totnetassetend != null) {
      facts.push({
        property: 'net-assets',
        value: filing.totnetassetend,
        asOf,
        source: sourceUrl,
        notes: `From IRS Form 990 (EIN ${einFormatted}). End-of-year net assets for ${periodNote}.`,
      });
    }
  }

  return facts;
}

function formatTaxPeriod(taxPrd: number): string {
  const s = String(taxPrd).padStart(6, '0');
  return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
}

function formatEin(ein: string): string {
  const clean = ein.replace(/-/g, '');
  if (clean.length === 9) {
    return `${clean.slice(0, 2)}-${clean.slice(2)}`;
  }
  return ein;
}

// ── Duplicate detection ───────────────────────────────────────────────

/** Key for matching a fact by its property and asOf year. */
function factKey(property: string, asOf: string): string {
  return `${property}::${asOf}`;
}

/**
 * Find which proposed facts already exist in the entity's FactBase data.
 * Matches on (property, asOf) — if an existing fact has the same property
 * and year, we treat it as a duplicate regardless of whether the value
 * exactly matches (since 990 data for a given year is canonical).
 *
 * Returns a Set of `property::asOf` keys for duplicates.
 */
function findDuplicateKeys(
  proposedFacts: FinancialFact[],
  existingFacts: Fact[],
): Set<string> {
  const existingKeys = new Set<string>();
  for (const f of existingFacts) {
    if (f.asOf) {
      existingKeys.add(factKey(f.propertyId, f.asOf));
    }
  }

  const duplicateKeys = new Set<string>();
  for (const pf of proposedFacts) {
    const key = factKey(pf.property, pf.asOf);
    if (existingKeys.has(key)) {
      duplicateKeys.add(key);
    }
  }
  return duplicateKeys;
}

// ── Discover command ──────────────────────────────────────────────────

async function discoverCommand(
  args: string[],
  _options: Import990Options,
): Promise<CommandResult> {
  const query = args.filter((a) => !a.startsWith('--')).join(' ');
  if (!query) {
    return {
      exitCode: 1,
      output: 'Usage: crux fb import-990 --discover <search query>\n\n  Search ProPublica Nonprofit Explorer for organizations matching the query.',
    };
  }

  const results = await searchProPublica(query);
  if (results.length === 0) {
    return {
      exitCode: 0,
      output: `No results found for "${query}".\n\nTips:\n  - Try the org's legal name (e.g., "The Clear Fund" instead of "GiveWell")\n  - Try searching without abbreviations\n  - Not all nonprofits have 990 data available`,
    };
  }

  const lines: string[] = [
    `\x1b[1mProPublica Search Results for "${query}"\x1b[0m`,
    '',
    `${'EIN'.padEnd(14)} ${'Name'.padEnd(45)} ${'City'.padEnd(20)} State`,
    '-'.repeat(90),
  ];

  for (const r of results.slice(0, 20)) {
    lines.push(
      `${r.strein.padEnd(14)} ${r.name.slice(0, 44).padEnd(45)} ${(r.city || '').slice(0, 19).padEnd(20)} ${r.state || ''}`,
    );
  }

  if (results.length > 20) {
    lines.push(`\n  ... and ${results.length - 20} more results`);
  }

  lines.push('');
  lines.push('To import data, use: crux fb import-990 <entity-slug> --ein=<EIN>');

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Main import command ───────────────────────────────────────────────

async function import990Command(
  args: string[],
  options: Import990Options,
): Promise<CommandResult> {
  // Route to discover sub-command
  // --discover <query> is parsed as discover: "<query>" by the CLI parser
  if (options.discover) {
    const discoverQuery = typeof options.discover === 'string' ? options.discover : '';
    const allParts = [discoverQuery, ...args.filter((a) => !a.startsWith('--'))].filter(Boolean);
    return discoverCommand(allParts, options);
  }

  const entityArg = args.find((a) => !a.startsWith('--'));
  const dryRun = options.dryRun ?? options['dry-run'] ?? false;

  if (!entityArg) {
    return {
      exitCode: 1,
      output: `Usage: crux fb import-990 <entity-slug> [--dry-run] [--ein=XXXXXXXXX] [--force]

  Import IRS Form 990 financial data from ProPublica Nonprofit Explorer.

  Adds revenue, expenses, and net assets facts for each available filing year.
  Idempotent: skips years that already have facts with the same property/year.

Options:
  --dry-run         Preview what would be written without modifying files
  --ein=XXXXXXXXX   Specify EIN directly (skips search/lookup)
  --force           Overwrite existing facts for the same property/year
  --ci              JSON output

Discovery:
  crux fb import-990 --discover <query>   Search ProPublica by org name

Examples:
  crux fb import-990 givewell --ein=208625442
  crux fb import-990 cais --dry-run
  crux fb import-990 --discover "Machine Intelligence Research"`,
    };
  }

  // 1. Resolve entity
  const kb = await loadGraphFull();
  const { graph, filenameMap } = kb;
  const entity = resolveEntity(entityArg, kb);

  if (!entity) {
    return {
      exitCode: 1,
      output: `Entity not found: "${entityArg}"\n  Try: crux fb search ${entityArg}`,
    };
  }

  const slug = filenameMap.get(entity.id);
  if (!slug) {
    return {
      exitCode: 1,
      output: `Cannot find filename for entity "${entity.name}" (${entity.id})`,
    };
  }

  const filePath = findEntityFilePath(slug, FACTBASE_DATA_DIR);
  if (!filePath) {
    return {
      exitCode: 1,
      output: `YAML file not found for entity "${entity.name}" (slug: ${slug})`,
    };
  }

  // 2. Determine EIN
  let ein = options.ein ? String(options.ein).replace(/-/g, '') : null;

  if (!ein) {
    // Try to extract EIN from existing ProPublica source URLs
    ein = extractEinFromExistingFacts(graph, entity.id);
  }

  if (!ein) {
    // Search by entity name
    const searchResults = await searchProPublica(entity.name);
    if (searchResults.length === 0) {
      return {
        exitCode: 1,
        output: `No ProPublica results for "${entity.name}".\n\nTips:\n  - Use --ein=XXXXXXXXX if you know the EIN\n  - Try: crux fb import-990 --discover "<legal name>"\n  - Not all nonprofits file 990s (e.g., churches, small orgs)`,
      };
    }

    // Show results and ask user to specify
    const lines: string[] = [
      `Multiple potential matches for "${entity.name}". Specify the EIN:`,
      '',
    ];
    for (const r of searchResults.slice(0, 10)) {
      lines.push(`  --ein=${String(r.ein).padEnd(12)} ${r.name} (${r.city}, ${r.state})`);
    }
    lines.push('');
    lines.push(`Example: crux fb import-990 ${entityArg} --ein=${searchResults[0].ein}`);

    return { exitCode: 1, output: lines.join('\n') };
  }

  // 3. Fetch 990 data
  let org: ProPublicaOrg;
  try {
    org = await fetchOrganization(ein);
  } catch (e) {
    return {
      exitCode: 1,
      output: `Failed to fetch 990 data for EIN ${formatEin(ein)}: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  if (!org.filings_with_data || org.filings_with_data.length === 0) {
    return {
      exitCode: 0,
      output: `No 990 filings with data found for ${org.organization.name} (EIN ${formatEin(ein)}).`,
    };
  }

  // 4. Extract financial facts
  const proposedFacts = extractFinancialFacts(entity.id, org);

  if (proposedFacts.length === 0) {
    return {
      exitCode: 0,
      output: `No financial data to import from 990 filings for ${entity.name}.`,
    };
  }

  // 5. Detect duplicates
  const existingFacts = graph.getFacts(entity.id);
  const duplicateKeys = findDuplicateKeys(proposedFacts, existingFacts);

  // Split facts into new (no existing match) and updates (existing match, --force only)
  const newFacts: FinancialFact[] = [];
  const factsToUpdate: FinancialFact[] = [];
  for (const f of proposedFacts) {
    const key = factKey(f.property, f.asOf);
    if (duplicateKeys.has(key)) {
      if (options.force) {
        factsToUpdate.push(f);
      }
      // else: skip silently (duplicate, no --force)
    } else {
      newFacts.push(f);
    }
  }

  const totalToWrite = newFacts.length + factsToUpdate.length;

  // 6. Output
  const lines: string[] = [];
  const orgName = org.organization.name || org.organization.sort_name;
  lines.push(`\x1b[1m${entity.name}\x1b[0m <- ${orgName} (EIN ${formatEin(ein)})`);
  lines.push(`Filings available: ${org.filings_with_data.length} years (${getYearRange(org.filings_with_data)})`);
  lines.push('');

  const skippedCount = proposedFacts.length - totalToWrite;
  if (skippedCount > 0) {
    const skipped = skippedCount;
    lines.push(`\x1b[2mSkipping ${skipped} facts already present (use --force to overwrite)\x1b[0m`);
    lines.push('');
  }
  if (factsToUpdate.length > 0) {
    lines.push(`\x1b[33mOverwriting ${factsToUpdate.length} existing facts (--force)\x1b[0m`);
    lines.push('');
  }

  if (totalToWrite === 0) {
    lines.push('Nothing new to import — all available 990 data is already in the FactBase.');
    return { exitCode: 0, output: lines.join('\n') };
  }

  // Group by year for display
  const allFactsToWrite = [...newFacts, ...factsToUpdate];
  const byYear = new Map<string, FinancialFact[]>();
  for (const f of allFactsToWrite) {
    const existing = byYear.get(f.asOf);
    if (existing) {
      existing.push(f);
    } else {
      byYear.set(f.asOf, [f]);
    }
  }

  for (const [year, facts] of [...byYear].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  \x1b[1m${year}\x1b[0m`);
    for (const f of facts) {
      const formatted = formatDollarAmount(f.value);
      lines.push(`    ${f.property.padEnd(18)} ${formatted}`);
    }
  }

  lines.push('');

  if (dryRun) {
    lines.push(`\x1b[33m[DRY RUN]\x1b[0m ${newFacts.length} new + ${factsToUpdate.length} updated = ${totalToWrite} facts would be written to ${slug}.yaml`);

    if (options.ci) {
      return {
        exitCode: 0,
        output: JSON.stringify({
          entity: entity.name,
          entityId: entity.id,
          ein: formatEin(ein),
          orgName,
          proposed: totalToWrite,
          new: newFacts.length,
          updated: factsToUpdate.length,
          skipped: skippedCount,
          facts: allFactsToWrite.map((f) => ({
            property: f.property,
            value: f.value,
            asOf: f.asOf,
          })),
        }),
      };
    }

    return { exitCode: 0, output: lines.join('\n') };
  }

  // 7. Write facts
  const doc = readEntityDocument(filePath);
  const writtenIds: string[] = [];
  const updatedIds: string[] = [];

  // Update existing facts in-place
  for (const fact of factsToUpdate) {
    const updatedId = updateFact(
      doc,
      { property: fact.property, asOf: fact.asOf },
      { value: fact.value, source: fact.source, notes: fact.notes },
    );
    if (updatedId) {
      updatedIds.push(updatedId);
    }
  }

  // Append new facts
  for (const fact of newFacts) {
    const factInput: RawFactInput = {
      property: fact.property,
      value: fact.value,
      asOf: fact.asOf,
      source: fact.source,
      notes: fact.notes,
    };
    const factId = appendFact(doc, factInput);
    writtenIds.push(factId);
  }

  writeEntityDocument(filePath, doc);

  if (writtenIds.length > 0) {
    lines.push(`\x1b[32m+${writtenIds.length} new facts\x1b[0m written to ${slug}.yaml`);
    lines.push(`  IDs: ${writtenIds.join(', ')}`);
  }
  if (updatedIds.length > 0) {
    lines.push(`\x1b[33m~${updatedIds.length} facts\x1b[0m updated in ${slug}.yaml`);
    lines.push(`  IDs: ${updatedIds.join(', ')}`);
  }

  if (options.ci) {
    return {
      exitCode: 0,
      output: JSON.stringify({
        entity: entity.name,
        entityId: entity.id,
        ein: formatEin(ein),
        orgName,
        written: writtenIds.length,
        updated: updatedIds.length,
        skipped: skippedCount,
        factIds: [...writtenIds, ...updatedIds],
      }),
    };
  }

  return { exitCode: 0, output: lines.join('\n') };
}

// ── Utility helpers ───────────────────────────────────────────────────

/**
 * Try to extract an EIN from existing ProPublica source URLs in the entity's facts.
 * Pattern: https://projects.propublica.org/nonprofits/organizations/<EIN>
 */
function extractEinFromExistingFacts(graph: Graph, entityId: string): string | null {
  const facts = graph.getFacts(entityId);
  const propublicaPattern = /propublica\.org\/nonprofits\/organizations\/(\d+)/;

  for (const fact of facts) {
    if (fact.source) {
      const match = fact.source.match(propublicaPattern);
      if (match) {
        return match[1];
      }
    }
  }
  return null;
}

function getYearRange(filings: ProPublicaFiling[]): string {
  if (filings.length === 0) return 'none';
  const years = filings.map((f) => f.tax_prd_yr).sort((a, b) => a - b);
  return `${years[0]}–${years[years.length - 1]}`;
}

function formatDollarAmount(value: number): string {
  if (Math.abs(value) >= 1e9) {
    return `$${(value / 1e9).toFixed(2)}B`;
  }
  if (Math.abs(value) >= 1e6) {
    return `$${(value / 1e6).toFixed(2)}M`;
  }
  if (Math.abs(value) >= 1e3) {
    return `$${(value / 1e3).toFixed(1)}K`;
  }
  return `$${value.toLocaleString()}`;
}

// ── Exports ───────────────────────────────────────────────────────────

export const import990 = import990Command;

export const commands = {
  default: import990Command,
};

export function getHelp(): string {
  return `
Import IRS Form 990 data — Automated nonprofit financial data from ProPublica

Usage:
  crux fb import-990 <entity-slug> [--dry-run] [--ein=XXXXXXXXX] [--force]
  crux fb import-990 --discover <query>

Imports revenue, expenses, and net assets for US nonprofit entities from the
ProPublica Nonprofit Explorer API. Writes FactBase YAML facts with proper
asOf dates and source URLs. Idempotent: skips years already present.

Options:
  --dry-run         Preview what would be written without modifying files
  --ein=XXXXXXXXX   Specify EIN directly (skips search/lookup)
  --force           Overwrite existing facts for the same property/year
  --discover        Search ProPublica by org name instead of importing
  --ci              JSON output

Examples:
  crux fb import-990 givewell --ein=208625442
  crux fb import-990 cais --dry-run
  crux fb import-990 --discover "Machine Intelligence Research"
`;
}
