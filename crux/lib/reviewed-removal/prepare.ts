import fs from 'node:fs';
import path from 'node:path';
import { draftDatabase, draftYaml, scopeFor } from './draft.ts';
import { createRedactor } from './redaction.ts';
import { canonical, changedColumns, digest, type Plan, type ReviewedRow, type Target } from './model.ts';
import { runCheck } from '../../validate/validate-reviewed-removal.ts';
import matter from 'gray-matter';
import { extractContentText } from '../../../apps/web/scripts/generate-llm-files.mjs';

const [bundleArgument, checkoutArgument] = process.argv.slice(2);
if (!bundleArgument || !checkoutArgument) throw new Error('Usage: prepare.ts BUNDLE CHECKOUT');
const bundle = path.resolve(bundleArgument), checkout = path.resolve(checkoutArgument);
const load = (name: string) => JSON.parse(fs.readFileSync(path.join(bundle, name), 'utf8'));
const targets: Target[] = load('targets.json'), rows: ReviewedRow[] = load('reviewed-rows.json'), backup = load('backups/database-with-dependencies.json');
const redactor = createRedactor(targets);
const sourceBackup = path.join(bundle, 'backups/source-before.json');
if (!fs.existsSync(sourceBackup)) fs.writeFileSync(sourceBackup, JSON.stringify(Object.fromEntries([...new Set(rows.filter(r => ['YAML','MDX','Code'].includes(r.storage)).map(r => r.table))].map(file => [file, fs.readFileSync(path.join(checkout, file), 'utf8')])), null, 2), { mode: 0o600 });
const originals: Record<string, string> = load('backups/source-before.json');
// The YAML draft uses a directory containing the frozen original source files.
const frozen = path.join(bundle, 'backups/source');
for (const [file, text] of Object.entries(originals)) { const filename = path.join(frozen, file); fs.mkdirSync(path.dirname(filename), { recursive: true }); fs.writeFileSync(filename, text); }
const yamlOverrides = fs.existsSync(path.join(bundle,'yaml-overrides.json')) ? load('yaml-overrides.json') : {};
const yamlFiles = draftYaml(frozen, rows, targets,yamlOverrides);
const articleOverrides: Record<string, Array<[string,string]>> = fs.existsSync(path.join(bundle,'article-overrides.json')) ? load('article-overrides.json') : {};
const resourceTitles = new Map((backup.tables.resources as any[]).map(r => [r.stable_id, redactor.removeNames(r.title ?? '', targets.map(t => t.name), true).trim() || 'Source document']));
const articleFiles = rows.filter(r => r.storage === 'MDX').map(row => {
  const before = originals[row.table];
  if (row.removal.startsWith('Delete')) return { file: row.table, before, after: null, targets: scopeFor(row, targets) };
  let text = before;
  for (const [old, replacement] of articleOverrides[row.table] ?? []) {
    if (!text.includes(old)) throw new Error('Missing reviewed article passage: ' + row.table + ' ' + old.slice(0,80));
    text = text.replace(old, replacement);
  }
  for (const target of targets) {
    const names = target.aliases.map(s => s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('|');
    text = text.replace(new RegExp('\\{\\s*name:\\s*["\'](?:' + names + ')["\'][\\s\\S]*?\\},?','g'), '');
  }
  text = redactor.removeNames(text, scopeFor(row, targets), true);
  text = text.replace(/<R\s+id="([^"]+)"[^>]*>\s*<\/R>/g, (_,id) => `<R id="${id}">${resourceTitles.get(id) ?? 'Source document'}</R>`);
  const originalBlankLines=new Set(before.match(/^[ \t]+$/gm)??[]);
  text = text.replace(/^[ \t]+$/gm,line=>originalBlankLines.has(line)?line:'');
  return { file: row.table, before, after: text, targets: scopeFor(row, targets) };
});
const codeOverrides: Record<string, Array<[string,string]>> = fs.existsSync(path.join(bundle,'code-overrides.json')) ? load('code-overrides.json') : {};
const codeFiles = [...new Set(rows.filter(r => r.storage === 'Code').map(r => r.table))].map(file => {
  const before = originals[file]; let after = before;
  for (const [old,replacement] of codeOverrides[file] ?? []) { if (!after.includes(old)) throw new Error('Missing code passage: ' + file); after = after.replace(old,replacement); }
  return { file, before, after, targets: [...new Set(rows.filter(r => r.table === file).flatMap(r => scopeFor(r, targets)))] };
});
const operations = draftDatabase(rows, backup.tables, targets);
const databaseOverrides = fs.existsSync(path.join(bundle,'database-overrides.json')) ? load('database-overrides.json') : {};
for (const operation of operations) {
  const override = databaseOverrides[operation.table + ':' + canonical(operation.key)];
  if (override && operation.after) Object.assign(operation.after, override);
  if(operation.table==='resources'&&operation.after&&['title','summary','abstract','review'].some(k=>canonical(operation.before[k])!==canonical(operation.after![k])))operation.after.search_vector=null;
  if (operation.table === 'wiki_pages' && operation.after) {
    const article = articleFiles.find(f => f.file.endsWith('/' + operation.before.slug + '.mdx'));
    const body = article?.after ? extractContentText(article.after) : redactor.removeNames(String(operation.before.content_plaintext ?? ''), operation.targets, true);
    if(article?.after){
      const metadata=matter(article.after).data;
      for(const field of ['title','summary','description'])if(typeof metadata[field]==='string')operation.after[field]=metadata[field];
      const previousHeader=String(operation.before.content_plaintext??'').match(/^[\s\S]*?\n---\n/)?.[0];
      const header=previousHeader?previousHeader.replace(/^# [^\n]*/,'# '+operation.after.title).replace(/^Summary:[^\n]*/m,operation.after.summary?'Summary: '+operation.after.summary:''):'# '+operation.after.title+'\n\nURL: https://www.longtermwiki.com/wiki/'+operation.before.wiki_id+'\n'+(operation.after.summary?'Summary: '+operation.after.summary+'\n':'')+'\n---\n';
      operation.after.content_plaintext=header+body+'\n';
    }else operation.after.content_plaintext=body;
    if(override)Object.assign(operation.after,override);
    operation.after.word_count = String(operation.after.content_plaintext).split(/\s+/).filter(Boolean).length;
    operation.after.search_vector = null;
  }
  // A rewritten quote is no longer a verified verbatim extraction. Clear it,
  // retaining the source URL and other unchanged evidence on the shared claim.
  if(operation.table==='citation_quotes'&&operation.after){
    if(canonical(operation.before.source_quote)!==canonical(operation.after.source_quote)){
      operation.after.source_quote=null;operation.after.quote_verified=false;
      for(const field of ['verification_method','verification_score','verified_at','verification_difficulty','source_location'])operation.after[field]=null;
    }
    if(['claim_text','claim_context','source_quote','accuracy_supporting_quotes','accuracy_issues'].some(field=>canonical(operation.before[field])!==canonical(operation.after![field])))
      for(const field of ['accuracy_score','accuracy_verdict','accuracy_issues','accuracy_checked_at'])operation.after[field]=null;
  }
}
const plan: Plan = { version: 1, targets, reviewed: false, operations, files: [...yamlFiles,...articleFiles,...codeFiles].filter(f => f.before !== f.after), schema: backup.schema, constraints: backup.constraints, refreshViews: backup.materializedViews.filter((v:any) => /hallucination_risk_snapshots|citation_accuracy_snapshots|tablebase_scanner_results/.test(v.definition)).map((v:any) => v.matviewname) };
const deletedPageIds = operations.filter(o => o.table === 'wiki_pages' && !o.after).map(o => String(o.before.id));
const pageReferenceTables = ['hallucination_risk_snapshots','citation_accuracy_snapshots','page_links','wikibase_page_similarity','wikibase_page_assessments','citation_quotes','page_citations','resource_citations','edit_logs','auto_update_results','page_improve_runs','session_pages','agent_session_pages','qa_page_checks','page_snapshots'];
plan.referenceScopes = backup.schema.filter((c:any) => pageReferenceTables.includes(c.table_name) && ['page_id','source_id','target_id','similar_page_id'].includes(c.column_name)).map((c:any) => ({table:c.table_name,column:c.column_name,values:deletedPageIds}));
plan.identityExceptions = load('identity-exceptions.json');
const vector=(fields:string[])=>fields.map((field,i)=>`setweight(to_tsvector('english',coalesce(a."${field}",'')), '${'ABCD'[Math.min(i,3)]}')`).join(' || ');
plan.computedColumns={resources:{search_vector:vector(['title','summary','abstract','review'])},wiki_pages:{search_vector:vector(['title','description','summary','tags','entity_type'])}};
const checks = runCheck(plan);
const unchanged = plan.operations.filter(o => o.after && !changedColumns(o).length).map(o => o.table + ':' + canonical(o.key));
fs.writeFileSync(path.join(bundle,'draft-plan.json'),JSON.stringify(plan),{ mode: 0o600 });
fs.writeFileSync(path.join(bundle,'reports/draft-validation.json'),JSON.stringify({digest:digest(plan),operations:operations.length,files:plan.files.length,checks,unchanged,codeFilesAwaitingEdits:codeFiles.filter(f => f.before === f.after).map(f => f.file)},null,2));
console.log(JSON.stringify({operations:operations.length,files:plan.files.length,violations:checks.violations.length,unchanged}));
