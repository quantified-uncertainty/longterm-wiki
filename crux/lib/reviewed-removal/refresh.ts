import matter from 'gray-matter';
import { canonical, type Plan, type SourceChange } from './model.ts';
import { extractContentText } from '../../../apps/web/scripts/generate-llm-files.mjs';

/** Refresh unchanged database operations while accepting reviewed source merges. */
export function refreshPlan(original: Plan, snapshot: {tables: Record<string, Record<string, unknown>[]>}, files: SourceChange[]): Plan {
  const plan: Plan = structuredClone({...original, reviewed: false, files});
  const records = new Map<string, Map<string, Record<string, unknown>>>();
  for (const operation of plan.operations) {
    const columns = Object.keys(operation.key);
    const indexName = operation.table + ':' + columns.join(',');
    if (!records.has(indexName)) records.set(indexName, new Map((snapshot.tables[operation.table] ?? []).map(row => [canonical(columns.map(k => row[k])), row])));
    const before = records.get(indexName)!.get(canonical(columns.map(k => operation.key[k])));
    if (!before || canonical(before) !== canonical(operation.before)) throw new Error('Refresh requires review of changed database row: ' + operation.table + ':' + canonical(operation.key));
    operation.before = before;
    if (operation.table !== 'wiki_pages' || !operation.after) continue;
    const file = files.find(f => f.file.endsWith('/' + before.slug + '.mdx'));
    if (!file?.after) continue;
    const metadata = matter(file.after).data;
    for (const field of ['title','summary','description']) if (typeof metadata[field] === 'string') operation.after[field] = metadata[field];
    const header = String(before.content_plaintext ?? '').match(/^[\s\S]*?\n---\n/)?.[0] ?? `# ${operation.after.title}\n\nURL: https://www.longtermwiki.com/wiki/${before.wiki_id}\n\n---\n`;
    operation.after.content_plaintext = header.replace(/^# [^\n]*/, '# ' + operation.after.title).replace(/^Summary:[^\n]*/m, operation.after.summary ? 'Summary: ' + operation.after.summary : '') + extractContentText(file.after) + '\n';
    operation.after.word_count = String(operation.after.content_plaintext).split(/\s+/).filter(Boolean).length;
    operation.after.search_vector = null;
  }
  plan.files = files.filter(file => file.before !== file.after);
  return plan;
}
