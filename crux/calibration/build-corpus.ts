/**
 * Calibration Corpus Builder (QUA-635)
 *
 * Samples confirmed sourcing verdicts from prod, pulls the matching
 * records + evidence + cached source content, and emits a calibration
 * corpus JSON file that the calibration runner can replay against
 * different LLM models.
 *
 * Known-true: real (record, sourceUrl) pairs whose verdict is `confirmed`.
 * Known-false: constructed by mutating a field of a known-true item so the
 * claim no longer matches the source (e.g. swap role, flip amount).
 *
 * Run: WIKI_SERVER_ENV=prod pnpm tsx crux/calibration/build-corpus.ts
 * Emits: crux/calibration/data/corpus.json
 */

import { writeFileSync } from 'node:fs';
import { apiRequest } from '../lib/wiki-server/client.ts';
import { getEvidenceByRecord } from '../lib/wiki-server/sourcing-client.ts';
import { fetchSourceContent } from '../lib/sourcing/source-fetcher.ts';
import { hostMatches } from '@longterm-wiki/url-utils';

// ── Types ───────────────────────────────────────────────────────────

type RecordType = 'personnel' | 'publication' | 'funding-round';

interface CorpusItem {
  id: string;                             // unique within corpus
  label: 'true' | 'false';                // ground truth
  expectedVerdict: 'confirmed' | 'contradicted' | 'unverifiable';
  recordType: RecordType;
  recordId: string;                       // real PG id (even for mutated false items — ok, we don't write back)
  entityDisplayName: string;              // e.g. "Anthropic"
  description: string;                    // human-readable claim description
  fields: Record<string, string | number | null>;  // the fields that go into the prompt
  sourceUrl: string;
  /** If label=false, what mutation was applied (for auditing). */
  mutation?: {
    kind: 'field-swap' | 'value-change' | 'name-swap';
    field: string;
    originalValue: string | number | null;
    mutatedValue: string | number | null;
    note: string;
  };
  /** For true items: the prior verdict evidence (for context, not fed into prompt). */
  provenance?: {
    priorVerdict: string;
    priorConfidence: number;
    priorReasoning: string;
    priorCheckerModel?: string;
  };
}

// ── Per-type fetchers ───────────────────────────────────────────────

async function fetchConfirmedVerdicts(recordType: RecordType, limit: number) {
  // The /verdicts endpoint returns aggregate verdicts, pageable with limit up to 500.
  // typed-client-ok: QUA-770 baseline — calibration corpus builder, direct typing acceptable for ad-hoc analysis queries
  const r = await apiRequest<{
    verdicts: Array<{
      recordType: string; recordId: string; entityId: string | null;
      displayName: string | null; entityDisplayName: string | null;
      verdict: string; confidence: number; reasoning: string;
    }>;
    total: number;
  }>(
    'GET',
    `/api/sourcing/verdicts?verdict=confirmed&record_type=${recordType}&limit=${limit}`,
  );
  if (!r.ok) throw new Error(`verdicts fetch failed: ${r.message}`);
  return r.data.verdicts;
}

async function fetchPersonnelRecord(id: string) {
  // There's no point-lookup endpoint for personnel — fetch by organizationId via verdict's entityId.
  // Simpler: just scan /api/personnel/all with offset, but that's expensive. Use the by-entity
  // endpoint via the verdict's entityId. The verdict has entityId = organizationId.
  return null; // we'll resolve fields from the verdict itself + evidence
}

/** Cache all publications once, keyed by id — point-lookup endpoint doesn't exist. */
let publicationCache: Map<string, Record<string, unknown>> | null = null;
async function fetchPublication(id: string) {
  if (!publicationCache) {
    publicationCache = new Map();
    let offset = 0;
    while (true) {
      // typed-client-ok: QUA-770 baseline — calibration corpus builder, direct typing acceptable for ad-hoc analysis queries
      const r = await apiRequest<{ publications: Array<Record<string, unknown>>; total: number }>(
        'GET', `/api/publications/all?limit=200&offset=${offset}`,
      );
      if (!r.ok) break;
      for (const row of r.data.publications) publicationCache.set(row.id as string, row);
      offset += r.data.publications.length;
      if (offset >= r.data.total || r.data.publications.length === 0) break;
    }
    console.log(`[cache] loaded ${publicationCache.size} publications`);
  }
  return publicationCache.get(id) ?? null;
}

