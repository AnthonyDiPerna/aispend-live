const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {initialState,cleanPolicy,observation,mergeObservations,buildPlan,decide,trimToolOutput}=require('./usage-guard');
const {createGuardServer,codexObservations,scanCodexLimits,demoState}=require('./usage-guard-server');

const NOW=Date.parse('2026-11-08T17:00:00Z'), HOUR=3600000;
function row(provider='claude',usedPercent=30,resetHours=72,ageMinutes=1,windowId='weekly') {
  return {provider,usedPercent,windowId,windowMinutes:windowId==='weekly'?10080:300,resetAt:new Date(NOW+resetHours*HOUR).toISOString(),observedAt:new Date(NOW-ageMinutes*60000).toISOString(),source:'manual'};
}
function state(rows) {return {...initialState(),observations:rows,bindings:{claude:{provider:'claude-code',model:'claude-test'},codex:{provider:'openai',model:'gpt-test'}}};}
async function run() {
  assert.throws(()=>observation({...row(),usedPercent:NaN},NOW));
  assert.throws(()=>observation({...row(),observedAt:new Date(NOW+HOUR).toISOString()},NOW));
  assert.throws(()=>cleanPolicy({reservePercent:101}));
  assert.throws(()=>cleanPolicy({providerOrder:['claude','claude','codex']}));
  const normal=buildPlan(state([row()]),NOW);
  assert.equal(normal.providers[0].status,'ready');
  assert.equal(normal.providers[0].windows[0].safePercentPerDay,20);
  assert.equal(normal.providers[0].windows[0].slopePercentPerHour,null);
  assert.equal(normal.providers[1].status,'unknown');
  assert.equal(decide(normal,{availableProviders:['claude']},NOW).provider,'claude');
  assert.equal(decide(normal,{availableProviders:[]},NOW).action,'pause','cannot switch to an unauthenticated account');
  assert.equal(decide(normal,{availableProviders:['claude'],requests:80},NOW).code,'request-budget');
  assert.equal(decide(normal,{availableProviders:['claude'],totalTokens:8000000},NOW).code,'token-budget');
  assert.equal(decide(normal,{availableProviders:['claude'],contextTokens:200000},NOW).action,'compact');
  assert.equal(decide(normal,{availableProviders:['claude'],repeatedTools:3},NOW).code,'repeated-tools');

  const protect=buildPlan(state([row('claude',94),row('codex',20)]),NOW);
  assert.equal(protect.recommendedProvider,'codex');
  assert.equal(protect.providers[0].status,'reserve');
  assert.equal(decide(protect,{currentProvider:'claude',availableProviders:['claude','codex']},NOW).action,'switch');
  const bothReady=buildPlan(state([row('claude'),row('codex')]),NOW);
  assert.equal(decide(bothReady,{currentProvider:'codex',continuation:true,availableProviders:['claude','codex']},NOW).provider,'codex','preserve cache within the task');
  assert.equal(decide(bothReady,{currentProvider:'codex',continuation:false,availableProviders:['claude','codex']},NOW).provider,'claude');

  const afterReset=buildPlan(state([row('claude',99,-1)]),NOW);
  assert.equal(afterReset.providers[0].status,'verify-reset');
  assert.equal(afterReset.providers[0].windows[0].remainingPercent,1,'timer must never fabricate a fresh quota');
  assert.equal(afterReset.recommendedProvider,null);
  const resetConfirmed=buildPlan(state([row('claude',99,-1,120),row('claude',2,167,1)]),NOW);
  assert.equal(resetConfirmed.providers[0].status,'ready');
  assert.equal(resetConfirmed.providers[0].windows[0].slopePercentPerHour,null,'do not calculate a slope across resets');
  const bothWindows=buildPlan(state([row('claude',95,4,1,'session'),row('claude',90,60)]),NOW);
  assert.equal(bothWindows.nextReviewAt,new Date(NOW+60*HOUR).toISOString(),'five-hour reset does not clear a weekly block');
  assert.equal(buildPlan(state([row('claude',20,72,121)]),NOW).providers[0].status,'stale');
  const pace=buildPlan(state([row('claude',20,72,61),row('claude',25,72,1)]),NOW);
  assert.equal(pace.providers[0].status,'pace');
  assert.equal(pace.providers[0].windows[0].slopePercentPerHour,5);
  assert.equal(buildPlan(state([row('claude',50,72,61),row('claude',20,72,1)]),NOW).providers[0].windows[0].slopePercentPerHour,null,'counter decreases are not savings forecasts');
  assert.equal(mergeObservations([row()],[row()],NOW).length,1);
  assert.equal(buildPlan(demoState(NOW),NOW).recommendedProvider,'codex');

  const text='begin'+'.'.repeat(40000)+'end', image={type:'image',data:'keep'};
  const trimmed=trimToolOutput([{type:'text',text},image],16000,'local-result.txt');
  assert.ok(trimmed.content.find(x=>x.type==='text').text.startsWith('begin'));
  assert.ok(trimmed.content.find(x=>x.type==='text').text.endsWith('end'));
  assert.equal(trimmed.removedChars,24008);
  assert.equal(trimmed.content[0],image);
  assert.deepEqual(trimToolOutput([{type:'text',text:'short'}],16000,'unused').content,[{type:'text',text:'short'}]);
  const snapshot={limit_id:'codex',primary:{used_percent:15,window_minutes:10080,resets_at:(NOW+6*24*HOUR)/1000}};
  const observed=codexObservations(snapshot,new Date(NOW-60000).toISOString(),NOW);
  assert.equal(observed[0].windowMinutes,10080,'primary can be weekly');
  assert.equal(observed[0].usedPercent,15);

  const root=fs.mkdtempSync(path.join(os.tmpdir(),'aispend-guard-test-'));
  const logs=path.join(root,'logs','2026','11','08');fs.mkdirSync(logs,{recursive:true});
  fs.writeFileSync(path.join(logs,'rollout.jsonl'),JSON.stringify({timestamp:new Date(NOW-60000).toISOString(),payload:{rate_limits:snapshot},secret:'PRIVATE_PROMPT'})+'\n');
  assert.equal(scanCodexLimits(path.join(root,'logs'),NOW).length,1);
  assert.ok(!JSON.stringify(scanCodexLimits(path.join(root,'logs'),NOW)).includes('PRIVATE_PROMPT'));
  const live=createGuardServer({stateDir:path.join(root,'live'),sync:false,now:()=>NOW});
  assert.equal(live.guard.state().policy.maxConcurrentRequests,1,'new users start with one in-flight request');
  live.guard.state().policy.maxConcurrentRequests=2; // Exercise an explicit concurrency override.
  await new Promise(resolve=>live.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${live.address().port}`;
  async function post(route,data,extra={}) {const response=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...extra},body:JSON.stringify(data)});return {status:response.status,data:await response.json()};}
  try {
    assert.equal((await post('/api/observations',{observations:[row()]},{Origin:'https://evil.example'})).status,403);
    assert.equal((await post('/api/binding',{group:'claude',provider:'anthropic',model:'paid-api'})).status,400,'no implicit API fallback');
    await post('/api/models',{models:[{group:'claude',provider:'claude-code',id:'claude-test',auth:'subscription'}]});
    assert.equal((await post('/api/binding',{group:'claude',provider:'claude-code',model:'claude-test'})).status,200);
    await post('/api/observations',{observations:[row()]});
    const query={taskId:'fixture-task',availableProviders:['claude'],contextTokens:20000};
    const idleState=JSON.stringify(live.guard.state());
    assert.equal((await post('/api/readiness',query)).data.action,'continue');
    assert.equal(JSON.stringify(live.guard.state()),idleState,'waiting checks spend no requests and never mutate counters');
    const first=(await post('/api/preflight',query)).data;
    assert.equal(first.action,'continue');assert.ok(first.leaseId);
    const second=(await post('/api/preflight',{...query,taskId:'fixture-task-2'})).data;
    assert.equal(second.action,'continue');
    assert.equal((await post('/api/preflight',{...query,taskId:'fixture-task-3'})).data.code,'concurrency');
    assert.equal((await post('/api/reset-task',{taskId:'fixture-task'})).status,400,'do not reset an in-flight task');
    assert.equal((await post('/api/complete',{taskId:'fixture-task',leaseId:first.leaseId,totalTokens:1200})).status,200);
    assert.equal((await post('/api/complete',{taskId:'fixture-task',leaseId:first.leaseId,totalTokens:1200})).status,400,'idempotent accounting refuses replay');
    const saved=await (await fetch(base+'/api/state')).json();
    assert.ok(fs.readFileSync(path.join(root,'live','state.json'),'utf8').includes(second.leaseId),'pending concurrency survives restarts');
    assert.equal(saved.tasks[0].requests,1);assert.equal(saved.tasks[0].totalTokens,1200);
    assert.ok(!JSON.stringify(saved).includes(root),'no machine paths in dashboard state');
    const before=JSON.stringify(live.guard.state());
    assert.equal((await post('/api/simulate',{hours:49})).data.providers[0].status,'verify-reset');
    assert.equal(JSON.stringify(live.guard.state()),before,'simulator must not mutate live policy or quota');
  } finally {await new Promise(resolve=>live.close(resolve));}
  const demo=createGuardServer({stateDir:path.join(root,'demo'),demo:true,sync:false,now:()=>NOW});
  await new Promise(resolve=>demo.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${demo.address().port}/api/preflight`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    assert.equal(response.status,403,'synthetic quota must never authorize real inference');
  } finally {await new Promise(resolve=>demo.close(resolve));}
  console.log('AI Spend Guard policy, reset, privacy, and HTTP integration tests passed');
}
run().catch(error=>{console.error(error);process.exitCode=1;});
