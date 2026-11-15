'use strict';
// The watchdog replays last night: quota walls returned as replies, a Pi process gone mid-task, a
// dead controller, stale readings. Every fix is a recorded stub; nothing is relaunched for real.
const assert=require('node:assert');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {createWatchdog,classify,summarizeSession}=require('./guard-watchdog');
const {createGuardServer}=require('./usage-guard-server');

const t0=Date.parse('2026-11-15T06:15:00.000Z');
const iso=ms=>new Date(ms).toISOString();
function writeSession(dir,entries){
  const sub=path.join(dir,'--H--devland-piharness--');fs.mkdirSync(sub,{recursive:true});
  const file=path.join(sub,'2026-11-15T06-00-00-000Z_test.jsonl');
  fs.writeFileSync(file,[{type:'session',version:3,id:'test',timestamp:iso(t0-900000),cwd:'H:\\devland\\piharness'},...entries].map(e=>JSON.stringify(e)).join('\n')+'\n');
  return file;
}
const user=(at,text)=>({type:'message',timestamp:iso(at),message:{role:'user',content:[{type:'text',text}],timestamp:at}});
const wall=at=>({type:'message',timestamp:iso(at),message:{role:'assistant',provider:'antigravity',model:'gemini-4-argon',stopReason:'stop',timestamp:at,content:[{type:'text',text:'⚠ Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 154h29m39s.'}],usage:{totalTokens:66235}}});
const work=(at,stop='stop')=>({type:'message',timestamp:iso(at),message:{role:'assistant',provider:'openai',model:'gpt-5.6-sol',stopReason:stop,timestamp:at,content:[{type:'text',text:'Done: railing moved behind the porch posts.'}],usage:{totalTokens:1200}}});

