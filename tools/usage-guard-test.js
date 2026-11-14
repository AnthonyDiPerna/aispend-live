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
function state(rows) {const base=initialState();base.policy.usageMode='strict';return {...base,observations:rows,bindings:{claude:{provider:'claude-code',model:'claude-test'},codex:{provider:'openai',model:'gpt-test'}}};}
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
  assert.equal(trimmed.removedChars,text.length-trimmed.content.find(x=>x.type==='text').text.length,'measure net removal including the archive notice');
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
  live.guard.state().policy.autoFix=false; // This fixture checks the review-first pause; auto-fix would grow the slots instead.
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

// Task routing rules: preferred provider wins when eligible; model alias resolves against available models.
{
  const {cleanPolicy,decide,buildPlan,initialState}=require('./usage-guard');
  const policy=cleanPolicy({routingRules:[{match:'Translations',provider:'agy',model:'argon'}]});
  assert.deepEqual(policy.routingRules,[{match:'translations',provider:'agy',model:'argon'}]);
  assert.throws(()=>cleanPolicy({routingRules:[{match:'x',provider:'agy'}]}));
  assert.throws(()=>cleanPolicy({blockedProviders:['claude','codex','agy']}));
  const s=initialState();s.policy.usageMode='max';s.policy.providerOrder=['claude','codex','agy'];
  s.bindings={claude:{provider:'claude-code',model:'claude-sonnet-5'},agy:{provider:'antigravity',model:'gemini-3-8-flash'}};
  const t0=Date.now();
  s.observations=[{provider:'claude',windowId:'weekly',windowMinutes:10080,usedPercent:10,resetAt:new Date(t0+72*3600000).toISOString(),observedAt:new Date(t0).toISOString(),source:'manual'},
    {provider:'agy',windowId:'gemini:weekly',windowMinutes:10080,usedPercent:0,resetAt:new Date(t0+100*3600000).toISOString(),observedAt:new Date(t0).toISOString(),source:'manual'}];
  const plan=buildPlan(s,t0);
  const task={availableProviders:['claude','agy'],availableModels:['claude-code/claude-sonnet-5','antigravity/gemini-3-8-flash','antigravity/gemini-4-argon']};
  assert.equal(decide(plan,task,t0).provider,'claude','order wins without a rule');
  const ruled=decide(plan,{...task,preferredProvider:'agy',preferredModel:'argon'},t0);
  assert.equal(ruled.provider,'agy');assert.equal(ruled.binding.model,'gemini-4-argon');
  assert.equal(decide(plan,{...task,preferredProvider:'agy',currentProvider:'claude',continuation:true},t0).provider,'claude','continuations keep their provider');
  s.policy.blockedProviders=['agy'];
  assert.equal(decide(buildPlan(s,t0),{...task,preferredProvider:'agy'},t0).provider,'claude','a rule cannot reach a blocked provider');
  console.log('Routing rules and blocked providers passed');
}

// Several Pi windows: each state poll or request identifies its task; the count expires after two minutes.
(async()=>{
  const {createGuardServer}=require('./usage-guard-server');
  const os=require('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-windows-'));
  const server=createGuardServer({stateDir:dir,sync:false});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const get=async q=>(await fetch(base+'/api/state'+q)).json();
  assert.equal((await get('')).windows.active,0);
  await get('?task=aaaaaaaa11111111');await get('?task=bbbbbbbb22222222');await get('?task=aaaaaaaa11111111');
  const seen=await get('');
  assert.equal(seen.windows.active,2,'two distinct windows counted once each');
  assert.equal(seen.windows.slots,1,'default concurrency slot');
  await get('?task=not-a-task-id!');
  assert.equal((await get('')).windows.active,2,'invalid ids are ignored');
  await new Promise(r=>server.close(r));
  console.log('Window counting passed');
})().catch(e=>{console.error(e);process.exit(1);});

