// Build a static, browser-only playground from the same policy and UI as the controller.
// Never reads local usage, auth, task state, or machine paths.
const fs=require('node:fs');
const path=require('node:path');
const {demoState}=require('./usage-guard-server');
const root=path.resolve(__dirname,'..');
const policy=fs.readFileSync(path.join(__dirname,'usage-guard.js'),'utf8')
  .replace("const crypto = require('node:crypto');",'')
  .replace(/function signature\(value\)[^\n]*/, '')
  .replace('module.exports =','globalThis.GuardPolicy =').replace('trimToolOutput, signature,','trimToolOutput,');
const adapter=`
const {initialState,cleanPolicy,buildPlan,mergeObservations}=GuardPolicy;
${demoState.toString()}
let playgroundState=demoState();
function playgroundView(){return {demo:true,...buildPlan(playgroundState),models:[],tasks:[],events:playgroundState.events};}
async function playgroundApi(route,body){
  if(route==='/api/state'||route==='/api/sync')return playgroundView();
  if(route==='/api/simulate')return {demo:true,simulation:true,...buildPlan(demoState(),Date.now()+Number(body.hours)*3600000)};
  if(route==='/api/policy')playgroundState.policy=cleanPolicy({...playgroundState.policy,...body});
  else if(route==='/api/observations')playgroundState.observations=mergeObservations(playgroundState.observations,body.observations.map(o=>({...o,source:'demo'})));
  else throw Error('Public playground: model connections and requests are available only in the local controller.');
  return playgroundView();
}
`;
let html=fs.readFileSync(path.join(__dirname,'usage-guard.html'),'utf8');
html=html.replace('<title>AI Spend Guard','<title>Playground · AI Spend Guard')
  .replace('href="/"','href="index.html"')
  .replace('Demo data. This server cannot authorize model requests. Change the simulator clock without spending tokens.','Public playground · Synthetic readings. Changes stay in this tab and reset on reload. No accounts are connected and no model calls are possible.')
  .replace('Refresh allowances','Refresh playground')
  .replace('Connecting…','Loading playground…')
  .replace(/async function api\(route,body\)\{[^\n]+\}/,'async function api(route,body){return playgroundApi(route,body);}')
  .replace('<script>','<script>\n(function(){'+policy+'})();\n'+adapter+'\n');
fs.mkdirSync(path.join(root,'public'),{recursive:true});
fs.writeFileSync(path.join(root,'public','guard.html'),html);
fs.copyFileSync(path.join(__dirname,'usage-guard.css'),path.join(root,'public','usage-guard.css'));
console.log('Exported public Guard playground (synthetic data only).');
