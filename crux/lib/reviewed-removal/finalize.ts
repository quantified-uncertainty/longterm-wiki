import fs from 'node:fs';
import path from 'node:path';
import {canonical,changedColumns,digest,rowKey,validatePlan,type Plan,type ReviewedRow} from './model.ts';
import {runCheck} from '../../validate/validate-reviewed-removal.ts';
const [bundle,tableFile]=process.argv.slice(2);
if(!bundle||!tableFile)throw new Error('Usage: finalize.ts BUNDLE SINGLE_TABLE_FILE');
const plan:Plan=JSON.parse(fs.readFileSync(path.join(bundle,'draft-plan.json'),'utf8'));
const rows:ReviewedRow[]=JSON.parse(fs.readFileSync(path.join(bundle,'reviewed-rows.json'),'utf8'));
const check=runCheck(plan);validatePlan(plan);
if(!check.passed)throw new Error('Remaining identities: '+check.violations.join(', '));
for(const name of ['source-validation','rehearsal'])if(!JSON.parse(fs.readFileSync(path.join(bundle,'reports/'+name+'.json'),'utf8')).passed)throw new Error(name+' has not passed');
const normalized=(key:Record<string,unknown>)=>canonical(Object.fromEntries(Object.entries(key).map(([k,v])=>[k,v==null?null:String(v)])));
const operations=new Map(plan.operations.map(o=>[o.table+':'+normalized(o.key),o]));
for(const row of rows.filter(r=>r.storage==='DB')){
 const operation=operations.get(row.table+':'+normalized(rowKey(row.table,row.id)));
 if(!operation)throw new Error('Unmatched reviewed row: '+row.table+' '+row.id);
 row.removal=operation.after?'Remove target data from '+changedColumns(operation).sort().join(', ')+'. Keep record.':'Delete record.';
}
fs.writeFileSync(path.join(bundle,'reviewed-rows.json'),JSON.stringify(rows,null,2),{mode:0o600});
const cell=(s:string)=>s.replace(/\s+/g,' ').trim().replaceAll('|','\\|');
const lines=['# LongTermWiki — people and organizations removal table','','One row per database record, source entry, or article. Remove the listed people and organizations, their associations, mentions and exclusive facts. Keep shared papers, grants, original sources and unrelated content. Preparation only; no production changes applied.','', '| Organization | Person | Storage | Table / file | Record ID | Item | Removal |','| --- | --- | --- | --- | --- | --- | --- |'];
for(const row of rows)lines.push('| '+[row.organization||'—',row.people.join('; ')||'—',row.storage,row.table,row.id,row.item,row.removal].map(cell).join(' | ')+' |');
fs.writeFileSync(tableFile,lines.join('\n')+'\n');
plan.reviewed=true;
fs.writeFileSync(path.join(bundle,'plan.json'),JSON.stringify(plan),{mode:0o600});
fs.writeFileSync(path.join(bundle,'reports/draft-validation.json'),JSON.stringify({passed:true,checks:check,unchanged:[],digest:digest(plan)},null,2));
const report={prepared:true,productionWrites:false,digest:digest(plan),tableRows:rows.length,databaseRows:plan.operations.length,databaseDeletes:plan.operations.filter(o=>!o.after).length,databaseEdits:plan.operations.filter(o=>o.after).length,sourceFiles:plan.files.length,people:plan.targets.filter(t=>t.type==='person').length,organizations:plan.targets.filter(t=>t.type==='organization').length,editedArticles:plan.files.filter(f=>f.file.endsWith('.mdx')&&f.after).length,deletedArticles:plan.files.filter(f=>f.file.endsWith('.mdx')&&!f.after).length};
fs.writeFileSync(path.join(bundle,'reports/prepared.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));
