const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const {randomUUID} = require('node:crypto');
const {initialState, cleanPolicy, mergeObservations, buildPlan, decide, recoveryPlan, PROVIDERS} = require('./usage-guard');
const {createCollector,fetchClaudeUsage,fetchCodexUsage,fetchAgyUsage,readStatusFile}=require('./usage-collectors');
const {accounting,checkApiBudget}=require('./guard-accounting');
const {buildAdvice,applyAdvice,defaultBindings}=require('./guard-advisor');
const {recordImpact,attributeTrimReplay,impactReport}=require('./guard-impact');
const {nativeEvent,COVERAGE}=require('./guard-native');
const {Worker}=require('node:worker_threads');

const MAX_BODY = 128 * 1024;
const LEASE_MS = 15 * 60000;

function demoState(now = Date.now()) {
  const state = initialState();
  const settings = [['claude',82,86,48], ['codex',26.8,27,96], ['agy',15,16,24]];
  for (const [provider, earlier, used, resetHours] of settings) {
    for (const [minutesAgo, usedPercent] of [[60,earlier],[1,used]]) state.observations.push({provider,windowId:'weekly',windowMinutes:10080,usedPercent,
      resetAt:new Date(now+resetHours*3600000).toISOString(),observedAt:new Date(now-minutesAgo*60000).toISOString(),source:'demo'});
  }
  state.bindings = {claude:{provider:'claude-code',model:'demo-claude'},codex:{provider:'openai',model:'demo-codex'}};
  state.insights = {generatedAt:new Date(now).toISOString(),providers:[{provider:'claude',requests:45,totalTokens:900000,metrics:[
    {id:'context',percent:65,label:'Tokens in requests with >150k input context',action:'Checkpoint earlier.'},
    {id:'long',percent:55,label:'Tokens in sessions spanning 8+ hours',action:'Review a bounded handoff.'}]}]};
  state.impact={rows:[{id:'example-trim',taskId:'example-task',kind:'tool-trim',harness:'pi',at:new Date(now-60000).toISOString(),removedChars:36000,replayed:true,estimatedTokens:9000,billing:'subscription',usdLow:.0027,usdHigh:.027},
    ...['loop-block','repair','compact'].map(kind=>({id:'example-'+kind,taskId:'example-task',kind,harness:'pi',at:new Date(now).toISOString()}))],seen:[]};
  return state;
}

function demoModels() {
  return [['claude','claude-code'],['codex','openai'],['agy','google-antigravity'],['api','example-api']].flatMap(([group,provider])=>
    ['balanced','thorough'].map(tier=>({group,provider,id:`example-${group}-${tier}`,label:`${tier==='balanced'?'Balanced':'Deep reasoning'} example`,auth:group==='api'?'api':'subscription'})));
}

function readTail(file, size = 1024*1024) {
  const stat = fs.statSync(file), length = Math.min(size,stat.size);
  const buffer=Buffer.alloc(length), descriptor=fs.openSync(file,'r');
  try { fs.readSync(descriptor,buffer,0,length,stat.size-length); } finally {fs.closeSync(descriptor);}
  const lines=buffer.toString('utf8').split('\n');
  return stat.size>length ? lines.slice(1) : lines;
}

function codexObservations(raw, observedAt, now = Date.now()) {
  if (!raw || typeof raw !== 'object') return [];
  const result=[];
  for (const key of ['primary','secondary']) {
    const value=raw[key];
    if (!value || !Number.isFinite(value.used_percent) || !value.resets_at || !value.window_minutes) continue;
    // Preserve the actual window ID: primary is not always a five-hour limit.
    const reset=Number(value.resets_at);
    try { result.push(...mergeObservations([], [{provider:'codex',windowId:`${raw.limit_id || 'codex'}:${key}`,windowMinutes:value.window_minutes,
      usedPercent:value.used_percent,resetAt:new Date(reset<1e12?reset*1000:reset).toISOString(),observedAt,source:'codex-log'}], now)); } catch {}
  }
  return result;
}

