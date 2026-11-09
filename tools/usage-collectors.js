// Local allowance adapters. No inference, purchases, prompt uploads, or auth copying.
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {observation}=require('./usage-guard');
const CLAUDE_USAGE_URL='https://api.anthropic.com/api/oauth/usage';
const INTERVAL_MS=5*60000;

function isoReset(value) {
  const ms=typeof value==='number'?(value<1e12?value*1000:value):Date.parse(value);
  return Number.isFinite(ms)?new Date(Math.floor(ms/1000)*1000).toISOString():null;
}
function claudeUsage(payload,now=Date.now()) {
  const rows=new Map();
  const add=(id,minutes,used,reset,modelFamily)=>{
    if(typeof used!=='number' || !isoReset(reset))return;
    try{rows.set(id,observation({provider:'claude',windowId:id,windowMinutes:minutes,usedPercent:used,resetAt:isoReset(reset),observedAt:new Date(now).toISOString(),source:'claude-usage',...(modelFamily?{modelFamily}:{})},now));}catch{}
  };
  if(!payload || typeof payload!=='object')throw Error('Claude returned an unrecognized allowance response.');
  for(const [key,id,minutes,family] of [['five_hour','session',300],['seven_day','weekly',10080],['seven_day_opus','weekly:opus',10080,'opus'],['seven_day_sonnet','weekly:sonnet',10080,'sonnet'],['seven_day_fable','weekly:fable',10080,'fable']]) {
    const row=payload[key];if(row)add(id,minutes,row.utilization,row.resets_at,family);
  }
  for(const item of Array.isArray(payload.limits)?payload.limits:[]) {
    if(item.kind==='weekly_all')add('weekly',10080,item.percent,item.resets_at);
    else if(item.kind==='five_hour' || item.kind==='session')add('session',300,item.percent,item.resets_at);
    else if(item.kind==='weekly_scoped' && !item.scope?.surface) {
      const name=String(item.scope?.model?.id || item.scope?.model?.display_name || '').toLowerCase();
      const family=['opus','sonnet','haiku','fable'].find(f=>name.includes(f));
      if(family)add('weekly:'+family,10080,item.percent,item.resets_at,family);
    }
  }
  if(!rows.size)throw Error('Claude did not report a usable allowance window. Missing readings stay unknown.');
  return {observations:[...rows.values()],retiredWindowIds:Object.hasOwn(payload,'five_hour') && payload.five_hour===null && !rows.has('session')?['session']:[],
    extraUsageEnabled:typeof payload.extra_usage?.is_enabled==='boolean'?payload.extra_usage.is_enabled:null};
}

async function fetchClaudeUsage({configDir,fetchImpl=fetch,now=Date.now()}={}) {
  let auth;
  try {
    const directory=configDir || process.env.PI_CLAUDE_CODE_CONFIG_DIR || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(),'.claude');
    const file=path.join(directory,'.credentials.json');
    if(fs.statSync(file).size>256*1024)throw Error();
    auth=JSON.parse(fs.readFileSync(file,'utf8')).claudeAiOauth;
    if(typeof auth?.accessToken!=='string' || !auth.accessToken || /[\r\n]/.test(auth.accessToken))throw Error();
  } catch {throw Error('Claude CLI login is unavailable. Sign in with Claude Code to enable automatic readings.');}
  if(typeof auth.expiresAt==='number' && auth.expiresAt<=now)throw Error('Claude login needs refreshing. Open Claude Code or sign in again.');
  let response;
  try{response=await fetchImpl(CLAUDE_USAGE_URL,{headers:{Authorization:`Bearer ${auth.accessToken}`,'anthropic-beta':'oauth-2025-04-20','User-Agent':'AI-Spend-Guard/0.1 (local allowance reader)'},redirect:'error',signal:AbortSignal.timeout(15000)});}
  catch{throw Error('Claude allowance service is unreachable. The previous reading has not been refreshed.');}
  if(!response.ok){
    const error=Error(response.status===401 || response.status===403?'Claude allowance access needs a current Claude CLI login.':response.status===429?'Claude allowance refresh is rate limited; waiting before retrying.':`Claude allowance service returned HTTP ${response.status}.`);
    if(response.status===429){const retry=response.headers.get('retry-after');error.retryMs=Math.max(INTERVAL_MS,Math.min(24*3600000,Number(retry)*1000 || Date.parse(retry)-now || 0));}
    throw error;
  }
  const raw=await response.text();if(raw.length>128*1024)throw Error('Claude allowance response exceeded the size limit.');
  let payload;try{payload=JSON.parse(raw);}catch{throw Error('Claude allowance response was not valid JSON.');}
  return claudeUsage(payload,now);
}

