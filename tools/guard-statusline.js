// Native CLI status-line input stays local. Persist only quota/cost/context metadata.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {signature}=require('./usage-guard');
const {isoReset}=require('./usage-collectors');
function sanitizeStatus(input,provider,now=Date.now()){
  const observations=[];
  const add=(id,minutes,used,reset,family)=>{
    if(typeof used!=='number' || !Number.isFinite(used) || used<0 || used>100 || !isoReset(reset))return;
    observations.push({provider,windowId:id,windowMinutes:minutes,usedPercent:used,resetAt:isoReset(reset),observedAt:new Date(now).toISOString(),source:provider==='agy'?'agy-cli':'provider',...(family?{modelFamily:family}:{})});
  };
  if(provider==='agy')for(const [id,row] of Object.entries(input.quota || {})){
    if(!/^[a-zA-Z0-9_.:-]{1,80}$/.test(id) || row.disabled || typeof row.remaining_fraction!=='number')continue;
    // An amount of credits is not a percentage. Unknown windows stay unknown.
    const minutes=/week/i.test(id)?10080:/5.?h|five.?hour/i.test(id)?300:null;
    if(minutes)add(id,minutes,(1-row.remaining_fraction)*100,row.reset_time,/gemini/i.test(id)?'gemini':/claude|gpt|anthropic/i.test(id)?'claude-gpt':undefined);
  }
  if(provider==='claude')for(const [id,minutes] of [['five_hour',300],['seven_day',10080]]){
    const row=input.rate_limits?.[id];if(row)add(minutes===300?'session':'weekly',minutes,row.used_percentage,row.resets_at);
  }
  const finite=n=>typeof n==='number' && Number.isFinite(n) && n>=0?n:null;
  const cost=provider==='agy'?input.cost?.total_usd:input.cost?.total_cost_usd;
  const model=String(input.model?.id || '').replace(/[^a-zA-Z0-9 ._:/()-]/g,'').slice(0,120);
  return {provider,observedAt:new Date(now).toISOString(),observations,session:{id:signature(input.session_id || input.conversation_id || provider),model,
    contextTokens:finite(input.context_window?.current_usage?.input_tokens),contextUsedPercent:finite(input.context_window?.used_percentage),
    costEstimateUsd:finite(cost),thinkingLevel:['off','low','medium','high','xhigh','max','ultra'].includes(input.model?.effort)?input.model.effort:null,
    activeSubagents:Array.isArray(input.subagents)?input.subagents.filter(a=>a.status==='running').length:null}};
}
async function main(){
  let raw='';for await(const part of process.stdin){raw+=part;if(raw.length>1024*1024)throw Error('Status input too large');}
  const provider=process.argv[2];if(!['claude','agy'].includes(provider))throw Error('Expected claude or agy');
  const value=sanitizeStatus(JSON.parse(raw),provider);
  const dir=process.argv[3] || process.env.AI_SPEND_GUARD_DIR || path.join(os.homedir(),'.aispend-live','guard');
  fs.mkdirSync(dir,{recursive:true});const dest=path.join(dir,provider+'-status.json'),temp=dest+'.'+process.pid+'.tmp';
  fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,dest);
  const windows=value.observations.map(w=>`${w.windowId}: ${(100-w.usedPercent).toFixed(0)}% left`).join(' | ');
  process.stdout.write(`AI Spend: ${windows || 'allowance not reported'}${value.session.costEstimateUsd!==null?' | ~$'+value.session.costEstimateUsd.toFixed(2)+' reference cost':''}`);
}
if(require.main===module)main().catch(()=>{process.stdout.write('AI Spend: status feed unavailable');});
module.exports={sanitizeStatus};
