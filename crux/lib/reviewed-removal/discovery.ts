import { createMatcher, resolveName } from './matcher.ts';
import { quote, type Data, type Target } from './model.ts';
import type { Transaction } from './database.ts';

export type Candidate={table:string;row:Data;action:'delete'|'review';targets:string[]};
const primaryTables=['entities','facts','resources','wiki_pages','personnel','grants','policy_stakeholders','divisions','funding_programs','entity_ids'];

export async function resolveFromDatabase(tx:Transaction,name:string):Promise<Target[]> {
  const entities=await tx.unsafe("SELECT title AS name,entity_type AS type,id,stable_id,wiki_id FROM entities WHERE entity_type IN ('person','organization')");
  return resolveName(name,entities.map(e=>({name:e.name,type:e.type,ids:[e.id,e.stable_id,e.wiki_id].filter(Boolean)})));
}

/** Read-only discovery. Text matches are review tasks; ownership uses resolved IDs. */
export async function discoverRecords(tx:Transaction,targets:Target[],progress?:(table:string)=>void):Promise<Candidate[]> {
  const matcher=createMatcher(targets),ids=targets.flatMap(t=>t.ids);
  const tokens=targets.flatMap(t=>[...t.ids,t.name,...t.aliases.filter(a=>a.length>5)]);
  if(!tokens.length)throw new Error('Discovery needs a resolved identity or full name');
  const result:Candidate[]=[];
  const coarse=tokens.map(token=>'%'+token.toLowerCase().replace(/[\\%_]/g,'\\$&')+'%');
  const visibleJson="(to_jsonb(r)-ARRAY['url','source','source_url','website','archive_url','local_filename','search_vector','created_at','updated_at','synced_at'])";
  for(const table of primaryTables){
    progress?.(table);
    const records=await tx.unsafe(`SELECT to_jsonb(r) AS data FROM ${quote(table)} r WHERE lower(${visibleJson}::text) LIKE ANY($1::text[])`,[coarse]);
    for(const {data} of records){
      const visible=Object.fromEntries(Object.entries(data).filter(([k])=>!['url','source','website','archive_url','local_filename','search_vector'].includes(k)));
      const matches=matcher.matches(JSON.stringify(visible));if(!matches.length)continue;
      const owned=table==='entities'&&[data.stable_id,data.id].some(id=>ids.includes(id))||table==='wiki_pages'&&[data.wiki_id,data.slug].some(id=>ids.includes(id))||table==='facts'&&ids.includes(data.entity_id)||table==='personnel'&&[data.person_entity_id,data.org_entity_id].some(id=>ids.includes(id));
      result.push({table,row:data,action:owned?'delete':'review',targets:matches.map(t=>t.name)});
    }
  }
  const pageIds=result.filter(r=>r.table==='wiki_pages'&&r.action==='delete').map(r=>String(r.row.id));
  const ownedFacts=result.filter(r=>r.table==='facts'&&r.action==='delete').map(r=>String(r.row.fact_id));
  const owners=new Map<string,string[]>();
  const sourceOwners=new Map<string,string[]>();
  for(const target of targets)for(const id of target.ids)owners.set(id,[target.name]);
  for(const candidate of result.filter(r=>r.action==='delete'))for(const id of [candidate.row.id,candidate.row.fact_id,candidate.row.stable_id])if(id!=null){owners.set(String(id),candidate.targets);sourceOwners.set(candidate.table+':'+String(id),candidate.targets);}
  const columns=await tx.unsafe("SELECT table_name,column_name FROM information_schema.columns WHERE table_schema='public'");
  const dependentTables=['hallucination_risk_snapshots','citation_accuracy_snapshots','page_links','wikibase_page_similarity','wikibase_page_assessments','citation_quotes','page_citations','resource_citations','edit_logs','session_pages','agent_session_pages','auto_update_results','page_improve_runs','source_check_verdicts','source_check_evidence','sourcing_url_suggestions','tablebase_scanner_results','things'];
  for(const table of dependentTables){
    progress?.(table);
    const fields=columns.filter(c=>c.table_name===table).map(c=>c.column_name);if(!fields.length)continue;
    const parameters:unknown[]=[];const conditions:string[]=[];
    for(const field of ['page_id','source_id','target_id','similar_page_id'])if(fields.includes(field)&&pageIds.length){parameters.push(pageIds);conditions.push(`${quote(field)}::text=ANY($${parameters.length}::text[])`);}
    if(fields.includes('entity_id')){parameters.push(ids);conditions.push(`entity_id=ANY($${parameters.length}::text[])`);}
    if(fields.includes('record_id')){parameters.push([...ids,...ownedFacts]);conditions.push(`record_id=ANY($${parameters.length}::text[])`);}
    if(table==='things') {
      // This index stores identifiers, not prose. Avoid a full JSON regex scan.
      parameters.push([...owners.keys()]);
      const parameter='$'+parameters.length+'::text[]';
      for(const field of ['id','parent_thing_id','source_id','wiki_id'])if(fields.includes(field))conditions.push(`${quote(field)}::text=ANY(${parameter})`);
    }else if(table==='tablebase_scanner_results') {
      parameters.push(coarse);conditions.push(`lower(entity_name) LIKE ANY($${parameters.length}::text[])`);
    }else if(!['hallucination_risk_snapshots','citation_accuracy_snapshots','page_links','wikibase_page_similarity','wikibase_page_assessments','session_pages','agent_session_pages','auto_update_results','page_improve_runs'].includes(table)){parameters.push(coarse);conditions.push(`lower(${visibleJson}::text) LIKE ANY($${parameters.length}::text[])`);}
    if(!conditions.length)continue;
    const records=await tx.unsafe(`SELECT to_jsonb(r) AS data FROM ${quote(table)} r WHERE ${conditions.join(' OR ')}`,parameters);
    for(const {data} of records){
      const ownership=['page_id','source_id','target_id','similar_page_id'].filter(k=>(table!=='things'||k!=='source_id')&&pageIds.includes(String(data[k]))).map(k=>String(data[k]));
      if(ids.includes(data.entity_id))ownership.push(data.entity_id);
      if(ownedFacts.includes(data.record_id)||ids.includes(data.record_id))ownership.push(data.record_id);
      if(table==='things'&&[data.id,data.stable_id].some(id=>ids.includes(id)))ownership.push(data.stable_id??data.id);
      if(table==='things'&&owners.has(data.parent_thing_id))ownership.push(data.parent_thing_id);
      const sourceLabels=table==='things'?sourceOwners.get(data.source_table+':'+String(data.source_id))??[]:[];
      const visible=Object.fromEntries(Object.entries(data).filter(([k])=>!['url','source','website','archive_url','local_filename','search_vector'].includes(k)));
      const labels=[...new Set([...matcher.matches(JSON.stringify(visible)).map(t=>t.name),...ownership.flatMap(id=>owners.get(id)??[]),...sourceLabels])];
      if(!ownership.length&&!labels.length)continue;
      result.push({table,row:data,action:ownership.length||sourceLabels.length?'delete':'review',targets:labels});
    }
  }
  return result;
}
