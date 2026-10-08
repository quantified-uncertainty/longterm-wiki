import { canonical, changedColumns, digest, quote, tableOrder, validatePlan, type Data, type Operation, type Plan } from './model.ts';
import { installPolicy, removePolicy } from './policy.ts';

// postgres.js supplies typed transactions; keeping this structural interface also
// lets the future server-side tool reuse the executor without owning its pool.
export type Transaction = { unsafe: (query: string, parameters?: unknown[]) => Promise<any[]> };
export type Receipt = { planDigest: string; operations: Operation[] };

function groups(operations: Operation[]): Map<string, Operation[]> {
  const result = new Map<string, Operation[]>();
  for (const operation of operations) { const list = result.get(operation.table) ?? []; list.push(operation); result.set(operation.table, list); }
  return result;
}
function joinKeys(operation: Operation, left = 'r', right = 'b'): string {
  return Object.keys(operation.key).map(k => `${left}.${quote(k)} ${k==='field_name'?'IS NOT DISTINCT FROM':'='} ${right}.${quote(k)}`).join(' AND ');
}
function source(table: string): string {
  return `jsonb_to_recordset($1::jsonb) e(before jsonb, after jsonb) CROSS JOIN LATERAL jsonb_populate_record(NULL::${quote(table)},e.before) b`;
}
async function verifyRows(tx: Transaction, table: string, operations: Operation[], absent = false): Promise<void> {
  const [result] = await tx.unsafe(`SELECT count(*)::int AS mismatches FROM ${source(table)} LEFT JOIN ${quote(table)} r ON ${joinKeys(operations[0])} WHERE ${absent ? 'r.ctid IS NOT NULL' : 'r.ctid IS NULL OR to_jsonb(r) IS DISTINCT FROM e.before'}`, [operations.map(o => ({ before: o.before, after: o.after }))]);
  if (result.mismatches) throw new Error(`Review is stale: ${result.mismatches} changed/missing/conflicting rows in ${table}`);
}

/** Detect every enforced reference to a deleted row before PostgreSQL can cascade. */
async function verifyDependencies(tx: Transaction, plan: Plan): Promise<void> {
  const deletionGroups = groups(plan.operations.filter(o => !o.after));
  const planned = groups(plan.operations);
  for (const fk of plan.constraints.filter(c => c.type === 'f' && deletionGroups.has(c.parent_table!))) {
    const removed = deletionGroups.get(fk.parent_table!)!;
    const predicate = fk.columns.map((column, i) => `r.${quote(column)} = b.${quote(fk.parent_columns[i])}`).join(' AND ');
    const references = await tx.unsafe(`SELECT DISTINCT to_jsonb(r) AS data FROM ${quote(fk.table_name)} r JOIN jsonb_populate_recordset(NULL::${quote(fk.parent_table!)},$1::jsonb) b ON ${predicate}`, [removed.map(o => o.before)]);
    const childOperations = planned.get(fk.table_name) ?? [];
    const childByKey = new Map(childOperations.map(o => [canonical(Object.keys(o.key).map(k => o.before[k])), o]));
    for (const { data } of references as Array<{ data: Data }>) {
      const operation = childOperations[0] && childByKey.get(canonical(Object.keys(childOperations[0].key).map(k => data[k])));
      if (!operation) throw new Error(`Unreviewed dependent row in ${fk.table_name} (${fk.name})`);
      if (operation.after && removed.some(parent => fk.columns.every((column, i) => operation.after![column] != null && operation.after![column] === parent.before[fk.parent_columns[i]]))) throw new Error(`Replacement still references a removed row: ${fk.table_name} (${fk.name})`);
    }
  }
}

