import { digest, quote, type Plan } from './model.ts';
import type { Transaction } from './database.ts';

const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
export function policyRules(plan: Plan): Array<{ token: string; pattern:string;caseSensitive: boolean }> {
  // Acronyms need entity-specific context and are covered by the exact ID rule.
  return plan.targets.flatMap(t => [...t.ids, ...t.aliases.filter(a => a.length > 5)].map(token => ({ token,pattern:'(^|[^[:alnum:]_-])'+escape(token).replace(/ /g,'[[:space:]]+')+'($|[^[:alnum:]_-])', caseSensitive: t.ids.includes(token) || (t.caseSensitiveAliases??[]).includes(token) })));
}

/** Private operational denylist, shared by all imports, including direct SQL writers. */
export async function installPolicy(tx: Transaction, plan: Plan): Promise<void> {
  const planDigest=digest(plan);
  await tx.unsafe(`CREATE TABLE IF NOT EXISTS removal_exclusions (plan_digest text NOT NULL,token text NOT NULL,pattern text NOT NULL, case_sensitive boolean NOT NULL, PRIMARY KEY (plan_digest,token,case_sensitive))`);
  for (const rule of policyRules(plan)) await tx.unsafe('INSERT INTO removal_exclusions (plan_digest,token,pattern,case_sensitive) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[planDigest,rule.token,rule.pattern,rule.caseSensitive]);
  await tx.unsafe('CREATE TABLE IF NOT EXISTS removal_identity_exceptions (plan_digest text NOT NULL,table_name text NOT NULL,record_key jsonb NOT NULL,expected_values jsonb NOT NULL,PRIMARY KEY(plan_digest,table_name,record_key))');
  for(const exception of plan.identityExceptions??[])await tx.unsafe('INSERT INTO removal_identity_exceptions (plan_digest,table_name,record_key,expected_values) VALUES ($1,$2,$3::jsonb,$4::jsonb) ON CONFLICT(plan_digest,table_name,record_key) DO UPDATE SET expected_values=excluded.expected_values',[planDigest,exception.table,exception.key,exception.values]);
  await tx.unsafe('CREATE TABLE IF NOT EXISTS removal_reference_exclusions (plan_digest text NOT NULL,table_name text NOT NULL,column_name text NOT NULL,value text NOT NULL,PRIMARY KEY(plan_digest,table_name,column_name,value))');
  const references=[...(plan.referenceScopes??[]),{table:'wiki_pages',column:'id',values:plan.operations.filter(o=>o.table==='wiki_pages'&&!o.after).map(o=>String(o.before.id))}];
  for(const scope of references)for(const value of scope.values)await tx.unsafe('INSERT INTO removal_reference_exclusions VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING',[planDigest,scope.table,scope.column,value]);
  await tx.unsafe(`CREATE OR REPLACE FUNCTION removal_visible_text(payload jsonb) RETURNS text LANGUAGE plpgsql IMMUTABLE AS $body$
    DECLARE result text:=''; item record;
    BEGIN
      IF jsonb_typeof(payload)='string' THEN RETURN payload#>>'{}'; END IF;
      IF jsonb_typeof(payload)='array' THEN
        FOR item IN SELECT value FROM jsonb_array_elements(payload) LOOP result:=result||E'\\n'||removal_visible_text(item.value); END LOOP;
      ELSIF jsonb_typeof(payload)='object' THEN
        FOR item IN SELECT key,value FROM jsonb_each(payload) LOOP result:=result||E'\\n'||item.key||E'\\n'||removal_visible_text(item.value); END LOOP;
      END IF;
      RETURN result;
    END
  $body$`);
  await tx.unsafe(`CREATE OR REPLACE FUNCTION enforce_removal_exclusions() RETURNS trigger LANGUAGE plpgsql AS $body$
    DECLARE candidate text; payload jsonb; rule record; exception record; field record;
    BEGIN
      IF current_setting('app.removal_maintenance',true)='on' THEN RETURN NEW; END IF;
      FOR rule IN SELECT column_name,value FROM removal_reference_exclusions WHERE table_name=TG_TABLE_NAME LOOP
        IF to_jsonb(NEW)->>rule.column_name=rule.value THEN RAISE EXCEPTION 'Reference to a removed profile is excluded' USING ERRCODE='23514'; END IF;
      END LOOP;
      -- Original documents/URLs and generated indexes are not catalog associations.
      payload := to_jsonb(NEW)-ARRAY['url','source','source_url','suggested_url','website','archive_url','local_filename','search_vector','created_at','updated_at','synced_at'];
      FOR exception IN SELECT expected_values FROM removal_identity_exceptions WHERE table_name=TG_TABLE_NAME AND to_jsonb(NEW) @> record_key LOOP
        FOR field IN SELECT * FROM jsonb_each(exception.expected_values) LOOP
          IF payload->field.key=field.value THEN payload:=payload-field.key; END IF;
        END LOOP;
      END LOOP;
      candidate := removal_visible_text(payload);
      candidate := regexp_replace(candidate,'https?://[^[:space:]<>"\\[\\]]+','','g');
      FOR rule IN SELECT DISTINCT pattern,case_sensitive FROM removal_exclusions LOOP
        IF rule.case_sensitive THEN
          IF candidate ~ rule.pattern THEN RAISE EXCEPTION 'Content includes an excluded identity; review and redact this record before importing' USING ERRCODE='23514'; END IF;
        ELSE
          IF candidate ~* rule.pattern THEN RAISE EXCEPTION 'Content includes an excluded identity; review and redact this record before importing' USING ERRCODE='23514'; END IF;
        END IF;
      END LOOP;
      RETURN NEW;
    END
  $body$`);
  // Domain tables only; immutable global audit logs remain intact.
  for (const table of [...new Set([...plan.operations.map(o=>o.table),...references.map(s=>s.table)])].filter(t=>t!=='entity_ids')) {
    await tx.unsafe(`DROP TRIGGER IF EXISTS enforce_removal_exclusions ON ${quote(table)}`);
    await tx.unsafe(`CREATE TRIGGER enforce_removal_exclusions BEFORE INSERT OR UPDATE ON ${quote(table)} FOR EACH ROW EXECUTE FUNCTION enforce_removal_exclusions()`);
  }
}

export async function removePolicy(tx: Transaction, plan: Plan): Promise<void> {
  const planDigest=digest(plan);
  await tx.unsafe('DELETE FROM removal_exclusions WHERE plan_digest=$1',[planDigest]);
  await tx.unsafe('DELETE FROM removal_identity_exceptions WHERE plan_digest=$1',[planDigest]);
  await tx.unsafe('DELETE FROM removal_reference_exclusions WHERE plan_digest=$1',[planDigest]);
}
