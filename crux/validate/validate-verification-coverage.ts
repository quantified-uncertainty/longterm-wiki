#!/usr/bin/env node
/**
 * Advisory gate rule: check verification coverage of TableBase submissions.
 * Warns when manifest files show records submitted without verification.
 *
 * Reads JSON manifests from data/tablebase-manifests/ and reports:
 * - Per-manifest: table, record count, verification coverage
 * - Total coverage percentage across all manifests
 * - Warnings for unverified or contradicted records
 *
 * Exit codes:
 *   0 = All records have verification (or no manifests to check)
 *   1 = Some records lack verification or have contradicted verdicts
 */

import { readdirSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { PROJECT_ROOT } from '../lib/content-types.ts';

const MANIFEST_DIR = join(PROJECT_ROOT, 'data', 'tablebase-manifests');

interface VerificationSummary {
  withVerification: number;
  withoutVerification: number;
  verdicts: {
    verified: number;
    contradicted: number;
    unverifiable: number;
    other: number;
  };
}

interface Manifest {
  table: string;
  recordCount: number;
  submittedAt: string;
  verificationSummary: VerificationSummary;
  records: Array<Record<string, unknown>>;
}

function main() {
  if (!existsSync(MANIFEST_DIR)) {
    console.log('No tablebase-manifests/ directory — nothing to check.');
    process.exit(0);
  }

  const files = readdirSync(MANIFEST_DIR).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.log('No manifest files found — nothing to check.');
    process.exit(0);
  }

  let totalRecords = 0;
  let totalVerified = 0;
  let totalUnverified = 0;
  const warnings: string[] = [];

  for (const file of files) {
    let manifest: Manifest;
    try {
      manifest = JSON.parse(readFileSync(join(MANIFEST_DIR, file), 'utf-8')) as Manifest;
    } catch (e: unknown) {
      warnings.push(`${file}: failed to parse — ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }

    const { table, recordCount, verificationSummary } = manifest;

    if (!verificationSummary || typeof recordCount !== 'number') {
      warnings.push(`${file}: missing verificationSummary or recordCount`);
      continue;
    }

    totalRecords += recordCount;
    totalVerified += verificationSummary.withVerification;
    totalUnverified += verificationSummary.withoutVerification;

    if (verificationSummary.withoutVerification > 0) {
      warnings.push(
        `${file}: ${verificationSummary.withoutVerification}/${recordCount} ${table} records submitted WITHOUT verification`
      );
    }

    if (verificationSummary.verdicts.contradicted > 0) {
      warnings.push(
        `${file}: ${verificationSummary.verdicts.contradicted} ${table} records have CONTRADICTED verdicts`
      );
    }
  }

  // Summary
  const coverage = totalRecords > 0 ? Math.round((totalVerified / totalRecords) * 100) : 100;
  console.log(`Verification coverage: ${totalVerified}/${totalRecords} records (${coverage}%)`);

  if (warnings.length > 0) {
    console.log('');
    for (const w of warnings) {
      console.log(`  WARNING: ${w}`);
    }
    process.exit(1); // advisory failure
  }

  console.log('All TableBase submissions have verification.');
  process.exit(0);
}

main();