function scanCodexLimits(root, now = Date.now()) {
  const files=[];
  for(let back=0;back<3;back++) {
    const date=new Date(now-back*86400000).toISOString().slice(0,10).split('-');
    const directory=path.join(root,...date);
    if (!fs.existsSync(directory)) continue;
    for(const entry of fs.readdirSync(directory,{withFileTypes:true})) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) {const file=path.join(directory,entry.name);files.push({file,mtime:fs.statSync(file).mtimeMs});}
    }
  }
  const rows=[];
  for(const {file} of files.sort((a,b)=>b.mtime-a.mtime).slice(0,16)) {
    for(const line of readTail(file)) {
      if (!line.includes('"rate_limits"')) continue;
      try { const record=JSON.parse(line); rows.push(...codexObservations(record.payload?.rate_limits, record.timestamp, now)); } catch {}
    }
  }
  return rows;
}

function createGuardServer(options={}) {
  const now=options.now || Date.now;
  const stateDir=options.stateDir || process.env.AI_SPEND_GUARD_DIR || path.join(os.homedir(),'.aispend-live','guard');
  const stateFile=path.join(stateDir,'state.json');
  fs.mkdirSync(stateDir,{recursive:true});
  let state=fs.existsSync(stateFile)?JSON.parse(fs.readFileSync(stateFile,'utf8')):options.demo?demoState(now()):initialState();
  cleanPolicy(state.policy);
  const leases=new Map(Object.entries(state.pendingRequests || {})), models=new Map();
  let lastSyncAt=null, syncError=null;
  const collectors={};
  const clients=new Set();
  let broadcast=()=>{};
  const save=()=>{state.pendingRequests=Object.fromEntries(leases);const temp=`${stateFile}.${process.pid}.tmp`;fs.writeFileSync(temp,JSON.stringify(state,null,2),{mode:0o600});fs.renameSync(temp,stateFile);broadcast();};
  const event=(kind,detail)=>{state.events.push({at:new Date(now()).toISOString(),kind,detail});state.events=state.events.slice(-100);};
  // Existing installations retain manual settings unless automatic tuning was enabled.
  if (state.policy.autoTune === undefined) { state.policy.autoTune = false; }
  const adapt=()=>{const result=applyAdvice(state,now());if(result){event('settings','Usage-based protection: '+result.reasons.join(' '));}return result;};
  const sync=()=>{
    if(options.demo) return;
    try {
      const root=options.codexRoot || process.env.CODEX_SESSIONS_ROOT || path.join(process.env.CODEX_HOME || path.join(os.homedir(),'.codex'),'sessions');
      state.observations=mergeObservations(state.observations,scanCodexLimits(root,now()),now());
      lastSyncAt=new Date(now()).toISOString();syncError=null;save();
    } catch {syncError='Could not read recent Codex limit snapshots. You can enter the provider reading manually.';}
  };
  function receive(provider,data) {
    const retired=new Set(data.retiredWindowIds || []);
    state.observations=mergeObservations(state.observations.filter(row=>row.provider!==provider || !retired.has(row.windowId)),data.observations,now());
    state.providerMeta ||= {};state.providerMeta[provider]={extraUsageEnabled:data.extraUsageEnabled ?? null,nativeSession:data.nativeSession || null};adapt();save();
  }
  if(!options.demo && options.sync!==false){
    for(const [provider,fetcher] of [['claude',options.fetchClaude || (()=>fetchClaudeUsage({now:now()}))],['codex',options.fetchCodex || (()=>fetchCodexUsage({now:now()}))],['agy',options.fetchAgy || (()=>fetchAgyUsage({now:now()}))]]){
      collectors[provider]=createCollector(provider,fetcher,{now,onData:data=>receive(provider,data),onStatus:()=>broadcast()});
    }
  }
  const refreshCollectors=()=>Promise.allSettled(Object.values(collectors).map(c=>c.refresh()));
  const publicState=()=>({demo:Boolean(options.demo),...buildPlan(state,now()),collectors:Object.fromEntries(Object.entries(collectors).map(([key,c])=>[key,c.view()])),providerMeta:state.providerMeta || {},
    accounting:accounting(state,leases,now()),impact:impactReport(state),insights:state.insights || null,reportedInsights:state.reportedInsights || {},advice:buildAdvice(state,now()),advisor:state.advisor || null,
    models:[...models.values()], tasks:Object.values(state.tasks).map(({id,requests,totalTokens,status,provider,updatedAt,removedChars,startedAt,contextTokens,thinkingLevel,subagentCalls,costEstimateUsd,unknownCostRequests})=>({id,requests,totalTokens,status,provider,updatedAt,removedChars,startedAt,contextTokens,thinkingLevel,subagentCalls,costEstimateUsd,unknownCostRequests})),
    harnesses:Object.entries(COVERAGE).map(([id,coverage])=>({id,...coverage,...state.harnesses?.[id]})),events:state.events, lastSyncAt,syncError});
  broadcast=()=>{if(!clients.size)return;const data='data: '+JSON.stringify(publicState())+'\n\n';for(const client of clients)if(client.writableLength>1024*1024){clients.delete(client);client.destroy();}else client.write(data);};
  function safeTaskId(id) {if(typeof id!=='string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(id)) throw new Error('Invalid task ID');return id;}
  async function body(req) {
    if(!String(req.headers['content-type']).startsWith('application/json')) throw new Error('JSON content type required');
    const chunks=[];let size=0;
    for await(const chunk of req){size+=chunk.length;if(size>MAX_BODY)throw new Error('Request too large');chunks.push(chunk);}
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  function reply(res,status,payload) {res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(payload));}
  const server=http.createServer(async(req,res)=>{
    try {
      const host=req.headers.host || '';
      if(!/^(127\.0\.0\.1|localhost):\d+$/.test(host)) return reply(res,403,{error:'Loopback host required'});
      if(req.headers.origin && ![`http://${host}`,`http://127.0.0.1:${server.address().port}`,`http://localhost:${server.address().port}`].includes(req.headers.origin)) return reply(res,403,{error:'Cross-origin requests rejected'});
      const url=new URL(req.url,`http://${host}`);
      if(req.method==='GET' && ['/guard-walkthrough.gif','/guard-walkthrough.json'].includes(url.pathname)){
        res.writeHead(200,{'Content-Type':url.pathname.endsWith('.gif')?'image/gif':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        return res.end(fs.readFileSync(path.join(__dirname,'../public',url.pathname.slice(1))));
      }
      if(req.method==='GET' && url.pathname==='/usage-guard.css') {
        res.writeHead(200,{'Content-Type':'text/css; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
        return res.end(fs.readFileSync(path.join(__dirname,'usage-guard.css')));
      }
      if(req.method==='GET' && ['/','/guard'].includes(url.pathname)) {
        res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff',
          'Content-Security-Policy':"default-src 'self'; img-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'"});
        return res.end(fs.readFileSync(path.join(__dirname,'usage-guard.html')));
      }
      if(req.method==='GET' && url.pathname==='/health') return reply(res,200,{ok:true,name:'ai-spend-guard',demo:Boolean(options.demo)});
      if(req.method==='GET' && url.pathname==='/api/state') return reply(res,200,publicState());
      if(req.method==='GET' && url.pathname==='/api/events'){
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Content-Type-Options':'nosniff'});
        clients.add(res);res.write('data: '+JSON.stringify(publicState())+'\n\n');req.on('close',()=>clients.delete(res));return;
      }
      if(req.method!=='POST') return reply(res,404,{error:'Not found'});
      const data=await body(req);
      if(url.pathname==='/api/observations') {
        if(!Array.isArray(data.observations) || data.observations.length>50) throw new Error('Expected up to 50 allowance observations');
        const incoming=data.observations.map(o=>({...o,source:options.demo?'demo':o.source==='provider'?'provider':'manual'}));
        state.observations=mergeObservations(state.observations,incoming,now());adapt();event('observation','Allowance readings updated.');save();
      } else if(url.pathname==='/api/provider-insights') {
        if(!['claude','codex','agy'].includes(data.provider) || !Number.isFinite(Date.parse(data.observedAt)) || Date.parse(data.observedAt)>now()+60000)throw Error('Invalid insight snapshot');
        const labels={subagentHeavy:'Usage from subagent-heavy sessions',largeContext:'Usage at >150k context',maxEffort:'Usage at max effort',longSessions:'Usage from sessions active 8+ hours',generalPurpose:'Usage from general-purpose subagents'};
        const metrics=[];for(const [id,label] of Object.entries(labels))if(typeof data.metrics?.[id]==='number' && data.metrics[id]>=0 && data.metrics[id]<=100)metrics.push({id,label,percent:data.metrics[id]});
        state.reportedInsights ||= {};state.reportedInsights[data.provider]={recordedAt:new Date(now()).toISOString(),source:'User-supplied native status / usage; original capture time unknown',metrics,
          contextTokens:Number.isFinite(data.contextTokens) && data.contextTokens>=0?data.contextTokens:null,
          referenceCostUsd:Number.isFinite(data.referenceCostUsd) && data.referenceCostUsd>=0?data.referenceCostUsd:null};save();
      } else if(url.pathname==='/api/policy') {
        state.policy=cleanPolicy({...state.policy,...data});adapt();event('policy','Work budgets and allowance reserve updated.');save();
      } else if(url.pathname==='/api/advice') {
        const result=applyAdvice(state,now(),true);
        if(result){event('settings','Applied usage recommendations: '+result.reasons.join(' '));save();}
      } else if(url.pathname==='/api/models') {
        if(!Array.isArray(data.models) || data.models.length>500) throw new Error('Invalid model list');
        for(const model of data.models) {
          if(!PROVIDERS.includes(model.group) || !['subscription','api'].includes(model.auth) || (model.group==='api')!==(model.auth==='api')) continue;
          if(!/^[a-zA-Z0-9_.:/-]{1,160}$/.test(model.provider) || !/^[a-zA-Z0-9_.:/-]{1,160}$/.test(model.id)) continue;
          const cost=model.cost && Object.fromEntries(['input','output','cacheRead','cacheWrite'].map(k=>[k,Number.isFinite(model.cost[k]) && model.cost[k]>=0?model.cost[k]:null]));
          models.set(`${model.provider}:${model.id}`,{group:model.group,provider:model.provider,id:model.id,auth:model.auth,cost,contextWindow:model.contextWindow,maxTokens:model.maxTokens});
        }
        const bindings=defaultBindings([...models.values()],state.bindings);
        if(JSON.stringify(bindings)!==JSON.stringify(state.bindings)){state.bindings=bindings;event('binding','Selected connected subscription models. Existing choices and API spending are unchanged.');save();}
      } else if(url.pathname==='/api/binding') {
        const model=models.get(`${data.provider}:${data.model}`);
        if(!model || model.group!==data.group) throw new Error('Select an authenticated model discovered by the Pi extension');
        state.bindings[data.group]={provider:data.provider,model:data.model};event('binding',`${data.group} model selected.`);save();
      } else if(url.pathname==='/api/sync') { sync();await refreshCollectors();
      } else if(url.pathname==='/api/native-event') {
        if(options.demo)return reply(res,403,{error:'Demo cannot guard native requests'});
        safeTaskId(data.taskId);const result=nativeEvent(state,data,now());save();return reply(res,200,result);
      } else if(url.pathname==='/api/intervention') {
        if(options.demo)return reply(res,403,{error:'Demo cannot record real interventions'});
        const id=safeTaskId(data.taskId);
        if(!state.tasks[id])throw Error('Unknown task');
        if(recordImpact(state,{...data,taskId:id,harness:'pi'},now())){
          if(data.kind==='tool-trim')state.tasks[id].removedChars+=(data.removedChars||0);
          if(data.kind==='compact')for(const row of state.impact.rows)if(row.taskId===id && row.kind==='tool-trim' && !row.replayed)row.discarded=true;
          event('protection',`${data.kind}: ${data.kind==='tool-trim'?data.removedChars+' net characters removed from context':'Guard enforced a work rule'}.`);save();
        }
      } else if(url.pathname==='/api/recovery') {
        if(options.demo)return reply(res,403,{error:'Demo cannot authorize recovery'});
        const id=safeTaskId(data.taskId),task=state.tasks[id];
        if(!task)throw Error('Unknown task');
        if([...leases.values()].some(l=>l.taskId===id))return reply(res,200,{action:'pause',code:'concurrency',reason:'Wait for the active request to finish.'});
        const plan=buildPlan(state,now());
        let decision=recoveryPlan(plan,{...task,currentProvider:data.currentProvider,continuation:true,repeatedTools:Number(data.repeatedTools)||0,
          contextTokens:Number(data.contextTokens)||0,availableProviders:data.availableProviders||[],availableModels:data.availableModels},now());
        if(decision.action==='repair' && decision.provider==='api')decision={...decision,...checkApiBudget(state,leases,id,models.get(decision.binding.provider+':'+decision.binding.model),plan.policy,now())};
        if(decision.action==='repair'){
          task.autoRepairs=decision.attempt;task.nextPhase='repair';
          recordImpact(state,{id:randomUUID(),taskId:id,kind:'repair',harness:'pi'},now());
          event('repair',decision.reason);
        }else event('pause',decision.reason);
        save();return reply(res,200,{...decision,policy:plan.policy});
      } else if(url.pathname==='/api/preflight' || url.pathname==='/api/readiness') {
        if(options.demo) return reply(res,403,{error:'Demo cannot authorize real model requests'});
        const id=safeTaskId(data.taskId);
        const task=state.tasks[id] || {id,requests:0,totalTokens:0,removedChars:0};
        const plan=buildPlan(state,now());
        let decision=decide(plan,{...task,...{
          currentProvider:data.currentProvider,continuation:Boolean(data.continuation),
          contextTokens:Number(data.contextTokens)||0,repeatedTools:Number(data.repeatedTools)||0,
          availableProviders:Array.isArray(data.availableProviders)?data.availableProviders:[],
          availableModels:Array.isArray(data.availableModels)?data.availableModels:undefined,
        }},now());
        if(['continue','switch'].includes(decision.action) && decision.provider==='api'){
          const budget=checkApiBudget(state,leases,id,models.get(decision.binding.provider+':'+decision.binding.model),plan.policy,now());
          decision={...decision,...budget};
        }
        if(url.pathname==='/api/readiness') {
          if(['continue','switch'].includes(decision.action) && [...leases.values()].filter(l=>l.expiresAt>now()).length>=plan.policy.maxConcurrentRequests) return reply(res,200,{action:'pause',code:'concurrency',policy:plan.policy});
          return reply(res,200,{...decision,policy:plan.policy});
        }
        if(['continue','switch'].includes(decision.action)) {
          // Expired leases still reserve dollars until reported; a crashed client cannot erase spend.
          if([...leases.values()].filter(l=>l.expiresAt>now()).length>=plan.policy.maxConcurrentRequests) return reply(res,200,{action:'pause',code:'concurrency',reason:'Other guarded requests are using the configured slots. Resume when a slot is free.',policy:plan.policy});
          const lease=randomUUID();leases.set(lease,{taskId:id,expiresAt:now()+LEASE_MS,billing:decision.provider==='api'?'api':'subscription',reserveUsd:decision.reserveUsd || 0,day:new Date(now()).toISOString().slice(0,10),
            model:models.get(decision.binding.provider+':'+decision.binding.model),phase:data.phase==='compact'?'compact':task.nextPhase||'work',
            trimIds:data.phase==='compact'?[]:(state.impact?.rows||[]).filter(r=>r.taskId===id&&r.kind==='tool-trim'&&!r.replayed&&!r.discarded).map(r=>r.id)});
          delete task.nextPhase;
          if(decision.action==='switch')recordImpact(state,{id:randomUUID(),taskId:id,kind:'switch'},now());
          task.startedAt ||= new Date(now()).toISOString();task.contextTokens=Number(data.contextTokens)||0;task.thinkingLevel=plan.policy.maxThinkingLevel;
          task.requests++;task.status='running';task.provider=decision.provider;decision.leaseId=lease;
          state.harnesses ||= {};state.harnesses.pi={lastSeenAt:new Date(now()).toISOString()};
        } else {task.status=decision.action;event(decision.action,`${decision.code}: ${decision.reason}`);if(decision.action==='pause')recordImpact(state,{id:randomUUID(),taskId:id,kind:'budget-pause'},now());}
        task.updatedAt=new Date(now()).toISOString();state.tasks[id]=task;save();
        return reply(res,200,{...decision,policy:plan.policy});
      } else if(url.pathname==='/api/complete') {
        const id=safeTaskId(data.taskId), lease=leases.get(data.leaseId), task=state.tasks[id];
        if(!lease || lease.taskId!==id || !task) throw new Error('Unknown or completed request');
        const tokens=Number(data.totalTokens), removed=Number(data.removedChars || 0);
        if(!Number.isFinite(tokens) || tokens<0 || tokens>100000000 || !Number.isFinite(removed) || removed<0) throw new Error('Invalid usage');
        const reported=typeof data.costEstimateUsd==='number' && Number.isFinite(data.costEstimateUsd) && data.costEstimateUsd>=0 && data.costEstimateUsd<100000;
        const usd=reported?data.costEstimateUsd:(lease.reserveUsd||0);
        state.costLedger ||= [];state.costLedger.push({taskId:id,billing:lease.billing || 'subscription',day:lease.day || new Date(now()).toISOString().slice(0,10),usd,unknown:!reported,phase:lease.phase||'work',at:new Date(now()).toISOString()});
        if(!data.failed && tokens>0)attributeTrimReplay(state,id,data.leaseId,lease.model,lease.billing,lease.trimIds);
        task.costEstimateUsd=(task.costEstimateUsd||0)+usd;task.unknownCostRequests=(task.unknownCostRequests||0)+(reported?0:1);
        leases.delete(data.leaseId);task.totalTokens+=tokens;task.removedChars+=removed;task.status=data.failed?'error':'ready';task.updatedAt=new Date(now()).toISOString();save();
      } else if(url.pathname==='/api/subagent') {
        const id=safeTaskId(data.taskId),task=state.tasks[id];
        if(!task || (task.subagentCalls||0)>=cleanPolicy(state.policy).maxSubagentCalls)return reply(res,200,{allowed:false,reason:'Subagent allowance reached. Guard defaults to no agent fan-out.'});
        task.subagentCalls=(task.subagentCalls||0)+1;save();return reply(res,200,{allowed:true});
      } else if(url.pathname==='/api/reset-task') {
        const id=safeTaskId(data.taskId);
        if([...leases.values()].some(l=>l.taskId===id)) throw new Error('Wait for the active request to finish');
        if(state.tasks[id]){const task=state.tasks[id];task.requests=0;task.totalTokens=0;task.subagentCalls=0;task.autoRepairs=0;delete task.nativePaused;task.nativeBlocked=[];task.nativeRepeats=0;task.startedAt=new Date(now()).toISOString();task.status='ready';event('budget','User renewed a task budget.');save();}
      } else if(url.pathname==='/api/simulate') {
        const hours=Number(data.hours || 0);
        if(!Number.isFinite(hours) || hours<0 || hours>336) throw new Error('Invalid simulation time');
        return reply(res,200,{demo:true,simulation:true,...buildPlan(demoState(now()),now()+hours*3600000)});
      } else return reply(res,404,{error:'Not found'});
      return reply(res,200,publicState());
    } catch(error) {reply(res,400,{error:error.message});}
  });
  let insightWorker,insightTimer;
  if(!options.demo && options.sync!==false && options.insights!==false){
    insightWorker=new Worker(path.join(__dirname,'usage-insights.js'),{workerData:{usageInsights:true}});
    insightWorker.on('message',data=>{if(data.insights){state.insights=data.insights;adapt();save();}});
    insightWorker.on('error',()=>{event('analysis','Local usage analysis unavailable.');});
    insightWorker.postMessage('refresh');insightTimer=setInterval(()=>insightWorker.postMessage('refresh'),5*60000);insightTimer.unref();
  }
  if(options.sync!==false){sync();void refreshCollectors();}
  const interval=options.sync===false?null:setInterval(()=>{sync();void refreshCollectors();},15000);
  const heartbeat=setInterval(()=>{for(const client of clients)client.write(': heartbeat\n\n');},20000);heartbeat.unref();
  interval?.unref();server.on('close',()=>{clearInterval(interval);clearInterval(heartbeat);clearInterval(insightTimer);insightWorker?.terminate();for(const client of clients)client.end();});
  server.guard={state:()=>state,view:publicState,sync};
  return server;
}

if(require.main===module) {
  const args=process.argv.slice(2), flag=name=>args.includes(name), value=(name,fallback)=>args.includes(name)?args[args.indexOf(name)+1]:fallback;
  const demo=flag('--demo'), port=Number(value('--port',demo?'9022':'9021'));
  const stateDir=value('--state-dir',process.env.AI_SPEND_GUARD_DIR || path.join(os.homedir(),'.aispend-live',demo?'guard-demo':'guard'));
  const server=createGuardServer({stateDir,demo,sync:!flag('--no-sync')});
  server.listen(port,'127.0.0.1',()=>console.log(`AI Spend Guard${demo?' DEMO':''}: http://127.0.0.1:${port}`));
}
module.exports={createGuardServer,scanCodexLimits,codexObservations,demoState,demoModels};
