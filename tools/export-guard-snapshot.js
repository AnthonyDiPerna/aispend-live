#!/usr/bin/env node
// Export a sanitized snapshot of the local Guard controller for the public site.
// Output holds percentages, hashed task IDs, counters, model IDs and policy values only:
// no prompts, paths, account identity, or file names. Usage:
//   node tools/export-guard-snapshot.js [--url http://127.0.0.1:9021] [--state-dir <dir>] [--out public/guard-snapshot.json]
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {buildPlan}=require('./usage-guard');

function flag(name,fallback){const i=process.argv.indexOf(name);return i>=0?process.argv[i+1]:fallback;}
const HOUR=3600000;
const span=h=>!Number.isFinite(h)||h<0?null:h<1?Math.max(1,Math.round(h*60))+'m':h<48?Math.round(h)+'h':Math.round(h/24)+'d';

async function loadState(url,stateDir){
  if(url){
    try{const r=await fetch(new URL('/api/state',url),{signal:AbortSignal.timeout(5000)});if(r.ok)return {public:await r.json(),source:'controller'};}catch{}
  }
  const file=path.join(stateDir,'state.json');
  const raw=JSON.parse(fs.readFileSync(file,'utf8').replace(/^﻿/,''));
  const plan=buildPlan(raw,Date.now());
  return {public:{...plan,tasks:Object.values(raw.tasks||{}),events:raw.events||[],impact:raw.impact||{},insights:raw.insights||null,accounting:raw.accounting||{}},source:'state-file'};
}

// Footer text exactly as the Pi extension renders it, for the site example.
function footer(state,currentGroup){
  const labels={claude:'Claude',codex:'Codex',agy:'AGY'};
  const order=state.policy?.providerOrder||['claude','codex','agy'];
  const lowest=p=>p.windows.filter(w=>w.applies).sort((a,b)=>a.remainingPercent-b.remainingPercent)[0];
  const rows=order.map(id=>state.providers.find(p=>p.provider===id)).filter(Boolean).map(p=>({p,w:lowest(p)}));
  const cells=rows.map(({p,w})=>{
    const active=p.provider===currentGroup;
    let cell=(active?'▸':'')+labels[p.provider]+' '+(w?Math.max(0,w.remainingPercent).toFixed(0)+'%':'?');
    if(p.status==='depleted')cell+='∅';
    if(p.status==='blocked')cell+='⛔';
    if(active && w && Number.isFinite(w.slopePercentPerHour) && w.slopePercentPerHour>=0.1)cell+=' −'+(w.slopePercentPerHour<1?w.slopePercentPerHour.toFixed(1):Math.round(w.slopePercentPerHour))+'%/h';
    return cell;
  });
  const current=rows.find(r=>r.p.provider===currentGroup);
  const fallback=rows.find(r=>r.p.provider!==currentGroup && r.p.status==='ready' && r.w && r.w.remainingPercent>(state.policy?.reservePercent??10));
  const bridge=rows.find(r=>r.p.provider===state.policy?.bridgeProvider && r.p.provider!==currentGroup);
  let next='';
  if(current && ['depleted','stale','verify-reset','blocked'].includes(current.p.status))next=fallback?'switch to '+labels[fallback.p.provider]:'wait for a fresh reading';
  else if(current?.w && Number.isFinite(current.w.depletionHours) && current.w.depletionHours<current.w.hoursLeft)next=labels[current.p.provider]+' runs out in '+span(current.w.depletionHours)+(fallback?', then '+labels[fallback.p.provider]:'');
  else if(bridge?.w)next=labels[bridge.p.provider]+' resets in '+span(bridge.w.hoursLeft);
  else if(current?.w)next=labels[current.p.provider]+' resets in '+span(current.w.hoursLeft);
  return 'Guard · '+cells.join(' · ')+(next?' · next: '+next:'');
}