let fundingRoundCache: Map<string, Record<string, unknown>> | null = null;
async function fetchFundingRound(id: string) {
  if (!fundingRoundCache) {
    fundingRoundCache = new Map();
    let offset = 0;
    while (true) {
      // typed-client-ok: QUA-770 baseline — calibration corpus builder, direct typing acceptable for ad-hoc analysis queries
      const r = await apiRequest<{ fundingRounds: Array<Record<string, unknown>>; total: number }>(
        'GET', `/api/funding-rounds/all?limit=200&offset=${offset}`,
      );
      if (!r.ok) break;
      for (const row of r.data.fundingRounds) fundingRoundCache.set(row.id as string, row);
      offset += r.data.fundingRounds.length;
      if (offset >= r.data.total || r.data.fundingRounds.length === 0) break;
    }
    console.log(`[cache] loaded ${fundingRoundCache.size} funding-rounds`);
  }
  return fundingRoundCache.get(id) ?? null;
}

/** Fetch a personnel row by scanning by-entity for the parent org. */
async function fetchPersonnelByEntity(orgId: string, recordId: string): Promise<Record<string, unknown> | null> {
  // typed-client-ok: QUA-770 baseline — calibration corpus builder, direct typing acceptable for ad-hoc analysis queries
  const r = await apiRequest<{
    personnel: Array<Record<string, unknown>>;
  }>('GET', `/api/personnel/by-entity/${encodeURIComponent(orgId)}?limit=500`);
  if (!r.ok) return null;
  return r.data.personnel.find(p => p.id === recordId) ?? null;
}

// ── Field extraction → fields used in prompt ────────────────────────

function personnelFields(row: Record<string, unknown>): {
  description: string;
  entityName: string;
  fields: Record<string, string | number | null>;
} {
  const person = row.person as { name?: string } | undefined;
  const org = row.organization as { name?: string } | undefined;
  const personName = person?.name ?? (row.personResolvedName as string) ?? String(row.personId ?? '');
  const orgName = org?.name ?? (row.orgResolvedName as string) ?? String(row.organizationId ?? '');
  const role = row.role as string | null;
  const description = `${personName} — ${role ?? 'unknown role'} at ${orgName}`;
  return {
    description,
    entityName: orgName,
    fields: {
      person: personName,
      organization: orgName,
      role: role,
      roleType: (row.roleType as string | null) ?? null,
      startDate: (row.startDate as string | null) ?? null,
      endDate: (row.endDate as string | null) ?? null,
      isFounder: row.isFounder ? 'true' : null,
    },
  };
}

function publicationFields(row: Record<string, unknown>): {
  description: string;
  entityName: string;
  fields: Record<string, string | number | null>;
} {
  const entityName = (row.entityDisplayName as string) ?? '(unknown org)';
  const title = (row.title as string) ?? '';
  const authors = (row.authors as string) ?? '';
  const venue = (row.venue as string | null) ?? null;
  const year = (row.publishedDate as string | null) ?? null;
  return {
    description: `"${title}" by ${authors}${year ? ` (${year})` : ''}${venue ? ` — ${venue}` : ''}`,
    entityName,
    fields: {
      title,
      authors,
      venue,
      publishedDate: year,
      publicationType: (row.publicationType as string | null) ?? null,
    },
  };
}

function fundingRoundFields(row: Record<string, unknown>): {
  description: string;
  entityName: string;
  fields: Record<string, string | number | null>;
} {
  const companyRef = row.companyRef as { name?: string } | undefined;
  const entityName = companyRef?.name ?? (row.companyResolvedName as string) ?? String(row.companyId ?? '');
  const name = (row.name as string) ?? '(unnamed round)';
  const date = (row.date as string | null) ?? null;
  const raised = (row.raised as number | null) ?? null;
  const lead = (row.leadInvestor as string | null) ?? null;
  const instrument = (row.instrument as string | null) ?? null;
  return {
    description: `${entityName} — ${name}${date ? ` (${date})` : ''}${raised ? `, raised $${raised.toLocaleString()}` : ''}`,
    entityName,
    fields: {
      company: entityName,
      roundName: name,
      date,
      raised,
      leadInvestor: lead,
      instrument,
    },
  };
}

