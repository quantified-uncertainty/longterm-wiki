/**
 * Per-record dispatcher: given a matched record + the chosen source URL,
 * write the URL into the appropriate YAML file when the record's table is
 * one of the YAML-mirrored ones.
 *
 * The PG write happens elsewhere (see `updateRecordSource` in fetch.ts) —
 * this file only handles the YAML half of the dual-write.
 *
 * Tables we touch:
 *   - facts                → packages/factbase/data/fb-entities/<slug>.yaml
 *   - policy_stakeholders  → data/entities/<file>.yaml under stakeholders[]
 *
 * Every other table is `not-applicable` and the caller can move on.
 */

import type { MissingSourceRecord } from './types.ts';
import { writeFactSourceToYaml } from './yaml-write-fact.ts';
import { writeStakeholderSourceToYaml } from './yaml-write-stakeholder.ts';
import type {
  FactbaseEntityIndex,
  PolicyEntityIndex,
} from './yaml-target-resolvers.ts';
import type { YamlWriteOutcome } from './yaml-write-fact.ts';

export interface YamlIndexes {
  facts: FactbaseEntityIndex;
  policies: PolicyEntityIndex;
}

export type YamlWriteRecordOutcome =
  | (YamlWriteOutcome & { applicable: true })
  | { status: 'not-applicable'; filepath: null; applicable: false };

export function writeRecordToYaml(
  record: MissingSourceRecord,
  url: string,
  indexes: YamlIndexes,
): YamlWriteRecordOutcome {
  if (record.record_table === 'facts') {
    const entitySid = String(record.entity_id ?? '');
    const factId = String(record.fact_id ?? '');
    if (!entitySid || !factId) {
      return {
        applicable: true,
        status: 'error',
        filepath: null,
        error: 'missing entity_id or fact_id on facts record',
      };
    }
    return {
      applicable: true,
      ...writeFactSourceToYaml({ entitySid, factId, url, index: indexes.facts }),
    };
  }

  if (record.record_table === 'policy_stakeholders') {
    const policySid = String(record.policy_entity_id ?? '');
    const name = String(record.stakeholder_display_name ?? '');
    const positionRaw = record.position;
    const position = typeof positionRaw === 'string' ? positionRaw : null;
    if (!policySid || !name) {
      return {
        applicable: true,
        status: 'error',
        filepath: null,
        error: 'missing policy_entity_id or stakeholder_display_name',
      };
    }
    return {
      applicable: true,
      ...writeStakeholderSourceToYaml({
        policyEntitySid: policySid,
        stakeholderName: name,
        position,
        url,
        index: indexes.policies,
      }),
    };
  }

  return { applicable: false, status: 'not-applicable', filepath: null };
}
