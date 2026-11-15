'use strict';
// AI Spend Guard watchdog. Watches the local controller and the newest Pi session, and keeps an
// unattended run moving without a model: a quota wall returned as a reply is recorded as a
// depleted window, a dead controller is restarted, stale readings are refreshed, a Pi process
// that died mid-task is relaunched and told to continue. Only a stall it cannot classify goes to
// a cheap triage model (counts, kinds and timestamps only, never message text), and only what
// neither can fix becomes an ALERT line for a human or a watching session.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn,execFile}=require('node:child_process');
const {parseProviderRejection}=require('./guard-rejection');

const MINUTE=60000;
const DEFAULTS={
  url:process.env.AI_SPEND_GUARD_URL||'http://127.0.0.1:9021',
  intervalMs:30000,stallMinutes:12,staleMinutes:20,recentHours:6,
  triage:'haiku',relaunch:true,toast:true,cooldownMs:15*MINUTE,
  repo:path.resolve(__dirname,'..'),
  sessions:path.resolve(__dirname,'..','.guard-data','pi-agent','sessions'),
  alerts:path.resolve(__dirname,'..','.guard-data','controller','watchdog-alerts.jsonl'),
};
const SUBSCRIPTIONS=['claude','codex','agy'];

// ---- session reading -------------------------------------------------------------------------
function newestSession(root){
  if(!root || !fs.existsSync(root))return null;
  let best=null;
  const visit=dir=>{for(const name of fs.readdirSync(dir)){const file=path.join(dir,name);const st=fs.statSync(file);
    if(st.isDirectory())visit(file);else if(name.endsWith('.jsonl') && (!best || st.mtimeMs>best.mtimeMs))best={file,mtimeMs:st.mtimeMs};}};
  visit(root);
  return best && best.file;
}
function readTail(file,maxBytes=400000){
  const size=fs.statSync(file).size;
  const fd=fs.openSync(file,'r');
  try{const start=Math.max(0,size-maxBytes);const buf=Buffer.alloc(size-start);fs.readSync(fd,buf,0,buf.length,start);
    const lines=buf.toString('utf8').split('\n');if(start>0)lines.shift();
    return lines.map(l=>{try{return JSON.parse(l);}catch{return null;}}).filter(Boolean);}
  finally{fs.closeSync(fd);}
}
function sessionCwd(file){
  try{const first=fs.readFileSync(file,{encoding:'utf8',flag:'r'}).slice(0,2000).split('\n')[0];const head=JSON.parse(first);return head.type==='session'?head.cwd:null;}catch{return null;}
}
// A compact, text-free view of where the session stands.
function summarizeSession(entries,now=Date.now()){
  const messages=entries.filter(e=>e.type==='message' && e.message);
  const last=entries[entries.length-1];
  const lastAt=last?Date.parse(last.timestamp||last.message?.timestamp||0)||null:null;
  let lastAssistant=null,lastUserAt=null,unanswered=false;
  for(const e of messages){
    const m=e.message;const at=Date.parse(e.timestamp||m.timestamp||0)||null;
    if(m.role==='assistant'){const refusal=parseProviderRejection(m,now);
      lastAssistant={at,provider:m.provider,model:m.model,stopReason:m.stopReason,refusal:refusal||null,
        textLength:(m.content||[]).filter(p=>p&&p.type==='text').reduce((n,p)=>n+String(p.text||'').length,0),
        toolCalls:(m.content||[]).filter(p=>p&&p.type==='toolCall').length};
      unanswered=false;}
    else if(m.role==='user'){lastUserAt=at;unanswered=true;}
  }
  // Consecutive identical short assistant replies at the end are a loop, not progress.
  let identicalShortReplies=0,fingerprint=null;
  for(let i=messages.length-1;i>=0;i--){const m=messages[i].message;if(m.role!=='assistant')continue;
    const text=(m.content||[]).filter(p=>p&&p.type==='text').map(p=>p.text||'').join(' ').replace(/\d+/g,'#').trim();
    if(!text || text.length>300 || (m.content||[]).some(p=>p&&p.type==='toolCall'))break;
    if(fingerprint===null)fingerprint=text;if(text!==fingerprint)break;identicalShortReplies++;}
  const turnOpen=Boolean(unanswered || (lastAssistant && lastAssistant.stopReason==='toolUse' && lastAssistant.at===lastAt) || (last && last.type==='message' && last.message?.role==='toolResult'));
  return {entries:entries.length,lastAt,lastKind:last?(last.type==='message'?last.message.role:last.type):null,lastAssistant,lastUserAt,unanswered,identicalShortReplies,turnOpen};
}

