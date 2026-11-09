// Prices are catalog estimates, never a subscription balance or provider invoice.
function requestReserve(model,policy){
  const rates=model?.cost;
  if(!rates || !['input','output','cacheRead','cacheWrite'].every(k=>Number.isFinite(rates[k]) && rates[k]>=0) || !Object.values(rates).some(n=>n>0))return null;
  if(!Number.isFinite(model.contextWindow) || model.contextWindow<=0)return null;
  const inputRate=Math.max(rates.input,rates.cacheRead,rates.cacheWrite);
  // Reserve the full model context, plus bounded output, with pricing headroom.
  // Tools, provider surcharges, and changing prices can still differ from this estimate.
  return Math.ceil(2*(model.contextWindow*inputRate+Math.min(model.maxTokens || policy.maxOutputTokens,policy.maxOutputTokens)*rates.output)/1e6*1e6)/1e6;
}
function accounting(state,leases,now=Date.now()){
  const day=new Date(now).toISOString().slice(0,10),rows=state.costLedger || [];
  const today=rows.filter(r=>r.day===day && r.billing==='api');
  const pending=[...leases.values()].filter(l=>l.billing==='api');
  return {day,apiEstimateUsd:today.reduce((n,r)=>n+r.usd,0),
    apiReservedUsd:pending.filter(r=>r.day===day).reduce((n,r)=>n+(r.reserveUsd||0),0),
    subscriptionReferenceUsd:rows.filter(r=>r.billing==='subscription').reduce((n,r)=>n+r.usd,0),
    unknownCostRequests:rows.filter(r=>r.unknown).length,
    estimated:true,scope:'Guarded Pi requests only; API day resets at 00:00 UTC. Subscription reference cost is not a bill.'};
}
function checkApiBudget(state,leases,taskId,model,policy,now){
  const reserveUsd=requestReserve(model,policy);
  if(reserveUsd===null)return {action:'pause',code:'api-pricing',reason:'API prices or context size are unknown. Select a model with known catalog prices before enabling paid fallback.'};
  const totals=accounting(state,leases,now);
  const taskSpent=(state.costLedger || []).filter(r=>r.taskId===taskId && r.billing==='api').reduce((n,r)=>n+r.usd,0);
  const taskPending=[...leases.values()].filter(l=>l.taskId===taskId && l.billing==='api').reduce((n,l)=>n+l.reserveUsd,0);
  if(totals.apiEstimateUsd+totals.apiReservedUsd+reserveUsd>policy.apiDailyBudgetUsd || taskSpent+taskPending+reserveUsd>policy.apiTaskBudgetUsd)
    return {action:'pause',code:'api-budget',reason:`API cap would be exceeded by the next request's $${reserveUsd.toFixed(2)} reservation.`,reserveUsd};
  return {reserveUsd};
}
module.exports={requestReserve,accounting,checkApiBudget};