// Feedback loop: renewals after request-budget pauses raise the budget one step; undo restores it;
// a bridge that cannot compact gets an advisory ceiling; native insights do not tune Pi without Pi evidence.
{
  const {recordLesson,learn,undo,learningView,REQUEST_STEPS}=require('./guard-learning');
  const {cleanPolicy,decide,buildPlan,initialState}=require('./usage-guard');
  const {buildAdvice}=require('./guard-advisor');
  const t0=Date.now();const s=initialState();
  const quota=(provider,windowId,used,hours)=>({provider,windowId,windowMinutes:10080,usedPercent:used,resetAt:new Date(t0+hours*3600000).toISOString(),observedAt:new Date(t0).toISOString(),source:'manual'});
  s.bindings={claude:{provider:'claude-code',model:'claude-test'},agy:{provider:'antigravity',model:'gemini-4-argon'}};
  s.observations=[quota('claude','weekly',10,72),quota('agy','gemini:weekly',0,100)];
  for(let i=0;i<2;i++){recordLesson(s,{kind:'pause',code:'request-budget',taskId:'t'+i,provider:'claude'},t0-3600000*(i+1));recordLesson(s,{kind:'renew',taskId:'t'+i,provider:'claude'},t0-3600000*(i+1)+60000);}
  assert.equal(learn(s,t0).length,1);assert.equal(s.policy.maxRequestsPerTask,REQUEST_STEPS[1],'one step up after two renewed pauses');
  assert.equal(learn(s,t0).length,0,'the same evidence is not counted twice');
  const id=learningView(s,t0).adjustments[0].id;undo(s,id,t0);assert.equal(s.policy.maxRequestsPerTask,40,'undo restores the previous value');
  assert.throws(()=>undo(s,id,t0));
  const plan=buildPlan(s,t0);
  const task={availableProviders:['claude','agy'],availableModels:['claude-code/claude-test','antigravity/gemini-4-argon'],contextTokens:150000};
  assert.equal(decide(plan,task,t0).action,'compact','Pi-held history is compacted');
  const onBridge=decide(plan,{...task,preferredProvider:'agy'},t0);
  assert.equal(onBridge.action,'continue');assert.ok(onBridge.contextAdvisory,'bridge route gets a warning instead of a dead-end compaction');
  s.policy=cleanPolicy({...s.policy,contextAdvisoryProviders:[]});
  recordLesson(s,{kind:'pause',code:'context-stuck',taskId:'t9',provider:'agy',providerId:'antigravity'},t0);
  learn(s,t0);assert.deepEqual(s.policy.contextAdvisoryProviders,['antigravity'],'a stuck compaction teaches the advisory ceiling');
  const n=initialState();n.insights={generatedAt:new Date(t0).toISOString(),providers:[{provider:'claude',requests:500,metrics:[{id:'context',percent:97},{id:'subagents',percent:92}]}]};
  const advice=buildAdvice(n,t0);assert.equal(advice.changes.maxContextTokens,undefined,'native large contexts do not clamp Pi without Pi evidence');
  n.tasks={x:{startedAt:new Date(t0).toISOString(),contextTokens:160000}};
  assert.equal(buildAdvice(n,t0).changes.maxContextTokens,80000,'Pi evidence of large contexts still tightens');
  console.log('Feedback loop, advisory ceiling and harness-scoped tuning passed');
}

