import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { applyDatabase, checkDatabase, rollbackDatabase, type Receipt } from './database.ts';
import { checkFiles, writeFiles } from './source.ts';
import { digest, validatePlan, type Plan } from './model.ts';
import { commitWithRecovery } from './commit.ts';

const [command='dry-run',planFile,checkout] = process.argv.slice(2).filter(a=>!a.startsWith('--'));
if (!['dry-run','apply','rollback','stage-source','reconcile'].includes(command)||!planFile||!checkout) throw new Error('Usage: cli.ts dry-run|apply|rollback|stage-source|reconcile PLAN CHECKOUT [--approval=DIGEST] [--receipt=PATH]');
const plan: Plan=JSON.parse(fs.readFileSync(planFile,'utf8'));
validatePlan(plan);
const approval=process.argv.find(a=>a.startsWith('--approval='))?.slice('--approval='.length);
const receiptFile=process.argv.find(a=>a.startsWith('--receipt='))?.slice('--receipt='.length)??path.resolve(path.dirname(planFile),'apply-receipt.json');
const root=path.resolve(checkout);
if(command==='stage-source') {checkFiles(root,plan.files);writeFiles(root,plan.files);console.log(JSON.stringify({stagedFiles:plan.files.length,databaseWrites:false}));process.exit(0);}
if(command!=='dry-run'&&(!plan.reviewed||approval!==digest(plan)))throw new Error('Mutation requires explicit approval of the exact reviewed plan digest');
if(!process.env.REMOVAL_DATABASE_URL)throw new Error('Set REMOVAL_DATABASE_URL explicitly; no production database is selected by default');
const require=createRequire(path.resolve(import.meta.dirname,'../../../apps/wiki-server/package.json'));
const postgres=require('postgres');
const db=postgres(process.env.REMOVAL_DATABASE_URL,{max:1,connection:{statement_timeout:'120000',lock_timeout:'10000',...(command==='dry-run'?{default_transaction_read_only:'on'}:{})}});
type Saved={status:string;executionId:string;receipt:Receipt};
const save=(saved:Saved,create=false)=>fs.writeFileSync(receiptFile,JSON.stringify(saved),{mode:0o600,...(create?{flag:'wx'}:{})});
async function journal(tx:any,id:string,state:string){
  await tx.unsafe("CREATE TABLE IF NOT EXISTS removal_execution_journal (execution_id text PRIMARY KEY,plan_digest text NOT NULL,state text NOT NULL CHECK(state IN ('applied','rolled-back')))");
  await tx.unsafe('INSERT INTO removal_execution_journal VALUES ($1,$2,$3) ON CONFLICT(execution_id) DO UPDATE SET state=EXCLUDED.state',[id,digest(plan),state]);
}
async function state(id:string):Promise<'applied'|'rolled-back'|'absent'>{
  const [table]=await db.unsafe("SELECT to_regclass('public.removal_execution_journal') AS name");
  if(!table.name)return 'absent';
  const [row]=await db.unsafe('SELECT state,plan_digest FROM removal_execution_journal WHERE execution_id=$1',[id]);
  if(row&&row.plan_digest!==digest(plan))throw new Error('Execution journal does not match this plan');
  return row?.state??'absent';
}
try {
  if(command==='dry-run'){
    checkFiles(root,plan.files);
    await db.begin('isolation level repeatable read read only',(tx:any)=>checkDatabase(tx,plan));
    console.log(JSON.stringify({passed:true,digest:digest(plan),databaseRows:plan.operations.length,files:plan.files.length,databaseWrites:false}));
  }else if(command==='apply'){
    if(fs.existsSync(receiptFile))throw new Error('Receipt already exists; reconcile it before retrying');
    checkFiles(root,plan.files);
    const executionId=randomUUID();let sourceWritten=false;
    await commitWithRecovery(async()=>{
      await db.begin(async(tx:any)=>{
        await tx.unsafe("SELECT set_config('app.agent_tool','reviewed-removal/apply',true)");
        const receipt=await applyDatabase(tx,plan,approval!);
        await journal(tx,executionId,'applied');
        save({status:'commit-pending',executionId,receipt},true);
        writeFiles(root,plan.files);sourceWritten=true;
      });
    },async()=>await state(executionId)==='applied'?'committed':'rolled-back',()=>{if(sourceWritten)writeFiles(root,plan.files,true);});
    const pending:Saved=JSON.parse(fs.readFileSync(receiptFile,'utf8'));save({...pending,status:'committed'});
    console.log(JSON.stringify({applied:true,receipt:receiptFile}));
  }else{
    const saved:Saved=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
    if(saved.receipt.planDigest!==digest(plan))throw new Error('Receipt does not match this plan');
    if(command==='reconcile'){
      const actual=await state(saved.executionId),after=actual==='applied';
      try{checkFiles(root,plan.files,after);}catch{
        checkFiles(root,plan.files,!after);writeFiles(root,plan.files,!after);
      }
      save({...saved,status:after?'committed':'rolled-back'});
      console.log(JSON.stringify({reconciled:true,databaseState:actual}));
    }else{
      if(saved.status!=='committed')throw new Error('Receipt is not committed; run reconcile before rollback');
      checkFiles(root,plan.files,true);let sourceWritten=false;
      save({...saved,status:'rollback-pending'});
      await commitWithRecovery(async()=>{
        await db.begin(async(tx:any)=>{
          await tx.unsafe("SELECT set_config('app.agent_tool','reviewed-removal/rollback',true)");
          await rollbackDatabase(tx,plan,saved.receipt);
          await journal(tx,saved.executionId,'rolled-back');
          writeFiles(root,plan.files,true);sourceWritten=true;
        });
      },async()=>await state(saved.executionId)==='rolled-back'?'committed':'rolled-back',()=>{if(sourceWritten)writeFiles(root,plan.files);});
      save({...saved,status:'rolled-back'});console.log(JSON.stringify({rolledBack:true}));
    }
  }
}finally{await db.end({timeout:1});}