// ── Known-false mutations ───────────────────────────────────────────

function mutatePersonnel(fields: Record<string, string | number | null>, description: string) {
  // Swap role to something clearly wrong.
  const original = fields.role as string | null;
  const swap = /ceo|chief executive/i.test(original ?? '') ? 'Intern'
    : /intern/i.test(original ?? '') ? 'CEO'
    : /board|director|trustee|advisor/i.test(original ?? '') ? 'Software Engineering Intern'
    : /founder|ceo/i.test(original ?? '') ? 'Janitor'
    : 'Chief Executive Officer';
  return {
    fields: { ...fields, role: swap, roleType: 'career' as string | null },
    description: description.replace(original ?? '', swap),
    mutation: {
      kind: 'value-change' as const,
      field: 'role',
      originalValue: original,
      mutatedValue: swap,
      note: 'Swapped role to clearly different title unsupported by source.',
    },
  };
}

function mutatePublication(fields: Record<string, string | number | null>, description: string) {
  // Change authors to a well-known AI-safety researcher not on the paper.
  const original = fields.authors as string | null;
  const swap = 'Geoffrey Hinton, Yoshua Bengio';
  return {
    fields: { ...fields, authors: swap },
    description: description.replace(original ?? '', swap),
    mutation: {
      kind: 'value-change' as const,
      field: 'authors',
      originalValue: original,
      mutatedValue: swap,
      note: 'Replaced authors with unrelated well-known researchers.',
    },
  };
}

function mutateFundingRound(fields: Record<string, string | number | null>, description: string) {
  // 10x the raised amount.
  const original = fields.raised as number | null;
  const swap = original == null ? 999_999_999 : original * 10;
  return {
    fields: { ...fields, raised: swap },
    description: description.replace(
      `$${(original ?? 0).toLocaleString()}`,
      `$${swap.toLocaleString()}`,
    ),
    mutation: {
      kind: 'value-change' as const,
      field: 'raised',
      originalValue: original,
      mutatedValue: swap,
      note: 'Inflated raised amount by 10x.',
    },
  };
}

// ── Main ───────────────────────────────────────────────────────────

const TARGETS: Record<RecordType, number> = {
  personnel: 20,
  publication: 15,
  'funding-round': 15,
};