(async()=>{
  // Session summary: the refusal is seen, the open turn is seen.
  const s=summarizeSession([user(t0,'fix the railing - use codex'),wall(t0+1000),user(t0+2000,'switch to codex'),wall(t0+3000),wall(t0+4000)],t0+5000);
  assert.ok(s.lastAssistant.refusal,'last reply is a quota wall');assert.equal(s.identicalShortReplies,3);assert.equal(s.turnOpen,false,'the wall closed the turn');
  const open=summarizeSession([user(t0,'go'),work(t0+1000,'toolUse')],t0+2000);
  assert.equal(open.turnOpen,true,'a toolUse stop with nothing after it is an open turn');

  // A real controller with last night's state.
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'guard-wd-'));
  const server=createGuardServer({stateDir,sync:false});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url='http://127.0.0.1:'+server.address().port;
  const post=async(route,body)=>{const r=await fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return r.json();};
  const now=Date.now();
  await post('/api/observations',{observations:[
    {provider:'agy',windowId:'gemini-argon:weekly',windowMinutes:10080,usedPercent:40,resetAt:iso(now+150*3600000),observedAt:iso(now-60000),source:'manual',modelFamily:'gemini-argon'},
    {provider:'codex',windowId:'codex:primary',windowMinutes:10080,usedPercent:10,resetAt:iso(now+100*3600000),observedAt:iso(now-60000),source:'manual'}]});
  await post('/api/models',{models:[{group:'agy',provider:'antigravity',id:'gemini-4-argon',auth:'subscription'},{group:'codex',provider:'openai',id:'gpt-5.6-sol',auth:'subscription'}]});
  await post('/api/policy',{usageMode:'max',providerOrder:['agy','codex','claude']});

  const sessions=fs.mkdtempSync(path.join(os.tmpdir(),'guard-wd-sessions-'));
  const calls=[];const stub=name=>async(...a)=>{calls.push([name,...a]);return {};};
  const lines=[];
  const make=(extra={})=>createWatchdog({url,sessions,toast:false,cooldownMs:1000,log:l=>lines.push(l),
    actions:{observe:o=>post('/api/observations',{observations:[o]}),sync:stub('sync'),restart:stub('restart'),reorder:stub('reorder'),relaunch:stub('relaunch'),piRunning:async()=>extra.piRunning??true,triage:async facts=>{calls.push(['triage',facts]);return {verdict:extra.verdict||'needs-human',why:'test'};}}});

  // 1. Quota wall as a reply, written minutes ago: the window is marked exhausted and the next route leaves Argon.
  const recent=Date.now()-2*60000;
  writeSession(sessions,[user(recent-2000,'fix the railing - use codex'),wall(recent-1000),wall(recent)]);
  let r=await make().tick();
  assert.deepEqual(r.findings.map(f=>f.code),['refusal-reply']);
  assert.ok(r.acted[0].includes('gemini-argon:weekly'),'observation posted');
  const st=await (await fetch(url+'/api/state')).json();
  assert.equal(st.providers.find(p=>p.provider==='agy').status,'depleted');
  const d=await post('/api/preflight',{taskId:'wd-task-000000001',availableProviders:['agy','codex'],availableModels:['antigravity/gemini-4-argon','openai/gpt-5.6-sol'],contextTokens:10});
  assert.equal(d.provider,'codex','after the watchdog spoke, Codex takes the task');
  r=await make().tick();
  assert.ok(!r.findings.some(f=>f.code==='refusal-reply'),'an already recorded wall is not reported twice');

  // 2. Pi died with the turn open: relaunch with a continue prompt, in the session's own folder.
  const stale=Date.now()-20*60000;
  writeSession(sessions,[user(stale-5000,'finish the porch'),work(stale,'toolUse')]);
  r=await make({piRunning:false}).tick();
  assert.ok(r.findings.some(f=>f.code==='pi-gone-mid-task'),r.findings.map(f=>f.code).join());
  const relaunch=calls.find(c=>c[0]==='relaunch');assert.ok(relaunch);assert.equal(relaunch[1],'H:\\devland\\piharness');assert.match(relaunch[2],/continue the last instruction/i);

  // 3. Pi alive but silent: triage gets facts without any message text; needs-human becomes an ALERT.
  calls.length=0;lines.length=0;
  r=await make({piRunning:true}).tick();
  assert.ok(r.findings.some(f=>f.code==='stalled-turn'));
  const triage=calls.find(c=>c[0]==='triage');assert.ok(triage,'triage consulted');
  assert.ok(!JSON.stringify(triage[1]).includes('porch'),'no prompt text leaves the machine');
  assert.ok(lines.some(l=>l.startsWith('ALERT stalled-turn')),'unresolved stall is alerted');
  // 3b. A reroute verdict moves the stuck provider to the end.
  calls.length=0;
  r=await make({piRunning:true,verdict:'reroute'}).tick();
  const reorder=calls.find(c=>c[0]==='reorder');assert.ok(reorder);assert.equal(reorder[1][reorder[1].length-1],'codex','the silent provider goes last');

  // 4. Controller down: restart, nothing else.
  const down=createWatchdog({url:'http://127.0.0.1:9',sessions,toast:false,log:()=>{},actions:{restart:stub('restart'),piRunning:async()=>true}});
  calls.length=0;r=await down.tick();
  assert.deepEqual(r.findings.map(f=>f.code),['controller-down']);assert.ok(calls.some(c=>c[0]==='restart'));

  // 5. Stale readings ask for a refresh; all-depleted is an alert with a cooldown.
  const stateNow=await (await fetch(url+'/api/state')).json();
  const f=classify({state:{...stateNow,providers:stateNow.providers.map(p=>p.provider==='codex'?{...p,windows:p.windows.map(w=>({...w,observedAt:iso(Date.now()-40*60000)}))}:p)},session:null,now:Date.now()});
  assert.ok(f.some(x=>x.code==='stale-readings' && x.provider==='codex'));
  const g=classify({state:{...stateNow,providers:stateNow.providers.map(p=>({...p,status:p.provider==='claude'?p.status:'depleted'}))},session:null,now:Date.now()});
  assert.ok(g.some(x=>x.code==='all-depleted' && x.fix==='alert'));

  await new Promise(r=>server.close(r));
  fs.rmSync(stateDir,{recursive:true,force:true});fs.rmSync(sessions,{recursive:true,force:true});
  console.log('Watchdog: refusal walls, dead Pi relaunch, text-free triage, controller restart, stale and depleted readings passed');
})().catch(e=>{console.error(e);process.exit(1);});
