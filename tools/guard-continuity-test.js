const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {initialState,buildPlan,decide,cleanPolicy}=require('./usage-guard');
const {codexResetCredits,codexUsage,fetchCodexUsage}=require('./usage-collectors');
const {createGuardServer}=require('./usage-guard-server');
const {nativeEvent}=require('./guard-native');
const {requestReserve}=require('./guard-accounting');
const {EventEmitter}=require('node:events'),{PassThrough}=require('node:stream');
const NOW=Date.parse('2026-11-09T15:00:00Z'),HOUR=3600000;
const iso=ms=>new Date(ms).toISOString();
function quota(provider,used,resetHours=144,ageMinutes=0){return {provider,windowId:'weekly',windowMinutes:10080,usedPercent:used,resetAt:iso(NOW+resetHours*HOUR),observedAt:iso(NOW-ageMinutes*60000),source:'provider'};}
function fixture(mode='continuous',used=76){const s=initialState();s.policy.usageMode=mode;s.bindings={claude:{provider:'claude-code',model:'test'},codex:{provider:'openai',model:'test'}};s.observations=[quota('claude',100,32),quota('codex',used-4,144,60),quota('codex',used)];return s;}
const task={availableProviders:['claude','codex'],currentProvider:'codex',continuation:true};
const credit=(count=1,expiry=NOW+21*24*HOUR)=>codexResetCredits({availableCount:count,credits:count?[{id:'PRIVATE_CREDIT_ID',description:'PRIVATE_TEXT',status:'available',resetType:'codexRateLimits',grantedAt:NOW/1000-86400,expiresAt:expiry/1000}]:[]},NOW);
async function main(){
  assert.equal(initialState().policy.usageMode,'continuous');assert.throws(()=>cleanPolicy({usageMode:'unlimited'}));
  for(const mode of ['continuous','preserve','max']){
    const s=fixture(mode),before=JSON.stringify(s.policy),plan=buildPlan(s,NOW),decision=decide(plan,task,NOW);
    assert.equal(plan.providers.find(p=>p.provider==='codex').status,'pace');assert.equal(decision.action,'continue',mode+' should keep working at 24%');
    assert(decision.warning);assert.equal(plan.bridge.targetAt,iso(NOW+32*HOUR),'bridge to Claude, not six more days on Codex alone');
    assert.equal(plan.providers[1].windows[0].planningUntil,iso(NOW+32*HOUR));
    assert.equal(JSON.stringify(s.policy),before,'mode overlays must not rewrite configured settings');
    assert.equal(plan.policy.allowApiSpend,false);assert.equal(plan.policy.apiDailyBudgetUsd,0);
    assert.equal(decide(plan,{...task,requests:plan.policy.maxRequestsPerTask},NOW).code,'request-budget');
    assert.equal(decide(plan,{...task,totalTokens:plan.policy.maxTokensPerTask},NOW).code,'token-budget');
    assert.equal(decide(plan,{...task,startedAt:iso(NOW-61*60000)},NOW).code,'time-budget');
    assert.equal(decide(buildPlan(fixture(mode,100),NOW),task,NOW).action,'pause');
    assert.equal(decide(buildPlan(fixture(mode,99),NOW),task,NOW).action,'continue','fresh allowance below the target stays usable');
  }
  assert.equal(decide(buildPlan(fixture('strict'),NOW),task,NOW).action,'pause','strict gates are an explicit choice');
  const preserve=buildPlan(fixture('preserve'),NOW);assert.equal(preserve.policy.maxOutputTokens,2048);assert.equal(preserve.policy.maxThinkingLevel,'low');assert.equal(preserve.configuredPolicy.maxOutputTokens,4096);
  const max=buildPlan(fixture('max'),NOW);assert.equal(max.policy.maxOutputTokens,4096);assert.equal(max.policy.maxThinkingLevel,'medium','use-it-now does not force maximum reasoning');
  const priced={contextWindow:200000,maxTokens:64000,cost:{input:3,cacheRead:.3,cacheWrite:3.75,output:15}};
  assert.equal(requestReserve(priced,preserve.policy),requestReserve(priced,max.policy),'API reservations cannot assume the transport enforces a requested lower output ceiling');
  let s=fixture();s.policy.maxContextTokens=20000;assert.equal(buildPlan(s,NOW).policy.maxContextTokens,20000);
  s=fixture();s.observations.push(quota('claude',94,32));assert.equal(decide(buildPlan(s,NOW),{availableProviders:task.availableProviders},NOW).provider,'codex');
  s.policy.usageMode='max';assert.equal(decide(buildPlan(s,NOW),{availableProviders:task.availableProviders},NOW).provider,'claude','max uses preferred subscription first');
  s=fixture();s.bindings={agy:{provider:'unsupported',model:'test'}};assert.equal(buildPlan(s,NOW).bridge,null,'unconnected quota cannot promise a Pi handoff');
  s=fixture();s.observations=[quota('codex',1,144,16)];assert.equal(decide(buildPlan(s,NOW),task,NOW).action,'pause','stale quota stays blocked');
  s.observations=[quota('codex',1,-1,120)];assert.equal(decide(buildPlan(s,NOW),task,NOW).action,'pause','scheduled reset needs confirmation');
  // A fresh post-redemption decrease starts a new trend even if the reset timestamp stays the same.
  s=fixture();s.observations.push(quota('codex',0));assert.equal(buildPlan(s,NOW).providers[1].windows[0].slopePercentPerHour,null);
  s.observations=[quota('codex',60,144,120),quota('codex',80,144,60),quota('codex',0,144,15),quota('codex',2)];
  assert.equal(buildPlan(s,NOW).providers[1].windows[0].slopePercentPerHour,8,'post-redemption trend must exclude all samples before the counter decrease');
  assert.equal(buildPlan(s,NOW).providers[1].windows[0].refillObservedAt,iso(NOW-15*60000));
  for(const harness of ['claude','codex','agy']){
    s=fixture();s.observations=[quota(harness,95)];
    const result=nativeEvent(s,{harness,event:'prompt',taskId:'continuity-task',eventId:'event-001'},NOW);
    assert.equal(result.action,'continue',harness+' supported native boundary shares the mode policy');
  }
  s=fixture();s.resetCredits={codex:credit()};let plan=buildPlan(s,NOW),c=plan.resetCredits[1];
  assert.equal(c.availableCount,1);assert.equal(c.action,'consider-reset');assert.equal(c.depletionHours,6);
  assert.equal(plan.providers[1].windows[0].remainingPercent,24,'credit is never added to allowance');
  assert(!JSON.stringify(c).includes('PRIVATE_'));
  s.observations=[quota('claude',100,32),quota('codex',100)];assert.equal(decide(buildPlan(s,NOW),task,NOW).action,'pause','a banked reset cannot authorize a call');
  s.resetCreditReports={codex:{source:'manual',scope:'weekly',observedAt:iso(NOW),availableCount:1,credits:[{status:'available',expiresAt:iso(NOW+20*24*HOUR)}]}};
  c=buildPlan(s,NOW).resetCredits[1];assert.equal(c.planningExpiryAt,iso(NOW+20*24*HOUR),'retain earlier user deadline separately from native expiry');assert.equal(c.nextExpiryAt,iso(NOW+21*24*HOUR));
  s.resetCredits.codex=credit(0);assert.equal(buildPlan(s,NOW).resetCredits[1].usableCount,0,'explicit native zero overrides older manual inventory');
  s.resetCredits.codex=codexResetCredits(null,NOW);assert.equal(buildPlan(s,NOW).resetCredits[1].status,'reported','unsupported inventory can use a labeled report');
  delete s.resetCreditReports;assert.equal(buildPlan(s,NOW).resetCredits[1].availableCount,null,'missing inventory is unknown, not zero');
  s.resetCredits.codex=credit(1,NOW-1000);assert.equal(buildPlan(s,NOW).resetCredits[1].usableCount,0,'expired credits do not extend runway');
  s.resetCredits.codex=credit();s.resetCredits.codex.observedAt=iso(NOW-16*60000);assert.equal(buildPlan(s,NOW).resetCredits[1].action,'refresh');
  assert.equal(codexResetCredits({availableCount:3,credits:[]},NOW).availableCount,3,'capped details do not replace the authoritative count');
  assert.equal(codexResetCredits({availableCount:3,credits:null},NOW).detailsKnown,false);
  assert.equal(codexResetCredits({availableCount:-1},NOW).availableCount,null);
  // Exercise the real read-only RPC path, including the field that older collectors dropped.
  const methods=[],payload={rateLimits:{limitId:'codex',primary:{usedPercent:79,windowDurationMins:10080,resetsAt:(NOW+6*24*HOUR)/1000}},rateLimitResetCredits:{availableCount:1,credits:[{id:'PRIVATE_CREDIT_ID',status:'available',resetType:'codexRateLimits',expiresAt:(NOW+21*24*HOUR)/1000}]}};
  const read=await fetchCodexUsage({now:NOW,spawnImpl:()=>{const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
    child.stdin.on('data',chunk=>{const m=JSON.parse(chunk);methods.push(m.method);queueMicrotask(()=>{if(m.id)child.stdout.write(JSON.stringify({id:m.id,result:m.id===1?{}:payload})+'\n');});});return child;}});
  assert.equal(read.resetCredits.availableCount,1);assert.deepEqual(methods,['initialize','initialized','account/rateLimits/read']);
  assert(!JSON.stringify(read).includes('PRIVATE_'));
  // Collector persistence and user reports go through the same server boundary the UI uses.
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'guard-continuity-'));
  let raw=payload,clock=NOW;const server=createGuardServer({stateDir:root,now:()=>clock,codexRoot:path.join(root,'no-logs'),fetchCodex:async()=>codexUsage(raw,clock),fetchClaude:async()=>({observations:[quota('claude',100,32)]}),fetchAgy:async()=>({observations:[]}),insights:false});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base='http://127.0.0.1:'+server.address().port;
  async function post(route,body){const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const result=await r.json();assert.equal(r.status,200,JSON.stringify(result));return result;}
  try{
    const view=await post('/api/sync',{});assert.equal(view.resetCredits[1].availableCount,1);
    assert.equal(JSON.parse(fs.readFileSync(path.join(root,'state.json'))).resetCredits.codex.availableCount,1);
    const reported=await post('/api/reset-credits',{provider:'claude',count:1,scope:'weekly',expiresAt:iso(NOW+20*24*HOUR)});assert.equal(reported.resetCredits[0].status,'reported');
    server.guard.state().tasks['existing-task']={id:'existing-task',requests:25,totalTokens:12345};
    const switched=await post('/api/policy',{usageMode:'max'});assert.equal(switched.tasks[0].requests,25);assert.equal(switched.policy.allowApiSpend,false);
    await post('/api/reset-credits',{provider:'codex',count:1,scope:'weekly',expiresAt:iso(NOW+20*24*HOUR)});
    server.guard.state().bindings.codex={provider:'openai',model:'test'};
    raw={...payload,rateLimits:{...payload.rateLimits,primary:{...payload.rateLimits.primary,usedPercent:1}},rateLimitResetCredits:{availableCount:0,credits:[]}};
    clock+=5*60000;
    const refilled=await post('/api/sync',{});assert.equal(refilled.resetCredits[1].availableCount,0);assert.equal(refilled.providers[1].windows[0].remainingPercent,99);
    assert.equal(refilled.providers[1].windows[0].refillObservedAt,iso(clock));
    assert.equal((await post('/api/readiness',{taskId:'existing-task',availableProviders:['codex']})).action,'continue','fresh confirmed refill permits the saved task, retaining its existing counters');
    assert.equal((await fetch(base+'/api/reset-credit/consume',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})).status,404,'no redemption route');
    assert(!JSON.stringify(switched).includes('PRIVATE_'));
  }finally{await new Promise(resolve=>server.close(resolve));if(path.dirname(root)===path.resolve(os.tmpdir()) && path.basename(root).startsWith('guard-continuity-'))fs.rmSync(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
  console.log('Continuity: modes, bridge forecasts, real remaining quota, banked-credit RPC/expiry/privacy, native gates and unchanged work/API budgets passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
