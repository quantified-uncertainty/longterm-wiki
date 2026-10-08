import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonical, digest, rowKey, tableOrder, validatePlan, type Plan, type Target } from './model.ts';
import { createMatcher, resolveName } from './matcher.ts';
import { createRedactor } from './redaction.ts';
import { editRanges, editYaml, checkFiles, writeFiles } from './source.ts';
import { runCheck } from '../../validate/validate-reviewed-removal.ts';
import {commitWithRecovery} from './commit.ts';
import {discoverRecords} from './discovery.ts';
import {extractContentText} from '../../../apps/web/scripts/generate-llm-files.mjs';
import {refreshPlan} from './refresh.ts';
import {checkDatabase, rollbackDatabase} from './database.ts';

const targets: Target[]=[{name:'Ada Example',type:'person',aliases:['Ada Example'],ids:['sid_example','ada-example'],contextAliases:['Example']},{name:'Example Institute',type:'organization',aliases:['Example Institute','EXI'],ids:['sid_institute']}];
function fixture(): Plan { return {version:1,targets,reviewed:false,operations:[{table:'entities',key:{id:1},before:{id:1,name:'Ada Example'},after:null,targets:['Ada Example'],reason:'Delete profile'}],files:[],schema:[{table_name:'entities',column_name:'id',sql_type:'integer',not_null:true,generated:'',default_expression:null},{table_name:'entities',column_name:'name',sql_type:'text',not_null:true,generated:'',default_expression:null}],constraints:[],refreshViews:[]}; }
describe('reviewed removal',()=>{
  it('rejects foreign-key changes before considering reviewed deletions',async()=>{
    const plan=fixture();
    const tx={unsafe:async(query:string)=>{
      if(query.includes('pg_attribute'))return plan.schema;
      if(query.includes('pg_constraint'))return [{name:'new_child_fk',table_name:'new_children',parent_table:'entities',type:'f',on_delete:'c',definition:'FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE',columns:['entity_id'],parent_columns:['id']}];
      return [{mismatches:0}];
    }};
    await expect(checkDatabase(tx,plan)).rejects.toThrow('Database schema changed since review');
  });
  it('rejects receipt substitutions even when the digest and operation count match',async()=>{
    const plan=fixture();
    const receipt={planDigest:digest(plan),operations:[{...plan.operations[0],key:{id:2},before:{id:2,name:'Grace Other'}}]};
    let queries=0;const tx={unsafe:async()=>{queries++;return [{mismatches:0}];}};
    await expect(rollbackDatabase(tx,plan,receipt)).rejects.toThrow('Rollback receipt does not match the reviewed plan');
    expect(queries).toBe(0);
  });
  it('preserves newer unrelated article content during refresh and rejects changed database rows',()=>{
    const plan=fixture();
    const before={id:7,slug:'shared',title:'Research',summary:'Shared research',content_plaintext:'# Research\n\nSummary: Shared research\n\n---\nOld text',word_count:5,search_vector:null};
    plan.operations=[{table:'wiki_pages',key:{id:7},before,after:{...before,content_plaintext:'Reviewed old text'},targets:['Ada Example'],reason:'Remove association'}];
    const files=[{file:'content/shared.mdx',before:'original source',after:'---\ntitle: Research\nsummary: Shared research\n---\n# Research\n\nNew unrelated finding. Grace Other studies control.\n',targets:['Ada Example']}];
    const refreshed=refreshPlan(plan,{tables:{wiki_pages:[before]}},files);
    expect(refreshed.operations[0].after!.content_plaintext).toContain('New unrelated finding. Grace Other studies control.');
    expect(refreshed.reviewed).toBe(false);
    expect(()=>refreshPlan(plan,{tables:{wiki_pages:[{...before,summary:'Changed live'}]}},files)).toThrow('changed database row');
    expect(()=>refreshPlan(plan,{tables:{}},files)).toThrow('changed database row');
  });
  it('reconciles a lost commit acknowledgement and preserves files when the outcome is unknown',async()=>{
    let restores=0;const failed=async()=>{throw new Error('connection lost');};
    await expect(commitWithRecovery(failed,async()=> 'committed',()=>{restores++;})).resolves.toEqual({reconciled:true});
    expect(restores).toBe(0);
    await expect(commitWithRecovery(failed,async()=> 'rolled-back',()=>{restores++;})).rejects.toThrow('connection lost');
    expect(restores).toBe(1);
    await expect(commitWithRecovery(failed,async()=>{throw new Error('offline');},()=>{restores++;})).rejects.toThrow('outcome is unknown');
    expect(restores).toBe(1);
  });
  it('discovers owned history with target labels while retaining a shared source document',async()=>{
    const tx={unsafe:async(query:string)=>{
      if(query.includes('information_schema'))return ['hallucination_risk_snapshots','things'].flatMap(table_name=>[{table_name,column_name:'id'},{table_name,column_name:'page_id'}]);
      if(query.includes('FROM "wiki_pages"'))return [{data:{id:9,wiki_id:'sid_example',slug:'ada-example',title:'Ada Example'}}];
      if(query.includes('FROM "resources"'))return [{data:{id:'paper',title:'Shared research',authors:['Ada Example','Grace Other'],url:'https://source.example/ada-example'}}];
      if(query.includes('FROM "hallucination_risk_snapshots"'))return [{data:{id:12,page_id:9}}];
      if(query.includes('FROM "things"'))return [{data:{id:'sid_example',title:'Ada Example'}},{data:{id:'unrelated',url:'https://source/ada-example'}},{data:{id:'same-number-other-table',source_table:'resources',source_id:'9'}},{data:{id:'owned-index',source_table:'wiki_pages',source_id:'9'}}];
      return [];
    }};
    const found=await discoverRecords(tx,targets);
    expect(found.find(r=>r.table==='resources')?.action).toBe('review');
    expect(found.find(r=>r.table==='hallucination_risk_snapshots')).toMatchObject({action:'delete',targets:['Ada Example']});
    expect(found.find(r=>r.table==='things')).toMatchObject({action:'delete'});
    expect(found.some(r=>r.row.id==='unrelated')).toBe(false);
    expect(found.some(r=>r.row.id==='same-number-other-table')).toBe(false);
    expect(found.find(r=>r.row.id==='owned-index')?.action).toBe('delete');
  });
  it('uses the existing article plaintext extraction without exposing JSX',()=>{
    const text=extractContentText('---\ntitle: Shared paper\n---\n# Research\n\n<EntityLink id="kept">Grace Other</EntityLink> studies control.\n');
    expect(text).toContain('Grace Other');expect(text).toContain('studies control');expect(text).not.toContain('EntityLink');expect(text).not.toContain('title:');
  });
  it('removes one identity and its authorship while retaining the shared work, coauthor, year and URL',()=>{
    const redact=createRedactor(targets);
    const result=redact.redactValue({title:'Joint paper',authors:['Ada Example','Grace Other'],year:2024,url:'https://source.example/ada-example-paper'},['Ada Example']);
    expect(result).toEqual({title:'Joint paper',authors:['Grace Other'],year:2024,url:'https://source.example/ada-example-paper'});
  });
  it('keeps unrelated entity names and generic lower-case acronyms',()=>{
    const match=createMatcher(targets);
    expect(match.matches('Ada Exampleton studies exi')).toEqual([]);
    expect(match.matches('Ada Example')).toEqual([targets[0]]);
    expect(match.matches('EXI')).toEqual([targets[1]]);
    expect(match.matches('https://source/ada-example')).toEqual([]);
    expect(match.structured([{id:'sid_example',role:'Researcher'},{id:'sid_other',role:'Researcher'}])).toEqual([{id:'sid_other',role:'Researcher'}]);
  });
  it('requires full identity resolution and returns ambiguous candidates for review',()=>{
    const catalog=[{name:'Ada Example',type:'person',ids:['one']},{name:'Ada Example',type:'person',ids:['two']},{name:'Other',type:'risk',ids:['risk']}];
    expect(resolveName('Ada Example',catalog).map(t=>t.ids)).toEqual([['one'],['two']]);
    expect(resolveName('Example',catalog)).toEqual([]);
    expect(resolveName('Other',catalog)).toEqual([]);
    expect(()=>resolveName('',catalog)).toThrow('Enter');
  });
  it('keeps indentation and publication metadata, unwraps identity links but keeps resource links',()=>{
    const redact=createRedactor(targets);
    expect(redact.removeNames('    <R id="paper"><EntityLink id="sid_example">Ada Example</EntityLink></R>', ['Ada Example'])).toBe('    <R id="paper"></R>');
    expect(redact.removeNames('Example (ICML 2024)', ['Ada Example'],true)).toContain('(ICML 2024)');
    expect(redact.removeNames('Example (Cambridge)', ['Ada Example'],true).trim()).toBe('');
    expect(redact.removeNames('  untouched:  spaced text')).toBe('  untouched:  spaced text');
    expect(redact.redactValue(null)).toBe(null);
  });
  it('edits exact YAML entries and preserves untouched source bytes',()=>{
    const before='# header\n- id: first\n  name: Ada Example\n- id: kept\n  authors: [Ada Example, Grace Other]\n  related:\n    - id: kept\n- id: last\n  note: "unchanged  spacing"\n';
    const after=editYaml(before,[{selector:'id=first',transform:()=>null},{selector:'id=kept',transform:v=>({...v,authors:['Grace Other']})}]);
    expect(after).toContain('# header\n');expect(after).not.toContain('Ada Example');expect(after).toContain('- id: last\n  note: "unchanged  spacing"\n');
    expect(()=>editYaml(before,[{selector:'id=missing',transform:()=>null}])).toThrow('0 entries');
    expect(()=>editYaml('- id: same\n- id: same\n',[{selector:'id=same',transform:()=>null}])).toThrow('2 entries');
    expect(()=>editYaml(before,[{selector:'id=first',transform:v=>v}])).toThrow('Unchanged');
    expect(()=>editYaml('[invalid',[{selector:'id=x',transform:()=>null}])).toThrow('malformed');
    expect(()=>editRanges('abcd',[{start:0,end:3,replacement:''},{start:2,end:4,replacement:''}])).toThrow('Overlapping');
  });
  it('handles scalar ranking entries, nested paper authors and exact mapping deletions',()=>{
    expect(editYaml('citations:\n  - footnote: 7\n    claimContext: Ada Example\n  - footnote: kept\n    claimContext: Grace Other\n',[{selector:'footnote=7',transform:v=>({...v,claimContext:''})}])).toContain('claimContext: Grace Other');
    expect(editYaml('ranking:\n  - first\n  - last\n',[{selector:'entry=first',transform:()=>null}])).toBe('ranking:\n  - last\n');
    expect(editYaml('overrides:\n  Example Institute: institute\n  Other: other\n',[{selector:'overrides.Example Institute',transform:()=>null}])).toBe('overrides:\n  Other: other\n');
    expect(()=>editYaml('overrides: {}\n',[{selector:'overrides.Missing',transform:()=>null}])).toThrow('Missing YAML mapping');
  });
  it('fails on source drift and restores edited/deleted files on rollback',()=>{
    const root=fs.mkdtempSync(path.join(os.tmpdir(),'removal-test-'));fs.mkdirSync(path.join(root,'content'));fs.writeFileSync(path.join(root,'content/a'),'before');fs.writeFileSync(path.join(root,'content/b'),'deleted');
    const changes=[{file:'content/a',before:'before',after:'after',targets:[]},{file:'content/b',before:'deleted',after:null,targets:[]}];
    writeFiles(root,changes);expect(fs.readFileSync(path.join(root,'content/a'),'utf8')).toBe('after');expect(fs.existsSync(path.join(root,'content/b'))).toBe(false);
    expect(()=>checkFiles(root,changes)).toThrow('changed');writeFiles(root,changes,true);expect(fs.readFileSync(path.join(root,'content/b'),'utf8')).toBe('deleted');
    fs.symlinkSync('/etc/passwd',path.join(root,'content/link'));expect(()=>checkFiles(root,[{file:'content/link',before:'',after:'',targets:[]}])).toThrow('escapes');fs.rmSync(root,{recursive:true});
  });
  it('hashes canonical plans consistently and rejects duplicate, stale-key and unsafe changes',()=>{
    expect(canonical({b:2,a:1})).toBe(canonical({a:1,b:2}));expect(digest({a:1})).toBe(digest({a:1}));
    const p=fixture();expect(()=>validatePlan(p)).not.toThrow();p.operations.push(p.operations[0]);expect(()=>validatePlan(p)).toThrow('Duplicate');
    const empty=fixture();empty.targets=[];expect(()=>validatePlan(empty)).toThrow('Empty');
    const key=fixture();key.operations[0].key.id=2;expect(()=>validatePlan(key)).toThrow('Key disagrees');
    const identity=fixture();identity.operations[0].after={id:2,name:'other'};expect(()=>validatePlan(identity)).toThrow('preserve row identity');
    const unchanged=fixture();unchanged.operations[0].after=unchanged.operations[0].before;expect(()=>validatePlan(unchanged)).toThrow('unchanged');
    const required=fixture();required.operations[0].after={id:1,name:null};expect(()=>validatePlan(required)).toThrow('required');
    const generated=fixture();generated.schema[1].generated='s';generated.operations[0].after={id:1,name:'other'};expect(()=>validatePlan(generated)).toThrow('generated');
    const unsafe=fixture();unsafe.files=[{file:'../escape',before:'x',after:null,targets:[]}];expect(()=>validatePlan(unsafe)).toThrow('Invalid source');
  });
  it('decodes composite nullable keys and orders foreign-key restoration',()=>{
    expect(rowKey('source_check_verdicts','record_type=fact; record_id=f_example; field_name=NULL')).toEqual({record_type:'fact',record_id:'f_example',field_name:null});
    expect(rowKey('facts','id=42; fact_id=f_example')).toEqual({id:'42'});
    expect(rowKey('resource_citations','resource_id=paper; page_id=2')).toEqual({resource_id:'paper',page_id:'2'});
    expect(rowKey('session_pages','session_id=3; page_id=2')).toEqual({session_id:'3',page_id:'2'});
    for(const table of ['facts','source_check_verdicts','resource_citations','session_pages','other'])expect(()=>rowKey(table,'invalid')).toThrow('Invalid');
    const fk={name:'fk',table_name:'child',parent_table:'parent',type:'f',on_delete:'r',definition:'',columns:['parent_id'],parent_columns:['id']};
    expect(tableOrder(['child','parent'],[fk])).toEqual(['parent','child']);expect(()=>tableOrder(['child','parent'],[fk,{...fk,table_name:'parent',parent_table:'child'}])).toThrow('Cyclic');
  });
  it('finds remaining identities and ignores original URLs and approved distinct identities',()=>{
    const p=fixture();p.operations[0].after={id:1,name:'Ada Example'};expect(runCheck(p).passed).toBe(false);
    p.identityExceptions=[{table:'entities',key:{id:1},values:{name:'Ada Example'}}];expect(runCheck(p).passed).toBe(true);
    p.files=[{file:'content/a',before:'old',after:'https://source/ada-example',targets:[]}];expect(runCheck(p).passed).toBe(true);
    p.files[0].after='Ada Example';expect(runCheck(p).violations).toContain('content/a:1');
  });
});
