import fs from 'node:fs';
import path from 'node:path';
import { createRedactor } from './redaction.ts';
import { editYaml } from './source.ts';
import { canonical, rowKey, type Data, type Operation, type ReviewedRow, type Target } from './model.ts';

export function scopeFor(row: ReviewedRow, targets: Target[]): string[] {
  return targets.filter(t => row.people.includes(t.name) || row.organization.split('; ').includes(t.name)).map(t => t.name);
}
export function draftDatabase(rows: ReviewedRow[], tables: Record<string, Data[]>, targets: Target[]): Operation[] {
  const redactor = createRedactor(targets), indexes = new Map<string, Map<string, Data>>();
  for (const row of rows.filter(r => r.storage === 'DB')) {
    if (indexes.has(row.table)) continue;
    const columns = Object.keys(rowKey(row.table, row.id));
    indexes.set(row.table, new Map((tables[row.table] ?? []).map(data => [canonical(columns.map(k => data[k] == null ? null : String(data[k]))), data])));
  }
  return rows.filter(r => r.storage === 'DB').map(row => {
    const key = rowKey(row.table, row.id);
    const before = indexes.get(row.table)!.get(canonical(Object.values(key).map(v => v == null ? null : String(v))));
    if (!before) throw new Error('Missing backed up record: ' + row.table + ' ' + row.id);
    const actualKey = Object.fromEntries(Object.keys(key).map(k => [k, before[k]]));
    const names = scopeFor(row, targets);
    if (row.removal.startsWith('Delete')) return { table: row.table, key: actualKey, before, after: null, targets: names, reason: row.removal };
    const after = structuredClone(before);
    const fieldList = row.removal.match(/Remove person data: ([^.]+)\./)?.[1] ?? row.removal.match(/Remove target data from ([^.]+)\./)?.[1] ?? row.removal.match(/ from ([^.]+)\. Keep/)?.[1];
    const protectedColumns=['id','stable_id','url','source','website','archive_url','local_filename','search_vector'];
    const fields = [...new Set([...(fieldList ? fieldList.split(/,|\s+and\s+/).map(s => s.trim()).map(s=>s==='content'?'content_plaintext':s==='key points'?'key_points':s==='context'&&row.table==='resources'?'context_note':s) : Object.keys(before).filter(k=>!protectedColumns.includes(k))),...Object.entries(before).filter(([k,v])=>!protectedColumns.includes(k)&&redactor.textMatches(typeof v==='string'?v:JSON.stringify(v),names,true)).map(([k])=>k)])];
    for (const field of fields) if (field in after) after[field] = redactor.redactValue(after[field], names, true);
    // An import lookup remains reserved, but has no active name/description.
    if (row.table === 'entity_ids') { after.slug = 'removed-e' + before.wiki_id; after.description = null; }
    // Clear target recipient identity even when its stored label includes a suffix.
    if (row.table === 'grants') {
      for (const field of ['grantee_id', 'grantee_entity_id', 'grantee_display_name']) {
        if (fields.includes(field) && typeof before[field] === 'string' && redactor.textMatches(before[field] as string, names)) after[field] = null;
      }
      if (typeof after.name === 'string') after.name = after.name.replace(/\b(?:of|to)\s+(?:the\s*)?$/i, '').trim() || 'Grant';
    }
    if (row.table === 'resources' && typeof after.title === 'string' && !after.title.trim()) after.title = 'Source document';
    return { table: row.table, key: actualKey, before, after, targets: names, reason: row.removal };
  });
}

export function draftYaml(root: string, rows: ReviewedRow[], targets: Target[], overrides: Record<string,Data> = {}): Array<{ file: string; before: string; after: string | null; targets: string[] }> {
  const redactor = createRedactor(targets), files = new Map<string, ReviewedRow[]>();
  for (const row of rows.filter(r => r.storage === 'YAML')) { const group = files.get(row.table) ?? []; group.push(row); files.set(row.table, group); }
  return [...files].map(([file, edits]) => {
    const before = fs.readFileSync(path.join(root, file), 'utf8');
    const ownedFactFile = file.includes('/fb-entities/') && edits.every(r => r.removal.startsWith('Delete'));
    const after = ownedFactFile ? null : editYaml(before, edits.map(row => ({ selector: row.id, transform: value => row.removal.startsWith('Delete') ? null : {...redactor.redactValue(value, scopeFor(row, targets), true) as Data,...overrides[file+':'+row.id]} })));
    return { file, before, after, targets: [...new Set(edits.flatMap(r => scopeFor(r, targets)))] };
  });
}