// ---- classification --------------------------------------------------------------------------
// Returns findings in severity order. `fix` names the deterministic action; 'triage' asks the cheap
// model; 'alert' goes straight to a human.
function classify({state,controllerError,session,piRunning,now=Date.now(),options=DEFAULTS}){
  const findings=[];
  const recent=session && session.lastAt && now-session.lastAt<options.recentHours*3600000;
  if(controllerError){findings.push({code:'controller-down',fix:'restart',detail:`Controller unreachable: ${controllerError}`});return findings;}
  const providers=(state.providers||[]).filter(p=>SUBSCRIPTIONS.includes(p.provider));
  if(session && session.lastAssistant && session.lastAssistant.refusal && recent){
    const r=session.lastAssistant.refusal;
    const known=(state.providers||[]).find(p=>p.provider===r.group);
    const alreadyMarked=known && known.windows && known.windows.some(w=>w.windowId===r.observation.windowId && w.usedPercent>=100 && Date.parse(w.observedAt)>=session.lastAssistant.at-MINUTE);
    if(!alreadyMarked)findings.push({code:'refusal-reply',fix:'observe',observation:r.observation,detail:r.note});
  }
  if(session && session.identicalShortReplies>=3 && recent && !(session.lastAssistant && session.lastAssistant.refusal))
    findings.push({code:'looping-replies',fix:'triage',detail:`${session.identicalShortReplies} identical short replies in a row from ${session.lastAssistant?.provider||'?'}/${session.lastAssistant?.model||'?'}`});
  if(session && session.turnOpen && recent && now-session.lastAt>options.stallMinutes*MINUTE){
    if(piRunning===false)findings.push({code:'pi-gone-mid-task',fix:'relaunch',detail:`Pi is not running and the last turn is open (${Math.round((now-session.lastAt)/MINUTE)} min since the last entry)`});
    else findings.push({code:'stalled-turn',fix:'triage',detail:`Turn open for ${Math.round((now-session.lastAt)/MINUTE)} min with no new entry; last ${session.lastKind}${session.lastAssistant?` from ${session.lastAssistant.provider}/${session.lastAssistant.model} (${session.lastAssistant.stopReason})`:''}`});
  }
  for(const p of providers){
    if(!p.configured || p.status==='blocked')continue;
    const newest=Math.max(0,...(p.windows||[]).map(w=>Date.parse(w.observedAt)||0));
    const collector=state.collectors && state.collectors[p.provider];
    if(newest && now-newest>options.staleMinutes*MINUTE && (!collector || collector.status!=='refreshing'))
      findings.push({code:'stale-readings',fix:'sync',provider:p.provider,detail:`${p.provider} readings are ${Math.round((now-newest)/MINUTE)} min old${collector&&collector.error?` (${collector.error})`:''}`});
  }
  const usable=providers.filter(p=>p.configured && ['ready','pace','reserve'].includes(p.status));
  if(providers.length && !usable.length){
    const soonest=providers.flatMap(p=>(p.windows||[]).map(w=>Date.parse(w.resetAt)||Infinity)).filter(t=>t>now).sort()[0];
    findings.push({code:'all-depleted',fix:'alert',cooldownMs:60*MINUTE,detail:`No subscription has allowance (${providers.map(p=>p.provider+'='+p.status).join(', ')}). Soonest reset ${soonest?new Date(soonest).toLocaleString():'unknown'}.`});
  }
  const pauses=(state.events||[]).filter(e=>['pause','compact'].includes(e.kind) && now-Date.parse(e.at)<10*MINUTE);
  const counts=new Map();for(const e of pauses)counts.set(e.detail,(counts.get(e.detail)||0)+1);
  for(const [detail,n] of counts)if(n>=3)findings.push({code:'repeated-pause',fix:'triage',detail:`${n} pauses in 10 min: ${detail.split(':')[0]}`});
  return findings;
}