function codexUsage(payload,now=Date.now()) {
  const snapshots=payload?.rateLimitsByLimitId?Object.values(payload.rateLimitsByLimitId):payload?.rateLimits?[payload.rateLimits]:[];
  const rows=[];
  for(const snapshot of snapshots)for(const which of ['primary','secondary']) {
    const row=snapshot?.[which];if(!row)continue;
    try{rows.push(observation({provider:'codex',windowId:`${snapshot.limitId || 'codex'}:${which}`,windowMinutes:row.windowDurationMins,usedPercent:row.usedPercent,resetAt:isoReset(row.resetsAt),observedAt:new Date(now).toISOString(),source:'codex-rpc'},now));}catch{}
  }
  if(!rows.length)throw Error('Codex did not report a usable subscription allowance.');
  return {observations:rows};
}

function codexCommand() {
  if(process.env.AI_SPEND_CODEX_COMMAND)return {command:process.env.AI_SPEND_CODEX_COMMAND,args:['app-server','--stdio']};
  if(process.platform==='win32'){
    const script=path.join(process.env.APPDATA || path.join(os.homedir(),'AppData','Roaming'),'npm','node_modules','@openai','codex','bin','codex.js');
    if(fs.existsSync(script))return {command:process.execPath,args:[script,'app-server','--stdio']};
  }
  return {command:'codex',args:['app-server','--stdio']};
}
function fetchCodexUsage({spawnImpl=spawn,command=codexCommand(),now=Date.now()}={}) {
  return new Promise((resolve,reject)=>{
    const child=spawnImpl(command.command,command.args,{windowsHide:true,stdio:['pipe','pipe','pipe'],env:process.env});
    let settled=false,buffer='';
    const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);child.stdin.end();child.kill();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(Error('Codex allowance check timed out.')),20000);
    child.on('error',()=>finish(Error('Could not start the local Codex allowance reader.')));
    child.on('close',()=>{if(!settled)finish(Error('Codex allowance reader exited before reporting limits.'));});
    child.stderr.on('data',()=>{}); // Never forward native auth diagnostics into a public payload.
    child.stdin.on('error',()=>{});
    const send=value=>child.stdin.write(JSON.stringify(value)+'\n');
    child.stdout.on('data',chunk=>{
      buffer+=chunk;if(buffer.length>2*1024*1024)return finish(Error('Codex allowance response exceeded the size limit.'));
      while(buffer.includes('\n')){
        const index=buffer.indexOf('\n'),line=buffer.slice(0,index);buffer=buffer.slice(index+1);let message;try{message=JSON.parse(line);}catch{continue;}
        if(message.id===1){if(message.error)return finish(Error('Codex initialization failed.'));send({method:'initialized'});send({id:2,method:'account/rateLimits/read'});}
        if(message.id===2){if(message.error)return finish(Error('Codex needs an active ChatGPT subscription login to read allowances.'));try{finish(null,codexUsage(message.result,now));}catch(error){finish(error);}}
      }
    });
    send({id:1,method:'initialize',params:{clientInfo:{name:'aispend_guard',title:'AI Spend Guard',version:'0.1.0'}}});
  });
}