async function buildForType(recordType: RecordType): Promise<CorpusItem[]> {
  const target = TARGETS[recordType];
  console.log(`\n[${recordType}] target: ${target} true + ${target} false`);

  // Pull more verdicts than needed — we'll filter.
  const verdicts = await fetchConfirmedVerdicts(recordType, Math.max(200, target * 6));
  console.log(`[${recordType}] fetched ${verdicts.length} confirmed verdicts`);

  const trueItems: CorpusItem[] = [];
  const falseItems: CorpusItem[] = [];

  for (const v of verdicts) {
    if (trueItems.length >= target && falseItems.length >= target) break;

    // 1. Fetch evidence to get sourceUrl and checker model.
    const evidenceResult = await getEvidenceByRecord(v.recordType, v.recordId, { limit: 5 });
    if (!evidenceResult.ok) continue;
    const evidence = evidenceResult.data.evidence;
    // Prefer LLM-checked evidence (Haiku) over inline-submission — those actually went through the verdict prompt.
    const llmEvidence = evidence.find(
      (e: any) => e.checkerModel && /haiku|sonnet|opus|claude/.test(e.checkerModel)
    );
    const anyEvidence = llmEvidence ?? evidence[0];
    if (!anyEvidence) continue;
    const sourceUrl = (anyEvidence as any).sourceUrl;
    if (!sourceUrl) continue;

    // 2. Skip archive/wayback URLs and dead-known domains.
    if (hostMatches(sourceUrl, 'web.archive.org') || sourceUrl.startsWith('mailto:')) continue;

    // 3. Fetch the full record (fields) from the typed endpoint.
    let row: Record<string, unknown> | null = null;
    if (recordType === 'personnel') {
      if (!v.entityId) continue;
      row = await fetchPersonnelByEntity(v.entityId, v.recordId);
    } else if (recordType === 'publication') {
      row = await fetchPublication(v.recordId);
    } else if (recordType === 'funding-round') {
      row = await fetchFundingRound(v.recordId);
    }
    if (!row) continue;

    // 4. Build description + fields.
    let extracted: { description: string; entityName: string; fields: Record<string, string | number | null> };
    if (recordType === 'personnel') extracted = personnelFields(row);
    else if (recordType === 'publication') extracted = publicationFields(row);
    else extracted = fundingRoundFields(row);

    // 5. Confirm source content is cached and non-empty (skip if not).
    const fetch = await fetchSourceContent(sourceUrl, undefined, '[corpus-build]');
    if (!fetch.content || fetch.content.length < 400) {
      // Skip silently — not enough text to verify against.
      continue;
    }

    // 6. Build true item.
    if (trueItems.length < target) {
      trueItems.push({
        id: `T-${recordType}-${v.recordId}`,
        label: 'true',
        expectedVerdict: 'confirmed',
        recordType,
        recordId: v.recordId,
        entityDisplayName: extracted.entityName,
        description: extracted.description,
        fields: extracted.fields,
        sourceUrl,
        provenance: {
          priorVerdict: v.verdict,
          priorConfidence: v.confidence,
          priorReasoning: v.reasoning?.slice(0, 300) ?? '',
          priorCheckerModel: (anyEvidence as any).checkerModel,
        },
      });
    }

    // 7. Build mutated false item from the same record.
    if (falseItems.length < target) {
      let mutated: { fields: Record<string, string | number | null>; description: string; mutation: CorpusItem['mutation'] };
      if (recordType === 'personnel') mutated = mutatePersonnel(extracted.fields, extracted.description);
      else if (recordType === 'publication') mutated = mutatePublication(extracted.fields, extracted.description);
      else mutated = mutateFundingRound(extracted.fields, extracted.description);

      // Sanity: skip mutations that didn't actually change the value.
      if (mutated.mutation!.originalValue === mutated.mutation!.mutatedValue) continue;

      falseItems.push({
        id: `F-${recordType}-${v.recordId}`,
        label: 'false',
        expectedVerdict: 'contradicted',
        recordType,
        recordId: v.recordId,
        entityDisplayName: extracted.entityName,
        description: mutated.description,
        fields: mutated.fields,
        sourceUrl,
        mutation: mutated.mutation,
      });
    }
  }

  console.log(`[${recordType}] built ${trueItems.length} true + ${falseItems.length} false`);
  return [...trueItems, ...falseItems];
}

async function main() {
  const allItems: CorpusItem[] = [];
  for (const t of ['personnel', 'publication', 'funding-round'] as RecordType[]) {
    const items = await buildForType(t);
    allItems.push(...items);
  }

  const outputPath = new URL('./data/corpus.json', import.meta.url).pathname;
  writeFileSync(outputPath, JSON.stringify({
    builtAt: new Date().toISOString(),
    totalItems: allItems.length,
    trueCount: allItems.filter(i => i.label === 'true').length,
    falseCount: allItems.filter(i => i.label === 'false').length,
    byType: Object.fromEntries(
      (['personnel', 'publication', 'funding-round'] as RecordType[]).map(t => [
        t,
        {
          true: allItems.filter(i => i.recordType === t && i.label === 'true').length,
          false: allItems.filter(i => i.recordType === t && i.label === 'false').length,
        },
      ]),
    ),
    items: allItems,
  }, null, 2));
  console.log(`\n✓ Wrote ${allItems.length} items to ${outputPath}`);
}

main().catch((e) => {
  console.error('FAILED:', e);
  process.exit(1);
});
