const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {initialState,buildPlan,recoveryPlan,decide,cleanPolicy}=require('./usage-guard');
const {recordImpact,attributeTrimReplay,impactReport}=require('./guard-impact');
const {nativeEvent}=require('./guard-native');
const {normalize,output,config,run,install}=require('./guard-hooks');
const {createGuardServer}=require('./usage-guard-server');
const now=Date.now();
function ready(){const s=initialState();for(const provider of ['claude','codex','agy']){s.bindings[provider]={provider,model:'test'};s.observations.push({provider,windowId:'weekly',windowMinutes:10080,usedPercent:20,observedAt:new Date(now).toISOString(),resetAt:new Date(now+86400000).toISOString(),source:'manual'});}return s;}
async function main(){
  const s=ready(),plan=buildPlan(s,now),task={requests:3,repeatedTools:3,availableProviders:['claude','codex'],availableModels:['codex/test']};
  assert.equal(decide(plan,{...task,repeatedTools:0},now).provider,'codex','unavailable preferred model falls through');
  assert.equal(recoveryPlan(plan,task,now).action,'repair');
  assert.equal(recoveryPlan(plan,{...task,autoRepairs:1},now).code,'repair-limit');
  assert.equal(recoveryPlan(plan,{...task,requests:40},now).code,'request-budget');
  assert.equal(recoveryPlan(plan,{...task,totalTokens:8000000},now).code,'token-budget');
  assert.equal(recoveryPlan(plan,{...task,startedAt:new Date(now-3600001).toISOString()},now).code,'time-budget');
  assert.equal(recoveryPlan(plan,{...task,availableProviders:[]},now).code,'allowance');
  assert.throws(()=>cleanPolicy({maxAutoRepairs:0.5}));
  const trim={id:'trim-event-1',taskId:'test-task',kind:'tool-trim',removedChars:4000};
  recordImpact(s,trim,now);recordImpact(s,trim,now);assert.equal(impactReport(s).events,1,'replayed telemetry is idempotent');
  assert.equal(impactReport(s).estimatedInputTokensAvoided,0,'no hypothetical future requests');
  attributeTrimReplay(s,'test-task','request-1',{cost:{input:3,cacheRead:.3}},'api',[trim.id]);
  attributeTrimReplay(s,'test-task','request-2',{cost:{input:3,cacheRead:.3}},'api',[trim.id]);
  let report=impactReport(s);assert.equal(report.estimatedInputTokensAvoided,1000);assert.equal(report.apiInputCostAvoided.high,.003);assert.equal(report.apiInputCostAvoided.low,.0003);assert.equal(report.subscriptionReferenceAvoided.high,0);
  recordImpact(s,{...trim,id:'trim-event-2'},now);attributeTrimReplay(s,'test-task','request-3',{},'subscription',['trim-event-2']);assert.equal(impactReport(s).unpricedReplays,1);
  for(const harness of ['claude','codex','agy']){
    const n=ready();let serial=0;
    const event=(event,extra={})=>nativeEvent(n,{harness,event,taskId:'native-task',eventId:'event-'+String(++serial).padStart(8,'0'),operation:'same-operation',result:'same-result',...extra},now);
    event('prompt');event('post-tool');event('post-tool');
    assert.equal(event('pre-tool').repair,true,harness+' repairs once');
    assert.equal(event('pre-tool').action,'pause',harness+' repeated repair stops');
    assert.equal(impactReport(n).repairs,1);assert.equal(impactReport(n).loopBlocks,2);
    assert.equal(impactReport(n).estimatedInputTokensAvoided,0,'native blocks do not invent token or dollar savings');
    assert.equal(event('prompt').action,'pause','new prompt does not reset limits');
    assert(config(harness));
    const wire=harness==='agy'?{conversationId:'private-session',lastUserInput:'PRIVATE',toolCall:{name:'run_command',args:{command:'SECRET'}},error:'failed'}:{session_id:'private-session',prompt:'PRIVATE',tool_name:'Bash',tool_input:{command:'SECRET'},tool_response:'same'};
    const payload=normalize(harness,'PreToolUse',wire);
    assert(!JSON.stringify(payload).includes('PRIVATE'));assert(!JSON.stringify(payload).includes('SECRET'));assert(!JSON.stringify(payload).includes('private-session'));
    const denied=await run(harness,'PreToolUse',wire,async()=>{throw Error('offline');});
    assert.equal(harness==='agy'?denied.decision:denied.hookSpecificOutput.permissionDecision,'deny');
  }
  assert.deepEqual(output('codex','PreModelRequest',{action:'pause'}),{},'diagnostic hooks never claim to stop a model');
  assert.equal(output('agy','PreInvocation',{action:'pause'}).terminationBehavior,'terminate');
  assert.equal(output('claude','PostToolBatch',{action:'pause'}).continue,false);
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guard-recovery-'));
  const server=createGuardServer({stateDir:path.join(temp,'state'),sync:false,now:()=>now});
  Object.assign(server.guard.state(),ready());
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const post=async(route,body)=>{const res=await fetch(`http://127.0.0.1:${server.address().port}`+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:res.status,...await res.json()};};
  try{
    const project=path.join(temp,'project');fs.mkdirSync(path.join(project,'.codex'),{recursive:true});fs.writeFileSync(path.join(project,'.codex/hooks.json'),JSON.stringify({hooks:{Stop:[{hooks:[{type:'command',command:'existing-hook'}]}]}}));
    const installed=install('codex',project);install('codex',project);const hooks=JSON.parse(fs.readFileSync(installed));assert.equal(hooks.hooks.Stop.length,2,'idempotent install preserves unrelated hooks');
    const q={taskId:'http-recovery',availableProviders:['claude'],availableModels:['claude/test']};
    const first=await post('/api/preflight',q);assert(first.leaseId);
    assert.equal((await post('/api/recovery',{...q,repeatedTools:3})).code,'concurrency');
    await post('/api/complete',{taskId:q.taskId,leaseId:first.leaseId,totalTokens:100});
    const repair=await post('/api/recovery',{...q,repeatedTools:3});assert.equal(repair.action,'repair');
    assert.equal(server.guard.state().tasks[q.taskId].requests,1,'repair never resets or spends a request by itself');
    assert.equal((await post('/api/recovery',{...q,repeatedTools:3})).code,'repair-limit');
    await post('/api/policy',{maxRequestsPerTask:1});assert.equal((await post('/api/preflight',q)).code,'request-budget');
    const persisted=JSON.parse(fs.readFileSync(path.join(temp,'state/state.json')));assert.equal(persisted.tasks[q.taskId].autoRepairs,1);
    assert.equal((await post('/api/native-event',{harness:'agy',event:'request',taskId:'agy-http-task',eventId:'native-http-event'})).action,'continue');
  }finally{await new Promise(resolve=>server.close(resolve));if(path.dirname(temp)===path.resolve(os.tmpdir())&&path.basename(temp).startsWith('guard-recovery-'))fs.rmSync(temp,{recursive:true,force:true});}
  console.log('Bounded recovery, savings attribution, native hook contracts/privacy and HTTP persistence passed');
}
main().catch(error=>{console.error(error);process.exitCode=1;});
