import { createMatcher } from '../lib/reviewed-removal/matcher.ts';
import type { Plan } from '../lib/reviewed-removal/model.ts';

/** URLs and deliberately preserved original identities are handled separately. */
export function runCheck(plan: Plan): { passed: boolean; errors: string[]; violations: string[] } {
  const matcher = createMatcher(plan.targets), violations: string[] = [];
  for (const operation of plan.operations) {
    if (!operation.after) continue;
    for (const [field, value] of Object.entries(operation.after)) {
      if (['id','stable_id','wiki_id','source','url','website','archive_url','local_filename','search_vector','created_at','updated_at','synced_at'].includes(field)) continue;
      if (plan.identityExceptions?.some(e=>e.table===operation.table&&JSON.stringify(e.key)===JSON.stringify(operation.key)&&field in e.values&&JSON.stringify(e.values[field])===JSON.stringify(value))) continue;
      const text=typeof value === 'string' ? value : JSON.stringify(value);
      const scoped=createMatcher(plan.targets.filter(t=>operation.targets.includes(t.name)).map(t=>({...t,aliases:t.contextAliases??[],ids:[]})));
      if (matcher.matches(text).length||scoped.matches(text).length) violations.push(`${operation.table}:${JSON.stringify(operation.key)}.${field}`);
    }
  }
  for (const file of plan.files) {
    if (file.after == null) continue;
    // YAML files contain many unrelated entries; a surname elsewhere in that
    // file does not establish the reviewed entry's identity.
    const scoped=createMatcher(file.file.endsWith('.yaml')?[]:plan.targets.filter(t=>file.targets.includes(t.name)).map(t=>({...t,aliases:t.contextAliases??[],ids:[]})));
    const lines = file.after.split('\n');
    lines.forEach((line, i) => { if (matcher.matches(line).length||scoped.matches(line).length) violations.push(`${file.file}:${i + 1}`); });
  }
  return { passed: !violations.length, errors: [], violations };
}
