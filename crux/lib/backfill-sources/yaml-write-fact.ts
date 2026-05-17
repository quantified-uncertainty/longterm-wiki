/**
 * Mirror a fact's `source: <url>` into its FactBase YAML file, alongside the
 * PG write that already happened in the apply path.
 *
 * Wraps the existing `updateFactMetaById` from `crux/lib/factbase-writer.ts`,
 * which preserves YAML comments + formatting and never overwrites a
 * pre-existing source unless explicitly asked.
 */

import {
  readEntityDocument,
  updateFactMetaById,
  writeEntityDocument,
} from '../factbase-writer.ts';
import type { FactbaseEntityIndex } from './yaml-target-resolvers.ts';

export type YamlWriteStatus =
  | 'wrote'
  | 'skipped-existing'
  | 'not-found'
  | 'no-yaml-target'
  | 'error';

export interface YamlWriteOutcome {
  status: YamlWriteStatus;
  filepath: string | null;
  error?: string;
}

const PROVENANCE_NOTE = '[auto-discovered by tb backfill-sources]';

export interface WriteFactSourceInput {
  entitySid: string;
  factId: string;
  url: string;
  index: FactbaseEntityIndex;
}

/**
 * Resolve the YAML file for `entitySid`, find the fact by `factId`, and
 * write `source: url` if no existing source is set. Caller writes nothing
 * to PG here — the apply path already did.
 *
 * Returns `no-yaml-target` when the entity isn't in the index (legacy
 * `thing:` format file we skipped during scan, or sid not present at all).
 * Caller treats that as a soft warning, not a hard error.
 */
export function writeFactSourceToYaml(input: WriteFactSourceInput): YamlWriteOutcome {
  const { entitySid, factId, url, index } = input;
  const filepath = index.sidToFilepath.get(entitySid) ?? null;
  if (!filepath) {
    return { status: 'no-yaml-target', filepath: null };
  }

  let doc;
  try {
    doc = readEntityDocument(filepath);
  } catch (err) {
    return {
      status: 'error',
      filepath,
      error: `read failed: ${errMsg(err)}`,
    };
  }

  const status = updateFactMetaById(doc, factId, {
    source: url,
    notes: PROVENANCE_NOTE,
  });

  if (status === 'not-found') return { status: 'not-found', filepath };
  if (status === 'skipped-existing') return { status: 'skipped-existing', filepath };

  try {
    writeEntityDocument(filepath, doc);
  } catch (err) {
    return {
      status: 'error',
      filepath,
      error: `write failed: ${errMsg(err)}`,
    };
  }
  return { status: 'wrote', filepath };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
