import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {resolveFromDatabase,discoverRecords} from './discovery.ts';

const names=process.argv.slice(2).filter(a=>!a.startsWith('--'));
const output=process.argv.find(a=>a.startsWith('--output='))?.slice(9);
if(!names.length||!output)throw new Error('Usage: discover.ts "Person or organization name" [...] --output=FILE');
if(!process.env.REMOVAL_DATABASE_URL)throw new Error('Set REMOVAL_DATABASE_URL explicitly');
const require=createRequire(path.resolve(import.meta.dirname,'../../../apps/wiki-server/package.json'));
const db=require('postgres')(process.env.REMOVAL_DATABASE_URL,{max:1,connection:{default_transaction_read_only:'on',statement_timeout:'120000'}});
try{
  const candidates=await db.begin('isolation level repeatable read read only',async(tx:any)=>{
    const targets=[];
    for(const name of names){
      const resolved=await resolveFromDatabase(tx,name);
      if(resolved.length!==1)throw new Error(`Resolve identity before proceeding: ${name} (${resolved.length} candidates). Use its exact entity ID when names are ambiguous.`);
      targets.push(resolved[0]);
    }
    return {targets,records:await discoverRecords(tx,targets),reviewed:false};
  });
  fs.writeFileSync(output,JSON.stringify(candidates,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({output,records:candidates.records.length,databaseWrites:false,requiresReview:true}));
}finally{await db.end({timeout:1});}