function sanitize(state,source){
  const now=Date.now();
  const providers=state.providers.filter(p=>p.provider!=='api').map(p=>{
    const rows=p.windows.filter(w=>w.applies).sort((a,b)=>a.remainingPercent-b.remainingPercent);
    const w=rows[0];
    return {provider:p.provider,status:p.status,blocked:p.status==='blocked',configured:Boolean(p.configured),
      model:p.binding?.model||null,remainingPercent:w?Math.round(Math.max(0,w.remainingPercent)):null,
      resetIn:w?span(w.hoursLeft):null,resetAt:w?.resetAt||null,burnPercentPerHour:w&&Number.isFinite(w.slopePercentPerHour)?Math.round(w.slopePercentPerHour*10)/10:null,
      runOutIn:w&&Number.isFinite(w.depletionHours)&&w.depletionHours<w.hoursLeft?span(w.depletionHours):null,
      windows:p.windows.map(x=>({id:x.windowId,remainingPercent:Math.round(Math.max(0,x.remainingPercent)),resetIn:span(x.hoursLeft),applies:Boolean(x.applies)}))};
  });
  const policy=state.policy||{};
  // Collapse bursts: the same intervention kind on the same task within two seconds counts once.
  const seen=new Map();const interventions={};
  const impactEvents=Array.isArray(state.impact?.events)?state.impact.events:[];
  if(!impactEvents.length && state.impact)for(const k of ['loopBlocks','subagentBlocks','repairs','switches'])if(state.impact[k])interventions[k]=state.impact[k];
  for(const e of impactEvents){const key=e.taskId+'|'+e.kind;const t=Date.parse(e.at);if(seen.has(key)&&Math.abs(seen.get(key)-t)<2000){seen.set(key,t);continue;}seen.set(key,t);interventions[e.kind]=(interventions[e.kind]||0)+1;}
  const tasks=(state.tasks||[]).map(t=>({id:String(t.id).slice(0,8),requests:t.requests||0,tokens:t.totalTokens||0,status:t.status,provider:t.provider||null,
    startedAt:t.startedAt||null,minutes:t.startedAt&&t.updatedAt?Math.round((Date.parse(t.updatedAt)-Date.parse(t.startedAt))/60000):null,contextTokens:t.contextTokens||null,trimmedChars:t.removedChars||0}));
  const events=(state.events||[]).slice(-40).map(e=>({at:e.at,kind:e.kind,detail:String(e.detail).replace(/[A-Za-z]:\\[^\s]+|\/[^\s]*\//g,'<path>').slice(0,220)}));
  const insights=state.insights?{since:state.insights.since,providers:(state.insights.providers||[]).map(p=>({provider:p.provider,requests:p.requests,totalTokens:p.totalTokens,
    cachePercent:p.inputTokens?Math.round(100*p.cachedInputTokens/p.inputTokens):null,metrics:(p.metrics||[]).map(m=>({id:m.id,label:m.label,percent:m.percent}))}))}:null;
  return {generatedAt:new Date(now).toISOString(),source,version:require('../package.json').version,
    policy:{usageMode:policy.usageMode,providerOrder:policy.providerOrder,blockedProviders:policy.blockedProviders||[],reservePercent:policy.reservePercent,maxRequestsPerTask:policy.maxRequestsPerTask,maxTaskMinutes:policy.maxTaskMinutes,maxContextTokens:policy.maxContextTokens,maxThinkingLevel:policy.maxThinkingLevel,maxSubagentCalls:policy.maxSubagentCalls,allowApiSpend:policy.allowApiSpend},
    recommendedProvider:state.recommendedProvider||null,footer:footer(state,state.recommendedProvider||undefined),providers,tasks,interventions,
    impact:{removedChars:state.impact?.removedChars||0,estimatedInputTokensAvoided:state.impact?.estimatedInputTokensAvoided||0,loopBlocks:state.impact?.loopBlocks||0},
    insights,events,
    note:'Sanitized local snapshot: percentages, hashed task prefixes, counters and model IDs. No prompts, files or account identity.'};
}

async function main(){
  const url=flag('--url',process.env.AI_SPEND_GUARD_URL||'http://127.0.0.1:9021');
  const stateDir=flag('--state-dir',process.env.AI_SPEND_GUARD_DIR||path.join(os.homedir(),'.aispend-live','guard'));
  const out=flag('--out',path.resolve(__dirname,'../public/guard-snapshot.json'));
  const {public:state,source}=await loadState(url,stateDir);
  const snapshot=sanitize(state,source);
  const text=JSON.stringify(snapshot,null,1);
  if(/[A-Za-z]:\\|\/Users\/|\/home\//.test(text))throw Error('Snapshot still contains a filesystem path');
  fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,text);
  console.log(`Wrote ${out} (${source}): ${snapshot.footer}`);
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exit(1);});
module.exports={sanitize,footer};