// Auto-fix: a tripped work budget renews itself and the request continues; with autoFix off it pauses.
(async()=>{
  const {createGuardServer}=require('./usage-guard-server');
  const os=require('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-autofix-'));
  const server=createGuardServer({stateDir:dir,sync:false});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();};
  const t0=Date.now();
  await post('/api/observations',{observations:[{provider:'claude',windowId:'weekly',windowMinutes:10080,usedPercent:10,resetAt:new Date(t0+72*3600000).toISOString(),observedAt:new Date(t0).toISOString(),source:'manual'}]});
  await post('/api/models',{models:[{group:'claude',provider:'claude-code',id:'claude-test',auth:'subscription'}]});
  await post('/api/policy',{maxRequestsPerTask:2,usageMode:'max'});
  const q={taskId:'autofix-task-0001',availableProviders:['claude'],availableModels:['claude-code/claude-test'],contextTokens:1000};
  for(let i=0;i<2;i++){const d=await post('/api/preflight',q);assert.equal(d.action,'continue');await post('/api/complete',{taskId:q.taskId,leaseId:d.leaseId,totalTokens:10,removedChars:0});}
  const third=await post('/api/preflight',q);
  assert.equal(third.action,'continue','budget renewed automatically');assert.equal(third.autoFixed,'request-budget');
  await post('/api/complete',{taskId:q.taskId,leaseId:third.leaseId,totalTokens:10,removedChars:0});
  const learned=(await (await fetch(base+'/api/state')).json()).learning;
  assert.ok(learned.lessons.some(l=>l.kind==='renew' && l.auto),'the auto renewal is recorded for learning');
  await post('/api/policy',{autoFix:false,maxRequestsPerTask:1});
  const fourth=await post('/api/preflight',q);
  assert.equal(fourth.action,'pause','with autoFix off the budget still pauses');
  await new Promise(r=>server.close(r));
  console.log('Auto-fix passed');
})().catch(e=>{console.error(e);process.exit(1);});

// Model fallback: an exhausted family window (Argon) falls through to another model on the same subscription
// before the next subscription; with the option off the task pauses.
(async()=>{
  const {createGuardServer}=require('./usage-guard-server');
  const os=require('node:os');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-fallback-'));
  const server=createGuardServer({stateDir:dir,sync:false});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const post=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();};
  const t0=Date.now(),iso=h=>new Date(t0+h*3600000).toISOString(),at=new Date(t0).toISOString();
  await post('/api/observations',{observations:[
    {provider:'agy',windowId:'gemini-argon:weekly',windowMinutes:10080,usedPercent:100,resetAt:iso(100),observedAt:at,source:'manual',modelFamily:'gemini-argon'},
    {provider:'agy',windowId:'gemini:weekly',windowMinutes:10080,usedPercent:20,resetAt:iso(100),observedAt:at,source:'manual',modelFamily:'gemini'},
    {provider:'codex',windowId:'codex:primary',windowMinutes:10080,usedPercent:50,resetAt:iso(20),observedAt:at,source:'manual'}]});
  await post('/api/models',{models:[{group:'agy',provider:'antigravity',id:'gemini-4-argon',auth:'subscription'},{group:'agy',provider:'antigravity',id:'gemini-4-hydrogen',auth:'subscription'},{group:'codex',provider:'openai-codex',id:'gpt-test',auth:'subscription'}]});
  await post('/api/binding',{group:'agy',provider:'antigravity',model:'gemini-4-argon'});
  await post('/api/policy',{usageMode:'max',providerOrder:['agy','codex','claude']});
  const q={taskId:'fallback-task-0001',availableProviders:['agy','codex'],availableModels:['antigravity/gemini-4-argon','antigravity/gemini-4-hydrogen','openai-codex/gpt-test'],contextTokens:1000};
  const d=await post('/api/preflight',q);
  assert.equal(d.action,'continue');assert.equal(d.provider,'agy');assert.equal(d.binding.model,'gemini-4-hydrogen','Argon empty, Hydrogen on the same subscription takes over');
  assert.equal(d.autoFixed,'model-fallback');
  await post('/api/complete',{taskId:q.taskId,leaseId:d.leaseId,totalTokens:10,removedChars:0});
  const st=await (await fetch(base+'/api/state')).json();
  assert.equal(st.providers.find(p=>p.provider==='agy').binding.model,'gemini-4-hydrogen','the switch is visible as the new binding');
  await post('/api/binding',{group:'agy',provider:'antigravity',model:'gemini-4-argon'});
  await post('/api/policy',{fallbackModels:false});
  assert.equal((await post('/api/preflight',{...q,availableModels:['antigravity/gemini-4-argon']})).action,'pause','without fallback and without other routes the task pauses');
  await new Promise(r=>server.close(r));
  console.log('Model fallback passed');
})().catch(e=>{console.error(e);process.exit(1);});
