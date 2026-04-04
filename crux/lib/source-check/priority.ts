/**
 * Priority computation for source-check verification items.
 * Higher priority items are verified first by the orchestrator.
 */

import type { Fact, Entity as FBEntity } from '../../../packages/factbase/src/types.ts';
import type { PageEntry } from '../content-types.ts';
import type { RecordType } from '../../../apps/wiki-server/src/api-types.ts';
import { ENTITY_TYPE_PRIORITY, type VerifiedFactInfo, type VerifiedRecordInfo } from './orchestrator-types.ts';

export function computeFactPriority(
  entity: FBEntity,
  _fact: Fact,
  existing: VerifiedFactInfo | undefined,
  page: PageEntry | undefined,
): number {
  let priority = 0;

  // Never-verified items get highest priority
  if (!existing) {
    priority += 100;
  } else if (existing.needsRecheck) {
    priority += 80;
  } else {
    // Staleness: older verifications get higher priority
    if (existing.checkedAt) {
      const ageMs = Date.now() - new Date(existing.checkedAt).getTime();
      const ageDays = ageMs / (24 * 60 * 60 * 1000);
      priority += Math.min(50, ageDays / 7); // +1 per week, max 50
    }
  }

  // Entity type priority
  const entityTypePriorityIndex = ENTITY_TYPE_PRIORITY.indexOf(entity.type ?? '');
  if (entityTypePriorityIndex >= 0) {
    priority += (ENTITY_TYPE_PRIORITY.length - entityTypePriorityIndex) * 3;
  }

  // Reader importance from page data
  if (page?.readerImportance) {
    priority += page.readerImportance * 5;
  }

  return priority;
}

export function computeRecordPriority(
  recordType: RecordType,
  existing: VerifiedRecordInfo | undefined,
): number {
  let priority = 0;

  if (!existing) {
    priority += 100;
  } else if (existing.needsRecheck) {
    priority += 80;
  } else if (existing.checkedAt) {
    const ageMs = Date.now() - new Date(existing.checkedAt).getTime();
    const ageDays = ageMs / (24 * 60 * 60 * 1000);
    priority += Math.min(50, ageDays / 7);
  }

  // Some record types are more important to verify
  const recordTypePriority: Record<string, number> = {
    'grant': 30,
    'personnel': 25,
    'funding-round': 20,
    'investment': 20,
    'publication': 18,
    'secondary-market-price': 18,
    'benchmark-result': 15,
    'division': 15,
    'funding-program': 15,
    'entity-event': 12,
    'entity-assessment': 10,
    'equity-position': 10,
    'policy-stakeholder': 10,
  };
  priority += recordTypePriority[recordType] ?? 0;

  return priority;
}