/** A new FK can cascade outside the reviewed rows even when those rows are unchanged. */
async function verifyMetadata(tx: Transaction, plan: Plan): Promise<void> {
  const affected = [...new Set(plan.operations.map(o => o.table))];
  const deleted = [...new Set(plan.operations.filter(o => !o.after).map(o => o.table))];
  const columns = await tx.unsafe(`SELECT c.relname AS table_name,a.attname AS column_name,format_type(a.atttypid,a.atttypmod) AS sql_type,a.attnotnull AS not_null,a.attgenerated AS generated,pg_get_expr(ad.adbin,ad.adrelid) AS default_expression FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum WHERE n.nspname='public' AND c.relkind='r' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped`, [affected]);
  const constraints = await tx.unsafe(`SELECT con.conname AS name,child.relname AS table_name,parent.relname AS parent_table,con.contype AS type,con.confdeltype AS on_delete,pg_get_constraintdef(con.oid) AS definition,ARRAY(SELECT attname FROM pg_attribute WHERE attrelid=con.conrelid AND attnum=ANY(con.conkey) ORDER BY array_position(con.conkey,attnum)) AS columns,ARRAY(SELECT attname FROM pg_attribute WHERE attrelid=con.confrelid AND attnum=ANY(con.confkey) ORDER BY array_position(con.confkey,attnum)) AS parent_columns FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid LEFT JOIN pg_class parent ON parent.oid=con.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace WHERE n.nspname='public' AND (child.relname=ANY($1::text[]) OR (con.contype='f' AND parent.relname=ANY($2::text[])))`, [affected, deleted]);
  const expectedColumns = plan.schema.filter(c => affected.includes(c.table_name)).map(({table_name,column_name,sql_type,not_null,generated,default_expression}) => ({table_name,column_name,sql_type,not_null,generated,default_expression}));
  const expectedConstraints = plan.constraints.filter(c => affected.includes(c.table_name) || c.type === 'f' && deleted.includes(c.parent_table!));
  const sorted = (values: unknown[]) => values.map(canonical).sort();
  if (canonical(sorted(columns)) !== canonical(sorted(expectedColumns)) || canonical(sorted(constraints)) !== canonical(sorted(expectedConstraints))) throw new Error('Database schema changed since review; refresh and review the affected schema and dependencies');
}

export async function checkDatabase(tx: Transaction, plan: Plan): Promise<void> {
  validatePlan(plan);
  await verifyMetadata(tx, plan);
  for (const [table, operations] of groups(plan.operations)) await verifyRows(tx, table, operations);
  await verifyDependencies(tx, plan);
  const planned = groups(plan.operations);
  for (const scope of plan.referenceScopes ?? []) {
    const rows = await tx.unsafe(`SELECT to_jsonb(r) AS data FROM ${quote(scope.table)} r WHERE ${quote(scope.column)}::text=ANY($1::text[])`,[scope.values]);
    const operations = planned.get(scope.table) ?? [];
    const keys = new Set(operations.map(o => canonical(Object.keys(o.key).map(k => o.before[k]))));
    for (const {data} of rows) if (!operations[0] || !keys.has(canonical(Object.keys(operations[0].key).map(k => data[k])))) throw new Error(`New unreviewed association in ${scope.table}.${scope.column}`);
  }
}

/** Verify every committed edit and deletion against the actual apply receipt. */
export async function verifyApplied(tx: Transaction, receipt: Receipt): Promise<void> {
  for (const [table, operations] of groups(receipt.operations)) {
    const edits = operations.filter(o => o.after).map(o => ({...o, before: o.after!}));
    if (edits.length) await verifyRows(tx, table, edits);
    const deletions = operations.filter(o => !o.after);
    if (deletions.length) await verifyRows(tx, table, deletions, true);
  }
}

