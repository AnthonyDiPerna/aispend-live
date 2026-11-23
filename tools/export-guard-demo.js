// Build a static, browser-only playground from the same policy, optimizer, and UI as the controller.
// Never reads local usage, auth, task state, or machine paths.
const fs=require('node:fs');
const path=require('node:path');
const {demoState,demoModels}=require('./usage-guard-server');
const {COVERAGE}=require('./guard-native');
const root=path.resolve(__dirname,'..');
const policy=fs.readFileSync(path.join(__dirname,'usage-guard.js'),'utf8')
  .replace("const crypto = require('node:crypto');",'')
  .replace(/function signature\(value\)[^\n]*/, '')
  .replace('module.exports =','globalThis.GuardPolicy =').replace('trimToolOutput, signature,','trimToolOutput,');
const adapter=`
const {initialState,cleanPolicy,buildPlan,mergeObservations,cleanCustomProvider,cleanCustomProviders}=GuardPolicy;
const {buildAdvice,applyAdvice}=GuardAdvice;
const {buildOptimizationPlan}=GuardOptimizer;
${demoState.toString()}
${demoModels.toString()}
let playgroundState=demoState();
playgroundState.bindings={claude:{provider:'claude-code',model:'example-claude-balanced'},codex:{provider:'openai',model:'example-codex-balanced'}};
applyAdvice(playgroundState);
function playgroundView(){
  const plan=buildPlan(playgroundState);
  return {demo:true,...plan,optimizer:buildOptimizationPlan(plan,playgroundState.insights),impact:GuardImpact.impactReport(playgroundState),harnesses:Object.entries(${JSON.stringify(COVERAGE)}).map(([id,value])=>({id,...value})),models:demoModels(),advice:buildAdvice(playgroundState),advisor:playgroundState.advisor,insights:playgroundState.insights,tasks:[],events:playgroundState.events};
}
async function playgroundApi(route,body){
  if(route==='/api/state'||route==='/api/sync')return playgroundView();
  if(route==='/api/checkin'){const v=playgroundView();return {demo:true,generatedAt:new Date().toISOString(),recommendedProvider:v.recommendedProvider,optimizer:v.optimizer,windows:v.providers,collectors:{}};}
  if(route==='/api/simulate'){const simNow=Date.now()+Number(body.hours)*3600000;const simPlan=buildPlan(demoState(),simNow);return {demo:true,simulation:true,...simPlan,optimizer:buildOptimizationPlan(simPlan,playgroundState.insights,simNow)};}
  if(route==='/api/policy')playgroundState.policy=cleanPolicy({...playgroundState.policy,...body});
  else if(route==='/api/advice')applyAdvice(playgroundState,Date.now(),true);
  else if(route==='/api/binding'){
    const model=demoModels().find(m=>m.group===body.group && m.provider===body.provider && m.id===body.model);
    if(!model)throw Error('Choose one of the example models.');
    playgroundState.bindings[body.group]={provider:model.provider,model:model.id};
    playgroundState.events.push({at:new Date().toISOString(),kind:'example',detail:'Example selection changed for '+body.group+'. No account connected or model called.'});
  }
  else if(route==='/api/reset-credits'){
    if(!['claude','codex','agy'].includes(body.provider)||!Number.isInteger(body.count)||body.count<0||body.count>100||!['weekly','short','both','unknown'].includes(body.scope))throw Error('Invalid banked reset report');
    const expiry=body.expiresAt?new Date(body.expiresAt).toISOString():null;
    playgroundState.resetCreditReports ||= {};playgroundState.resetCreditReports[body.provider]={source:'manual',observedAt:new Date().toISOString(),scope:body.scope,availableCount:body.count,credits:Array.from({length:body.count},()=>({status:'available',expiresAt:expiry,expiryKnown:Boolean(expiry)}))};
  }
  else if(route==='/api/observations')playgroundState.observations=mergeObservations(playgroundState.observations,body.observations.map(o=>({...o,source:'demo'})));
  else if(route==='/api/custom-providers'){
    const list=Array.isArray(playgroundState.customProviders)?[...playgroundState.customProviders]:[];
    if(body&&(body.action==='remove'||body.remove)){const id=String(body.id||body.remove||'').trim().toLowerCase();playgroundState.customProviders=list.filter(c=>c.id!==id);}
    else if(body&&Array.isArray(body.customProviders)){playgroundState.customProviders=cleanCustomProviders(body.customProviders);}
    else{const item=cleanCustomProvider(body&&body.provider?body.provider:body);const idx=list.findIndex(c=>c.id===item.id);if(idx>=0)list[idx]=item;else list.push(item);playgroundState.customProviders=cleanCustomProviders(list);}
  }
  else throw Error('Public playground: model connections and requests are available only in the local controller.');
  applyAdvice(playgroundState);
  return playgroundView();
}
`;
const advice=fs.readFileSync(path.join(__dirname,'guard-advisor.js'),'utf8')
  .replace("const {cleanPolicy, buildPlan} = require('./usage-guard');",'const {cleanPolicy,buildPlan}=GuardPolicy;')
  .replace('module.exports =','globalThis.GuardAdvice =');
const impact=fs.readFileSync(path.join(__dirname,'guard-impact.js'),'utf8').replace('module.exports=','globalThis.GuardImpact=');
const optimizer=fs.readFileSync(path.join(__dirname,'subscription-optimizer.js'),'utf8');
const optimizerBundle='(function(){const module={exports:{}};const exports=module.exports;const require=id=>id==="./usage-guard"?GuardPolicy:{};\n'+optimizer+'\nglobalThis.GuardOptimizer=module.exports;})();';
const pkgVersion=require('../package.json').version;
let html=fs.readFileSync(path.join(__dirname,'usage-guard.html'),'utf8');
html=html.replace(/href="usage-guard\.css(?:\?v=[^"]*)?"/,'href="usage-guard.css?v='+pkgVersion+'"')
  .replace(/guard-walkthrough\.gif(?:\?v=[^"]*)?/g,'guard-walkthrough.gif?v='+pkgVersion)
  .replace('<title>AI Spend Guard','<title>Playground · AI Spend Guard')
  .replace('href="/"','href="index.html"')
  .replace('Demo data. This server cannot authorize model requests. Change the simulator clock without spending tokens.','Public playground · Synthetic readings. Changes stay in this tab and reset on reload. No accounts are connected and no model calls are possible.')
  .replace('Refresh allowances','Refresh playground')
  .replace('Connecting…','Loading playground…')
  .replace(/async function api\(route,body\)\{[^\n]+\}/,'async function api(route,body){return playgroundApi(route,body);}')
  .replace('<script>','<script>\n(function(){'+policy+'})();\n(function(){'+advice+'})();\n(function(){'+impact+'})();\n'+optimizerBundle+'\n'+adapter+'\n');
fs.mkdirSync(path.join(root,'public'),{recursive:true});
fs.writeFileSync(path.join(root,'public','guard.html'),html);
fs.copyFileSync(path.join(__dirname,'usage-guard.css'),path.join(root,'public','usage-guard.css'));
console.log('Exported public Guard playground (synthetic data only).');
