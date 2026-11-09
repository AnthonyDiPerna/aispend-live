// Build a static, browser-only playground from the same policy and UI as the controller.
// Never reads local usage, auth, task state, or machine paths.
const fs=require('node:fs');
const path=require('node:path');
const {demoState,demoModels}=require('./usage-guard-server');
const root=path.resolve(__dirname,'..');
const policy=fs.readFileSync(path.join(__dirname,'usage-guard.js'),'utf8')
  .replace("const crypto = require('node:crypto');",'')
  .replace(/function signature\(value\)[^\n]*/, '')
  .replace('module.exports =','globalThis.GuardPolicy =').replace('trimToolOutput, signature,','trimToolOutput,');
const adapter=`
const {initialState,cleanPolicy,buildPlan,mergeObservations}=GuardPolicy;
const {buildAdvice,applyAdvice}=GuardAdvice;
${demoState.toString()}
${demoModels.toString()}
let playgroundState=demoState();
playgroundState.bindings={claude:{provider:'claude-code',model:'example-claude-balanced'},codex:{provider:'openai',model:'example-codex-balanced'}};
applyAdvice(playgroundState);
function playgroundView(){return {demo:true,...buildPlan(playgroundState),models:demoModels(),advice:buildAdvice(playgroundState),advisor:playgroundState.advisor,insights:playgroundState.insights,tasks:[],events:playgroundState.events};}
async function playgroundApi(route,body){
  if(route==='/api/state'||route==='/api/sync')return playgroundView();
  if(route==='/api/simulate')return {demo:true,simulation:true,...buildPlan(demoState(),Date.now()+Number(body.hours)*3600000)};
  if(route==='/api/policy')playgroundState.policy=cleanPolicy({...playgroundState.policy,...body});
  else if(route==='/api/advice')applyAdvice(playgroundState,Date.now(),true);
  else if(route==='/api/binding'){
    const model=demoModels().find(m=>m.group===body.group && m.provider===body.provider && m.id===body.model);
    if(!model)throw Error('Choose one of the example models.');
    playgroundState.bindings[body.group]={provider:model.provider,model:model.id};
    playgroundState.events.push({at:new Date().toISOString(),kind:'example',detail:'Example selection changed for '+body.group+'. No account connected or model called.'});
  }
  else if(route==='/api/observations')playgroundState.observations=mergeObservations(playgroundState.observations,body.observations.map(o=>({...o,source:'demo'})));
  else throw Error('Public playground: model connections and requests are available only in the local controller.');
  applyAdvice(playgroundState);
  return playgroundView();
}
`;
const advice=fs.readFileSync(path.join(__dirname,'guard-advisor.js'),'utf8')
  .replace("const {cleanPolicy, buildPlan} = require('./usage-guard');",'const {cleanPolicy,buildPlan}=GuardPolicy;')
  .replace('module.exports =','globalThis.GuardAdvice =');
let html=fs.readFileSync(path.join(__dirname,'usage-guard.html'),'utf8');
html=html.replace('<title>AI Spend Guard','<title>Playground · AI Spend Guard')
  .replace('href="/"','href="index.html"')
  .replace('Demo data. This server cannot authorize model requests. Change the simulator clock without spending tokens.','Public playground · Synthetic readings. Changes stay in this tab and reset on reload. No accounts are connected and no model calls are possible.')
  .replace('Refresh allowances','Refresh playground')
  .replace('Connecting…','Loading playground…')
  .replace(/async function api\(route,body\)\{[^\n]+\}/,'async function api(route,body){return playgroundApi(route,body);}')
  .replace('<script>','<script>\n(function(){'+policy+'})();\n(function(){'+advice+'})();\n'+adapter+'\n');
fs.mkdirSync(path.join(root,'public'),{recursive:true});
fs.writeFileSync(path.join(root,'public','guard.html'),html);
fs.copyFileSync(path.join(__dirname,'usage-guard.css'),path.join(root,'public','usage-guard.css'));
console.log('Exported public Guard playground (synthetic data only).');