function createCollector(provider,fetcher,{now=Date.now,intervalMs=INTERVAL_MS,onData=()=>{},onStatus=()=>{}}={}) {
  let status={provider,status:'starting',lastAttemptAt:null,lastSuccessAt:null,nextAttemptAt:null,error:null},running;
  async function refresh(){
    if(running)return running;if(status.nextAttemptAt && Date.parse(status.nextAttemptAt)>now())return;
    status={...status,status:'refreshing',lastAttemptAt:new Date(now()).toISOString()};onStatus({...status});
    running=(async()=>{
      try{const data=await fetcher();await onData(data);status={...status,status:'connected',lastSuccessAt:new Date(now()).toISOString(),nextAttemptAt:new Date(now()+intervalMs).toISOString(),error:null};}
      catch(error){status={...status,status:'unavailable',nextAttemptAt:new Date(now()+Math.max(intervalMs,error.retryMs||0)).toISOString(),error:error.message};}
      finally{running=undefined;onStatus({...status});}
    })();return running;
  }
  return {refresh,view:()=>({...status})};
}
function readStatusFile(provider,stateDir,now=Date.now()){
  const file=path.join(stateDir,provider+'-status.json');
  if(!fs.existsSync(file))throw Error(`Waiting for ${provider==='agy'?'Antigravity':'Claude'} status-line feed. Start the connected CLI to send readings.`);
  if(fs.statSync(file).size>128*1024)throw Error('Status snapshot exceeded the size limit.');
  const data=JSON.parse(fs.readFileSync(file,'utf8'));
  if(now-Date.parse(data.observedAt)>10*60000)throw Error('Native status feed is inactive. Refresh /usage in the connected CLI.');
  if(!Array.isArray(data.observations) || !data.observations.length)throw Error('Native CLI has not reported a usable quota percentage and reset yet.');
  return {observations:data.observations.filter(o=>o.provider===provider).map(o=>observation(o,now)),nativeSession:data.session};
}
function agyUsage(report,now=Date.now()){
  const observations=[];
  for(const line of String(report).split(/\r?\n/)){
    const [name,label,remaining,reset]=line.split('\t');
    if(!name || !label || !/^\d+(?:\.\d+)?%$/.test(remaining||'') || !isoReset(reset))continue;
    const minutes=/week/i.test(label)?10080:/five.?hour|5.?hour/i.test(label)?300:null;if(!minutes)continue;
    const family=/argon/i.test(name)?'gemini-argon':/gemini/i.test(name)?'gemini':/claude|gpt/i.test(name)?'claude-gpt':null;
    if(!family)continue;
    observations.push(observation({provider:'agy',windowId:`${family}:${minutes===300?'session':'weekly'}`,windowMinutes:minutes,usedPercent:100-Number(remaining.slice(0,-1)),resetAt:isoReset(reset),observedAt:new Date(now).toISOString(),source:'agy-cli',modelFamily:family},now));
  }
  if(!observations.length)throw Error('Antigravity did not return recognized percentages and reset times.');
  return {observations};
}
function fetchAgyUsage({spawnImpl=spawn,now=Date.now(),command=process.env.AI_SPEND_AGY_COMMAND || (process.platform==='win32'?path.join(process.env.LOCALAPPDATA || path.join(os.homedir(),'AppData','Local'),'agy','bin','agy.exe'):'agy')}={}){
  return new Promise((resolve,reject)=>{
    // /usage is handled by the native CLI, not sent as a prompt. Keep expansion on.
    const child=spawnImpl(command,['--print','/usage','--settings',JSON.stringify({disableSlashCommands:false,useG1Credits:false}),'--print-timeout','20s'],{windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output='',done=false;
    const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);child.kill();error?reject(error):resolve(value);};
    const timer=setTimeout(()=>finish(Error('Antigravity usage check timed out.')),25000);
    child.on('error',()=>finish(Error('Antigravity CLI is unavailable. Install and sign in to agy.')));
    child.stderr.on('data',()=>{});
    child.stdout.on('data',part=>{output+=part;if(output.length>128*1024)finish(Error('Antigravity usage report exceeded the size limit.'));});
    child.on('close',code=>{if(code!==0)return finish(Error('Antigravity usage check failed. Check agy login and /usage.'));try{finish(null,agyUsage(output,now));}catch(error){finish(error);}});
  });
}
module.exports={CLAUDE_USAGE_URL,INTERVAL_MS,isoReset,claudeUsage,fetchClaudeUsage,codexUsage,codexCommand,fetchCodexUsage,createCollector,readStatusFile,agyUsage,fetchAgyUsage};
