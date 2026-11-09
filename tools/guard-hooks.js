// Native hook adapter: send only hashes/counters to the local controller.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {signature}=require('./usage-guard');
const EVENTS={claude:{UserPromptSubmit:'prompt',PreToolUse:'pre-tool',PostToolUse:'post-tool',PostToolUseFailure:'post-tool',PostToolBatch:'batch',Stop:'stop'},codex:{UserPromptSubmit:'prompt',PreToolUse:'pre-tool',PostToolUse:'post-tool',PreModelRequest:'request',PostModelRequest:'usage',Stop:'stop'},agy:{PreInvocation:'request',PostInvocation:'usage',PreToolUse:'pre-tool',PostToolUse:'post-tool',Stop:'stop'}};
function config(harness){
  if(!EVENTS[harness])throw Error('Choose claude, codex or agy');
  const file=__filename.replaceAll('\\','/');
  if(/["`$\r\n]/.test(file))throw Error('Install Guard in a path without shell metacharacters');
  const hooks={};
  for(const event of Object.keys(EVENTS[harness])){
    const handler={type:'command',command:`node "${file}" run ${harness} ${event}`,timeout:10};
    if(harness==='claude')handler.onFailure='block';
    hooks[event]=harness==='agy'&&!event.includes('Tool')?[handler]:[{hooks:[handler]}];
  }
  return harness==='agy'?{'ai-spend-guard':hooks}:{hooks};
}
function normalize(harness,event,input){
  if(!EVENTS[harness]?.[event])throw Error('Unknown hook event');
  const session=input.session_id||input.conversationId;
  if(typeof session!=='string' || !session)throw Error('Missing native session ID');
  const tool=input.tool_name||input.toolCall?.name||'';
  const args=input.tool_input||input.toolCall?.args||{};
  const response=harness==='agy'?(input.error||null):(input.tool_response??input.error??null);
  const usage=input.token_usage;
  const total=usage?.total_tokens??usage?.totalTokens??(Number.isFinite(usage?.input_tokens)&&Number.isFinite(usage?.output_tokens)?usage.input_tokens+usage.output_tokens:undefined);
  // Tool IDs and AGY invocation numbers are stable; diagnostic model attempts use a new ID.
  const eventId=input.tool_use_id!==undefined?signature([harness,session,event,input.tool_use_id]):harness==='agy'&&Number.isInteger(input.invocationNum)&&['PreInvocation','PostInvocation'].includes(event)?signature([session,event,input.invocationNum]):crypto.randomUUID();
  return {harness,event:EVENTS[harness][event],taskId:signature([harness,session]),eventId,
    model:/^[\w.\/:@-]{1,160}$/.test(input.model||input.modelName||'')?(input.model||input.modelName):'unknown',operation:signature([tool,args]),result:response===null?null:signature(response),
    subagent:/^(agent|task|subagents?|spawn_agent|delegate|spawn_subagent)$/i.test(tool),totalTokens:total};
}
function output(harness,event,result){
  const blocked=['pause','deny'].includes(result.action),reason=result.reason||'Guard paused: the local controller is unavailable.';
  if(harness==='agy'){
    if(event==='PreToolUse')return blocked?{decision:'deny',reason}:{};
    if(event==='PreInvocation' && blocked)return {terminationBehavior:'terminate',injectSteps:[{errorMessage:{userMessage:reason}}]};
    return {};
  }
  if(['PreModelRequest','PostModelRequest','PostToolUse','PostToolUseFailure','Stop'].includes(event))return {};
  if(!blocked)return {};
  if(event==='PreToolUse')return {hookSpecificOutput:{hookEventName:event,permissionDecision:'deny',permissionDecisionReason:reason}};
  return {continue:false,stopReason:reason,decision:'block',reason};
}
async function run(harness,event,input,fetcher=fetch){
  let decision;
  try{
    const endpoint=new URL(process.env.AI_SPEND_GUARD_URL||'http://127.0.0.1:9021');
    if(endpoint.protocol!=='http:'||!['127.0.0.1','localhost'].includes(endpoint.hostname))throw Error('Loopback controller required');
    const response=await fetcher(new URL('/api/native-event',endpoint),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(normalize(harness,event,input)),signal:AbortSignal.timeout(5000)});
    decision=await response.json();if(!response.ok)throw Error('Controller rejected native event');
  }catch{decision={action:'pause',reason:'Guard could not verify the work budget. Start or repair the local controller before continuing.'};}
  return output(harness,event,decision);
}
function install(harness,project){
  const generated=config(harness),root=path.resolve(project);
  const file=path.join(root,harness==='claude'?'.claude/settings.local.json':harness==='codex'?'.codex/hooks.json':'.agents/hooks.json');
  const previous=fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):{};
  let merged;
  if(harness==='agy')merged={...previous,...generated};
  else{
    merged={...previous,hooks:{...previous.hooks}};
    for(const [event,groups] of Object.entries(generated.hooks))merged.hooks[event]=[...(previous.hooks?.[event]||[]).filter(group=>!group.hooks?.some(h=>String(h.command).includes('guard-hooks.js'))),...groups];
  }
  fs.mkdirSync(path.dirname(file),{recursive:true});
  if(fs.existsSync(file))fs.copyFileSync(file,file+'.backup-'+Date.now());
  const tmp=file+'.'+process.pid+'.tmp';fs.writeFileSync(tmp,JSON.stringify(merged,null,2)+'\n');fs.renameSync(tmp,file);
  return file;
}
if(require.main===module)(async()=>{
  const [action,harness,event,...rest]=process.argv.slice(2);
  if(action==='config'){console.log(JSON.stringify(config(harness),null,2));return;}
  if(action==='install'){
    if(event!=='--project'||rest.length!==1)throw Error('Usage: install <claude|codex|agy> --project <directory>');
    console.log('Installed '+install(harness,rest[0])+'. Restart the harness, review /hooks and trust the Guard hooks. See integrations/native/README.md for coverage.');return;
  }
  if(action!=='run')throw Error('Usage: guard-hooks.js config|install|run <claude|codex|agy>');
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(raw.length>4*1024*1024)throw Error('Hook input too large');}
  let result;try{result=await run(harness,event,JSON.parse(raw));}catch{result=output(harness,event,{action:'pause',reason:'Guard could not read this hook event.'});}
  process.stdout.write(JSON.stringify(result));
})().catch(error=>{
  const [action,harness,event]=process.argv.slice(2);
  if(action==='run' && EVENTS[harness]?.[event])process.stdout.write(JSON.stringify(output(harness,event,{action:'pause',reason:'Guard could not process this hook event. Check local setup before continuing.'})));
  else {process.stderr.write(error.message+'\n');process.exitCode=2;}
});
module.exports={config,normalize,output,run,install};
