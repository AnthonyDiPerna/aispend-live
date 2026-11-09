// Evidence of interventions, not an invented counterfactual invoice.
const KINDS=['tool-trim','loop-block','subagent-block','compact','handoff','repair','switch','effort-cap','budget-pause'];
function recordImpact(state,input,now=Date.now()) {
  if(!KINDS.includes(input.kind) || typeof input.id!=='string' || !/^[\w-]{8,100}$/.test(input.id))throw Error('Invalid intervention');
  state.impact ||= {rows:[],seen:[]};
  if(state.impact.seen.includes(input.id))return false;
  const row={id:input.id,taskId:input.taskId,kind:input.kind,harness:input.harness||'pi',at:new Date(now).toISOString()};
  for(const key of ['removedChars','beforeTokens','afterTokens'])if(input[key]!==undefined){
    if(!Number.isFinite(input[key]) || input[key]<0 || input[key]>100000000)throw Error('Invalid intervention measurement');
    row[key]=Math.floor(input[key]);
  }
  state.impact.rows.push(row);state.impact.seen.push(row.id);
  // Keep a bounded evidence window. Totals explicitly cover these retained rows.
  state.impact.rows=state.impact.rows.slice(-2000);state.impact.seen=state.impact.seen.slice(-4000);
  return true;
}
function attributeTrimReplay(state,taskId,leaseId,model,billing,ids=[]) {
  // Credit each removal once, only when a subsequent request is authorized.
  // No credit for hypothetical future turns or after compaction discarded the output.
  for(const row of state.impact?.rows||[]){
    if(row.taskId!==taskId || !ids.includes(row.id) || row.kind!=='tool-trim' || row.replayed || row.discarded)continue;
    row.replayed=true;row.requestId=leaseId;row.billing=billing;
    row.estimatedTokens=Math.floor((row.removedChars||0)/4);
    const rates=model?.cost;
    if(rates && Number.isFinite(rates.input) && rates.input>0 && Number.isFinite(rates.cacheRead) && rates.cacheRead>=0){
      row.usdLow=row.estimatedTokens*Math.min(rates.input,rates.cacheRead)/1e6;
      row.usdHigh=row.estimatedTokens*Math.max(rates.input,rates.cacheRead)/1e6;
    }
  }
}
function impactReport(state) {
  const rows=state.impact?.rows||[],count=kind=>rows.filter(r=>r.kind===kind).length;
  const trims=rows.filter(r=>r.kind==='tool-trim'),replayed=trims.filter(r=>r.replayed);
  const sum=(items,key)=>items.reduce((n,r)=>n+(r[key]||0),0);
  const costs=billing=>({low:sum(replayed.filter(r=>r.billing===billing),'usdLow'),high:sum(replayed.filter(r=>r.billing===billing),'usdHigh')});
  const overhead=(state.costLedger||[]).filter(r=>['repair','compact'].includes(r.phase));
  return {since:rows[0]?.at||null,events:rows.length,removedChars:sum(trims,'removedChars'),
    estimatedInputTokensAvoided:sum(replayed,'estimatedTokens'),pendingTrimChars:sum(trims.filter(r=>!r.replayed&&!r.discarded),'removedChars'),
    apiInputCostAvoided:costs('api'),subscriptionReferenceAvoided:costs('subscription'),
    unpricedReplays:replayed.filter(r=>r.usdHigh===undefined).length,
    loopBlocks:count('loop-block'),subagentBlocks:count('subagent-block'),repairs:count('repair'),switches:count('switch'),
    effortCaps:count('effort-cap'),budgetPauses:count('budget-pause'),handoffs:count('handoff'),compactions:count('compact'),
    contextReductionTokens:rows.filter(r=>r.kind==='compact').reduce((n,r)=>n+Math.max(0,(r.beforeTokens||0)-(r.afterTokens||0)),0),
    overhead:{requests:overhead.length,apiEstimateUsd:sum(overhead.filter(r=>r.billing==='api'),'usd'),unknown:overhead.filter(r=>r.unknown).length},
    evidence:rows.slice(-30).reverse(),
    method:'Retained intervention history (up to 2,000 events). Net text removed includes the archive notice. Estimated tokens = net characters / 4; credited once on the first completed replay with usage, not every later turn. Cost range uses cached-to-uncached input catalog rates. Estimates are not invoices or subscription quota savings. Compaction reduction is separate and is not added to trimmed tokens; repair/compaction overhead is shown separately.'};
}
module.exports={recordImpact,attributeTrimReplay,impactReport};
