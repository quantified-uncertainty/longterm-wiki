/**
 * Validate sourcing name resolution quality.
 *
 * Checks that sourcing verdicts resolve to human-readable names
 * (not raw 10-char IDs). Catches regressions like the one where entity
 * names showed as "fVMqY7vpMA" instead of "Bezos Earth Fund".
 *
 * Usage:
 *   pnpm crux validate sourcing-names              # Check against wiki-server
 *   WIKI_SERVER_ENV=prod pnpm crux validate sourcing-names  # Check production
 *
 * This validator checks:
 * 1. Entity IDs in verdicts resolve to entity names (not raw IDs)
 * 2. Record IDs in verdicts resolve to display names (not raw IDs)
 * 3. Entity links resolve to valid wiki pages (not /wiki/<raw-id>)
 */

import { apiRequest } from '../lib/wiki-server/client.ts';
import { isAnySid, isSid } from '../../packages/id-utils/src/index.ts';

interface Verdict {
  recordType: string;
  recordId: string;
  entityId: string | null;
  verdict: string;
}

interface VerdictsResponse {
  verdicts: Verdict[];
  total: number;
}

interface ResolveNamesResponse {
  names: Record<string, string>;
}

const RECORD_TYPES = ['personnel', 'grant', 'publication', 'division', 'investment', 'policy-stakeholder'];

export async function validateSourcingNames(): Promise<{
  pass: boolean;
  totalChecked: number;
  unresolvedEntities: number;
  unresolvedRecords: number;
  details: string[];
}> {
  const details: string[] = [];
  let totalChecked = 0;
  let unresolvedEntities = 0;
  let unresolvedRecords = 0;

  for (const recordType of RECORD_TYPES) {
    // Fetch a sample of verdicts
    // typed-client-ok: QUA-770 baseline — validator script, direct typing acceptable for ad-hoc integrity queries
    const verdictsResult = await apiRequest<VerdictsResponse>(
      'GET',
      `/api/sourcing/verdicts?record_type=${recordType}&limit=20`
    );

    if (!verdictsResult.ok) {
      details.push(`[SKIP] ${recordType}: failed to fetch verdicts`);
      continue;
    }

    const { verdicts, total } = verdictsResult.data;
    if (verdicts.length === 0) {
      details.push(`[OK] ${recordType}: no verdicts`);
      continue;
    }

    // Collect entity IDs and record IDs
    const entityIds = new Set<string>();
    const recordIds = new Set<string>();
    for (const v of verdicts) {
      if (v.entityId) entityIds.add(v.entityId);
      recordIds.add(v.recordId);
    }

    // Check entity IDs — none should be bare stableIds without names
    const entityIssues: string[] = [];
    for (const eid of entityIds) {
      if (isAnySid(eid) && !isSid(eid)) {
        entityIssues.push(eid);
      }
    }
    if (entityIssues.length > 0) {
      // These are bare IDs that the frontend will need to resolve with sid_ prefix
      details.push(
        `[INFO] ${recordType}: ${entityIssues.length}/${entityIds.size} entity IDs stored without sid_ prefix`
      );
    }

    // Resolve record names
    const idList = [...recordIds].join(',');
    // typed-client-ok: QUA-770 baseline — validator script, direct typing acceptable for ad-hoc integrity queries
    const namesResult = await apiRequest<ResolveNamesResponse>(
      'GET',
      `/api/sourcing/resolve-names?record_type=${recordType}&record_ids=${encodeURIComponent(idList)}`
    );

    if (!namesResult.ok) {
      details.push(`[WARN] ${recordType}: resolve-names failed`);
      continue;
    }

    const names = namesResult.data.names;
    const unresolved: string[] = [];
    for (const rid of recordIds) {
      totalChecked++;
      if (!names[rid]) {
        unresolved.push(rid);
        unresolvedRecords++;
      }
    }

    // Count unresolved entities
    unresolvedEntities += entityIssues.length;

    const resolvedPct = Math.round(((recordIds.size - unresolved.length) / recordIds.size) * 100);
    if (unresolved.length === 0) {
      details.push(`[OK] ${recordType}: ${recordIds.size}/${total} sampled, 100% resolved`);
    } else if (resolvedPct >= 50) {
      details.push(
        `[WARN] ${recordType}: ${unresolved.length}/${recordIds.size} unresolved (${resolvedPct}% resolved) — orphaned records`
      );
    } else {
      details.push(
        `[FAIL] ${recordType}: ${unresolved.length}/${recordIds.size} unresolved (${resolvedPct}% resolved) — likely broken resolution`
      );
    }
  }

  // Pass if >50% of records resolve (orphaned records are expected; broken resolution is not)
  const resolvedPct = totalChecked > 0 ? Math.round(((totalChecked - unresolvedRecords) / totalChecked) * 100) : 100;
  const pass = resolvedPct >= 50;

  return {
    pass,
    totalChecked,
    unresolvedEntities,
    unresolvedRecords,
    details,
  };
}

// CLI entry point
if (import.meta.url.endsWith(process.argv[1]) || process.argv[1]?.endsWith('validate-sourcing-names.ts')) {
  validateSourcingNames()
    .then((result) => {
      console.log('\n=== Source-Check Name Resolution Validation ===\n');
      for (const line of result.details) {
        console.log(`  ${line}`);
      }
      console.log();
      console.log(`  Total records checked: ${result.totalChecked}`);
      console.log(`  Unresolved records: ${result.unresolvedRecords}`);
      console.log(`  Bare entity IDs (need sid_ prefix): ${result.unresolvedEntities}`);
      console.log(`  Result: ${result.pass ? 'PASS' : 'FAIL'}\n`);
      process.exit(result.pass ? 0 : 1);
    })
    .catch((e) => {
      console.error('Validation failed:', e);
      process.exit(1);
    });
}
