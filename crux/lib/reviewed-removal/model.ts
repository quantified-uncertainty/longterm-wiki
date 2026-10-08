import { createHash } from 'node:crypto';

export type Data = Record<string, unknown>;
export type Target = { name: string; type: 'person' | 'organization'; aliases: string[]; ids: string[]; contextAliases?: string[]; caseSensitiveAliases?: string[] };
export type Operation = { table: string; key: Data; before: Data; after: Data | null; targets: string[]; reason: string };
export type SourceChange = { file: string; before: string; after: string | null; targets: string[] };
export type Column = { table_name: string; column_name: string; sql_type: string; not_null: boolean; generated: string; default_expression: string | null };
export type Constraint = { name: string; table_name: string; parent_table: string | null; type: string; on_delete: string; definition: string; columns: string[]; parent_columns: string[] };
export type Plan = { version: 1; targets: Target[]; reviewed: boolean; operations: Operation[]; files: SourceChange[]; schema: Column[]; constraints: Constraint[]; refreshViews: string[]; referenceScopes?: Array<{table:string;column:string;values:string[]}>; identityExceptions?: Array<{table:string;key:Data;values:Data}>; computedColumns?:Record<string,Record<string,string>> };
export type ReviewedRow = { storage: string; table: string; id: string; people: string[]; organization: string; removal: string; item: string; kind: number };

export function rowKey(table: string, id: string): Data {
  if (table === 'session_pages') {
    const match = id.match(/^session_id=(.+); page_id=(.+)$/);
    if (!match) throw new Error('Invalid session/page key: ' + id);
    return { session_id: match[1], page_id: match[2] };
  }
  if (table === 'facts') {
    const match = id.match(/^id=([^;]+)/);
    if (!match) throw new Error('Invalid fact key: ' + id);
    return { id: match[1] };
  }
  if (table === 'source_check_verdicts') {
    const match = id.match(/^record_type=(.*?); record_id=(.*?); field_name=(.*)$/);
    if (!match) throw new Error('Invalid verdict key: ' + id);
    return { record_type: match[1], record_id: match[2], field_name: match[3] === 'NULL' ? null : match[3] };
  }
  if (table === 'resource_citations') {
    const match = id.match(/^resource_id=(.*?); page_id=(.*)$/);
    if (!match) throw new Error('Invalid citation key: ' + id);
    return { resource_id: match[1], page_id: match[2] };
  }
  const match = id.match(/^(\w+)=(.+)$/);
  if (!match) throw new Error('Invalid row key: ' + id);
  return { [match[1]]: match[2] };
}

export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export function digest(value: unknown): string { return createHash('sha256').update(canonical(value)).digest('hex'); }
export function quote(name: string): string { return '"' + name.replaceAll('"', '""') + '"'; }
export function changedColumns(operation: Operation): string[] {
  return operation.after ? Object.keys(operation.before).filter(k => canonical(operation.before[k]) !== canonical(operation.after![k])) : [];
}
export function validatePlan(plan: Plan): void {
  if (plan.version !== 1 || !plan.targets.length || !plan.operations.length) throw new Error('Empty or unsupported removal plan');
  const keys = new Set<string>();
  for (const operation of plan.operations) {
    const key = operation.table + ':' + canonical(operation.key);
    if (keys.has(key)) throw new Error('Duplicate physical row: ' + key);
    keys.add(key);
    const columns = plan.schema.filter(c => c.table_name === operation.table);
    if (!columns.length || !Object.keys(operation.key).length) throw new Error('Unknown table or missing key: ' + key);
    if (Object.entries(operation.key).some(([k, v]) => !columns.some(c => c.column_name === k) || canonical(operation.before[k]) !== canonical(v))) throw new Error('Key disagrees with original row: ' + key);
    if (operation.after && Object.entries(operation.key).some(([k, v]) => canonical(operation.after![k]) !== canonical(v))) throw new Error('Removal must preserve row identity: ' + key);
    if (operation.after && (Object.keys(operation.before).sort().join() !== Object.keys(operation.after).sort().join() || !changedColumns(operation).length)) throw new Error('Incomplete or unchanged replacement: ' + key);
    for (const column of changedColumns(operation)) {
      const spec = columns.find(c => c.column_name === column)!;
      if (spec.generated) throw new Error('Cannot write generated column: ' + column);
      if (spec.not_null && operation.after![column] == null) throw new Error('Cannot clear required column: ' + column);
    }
  }
  const files = new Set<string>();
  for (const file of plan.files) {
    if (files.has(file.file) || file.file.startsWith('/') || file.file.split('/').includes('..') || file.before === file.after) throw new Error('Invalid source change: ' + file.file);
    files.add(file.file);
  }
}

/** Parents precede children; apply deletions reverses this order. */
export function tableOrder(tables: string[], constraints: Constraint[]): string[] {
  const remaining = new Set(tables), result: string[] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(t => !constraints.some(c => c.type === 'f' && c.table_name === t && c.parent_table !== t && remaining.has(c.parent_table!))).sort();
    if (!ready.length) throw new Error('Cyclic foreign keys require an explicit migration strategy');
    for (const table of ready) { remaining.delete(table); result.push(table); }
  }
  return result;
}
