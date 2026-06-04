/**
 * Mirror a policy_stakeholders row's `source: <url>` into the policy entity's
 * YAML file (`data/entities/*.yaml`).
 *
 * Each policy entity in those files has a `stakeholders:` array; each item is
 * keyed structurally by `name` + `position` (the same composite key the PG
 * sync uses to dedupe). We locate the file via the policy entity's stableId,
 * walk to the matching stakeholder, and set `source: <url>` on it — without
 * touching any other field on the entity or the file.
 *
 * Uses the `yaml` package's Document API (parseDocument + isMap/isSeq) to
 * preserve comments, anchors, and existing field order — same approach as
 * `factbase-writer.updateFactMetaById`.
 */

import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { isMap, isSeq, parseDocument } from 'yaml';
import type { YamlWriteOutcome } from './yaml-write-fact.ts';
import type { PolicyEntityIndex } from './yaml-target-resolvers.ts';

export interface WriteStakeholderSourceInput {
  policyEntitySid: string;
  stakeholderName: string;
  /** Position string from PG (e.g. "support", "oppose", "mixed"). Used for
   *  disambiguation when a policy has the same name listed twice in two
   *  different positions — first writer wins by name; second match by
   *  position breaks the tie. */
  position: string | null;
  url: string;
  index: PolicyEntityIndex;
}

/**
 * Find the right policy entity in the file, find the right stakeholder
 * within its `stakeholders` list, and set `source: <url>` if no source is
 * already present.
 *
 * Returns `no-yaml-target` if the policy stableId isn't indexed (entity
 * doesn't exist in YAML, or scan didn't reach it). Returns `not-found` when
 * the file is found but the stakeholder name+position pair isn't there.
 * Returns `skipped-existing` when a non-empty `source` is already set.
 */
export function writeStakeholderSourceToYaml(
  input: WriteStakeholderSourceInput,
): YamlWriteOutcome {
  const { policyEntitySid, stakeholderName, position, url, index } = input;
  const filepath = index.sidToFilepath.get(policyEntitySid) ?? null;
  if (!filepath) {
    return { status: 'no-yaml-target', filepath: null };
  }

  let raw: string;
  try {
    raw = readFileSync(filepath, 'utf-8');
  } catch (err) {
    return { status: 'error', filepath, error: `read failed: ${errMsg(err)}` };
  }

  const doc = parseDocument(raw);
  const root = doc.contents;
  if (!isSeq(root)) {
    return { status: 'error', filepath, error: 'root node is not a sequence' };
  }

  // Find the policy entity by stableId.
  let entityNode: unknown = null;
  for (const item of root.items) {
    if (!isMap(item)) continue;
    const sid = String(item.get('stableId') ?? '');
    if (sid === policyEntitySid) {
      entityNode = item;
      break;
    }
  }
  if (!entityNode || !isMap(entityNode)) {
    return { status: 'not-found', filepath };
  }

  const stakeholders = entityNode.get('stakeholders', true);
  if (!isSeq(stakeholders)) {
    return { status: 'not-found', filepath };
  }

  // Match priority:
  //   1. exact name + position match (when position is provided)
  //   2. exact name match (single occurrence)
  // Multiple-occurrence-no-position is treated as not-found to avoid
  // guessing wrong.
  const nameMatches: { node: ReturnType<typeof asMap>; pos: string | null }[] = [];
  for (const item of stakeholders.items) {
    const m = asMap(item);
    if (!m) continue;
    const name = String(m.get('name') ?? '');
    if (name !== stakeholderName) continue;
    const pos = m.get('position');
    nameMatches.push({ node: m, pos: typeof pos === 'string' ? pos : null });
  }

  if (nameMatches.length === 0) return { status: 'not-found', filepath };

  let target = nameMatches[0].node;
  if (nameMatches.length > 1) {
    if (!position) return { status: 'not-found', filepath };
    const byPos = nameMatches.find(m => m.pos === position);
    if (!byPos) return { status: 'not-found', filepath };
    target = byPos.node;
  }

  if (!target) return { status: 'not-found', filepath };

  const existingSource = target.get('source');
  if (typeof existingSource === 'string' && existingSource.trim() !== '') {
    return { status: 'skipped-existing', filepath };
  }

  target.set('source', url);

  // Atomic write: temp file + rename. `lineWidth: 120` matches the
  // convention used elsewhere in the codebase (extract-structured-data,
  // political-data, factbase-migrate) — the yaml package's default 80
  // would re-fold lines that those writers left unwrapped, producing
  // noisy diffs every time we touch one source field.
  try {
    const out = doc.toString({ lineWidth: 120 });
    const tmp = filepath + '.tmp';
    writeFileSync(tmp, out, 'utf-8');
    renameSync(tmp, filepath);
  } catch (err) {
    return { status: 'error', filepath, error: `write failed: ${errMsg(err)}` };
  }
  return { status: 'wrote', filepath };
}

function asMap(node: unknown) {
  return isMap(node) ? node : null;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
