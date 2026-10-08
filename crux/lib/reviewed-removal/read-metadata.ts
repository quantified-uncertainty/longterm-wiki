import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(path.resolve(import.meta.dirname,'../../../apps/wiki-server/package.json'));
const postgres = require('postgres');
const dotenv = createRequire(path.resolve(import.meta.dirname,'../../../package.json'))('dotenv');
const [bundle, environmentFile] = process.argv.slice(2);
if (!bundle || !environmentFile) throw new Error('Usage: read-metadata.ts BUNDLE ENVIRONMENT_FILE');
const configuration = dotenv.parse(fs.readFileSync(environmentFile));
const backup=JSON.parse(fs.readFileSync(path.join(bundle,'backups/database-with-dependencies.json'),'utf8'));
const sessionIds=(backup.tables.session_pages??[]).map((row:any)=>row.session_id);
const database = postgres(configuration.PROD_DATABASE_URL,{max:1,connection:{default_transaction_read_only:'on',statement_timeout:60000}});
try {
  const metadata = await database.begin('isolation level repeatable read read only',async (tx:any) => {
    const triggers = await tx`select c.relname as table_name, t.tgname as name, pg_get_triggerdef(t.oid) as definition, p.oid as function_oid, pg_get_functiondef(p.oid) as function_definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid where n.nspname='public' and not t.tgisinternal`;
    const sessions = await tx`select to_jsonb(s) as data from sessions s where id=any(${sessionIds}::bigint[])`;
    return {readOnly:true,triggers,supportParents:{sessions:sessions.map((r:any) => r.data)}};
  });
  fs.writeFileSync(path.join(bundle,'backups/database-metadata.json'),JSON.stringify(metadata),{mode:0o600});
  console.log(JSON.stringify({triggers:metadata.triggers.length,sessions:metadata.supportParents.sessions.length,readOnly:true}));
} finally { await database.end({timeout:1}); }
