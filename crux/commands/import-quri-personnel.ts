/**
 * Import QURI personnel records into wiki-server Postgres.
 *
 * Syncs a curated list of QURI staff, contractors, and board members
 * to the personnel table via POST /api/personnel/sync.
 *
 * Usage:
 *   pnpm crux tb import-quri-personnel sync              # Sync to wiki-server
 *   pnpm crux tb import-quri-personnel sync --dry-run    # Preview without writing
 */

import type { CommandResult } from '../lib/command-types.ts';
import { getServerUrl } from '../lib/wiki-server/client.ts';
import { syncPersonnel } from '../lib/wiki-server/personnel.ts';

// ---------------------------------------------------------------------------
// Personnel type (matches wiki-server SyncPersonnelItemSchema)
// ---------------------------------------------------------------------------

interface PersonnelRecord {
  id: string;
  personId: string;
  organizationId: string;
  role: string;
  roleType: 'key-person' | 'board' | 'career';
  startDate?: string;
  endDate?: string | null;
  isFounder?: boolean;
  source?: string;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Curated QURI personnel data
// ---------------------------------------------------------------------------

const QURI_PERSONNEL: PersonnelRecord[] = [
  {
    id: 'QRprs00001',
    personId: 'ozzie-gooen',
    organizationId: 'quri',
    role: 'Executive Director',
    roleType: 'key-person',
    startDate: '2019',
    endDate: null,
    isFounder: true,
    notes: 'Founder and Executive Director since 2019',
  },
  {
    id: 'QRprs00002',
    personId: 'slava-matyukhin',
    organizationId: 'quri',
    role: 'Lead Developer',
    roleType: 'key-person',
    startDate: '2022',
    endDate: '2025',
    isFounder: false,
    notes: 'Lead developer of Squiggle v0.8-0.10 and Squiggle Hub',
  },
  {
    id: 'QRprs00003',
    personId: 'nuno-sempere',
    organizationId: 'quri',
    role: 'Research Fellow',
    roleType: 'key-person',
    startDate: '2020',
    endDate: '2023',
    isFounder: false,
    notes: 'Built Metaforecast; extensive forecasting research',
  },
  {
    id: 'QRprs00004',
    personId: 'sam-nolan',
    organizationId: 'quri',
    role: 'Software Developer',
    roleType: 'key-person',
    startDate: '2021',
    endDate: '2023',
    isFounder: false,
    notes: 'Squiggle developer; led GiveWell CEA quantification project',
  },
  {
    id: 'QRprs00005',
    personId: 'elizabeth-van-nostrand',
    organizationId: 'quri',
    role: 'Consultant',
    roleType: 'key-person',
    startDate: '2019',
    endDate: '2020',
    isFounder: false,
    notes: 'Evaluation work and Amplifying Generalist Research experiment',
  },
  {
    id: 'QRprs00006',
    personId: 'quinn-dougherty',
    organizationId: 'quri',
    role: 'Software Engineer',
    roleType: 'key-person',
    startDate: '2021',
    endDate: '2022',
    isFounder: false,
    notes: 'Focused on epistemic public goods',
  },
  {
    id: 'QRprs00007',
    personId: 'ben-goldhaber',
    organizationId: 'quri',
    role: 'Board Member',
    roleType: 'board',
    isFounder: false,
  },
  {
    id: 'QRprs00008',
    personId: 'jacob-lagerros',
    organizationId: 'quri',
    role: 'Board Member',
    roleType: 'board',
    isFounder: false,
  },
  {
    id: 'QRprs00009',
    personId: 'andrew-critch',
    organizationId: 'quri',
    role: 'Board Member',
    roleType: 'board',
    isFounder: false,
  },
];

// ---------------------------------------------------------------------------
// Command handler
// ---------------------------------------------------------------------------

async function syncCommand(
  _args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const dryRun = !!options['dry-run'];
  const lines: string[] = [];

  if (!getServerUrl()) {
    return {
      exitCode: 1,
      output:
        'wiki-server URL not configured. Set LONGTERMWIKI_SERVER_URL or use WIKI_SERVER_ENV=prod.',
    };
  }

  lines.push('\n  QURI Personnel Import');
  lines.push(`  ${'='.repeat(40)}`);
  lines.push(`  ${QURI_PERSONNEL.length} personnel records to sync`);

  if (dryRun) {
    for (const p of QURI_PERSONNEL) {
      lines.push(
        `    - ${p.personId}: ${p.role} (${p.roleType})${p.isFounder ? ' [founder]' : ''}`,
      );
    }
    lines.push('\n  DRY RUN: no changes made');
    return { exitCode: 0, output: lines.join('\n') };
  }

  const result = await syncPersonnel(QURI_PERSONNEL, {
    forceSkipSourcing: true,
    forceSkipSourcingReason: 'bulk-import: curated QURI personnel data',
  });

  if (!result.ok) {
    lines.push(`\n  Sync failed: ${result.message}`);
    return { exitCode: 1, output: lines.join('\n') };
  }

  lines.push(`\n  Sync complete`);
  return { exitCode: 0, output: lines.join('\n') };
}

// ---------------------------------------------------------------------------
// CLI interface
// ---------------------------------------------------------------------------

export const commands: Record<
  string,
  (args: string[], options: Record<string, unknown>) => Promise<CommandResult>
> = {
  sync: syncCommand,
  default: syncCommand,
};

export function getHelp(): string {
  return `
Import QURI Personnel — Sync QURI staff, contractors, and board members to PG

Commands:
  sync          Sync personnel records to wiki-server (default)

Options:
  --dry-run     Preview records without writing
`;
}
