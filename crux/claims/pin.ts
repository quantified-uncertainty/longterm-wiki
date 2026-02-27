/**
 * Pin / unpin a structured claim as the canonical value for an entity+property.
 *
 * Usage:
 *   crux claims pin <claim-id>          Pin a claim
 *   crux claims pin <claim-id> --unpin  Unpin a claim
 *   crux claims pin --list <entity-id>  List pinned claims for an entity
 */

import { apiRequest, BATCH_TIMEOUT_MS } from '../lib/wiki-server/client.ts';

interface Claim {
  id: number;
  entityId: string;
  claimText: string;
  subjectEntity: string | null;
  property: string | null;
  structuredValue: string | null;
  valueUnit: string | null;
  valueDate: string | null;
  isPinned: boolean;
}

async function main() {
  const args = process.argv.slice(2);
  const flags = args.filter((a) => a.startsWith('--'));
  const positional = args.filter((a) => !a.startsWith('--'));

  const unpin = flags.includes('--unpin');
  const listFlag = flags.find((f) => f.startsWith('--list'));

  // List mode: show pinned claims for an entity
  if (listFlag) {
    const entityId = listFlag.includes('=')
      ? listFlag.split('=')[1]
      : positional[0];
    if (!entityId) {
      console.error('Usage: crux claims pin --list=<entity-id>');
      process.exit(1);
    }

    const result = await apiRequest<{ claims: Claim[] }>(
      'GET',
      `/api/claims/pinned/${encodeURIComponent(entityId)}`,
      undefined,
      BATCH_TIMEOUT_MS,
    );

    if (!result.ok) {
      console.error(`Error: ${result.message}`);
      process.exit(1);
    }

    const { claims } = result.data;
    if (claims.length === 0) {
      console.log(`No pinned claims for entity: ${entityId}`);
      return;
    }

    console.log(`Pinned claims for ${entityId} (${claims.length}):\n`);
    for (const claim of claims) {
      const value = claim.structuredValue ?? '(no value)';
      const unit = claim.valueUnit ? ` [${claim.valueUnit}]` : '';
      const date = claim.valueDate ? ` (${claim.valueDate})` : '';
      console.log(`  #${claim.id}  ${claim.property ?? '?'} = ${value}${unit}${date}`);
      console.log(`         ${claim.claimText.slice(0, 100)}${claim.claimText.length > 100 ? '...' : ''}`);
    }
    return;
  }

  // Pin/unpin mode: toggle isPinned on a specific claim
  const claimIdStr = positional[0];
  if (!claimIdStr) {
    console.error('Usage: crux claims pin <claim-id> [--unpin]');
    console.error('       crux claims pin --list=<entity-id>');
    process.exit(1);
  }

  const claimId = Number(claimIdStr);
  if (!Number.isInteger(claimId) || claimId <= 0) {
    console.error(`Invalid claim ID: ${claimIdStr}`);
    process.exit(1);
  }

  // First, fetch the claim to show what we're pinning
  const getResult = await apiRequest<Claim>(
    'GET',
    `/api/claims/${claimId}`,
    undefined,
    BATCH_TIMEOUT_MS,
  );

  if (!getResult.ok) {
    console.error(`Error fetching claim ${claimId}: ${getResult.message}`);
    process.exit(1);
  }

  const claim = getResult.data;
  const action = unpin ? 'Unpinning' : 'Pinning';
  console.log(`${action} claim #${claimId}:`);
  console.log(`  Entity: ${claim.subjectEntity ?? claim.entityId}`);
  console.log(`  Property: ${claim.property ?? '(none)'}`);
  console.log(`  Value: ${claim.structuredValue ?? claim.claimText.slice(0, 80)}`);

  if (!claim.property && !unpin) {
    console.warn('\n  Warning: This claim has no property set. Pinned claims should have structured fields.');
  }

  // Patch the claim
  const patchResult = await apiRequest<Claim>(
    'PATCH',
    `/api/claims/${claimId}`,
    { isPinned: !unpin },
    BATCH_TIMEOUT_MS,
  );

  if (!patchResult.ok) {
    console.error(`Error: ${patchResult.message}`);
    process.exit(1);
  }

  console.log(`\n  ✓ Claim #${claimId} ${unpin ? 'unpinned' : 'pinned'} successfully.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
