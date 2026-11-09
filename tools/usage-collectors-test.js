const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {EventEmitter}=require('node:events');
const {PassThrough}=require('node:stream');
const {claudeUsage,codexUsage,agyUsage,fetchClaudeUsage,fetchCodexUsage,createCollector}=require('./usage-collectors');
const {sanitizeStatus}=require('./guard-statusline');
const {buildUsageInsights}=require('./usage-insights');
const {buildPlan,initialState,decide}=require('./usage-guard');
const {requestReserve,checkApiBudget}=require('./guard-accounting');
const NOW=Date.parse('2026-11-08T21:00:00Z'),RESET='2026-11-10T22:59:59.812319Z';
async function main(){
  const data=claudeUsage({five_hour:null,seven_day:{utilization:100,resets_at:RESET},limits:[{kind:'weekly_scoped',percent:41,resets_at:RESET,scope:{model:{display_name:'Fable'}}}],extra_usage:{is_enabled:false}},NOW);
  assert.equal(data.observations[0].resetAt,'2026-11-10T22:59:59.000Z');assert.deepEqual(data.retiredWindowIds,['session']);assert.equal(data.extraUsageEnabled,false);
  const state={...initialState(),observations:data.observations,bindings:{claude:{provider:'claude-code',model:'claude-fable-5-1'}}};
  assert.equal(buildPlan(state,NOW).providers[0].status,'reserve','unused scoped quota cannot override exhausted account quota');
  assert.throws(()=>claudeUsage({seven_day:null},NOW));
  assert.equal(codexUsage({rateLimits:{limitId:'codex',primary:{usedPercent:45,windowDurationMins:10080,resetsAt:Date.parse('2026-11-15T13:38:43Z')/1000}}},NOW).observations[0].windowMinutes,10080);
  const agy=agyUsage('Gemini Models\tWeekly Limit Remaining\t100%\t2026-11-15T20:00:00Z\nGemini 4 Argon\tGemini 4 Argon Weekly Limit\t87%\t2026-11-15T06:17:03Z',NOW);
  assert.equal(agy.observations[0].usedPercent,0);assert.equal(agy.observations[1].usedPercent,13);
  assert.throws(()=>agyUsage('Unexpected quota format',NOW));
  const sanitized=sanitizeStatus({email:'PRIVATE_EMAIL',cwd:'PRIVATE_PATH',session_id:'PRIVATE_SESSION',quota:{'gemini-weekly':{remaining_fraction:.87,reset_time:RESET}},cost:{total_usd:1.2}},'agy',NOW);
  assert.equal(sanitized.observations[0].usedPercent,13);assert.ok(!JSON.stringify(sanitized).includes('PRIVATE_'));
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'guard-collectors-'));
  try{
    fs.writeFileSync(path.join(root,'.credentials.json'),JSON.stringify({claudeAiOauth:{accessToken:'TEST_SECRET',expiresAt:NOW+60000}}));
    let calls=0;
    const fetchImpl=async(url,opts)=>{calls++;assert.equal(url,'https://api.anthropic.com/api/oauth/usage');assert.equal(opts.redirect,'error');assert.equal(opts.headers.Authorization,'Bearer TEST_SECRET');return new Response(JSON.stringify({seven_day:{utilization:100,resets_at:RESET}}));};
    const result=await fetchClaudeUsage({configDir:root,fetchImpl,now:NOW});assert.equal(calls,1);assert.ok(!JSON.stringify(result).includes('TEST_SECRET'));
    await assert.rejects(fetchClaudeUsage({configDir:root,now:NOW,fetchImpl:async()=>{throw Error('TEST_SECRET');}}),e=>!e.message.includes('TEST_SECRET'));
    let clock=NOW,attempts=0,reports=0;
    const collector=createCollector('claude',async()=>{attempts++;await Promise.resolve();if(attempts===1){const error=Error('rate limited');error.retryMs=600000;throw error;}return data;},{now:()=>clock,onData:()=>reports++});
    await Promise.all([collector.refresh(),collector.refresh()]);assert.equal(attempts,1);assert.equal(reports,0);
    clock+=300000;await collector.refresh();assert.equal(attempts,1,'respect backoff');clock+=300000;await collector.refresh();assert.equal(attempts,2);assert.equal(reports,1);
    const methods=[];
    const rpc=await fetchCodexUsage({now:NOW,spawnImpl:()=>{
      const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{};
      child.stdin.on('data',chunk=>{const msg=JSON.parse(chunk);methods.push(msg.method);queueMicrotask(()=>{if(msg.id===1)child.stdout.write('{"id":1,"result":{}}\n');if(msg.id===2)child.stdout.write(JSON.stringify({id:2,result:{rateLimits:{limitId:'codex',primary:{usedPercent:45,windowDurationMins:10080,resetsAt:Date.parse('2026-11-15T13:38:43Z')/1000}}}})+'\n');});});return child;
    }});
    assert.equal(rpc.observations[0].usedPercent,45);assert.deepEqual(methods,['initialize','initialized','account/rateLimits/read']);
  }finally{const resolved=path.resolve(root);if(resolved.startsWith(path.resolve(os.tmpdir())+path.sep) && path.basename(resolved).startsWith('guard-collectors-'))fs.rmSync(resolved,{recursive:true,force:true});}
  const plan=buildPlan(state,NOW);assert.equal(decide(plan,{startedAt:new Date(NOW-121*60000).toISOString()},NOW).code,'time-budget');
  const model={contextWindow:200000,maxTokens:4096,cost:{input:3,output:15,cacheRead:.3,cacheWrite:3.75}},policy={...plan.policy,allowApiSpend:true,apiDailyBudgetUsd:2,apiTaskBudgetUsd:2};
  assert.equal(requestReserve({contextWindow:100000},policy),null);
  const reserve=requestReserve(model,policy),leases=new Map([['pending',{billing:'api',taskId:'test-task',reserveUsd:reserve,day:'2026-11-08',expiresAt:NOW-100}]]);
  assert.equal(checkApiBudget(state,leases,'test-task',model,policy,NOW).code,'api-budget','expired unknown requests still reserve dollars');
  const insight=buildUsageInsights([{provider:'codex',sessionId:'one',timestampMs:NOW,totalTokens:200000,tokens:{inputTokens:200000,cachedInputTokens:180000},isSubagent:true,reasoningEffort:'ultra',costKnown:false}],[],NOW);
  assert.equal(insight.providers[1].metrics[1].percent,100);assert.equal(insight.providers[0].metrics[0].percent,null);
  const cachedContext=buildUsageInsights([{provider:'claude',sessionId:'cache-window',timestampMs:NOW,totalTokens:160010,tokens:{inputTokens:10000,cacheCreationInputTokens:20000,cacheCreation1hInputTokens:130000,outputTokens:10}}],[],NOW);
  assert.equal(cachedContext.providers[0].metrics[1].percent,100,'one-hour cache writes contribute to Claude input context');
  console.log('Collectors: native quota formats, auth privacy, RPC, backoff, scoped limits, cost reservations and insights passed');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
