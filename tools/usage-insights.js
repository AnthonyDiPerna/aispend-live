const {isMainThread,parentPort,workerData}=require('node:worker_threads');
function buildUsageInsights(events,sessions=[],now=Date.now()){
  const start=now-86400000,meta=new Map(sessions.map(s=>[`${s.provider}:${s.id}:${s.file}`,s]));
  const result=[];
  for(const provider of ['claude','codex','agy']){
    const rows=events.filter(e=>e.provider===provider && !e.syntheticThreadTotal && e.timestampMs>=start && e.timestampMs<=now);
    let tokens=0,subagent=0,large=0,effortKnown=0,maxEffort=0,long=0,cost=0,unknownCost=0,inputTokens=0,cachedInputTokens=0,fast=0,swarm=0;
    for(const e of rows){
      const n=Math.max(0,e.totalTokens||0),s=meta.get(`${e.provider}:${e.sessionId}:${e.file}`)||{},t=e.tokens||{};
      tokens+=n;if(e.isSubagent)subagent+=n;
      const input=(t.inputTokens||0)+(provider!=='codex'?(t.cacheReadInputTokens||0)+(t.cacheCreationInputTokens||0)+(t.cacheCreation1hInputTokens||0):0);
      inputTokens+=input;cachedInputTokens+=Math.min(input,Math.max(0,provider==='codex'?(t.cachedInputTokens||0):(t.cacheReadInputTokens||0)));
      if(input>150000)large+=n;
      const effort=String(e.reasoningEffort||'').toLowerCase();
      if(effort){effortKnown+=n;if(['max','ultra','xhigh'].includes(effort))maxEffort+=n;}
      const speed=String(e.serviceTier||e.speed||'').toLowerCase();
      if(['fast','ultrafast','priority'].includes(speed))fast+=n;
      if(provider==='agy' && (e.swarmId || s.swarmId || e.subagentKind==='swarm_worker' || s.subagentKind==='swarm_worker'))swarm+=n;
      if((s.durationMinutes||0)>=480 || (s.endMs||0)-(s.startMs||0)>=8*3600000)long+=n;
      if(e.costKnown)cost+=e.costUsd||0;else unknownCost+=n;
    }
    const pct=n=>tokens?Math.round(n/tokens*1000)/10:null;
    const metrics=[
      {id:'subagents',percent:pct(subagent),label:'Tokens in subagent requests',action:'Keep agent fan-out off for routine work.'},
      {id:'context',percent:pct(large),label:'Tokens in requests with >150k input context',action:'Compact at a milestone and start a fresh task when the scope changes.'},
      {id:'effort',percent:effortKnown?Math.round(maxEffort/effortKnown*1000)/10:null,coveragePercent:pct(effortKnown),label:'Max / ultra / xhigh effort, where recorded',action:'Default to medium; raise effort deliberately for difficult steps.'},
      {id:'long',percent:pct(long),label:'Tokens in sessions spanning 8+ hours',action:'Checkpoint at milestones. Wall-clock span includes idle time and is not evidence of continuous work.'},
      {id:'cache',percent:inputTokens?Math.round(cachedInputTokens/inputTokens*1000)/10:null,label:'Recorded input tokens read from cache',action:'Keep useful context stable across tool follow-ups; checkpoint irrelevant history. Cache reuse is not wasted input or a quota refund.'},
      {id:'fast',percent:pct(fast),label:'Tokens in /fast or ultrafast requests',action:'Reserve /fast and ultrafast for surplus windows or tight edit-test loops; turn off when weekly headroom is tight.'}
    ];
    if(provider==='agy'){
      metrics.push({id:'swarm',percent:pct(swarm),label:'Tokens in /swarm sessions',action:'Run /swarm (3-4 workers) when AGY headroom is healthy; scale workers down as weekly or 5h allowance tightens.'});
    }
    result.push({provider,requests:rows.length,totalTokens:tokens,inputTokens,cachedInputTokens,referenceCostUsd:cost,unknownCostTokenPercent:pct(unknownCost),metrics});
  }
  return {generatedAt:new Date(now).toISOString(),since:new Date(start).toISOString(),providers:result,
    basis:'Local recorded tokens, not provider quota weights. These characteristics overlap and do not add to 100%. Other devices and web chats are not included.'};
}
if(!isMainThread && workerData?.usageInsights){
  const {parseAllUsage}=require('./ai-spend-dashboard-server');
  let running=false;
  parentPort.on('message',async()=>{
    if(running)return;running=true;
    try{const sources=await parseAllUsage({days:1});const seen=new Set(),events=[];for(const s of sources)for(const e of s.events){const key=e.dedupeKey || `${e.provider}:${e.sessionId}:${e.turnIndex}:${e.timestampMs}:${e.totalTokens}`;if(!seen.has(key)){seen.add(key);events.push(e);}}parentPort.postMessage({insights:buildUsageInsights(events,sources.flatMap(s=>s.sessions||[]))});}
    catch{parentPort.postMessage({error:'Local usage analysis could not refresh. Previous insights remain dated.'});}
    finally{running=false;}
  });
}
module.exports={buildUsageInsights};
