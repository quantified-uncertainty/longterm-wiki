/** A lost COMMIT acknowledgement does not imply the transaction rolled back. */
export async function commitWithRecovery(
  commit:()=>Promise<void>,
  outcome:()=>Promise<'committed'|'rolled-back'>,
  restore:()=>void,
):Promise<{reconciled:boolean}> {
  try { await commit(); return {reconciled:false}; }
  catch(error) {
    let state:'committed'|'rolled-back';
    try { state=await outcome(); }
    catch { throw new Error('Commit outcome is unknown. Files and pending receipt were preserved; run reconcile before retrying.',{cause:error}); }
    if(state==='committed')return {reconciled:true};
    restore();throw error;
  }
}
