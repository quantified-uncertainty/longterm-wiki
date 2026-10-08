import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { rowKey } from './model.ts';

const requireBackend=createRequire(path.resolve(import.meta.dirname,'../../../apps/wiki-server/package.json'));
const postgres=requireBackend('postgres');
const requireRoot=createRequire(path.resolve(import.meta.dirname,'../../../package.json'));
const dotenv=requireRoot('dotenv');
type RecordData=Record<string,unknown>;
type TableRow={storage:string;table:string;id:string;people:string[];organization:string;removal:string;item:string;kind:number};
const [tableFile,destination,environmentFile]=process.argv.slice(2);
if(!tableFile||!destination||!environmentFile)throw new Error('Usage: snapshot.ts REVIEWED_ROWS BUNDLE ENVIRONMENT_FILE');
if(fs.existsSync(path.join(destination,'backups/database-before.json')))throw new Error('Snapshot backups are immutable; choose a fresh bundle directory');
fs.mkdirSync(path.join(destination,'backups'),{recursive:true});fs.mkdirSync(path.join(destination,'reports'),{recursive:true});
const tableRows:TableRow[]=JSON.parse(fs.readFileSync(tableFile,'utf8'));
const grouped=new Map<string,Array<{key:RecordData;proposal:TableRow}>>();
for(const row of tableRows.filter(r=>r.storage==='DB')){
 const list=grouped.get(row.table)??[];list.push({key:rowKey(row.table,row.id),proposal:row});grouped.set(row.table,list);
}
const configuration=dotenv.parse(fs.readFileSync(environmentFile));
const db=postgres(configuration.PROD_DATABASE_URL,{max:1,connect_timeout:10,connection:{default_transaction_read_only:'on',statement_timeout:60000}});
const backup:{checkedAt?:string;readOnly?:boolean;tables:Record<string,RecordData[]>;schema?:RecordData[];constraints?:RecordData[];indexes?:RecordData[];materializedViews?:RecordData[];scopeDrift:RecordData[];missing:RecordData[];foreignKeyReferences?:RecordData[];supportParents?:Record<string,RecordData[]>}={tables:{},scopeDrift:[],missing:[]};
const quoted=(s:string)=>'"'+s.replaceAll('"','""')+'"';
const json=(v:unknown)=>JSON.stringify(v);
try {
 await db.begin('isolation level repeatable read read only',async (tx:any)=>{
  const [state]=await tx`select now()::text as checked_at,current_setting('transaction_read_only') as read_only`;
  backup.checkedAt=state.checked_at;backup.readOnly=state.read_only==='on';
  for(const [table,entries] of grouped){
   const columns=Object.keys(entries[0].key);const join=columns.map(c=>'r.'+quoted(c)+(c==='field_name'?' IS NOT DISTINCT FROM ':' = ')+'k.'+quoted(c)).join(' AND ');
   const rows=await tx.unsafe('select to_jsonb(r) as data from '+quoted(table)+' r join jsonb_populate_recordset(NULL::'+quoted(table)+',$1::jsonb) k on '+join,[entries.map(e=>e.key)]);
   backup.tables[table]=rows.map((r:any)=>r.data);
   const actualKeys=new Set(rows.map((r:any)=>json(columns.map(c=>r.data[c]==null?null:String(r.data[c])))));
   for(const entry of entries)if(!actualKeys.has(json(columns.map(c=>entry.key[c]==null?null:String(entry.key[c])))))backup.missing.push({table,key:entry.key});
   console.log(JSON.stringify({table,requested:entries.length,backedUp:rows.length}));
  }
  backup.schema=await tx`select c.relname as table_name,a.attname as column_name,format_type(a.atttypid,a.atttypmod) as sql_type,a.attnotnull as not_null,a.attgenerated as generated,a.attidentity as identity,pg_get_expr(ad.adbin,ad.adrelid) as default_expression from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef ad on ad.adrelid=a.attrelid and ad.adnum=a.attnum where n.nspname='public' and c.relkind='r' and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`;
  backup.constraints=await tx`select con.conname as name,child.relname as table_name,parent.relname as parent_table,con.contype as type,con.confdeltype as on_delete,pg_get_constraintdef(con.oid) as definition,array(select attname from pg_attribute where attrelid=con.conrelid and attnum=any(con.conkey) order by array_position(con.conkey,attnum)) as columns,array(select attname from pg_attribute where attrelid=con.confrelid and attnum=any(con.confkey) order by array_position(con.confkey,attnum)) as parent_columns from pg_constraint con join pg_class child on child.oid=con.conrelid left join pg_class parent on parent.oid=con.confrelid join pg_namespace n on n.oid=child.relnamespace where n.nspname='public' order by child.relname,con.conname`;
  backup.indexes=await tx`select tablename,indexname,indexdef from pg_indexes where schemaname='public'`;
  backup.materializedViews=await tx`select matviewname,definition from pg_matviews where schemaname='public'`;
  const removedEntities=tableRows.filter(r=>r.storage==='DB'&&r.table==='entities'&&r.removal==='Delete record.').map(r=>r.id.split('=',2)[1]);
  const removedPages=tableRows.filter(r=>r.storage==='DB'&&r.table==='wiki_pages'&&r.removal==='Delete record.').map(r=>r.id.split('=',2)[1]);
  const dependencies:RecordData[]=[];
  for(const constraint of backup.constraints!.filter((c:any)=>c.type==='f'&&['entities','wiki_pages'].includes(c.parent_table)) as any[]){
   const target=constraint.parent_table==='entities'?backup.tables.entities.filter(r=>removedEntities.includes(String(r.stable_id))):backup.tables.wiki_pages.filter(r=>removedPages.includes(String(r.id)));
   const columns=constraint.columns as string[];const parents=constraint.parent_columns as string[];
   const join=columns.map((c,i)=>'r.'+quoted(c)+' = k.'+quoted(parents[i])).join(' AND ');
   const referenced=await tx.unsafe('select to_jsonb(r) as data from '+quoted(constraint.table_name)+' r join jsonb_populate_recordset(NULL::'+quoted(constraint.parent_table)+',$1::jsonb) k on '+join,[target]);
   if(referenced.length)dependencies.push({table:constraint.table_name,constraint:constraint.name,onDelete:constraint.on_delete,rows:referenced.map((r:any)=>r.data)});
  }
  backup.foreignKeyReferences=dependencies;
  for(const table of ['hallucination_risk_snapshots','citation_accuracy_snapshots','tablebase_scanner_results','page_links','wikibase_page_similarity','wikibase_page_assessments','citation_quotes','page_citations','resource_citations','edit_logs','auto_update_results','page_improve_runs','session_pages','agent_session_pages','qa_page_checks','page_snapshots']){
   const present=backup.schema!.filter((c:any)=>c.table_name===table);
   const columns=present.filter((c:any)=>['page_id','source_id','target_id','similar_page_id','entity_id'].includes(c.column_name));
   if(!columns.length)continue;
   const parameters:Array<string[]>=[];
   const condition=columns.map((c:any)=>{parameters.push(c.column_name==='entity_id'?removedEntities:removedPages);return quoted(c.column_name)+'::text = ANY($'+parameters.length+'::text[])';}).join(' OR ');
   const current=await tx.unsafe('select to_jsonb(r) as data from '+quoted(table)+' r where '+condition,parameters);
   if(!current.length)continue;
   const existing=new Set((backup.tables[table]??[]).map(r=>json(r)));
   const extra=current.map((r:any)=>r.data).filter((r:RecordData)=>!existing.has(json(r)));
   if(extra.length)backup.scopeDrift.push({table,rows:extra});
  }
  // Keep the exact referenced parent rows needed for a PostgreSQL rehearsal.
  const support:Record<string,RecordData[]>={};
  const working:Record<string,RecordData[]>=Object.fromEntries(Object.entries(backup.tables).map(([table,rows])=>[table,[...rows]]));
  for(const drift of backup.scopeDrift as any[])(working[drift.table]??=[]).push(...drift.rows);
  let added=true;
  while(added){
   added=false;
   for(const constraint of backup.constraints!.filter((c:any)=>c.type==='f') as any[]){
    if(!working[constraint.table_name]?.length)continue;
    const join=(constraint.columns as string[]).map((c,i)=>'r.'+quoted(constraint.parent_columns[i])+' = k.'+quoted(c)).join(' AND ');
    const result=await tx.unsafe('select distinct to_jsonb(r) as data from '+quoted(constraint.parent_table)+' r join jsonb_populate_recordset(NULL::'+quoted(constraint.table_name)+',$1::jsonb) k on '+join,[working[constraint.table_name]]);
    const current=new Set((working[constraint.parent_table]??[]).map(r=>json(r)));
    const extras=result.map((r:any)=>r.data).filter((r:RecordData)=>!current.has(json(r)));
    if(extras.length){
     (support[constraint.parent_table]??=[]).push(...extras);(working[constraint.parent_table]??=[]).push(...extras);added=true;
    }
   }
  }
  backup.supportParents=support;
 });
 fs.writeFileSync(path.join(destination,'backups/database-before.json'),json(backup),{mode:0o600});
 fs.writeFileSync(path.join(destination,'reviewed-rows.json'),json(tableRows),{mode:0o600});
 fs.writeFileSync(path.join(destination,'reports/snapshot.json'),JSON.stringify({checkedAt:backup.checkedAt,readOnly:backup.readOnly,missing:backup.missing,scopeDrift:backup.scopeDrift.map((b:any)=>({table:b.table,rows:b.rows.length})),foreignKeyDependencies:backup.foreignKeyReferences?.map((b:any)=>({table:b.table,rows:b.rows.length,onDelete:b.onDelete})),backupSha256:createHash('sha256').update(fs.readFileSync(path.join(destination,'backups/database-before.json'))).digest('hex')},null,2));
 console.log(JSON.stringify({finished:true,missing:backup.missing.length,drift:backup.scopeDrift.map((b:any)=>[b.table,b.rows.length])}));
}finally{await db.end({timeout:1});}