/** Call inside a transaction. The caller decides whether to commit. */
export async function applyDatabase(tx: Transaction, plan: Plan, approvalDigest: string): Promise<Receipt> {
  validatePlan(plan);
  if (!plan.reviewed || approvalDigest !== digest(plan)) throw new Error('Apply requires approval of this exact reviewed plan');
  const affected = [...new Set([...plan.operations.map(o => o.table), ...(plan.referenceScopes??[]).map(s=>s.table), ...plan.constraints.filter(c => c.type === 'f' && plan.operations.some(o => o.table === c.parent_table && !o.after)).map(c => c.table_name)])].sort();
  await tx.unsafe(`LOCK TABLE ${affected.map(quote).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
  await checkDatabase(tx, plan);
  const receipt: Receipt = { planDigest: digest(plan), operations: [] };
  // Clear associations before deleting their parents; only approved columns change.
  for (const [table, operations] of groups(plan.operations.filter(o => o.after))) {
    const byColumns = new Map<string, Operation[]>();
    for (const operation of operations) { const signature = changedColumns(operation).sort().join(','); const batch = byColumns.get(signature) ?? []; batch.push(operation); byColumns.set(signature, batch); }
    for (const batch of byColumns.values()) {
      const columns = changedColumns(batch[0]);
      const updated = await tx.unsafe(`UPDATE ${quote(table)} r SET ${columns.map(c => `${quote(c)}=${plan.computedColumns?.[table]?.[c]??'a.'+quote(c)}`).join(',')} FROM ${source(table)} CROSS JOIN LATERAL jsonb_populate_record(NULL::${quote(table)},e.after) a WHERE ${joinKeys(batch[0])} RETURNING to_jsonb(r) AS data`, [batch.map(o => ({ before: o.before, after: o.after }))]);
      if (updated.length !== batch.length) throw new Error('Unexpected update count: ' + table);
      const actual = new Map(updated.map(r => [canonical(Object.keys(batch[0].key).map(k => r.data[k])), r.data]));
      for (const operation of batch) receipt.operations.push({ ...operation, after: actual.get(canonical(Object.keys(operation.key).map(k => operation.key[k])))! });
    }
  }
  const deletedGroups = groups(plan.operations.filter(o => !o.after));
  for (const table of tableOrder([...deletedGroups.keys()], plan.constraints).reverse()) {
    const operations = deletedGroups.get(table)!;
    const deleted = await tx.unsafe(`DELETE FROM ${quote(table)} r USING ${source(table)} WHERE ${joinKeys(operations[0])} RETURNING to_jsonb(r) AS data`, [operations.map(o => ({ before: o.before, after: null }))]);
    if (deleted.length !== operations.length) throw new Error('Unexpected deletion count: ' + table);
    receipt.operations.push(...operations);
  }
  for (const view of plan.refreshViews) await tx.unsafe(`REFRESH MATERIALIZED VIEW ${quote(view)}`);
  await installPolicy(tx,plan);
  return receipt;
}

export async function rollbackDatabase(tx: Transaction, plan: Plan, receipt: Receipt): Promise<void> {
  if (receipt.planDigest !== digest(plan) || receipt.operations.length !== plan.operations.length) throw new Error('Rollback receipt does not match the reviewed plan');
  validatePlan(plan);
  const approved = new Map(plan.operations.map(o => [o.table + ':' + canonical(o.key), o]));
  for (const operation of receipt.operations) {
    const key = operation.table + ':' + canonical(operation.key), original = approved.get(key);
    if (!original || canonical(original.before) !== canonical(operation.before) || Boolean(original.after) !== Boolean(operation.after) || operation.after && Object.entries(operation.key).some(([column,value]) => canonical(operation.after![column]) !== canonical(value))) throw new Error('Rollback receipt does not match the reviewed plan');
    approved.delete(key);
  }
  const grouped = groups(receipt.operations);
  await tx.unsafe("SELECT set_config('app.removal_maintenance','on',true)");
  await tx.unsafe(`LOCK TABLE ${[...grouped.keys()].sort().map(quote).join(',')} IN SHARE ROW EXCLUSIVE MODE`);
  for (const [table, operations] of grouped) {
    const edits = operations.filter(o => o.after).map(o => ({ ...o, before: o.after!, after: o.before }));
    if (edits.length) await verifyRows(tx, table, edits);
    const deletions = operations.filter(o => !o.after);
    if (deletions.length) await verifyRows(tx, table, deletions, true);
  }
  // Restore parents before dependent rows, then put edited associations back.
  for (const table of tableOrder([...grouped.keys()], plan.constraints)) {
    const deletions = grouped.get(table)!.filter(o => !o.after);
    if (!deletions.length) continue;
    const columns = plan.schema.filter(c => c.table_name === table && !c.generated).map(c => c.column_name);
    await tx.unsafe(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) OVERRIDING SYSTEM VALUE SELECT ${columns.map(c => 'b.' + quote(c)).join(',')} FROM jsonb_populate_recordset(NULL::${quote(table)},$1::jsonb) b`, [deletions.map(o => o.before)]);
  }
  for (const [table, operations] of grouped) {
    const edits = operations.filter(o => o.after);
    for (const operation of edits) {
      const columns = changedColumns(operation).filter(column => !plan.schema.find(c => c.table_name === table && c.column_name === column)!.generated);
      await tx.unsafe(`UPDATE ${quote(table)} r SET ${columns.map(c => `${quote(c)}=b.${quote(c)}`).join(',')} FROM jsonb_populate_record(NULL::${quote(table)},$1::jsonb) b WHERE ${joinKeys(operation)}`, [operation.before]);
    }
  }
  for (const view of plan.refreshViews) await tx.unsafe(`REFRESH MATERIALIZED VIEW ${quote(view)}`);
  await removePolicy(tx,plan);
}