// ---- actions ---------------------------------------------------------------------------------
async function fetchJson(url,body){
  const res=await fetch(url,body?{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:undefined);
  if(!res.ok)throw new Error(`${res.status} ${await res.text().catch(()=>'')}`.trim());
  return res.json();
}
function run(cmd,args,{timeoutMs=120000,input}={}){
  return new Promise(resolve=>{const child=execFile(cmd,args,{timeout:timeoutMs,windowsHide:true,maxBuffer:4e6},(error,stdout,stderr)=>resolve({error,stdout:String(stdout||''),stderr:String(stderr||'')}));if(input){child.stdin.end(input);}});
}
function defaultActions(options){
  const repo=options.repo;
  const ps=['-NoProfile','-ExecutionPolicy','Bypass'];
  return {
    observe:obs=>fetchJson(options.url+'/api/observations',{observations:[obs]}),
    sync:()=>fetchJson(options.url+'/api/sync',{}),
    restart:()=>run('powershell.exe',[...ps,'-File',path.join(repo,'integrations','pi','Restart-Controller.ps1')]),
    reorder:order=>fetchJson(options.url+'/api/policy',{providerOrder:order}),
    piRunning:async()=>{
      if(process.platform!=='win32')return null;
      const r=await run('powershell.exe',[...ps,'-Command',"Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -match 'pi-coding-agent' -and $_.CommandLine -match 'cli' } | Measure-Object | Select-Object -ExpandProperty Count"],{timeoutMs:20000});
      if(r.error)return null;const n=parseInt(r.stdout.trim(),10);return Number.isFinite(n)?n>0:null;
    },
    relaunch:(project,prompt)=>{
      // A new console window running the launcher, resumed and unattended, with the continuation prompt.
      const launcher=path.join(repo,'integrations','pi','Start-Guard.ps1');
      const child=spawn('cmd.exe',['/c','start','AI Spend Guard (relaunched by watchdog)','powershell.exe',...ps,'-File',launcher,'-ProjectPath',project,'-Resume','-Unattended','-Prompt',prompt],{detached:true,stdio:'ignore',windowsHide:false});
      child.unref();return Promise.resolve({started:true});
    },
    // Cheap triage: structured facts only. The verdict is one word so a wrong answer cannot do much.
    triage:async facts=>{
      if(!options.triage || options.triage==='off')return {verdict:'needs-human',why:'triage off'};
      const prompt=`You are the triage step of a local AI usage guard. A coding-agent session appears stuck. Facts (JSON, no message text):\n${JSON.stringify(facts)}\n\nReply with exactly one word from: reroute (move the current provider to the end of the priority order), restart (restart the local controller), relaunch (start the agent again and tell it to continue), needs-human. Then one short sentence why.`;
      const r=await run('claude',['-p','--model',options.triage,'--output-format','text','--max-turns','1','--',prompt],{timeoutMs:90000});
      const text=(r.stdout||'').trim();
      const verdict=(/\b(reroute|restart|relaunch|needs-human)\b/i.exec(text)||[,'needs-human'])[1].toLowerCase();
      return {verdict,why:text.slice(0,200)||r.error?.message||''};
    },
    toast:(title,text)=>run('powershell.exe',[...ps,'-Command',`[void][reflection.assembly]::LoadWithPartialName('System.Windows.Forms');$n=New-Object System.Windows.Forms.NotifyIcon;$n.Icon=[System.Drawing.SystemIcons]::Warning;$n.Visible=$true;$n.ShowBalloonTip(15000,'${title.replace(/'/g,"''")}','${text.replace(/'/g,"''").slice(0,250)}','Warning');Start-Sleep -Seconds 16;$n.Dispose()`],{timeoutMs:30000}),
  };
}

// ---- the loop --------------------------------------------------------------------------------
function createWatchdog(opts={}){
  const options={...DEFAULTS,...opts};
  const actions={...defaultActions(options),...(opts.actions||{})};
  const log=opts.log||((line)=>console.log(`${new Date().toISOString().slice(11,19)} ${line}`));
  const lastActed=new Map();
  const history=[];
  function cooled(code,ms){const at=lastActed.get(code)||0;return Date.now()-at>=ms;}
  async function alert(code,detail){
    const line=`ALERT ${code}: ${detail}`;log(line);
    try{fs.mkdirSync(path.dirname(options.alerts),{recursive:true});fs.appendFileSync(options.alerts,JSON.stringify({at:new Date().toISOString(),code,detail})+'\n');}catch{}
    if(options.toast){try{await actions.toast('AI Spend Guard',`${code}: ${detail}`);}catch{}}
  }
  async function tick(now=Date.now()){
    let state=null,controllerError=null;
    try{state=await fetchJson(options.url+'/api/state');}catch(error){controllerError=error.message;}
    const file=newestSession(options.sessions);
    const session=file?summarizeSession(readTail(file),now):null;
    const needPi=session && session.turnOpen && now-(session.lastAt||0)>options.stallMinutes*MINUTE;
    const piRunning=needPi?await actions.piRunning():undefined;
    const findings=classify({state:state||{},controllerError,session,piRunning,now,options});
    const acted=[];
    for(const f of findings){
      const cooldown=f.cooldownMs||options.cooldownMs;
      if(!cooled(f.code,cooldown))continue;
      lastActed.set(f.code,Date.now());
      log(`${f.code}: ${f.detail}`);
      try{
        if(f.fix==='observe'){await actions.observe(f.observation);acted.push(`${f.code}: marked ${f.observation.windowId} on ${f.observation.provider} exhausted until ${f.observation.resetAt}`);}
        else if(f.fix==='sync'){await actions.sync();acted.push(`${f.code}: asked the controller to refresh ${f.provider} readings`);}
        else if(f.fix==='restart'){await actions.restart();acted.push(`${f.code}: controller restarted`);}
        else if(f.fix==='relaunch'){
          if(!options.relaunch){await alert(f.code,f.detail+' (relaunch disabled)');continue;}
          const project=(file && sessionCwd(file))||options.project||process.cwd();
          await actions.relaunch(project,'Guard watchdog: the previous Pi process ended with this turn unfinished. Continue the last instruction from where the work stands; do not repeat finished steps.');
          acted.push(`${f.code}: relaunched Pi in ${project} with a continue prompt`);
        }
        else if(f.fix==='triage'){
          const facts={finding:f.code,detail:f.detail,session:session&&{lastKind:session.lastKind,minutesSinceLastEntry:Math.round((now-session.lastAt)/MINUTE),lastAssistant:session.lastAssistant&&{provider:session.lastAssistant.provider,model:session.lastAssistant.model,stopReason:session.lastAssistant.stopReason,textLength:session.lastAssistant.textLength,toolCalls:session.lastAssistant.toolCalls},identicalShortReplies:session.identicalShortReplies,piRunning},
            providers:(state.providers||[]).map(p=>({provider:p.provider,status:p.status,model:p.binding&&p.binding.model})),order:state.policy&&state.policy.providerOrder,
            recentEvents:(state.events||[]).slice(-12).map(e=>({at:e.at,kind:e.kind}))};
          const t=await actions.triage(facts);
          log(`triage ${t.verdict}: ${t.why}`);
          const current=session&&session.lastAssistant&&(({'claude-code':'claude',antigravity:'agy','antigravity-acp':'agy'})[session.lastAssistant.provider]||(state.providers||[]).find(p=>p.binding&&p.binding.provider===session.lastAssistant.provider)?.provider);
          if(t.verdict==='reroute' && current && state.policy){const order=[...state.policy.providerOrder.filter(p=>p!==current),current];await actions.reorder(order);acted.push(`${f.code}: triage moved ${current} to the end (${order.join('>')})`);}
          else if(t.verdict==='restart'){await actions.restart();acted.push(`${f.code}: triage restarted the controller`);}
          else if(t.verdict==='relaunch' && options.relaunch && piRunning===false){const project=(file && sessionCwd(file))||options.project||process.cwd();await actions.relaunch(project,'Guard watchdog: continue the last instruction from where the work stands.');acted.push(`${f.code}: triage relaunched Pi`);}
          else await alert(f.code,`${f.detail}. Triage: ${t.verdict}${t.why?' ('+t.why+')':''}`);
        }
        else await alert(f.code,f.detail);
      }catch(error){await alert(f.code,`${f.detail}. Fix failed: ${error.message}`);}
    }
    for(const a of acted)log('fixed '+a);
    history.push({at:new Date(now).toISOString(),findings:findings.map(f=>f.code),acted});
    if(history.length>200)history.shift();
    return {findings,acted,session,controllerError};
  }
  let timer;
  return {tick,start(){log(`watching ${options.url} and ${options.sessions} every ${options.intervalMs/1000}s`);void tick();timer=setInterval(()=>void tick(),options.intervalMs);return timer;},stop(){if(timer)clearInterval(timer);},history};
}

function parseArgs(argv){
  const o={};
  for(let i=0;i<argv.length;i++){const a=argv[i];const next=()=>argv[++i];
    if(a==='--once')o.once=true;else if(a==='--interval')o.intervalMs=Number(next())*1000;else if(a==='--stall-minutes')o.stallMinutes=Number(next());
    else if(a==='--url')o.url=next();else if(a==='--sessions')o.sessions=next();else if(a==='--project')o.project=next();
    else if(a==='--triage')o.triage=next();else if(a==='--no-triage')o.triage='off';else if(a==='--no-relaunch')o.relaunch=false;else if(a==='--no-toast')o.toast=false;}
  return o;
}
if(require.main===module){
  const o=parseArgs(process.argv.slice(2));
  const w=createWatchdog(o);
  if(o.once)w.tick().then(r=>{console.log(JSON.stringify({findings:r.findings.map(f=>f.code),acted:r.acted,controllerError:r.controllerError,session:r.session&&{lastKind:r.session.lastKind,turnOpen:r.session.turnOpen,lastAt:r.session.lastAt&&new Date(r.session.lastAt).toISOString()}},null,1));process.exit(0);});
  else w.start();
}
module.exports={createWatchdog,classify,summarizeSession,newestSession,readTail,sessionCwd,parseArgs,DEFAULTS};
