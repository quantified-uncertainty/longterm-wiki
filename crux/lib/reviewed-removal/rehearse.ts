import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { applyDatabase, checkDatabase, rollbackDatabase, verifyApplied, type Receipt } from './database.ts';
import { canonical, digest, quote, type Data, type Plan } from './model.ts';
const require = createRequire(path.resolve(import.meta.dirname,'../../../apps/wiki-server/package.json'));
const postgres = require('postgres');
const [bundle, databaseUrl] = process.argv.slice(2);
if (!bundle || !databaseUrl) throw new Error('Usage: rehearse.ts BUNDLE LOCAL_DATABASE_URL');
const location = new URL(databaseUrl);
if (location.hostname !== '127.0.0.1' || location.pathname !== '/removal') throw new Error('Rehearsal requires the disposable local removal database');
const backup = JSON.parse(fs.readFileSync(path.join(bundle,'backups/database-with-dependencies.json'),'utf8'));
const metadata = JSON.parse(fs.readFileSync(path.join(bundle,'backups/database-metadata.json'),'utf8'));
const draft: Plan = JSON.parse(fs.readFileSync(path.join(bundle,'draft-plan.json'),'utf8'));
// Rehearsal approval never changes the production plan's reviewed status.
const plan = {...draft,reviewed:true};
const database = postgres(databaseUrl,{max:1,onnotice:()=>{},connection:{statement_timeout:'120000',lock_timeout:'10000'}});
const seed: Record<string,Data[]> = {};
for (const source of [backup.tables,backup.supportParents,metadata.supportParents]) for (const [table,rows] of Object.entries(source)) seed[table]=[...(seed[table]??[]),...(rows as Data[])];
const tables = new Set([...Object.keys(seed),...plan.referenceScopes!.map(s=>s.table),'full_audit_log']);
for(const c of plan.constraints)if(c.type==='f'&&plan.operations.some(o=>o.table===c.parent_table&&!o.after))tables.add(c.table_name);
let extended=true;
while(extended) {extended=false;for(const c of plan.constraints)if(c.type==='f'&&tables.has(c.table_name)&&!tables.has(c.parent_table!)){tables.add(c.parent_table!);extended=true;}}
try {
  await database.unsafe('DROP SCHEMA public CASCADE');
  await database.unsafe('CREATE SCHEMA public');
  await database.unsafe('CREATE EXTENSION IF NOT EXISTS pg_trgm');
  for (const table of tables) {
    const columns=plan.schema.filter(c=>c.table_name===table);
    for (const column of columns) {
      const sequence=column.default_expression?.match(/nextval\('([^']+)'::regclass\)/)?.[1];
      if(sequence)await database.unsafe('CREATE SEQUENCE IF NOT EXISTS '+quote(sequence.replace(/^public\./,'')));
    }
    await database.unsafe('CREATE TABLE '+quote(table)+' ('+columns.map(c=>quote(c.column_name)+' '+c.sql_type+(c.generated?' GENERATED ALWAYS AS ('+c.default_expression+') STORED':c.default_expression?' DEFAULT '+c.default_expression:'')+(c.not_null?' NOT NULL':'')).join(',')+')');
  }
  // Preserve primary keys, null-aware uniqueness and all check/FK constraints.
  for(const constraint of plan.constraints.filter(c=>tables.has(c.table_name)&&c.type!=='f'))await database.unsafe(`ALTER TABLE ${quote(constraint.table_name)} ADD CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`);
  for(const [table,rows] of Object.entries(seed)) {
    const primary=plan.constraints.find(c=>c.table_name===table&&c.type==='p')?.columns ?? Object.keys(rows[0]);
    const unique=new Map(rows.map(row=>[canonical(primary.map(k=>row[k])),row]));seed[table]=[...unique.values()];
    const columns=plan.schema.filter(c=>c.table_name===table&&!c.generated).map(c=>c.column_name);
    if(seed[table].length)await database.unsafe(`INSERT INTO ${quote(table)} (${columns.map(quote).join(',')}) SELECT ${columns.map(c=>'b.'+quote(c)).join(',')} FROM jsonb_populate_recordset(NULL::${quote(table)},$1::jsonb) b`,[seed[table]]);
    console.log(JSON.stringify({seeded:table,rows:seed[table].length}));
  }
  for(const constraint of plan.constraints.filter(c=>tables.has(c.table_name)&&c.type==='f'))await database.unsafe(`ALTER TABLE ${quote(constraint.table_name)} ADD CONSTRAINT ${quote(constraint.name)} ${constraint.definition}`);
  const uniqueIndexes=backup.indexes.filter((i:any)=>tables.has(i.tablename)&&i.indexdef.includes('CREATE UNIQUE INDEX')&&!plan.constraints.some(c=>c.name===i.indexname));
  for(const index of uniqueIndexes)await database.unsafe(index.indexdef);
  // Rehearse with the actual audit triggers enabled.
  const functions=new Map(metadata.triggers.filter((t:any)=>tables.has(t.table_name)).map((t:any)=>[t.function_oid,t.function_definition]));
  for(const definition of functions.values())await database.unsafe(definition);
  for(const trigger of metadata.triggers.filter((t:any)=>tables.has(t.table_name)))await database.unsafe(trigger.definition);
  for(const view of plan.refreshViews) {
    const definition=backup.materializedViews.find((v:any)=>v.matviewname===view).definition;
    await database.unsafe('CREATE MATERIALIZED VIEW '+quote(view)+' AS '+definition);
  }
  console.log('Schema, real constraints and audit triggers loaded');
  const baseline:Record<string,Data[]>={};
  for(const table of Object.keys(seed))baseline[table]=(await database.unsafe('SELECT to_jsonb(r) AS data FROM '+quote(table)+' r')).map((r:any)=>r.data);
  await database.begin('isolation level repeatable read read only',(tx:any)=>checkDatabase(tx,plan));
  const expectRejected=async(action:()=>Promise<unknown>,message:string)=>{
    let rejection='';try{await action();}catch(error){rejection=String(error);}
    if(!rejection.includes(message))throw new Error('Expected rejection: '+message+'; received '+rejection);
  };
  await expectRejected(()=>database.begin((tx:any)=>applyDatabase(tx,plan,'wrong-digest')),'requires approval');
  await database.unsafe('CREATE TABLE removal_unreviewed_children (id integer PRIMARY KEY, entity_id text REFERENCES entities(id) ON DELETE CASCADE)');
  await database.unsafe('INSERT INTO removal_unreviewed_children VALUES (1,$1)',[seed.entities[0].id]);
  await expectRejected(()=>database.begin((tx:any)=>applyDatabase(tx,plan,digest(plan))),'Database schema changed since review');
  await database.unsafe('DROP TABLE removal_unreviewed_children');
  const retainedResource=plan.operations.find(o=>o.table==='resources'&&o.after)!;
  await database.unsafe('UPDATE resources SET title=$1 WHERE id=$2',['Changed after review',retainedResource.key.id]);
  await expectRejected(()=>database.begin((tx:any)=>applyDatabase(tx,plan,digest(plan))),'Review is stale');
  await database.unsafe('UPDATE resources SET title=$1 WHERE id=$2',[retainedResource.before.title,retainedResource.key.id]);
  const extraRole={...seed.personnel[0],id:'testrole00',role:'Unreviewed test role'};
  const roleColumns=plan.schema.filter(c=>c.table_name==='personnel'&&!c.generated).map(c=>c.column_name);
  await database.unsafe(`INSERT INTO personnel (${roleColumns.map(quote).join(',')}) SELECT ${roleColumns.map(c=>'b.'+quote(c)).join(',')} FROM jsonb_populate_record(NULL::personnel,$1::jsonb) b`,[extraRole]);
  await expectRejected(()=>database.begin((tx:any)=>applyDatabase(tx,plan,digest(plan))),'Unreviewed dependent');
  await database.unsafe('DELETE FROM personnel WHERE id=$1',[extraRole.id]);
  const started=Date.now();
  const receipt:Receipt=await database.begin(async(tx:any)=>{await tx.unsafe("SELECT set_config('app.agent_tool','reviewed-removal/rehearsal',true)");return applyDatabase(tx,plan,digest(plan));});
  await database.begin('read only',(tx:any)=>verifyApplied(tx,receipt));
  const tampered={...receipt,operations:receipt.operations.map((o,i)=>i?o:{...o,before:{...o.before,id:'tampered'}})};
  await expectRejected(()=>database.begin((tx:any)=>rollbackDatabase(tx,plan,tampered)),'Rollback receipt does not match');
  fs.writeFileSync(path.join(bundle,'reports/rehearsal-receipt.json'),JSON.stringify(receipt),{mode:0o600});
  for(const [table,beforeRows] of Object.entries(baseline)){
    const actual=(await database.unsafe('SELECT to_jsonb(r) AS data FROM '+quote(table)+' r')).map((r:any)=>r.data);
    const deleted=plan.operations.filter(o=>o.table===table&&!o.after).length;
    if(actual.length!==beforeRows.length-deleted)throw new Error('Unexpected retained row count: '+table);
  }
  for(const operation of receipt.operations.filter(o=>o.after&&['grants','resources'].includes(o.table))){
    const preserved=operation.table==='grants'?['organization_id','org_entity_id','amount','currency','date','source']:['id','stable_id','url','published_date','archive_url','local_filename'];
    if(preserved.some(k=>canonical(operation.before[k])!==canonical(operation.after![k])))throw new Error('Shared record preservation failed: '+operation.table);
  }
  await expectRejected(()=>database.unsafe('UPDATE resources SET authors=$1::jsonb WHERE id=$2',[['Stuart Russell'],retainedResource.key.id]),'excluded identity');
  await expectRejected(()=>database.unsafe('UPDATE resources SET summary=$1 WHERE id=$2',['Stuart\nRussell is a professor',retainedResource.key.id]),'excluded identity');
  await expectRejected(()=>database.unsafe('UPDATE resources SET author_entity_ids=$1::jsonb WHERE id=$2',[['sid_ZxUirlzHke'],retainedResource.key.id]),'excluded identity');
  // Distinct source identity and original external URLs continue to work.
  await database.unsafe('UPDATE resources SET title=title WHERE id=$1',['fad8c070554441dd']);
  await database.unsafe('UPDATE resources SET url=url WHERE id=$1',[retainedResource.key.id]);
  await expectRejected(()=>database.begin((tx:any)=>applyDatabase(tx,plan,digest(plan))),'Review is stale');
  await database.begin((tx:any)=>rollbackDatabase(tx,plan,receipt));
  for(const [table,beforeRows] of Object.entries(baseline)){
    const actual=(await database.unsafe('SELECT to_jsonb(r) AS data FROM '+quote(table)+' r')).map((r:any)=>r.data);
    const sort=(rows:Data[])=>rows.map(canonical).sort();
    if(canonical(sort(actual))!==canonical(sort(beforeRows)))throw new Error('Rollback did not restore exact original rows: '+table);
  }
  const report={passed:true,operations:plan.operations.length,applyAndRollbackMs:Date.now()-started,foreignKeys:true,auditTriggers:true,sharedResourcesPreserved:true,sharedGrantsPreserved:true,exactRollback:true,staleReviewRejected:true,unreviewedCascadeRejected:true,reimportBlocked:true,distinctIdentityRetained:true,originalUrlsRetained:true,productionWrites:false};
  fs.writeFileSync(path.join(bundle,'reports/rehearsal.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
}finally{await database.end({timeout:1});}
