// Records real Pi RPC commands/decisions using isolated, offline fixture providers.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const {createGuardServer}=require('./usage-guard-server');
const root=path.resolve(__dirname,'..');
const runtime=process.env.AI_SPEND_PI_RUNTIME || path.join(root,'.guard-runtime');
const destination=process.argv[2] || path.join(root,'public/guard-walkthrough.json');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function main(){
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guard-walkthrough-'));
  const server=createGuardServer({stateDir:path.join(temp,'controller'),sync:false});
  const seed=(claude,codex)=>{
    const now=Date.now();server.guard.state().observations=[['claude',claude],['codex',codex]].map(([provider,usedPercent])=>({provider,windowId:'weekly',windowMinutes:10080,usedPercent,resetAt:new Date(now+72*3600000).toISOString(),observedAt:new Date(now).toISOString(),source:'manual'}));
  };
  seed(20,25);
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const agentDir=path.join(temp,'agent'),artifacts=path.join(temp,'artifacts'),countFile=path.join(temp,'calls.txt');
  fs.mkdirSync(agentDir);fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({cacheWarming:'off',retry:{enabled:false},defaultProjectTrust:'never'}));
  const count=()=>fs.existsSync(countFile)?fs.readFileSync(countFile,'utf8').trim().split('\n').filter(Boolean):[];
  const child=spawn(process.execPath,[path.join(runtime,'node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js'),'--mode','rpc','--no-extensions','--no-skills','--no-context-files','--no-prompt-templates','--no-themes','--no-approve','-e',path.join(root,'integrations/pi/test-fixtures/walkthrough-provider.ts'),'-e',path.join(root,'integrations/pi/index.ts'),'--model','aispend/guard'],{
    cwd:temp,windowsHide:true,env:{...process.env,PI_OFFLINE:'1',PI_TELEMETRY:'0',PI_CODING_AGENT_DIR:agentDir,AI_SPEND_GUARD_URL:`http://127.0.0.1:${server.address().port}`,AI_SPEND_GUARD_ARTIFACTS:artifacts,AI_SPEND_FIXTURE_COUNT:countFile},stdio:['pipe','pipe','pipe']});
  let buffer='',stderr='',serial=0;
  const pending=new Map(),events=[],frames=[];
  child.stderr.on('data',chunk=>stderr+=chunk);
  child.stdout.on('data',chunk=>{buffer+=chunk;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const event=JSON.parse(line);events.push(event);if(event.type==='response' && pending.has(event.id)){const callback=pending.get(event.id);pending.delete(event.id);callback(event);}}catch{}}});
  const send=(type,data={})=>new Promise((resolve,reject)=>{const id='walkthrough-'+(++serial);const timer=setTimeout(()=>{pending.delete(id);reject(Error(type+' timed out: '+stderr.slice(-1200)));},12000);pending.set(id,response=>{clearTimeout(timer);if(response.success===false)reject(Error(response.error));else resolve(response);});child.stdin.write(JSON.stringify({id,type,...data})+'\n');});
  const idle=async()=>{await delay(250);for(let i=0;i<150;i++){const response=await send('get_state');if(!response.data.isStreaming && !response.data.isCompacting){await delay(200);return;}await delay(100);}throw Error('Pi did not settle');};
  const clean=text=>String(text).replaceAll(temp,'[local fixture]').replace(/\[local fixture\][^\s]*handoff[^\s]*\.md/g,'./guard-artifacts/handoff.md').replace(/http:\/\/127\.0\.0\.1:\d+/g,'http://127.0.0.1:9021');
  const capture=(title,command,start)=>{
    const lines=[];
    for(const event of events.slice(start)){
      if(event.type==='extension_ui_request' && event.method==='notify')lines.push(clean(event.message));
      if(event.type==='message_end' && event.message?.role==='assistant')for(const block of event.message.content||[])if(block.type==='text')lines.push(clean(block.text));
      if(event.type==='compaction_end' && !event.errorMessage && !event.aborted)lines.push('Pi context checkpoint completed.');
    }
    frames.push({title,command,lines:[...new Set(lines)],fixtureCalls:count().length});
  };
  const command=async(title,message)=>{const start=events.length;await send('prompt',{message});await idle();capture(title,message.replaceAll(temp,'[local fixture]'),start);};
  try{
    await send('get_state');
    await command('Connect once. See limits and protection.','/guard');
    assert(server.guard.state().bindings.claude);assert(server.guard.state().bindings.codex);
    await command('Work normally through Guard.','Implement the small reset-planner fixture.');
    assert(count().includes('claude-code'));
    server.guard.state().insights={generatedAt:new Date().toISOString(),providers:[{requests:30,metrics:[{id:'context',percent:65},{id:'long',percent:55}]}]};
    await fetch(`http://127.0.0.1:${server.address().port}/api/advice`,{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
    await command('Recent usage leads to tighter work budgets.','/guard');
    assert.equal(server.guard.state().policy.maxContextTokens,80000);
    seed(95,25);
    await command('Claude reaches reserve. Guard uses Codex.','Continue the fixture within the available subscription.');
    assert(count().includes('openai'));
    const beforeCompact=count().length;
    await command('Growing context triggers a saved checkpoint.','/fixture-context');
    // Compaction can schedule a continuation after agent_end; wait for that follow-up.
    await delay(500);await idle();
    assert(count().length>=beforeCompact+2,'Expected a real Pi compaction request: '+JSON.stringify({beforeCompact,calls:count(),frame:frames.at(-1),recent:events.filter(e=>['agent_end','agent_settled','extension_ui_request','message_end','compaction_end'].includes(e.type)).slice(-10)}).slice(-6500));
    const contextFrame=frames.at(-1);contextFrame.lines=events.filter(e=>e.type==='extension_ui_request' && e.method==='notify').map(e=>clean(e.message)).filter(line=>/checkpoint|handoff|compact/i.test(line)).slice(-3);
    contextFrame.fixtureCalls=count().length;
    seed(95,95);const beforePause=count().length;
    await command('Both reserves protected. Work pauses.','Continue the fixture after checking allowance.');
    assert.equal(count().length,beforePause,'Paused work must make no provider call');
    await command('Save portable notes without spending tokens.','/guard-handoff');
    assert(fs.readdirSync(artifacts).some(file=>file.endsWith('.md')));
    const oldSession=(await send('get_state')).data.sessionId;
    await command('Start fresh; keep the original session.','/guard-new');
    assert.notEqual((await send('get_state')).data.sessionId,oldSession);
    const imported=path.join(temp,'claude-handoff.md');fs.writeFileSync(imported,'# Claude handoff\nGoal: finish the reset planner.\nChanged: planner.js.\nNext: verify a reset needs a fresh reading.\n');
    await command('Bring Claude or Codex notes into Pi.','/guard-import "'+imported+'"');
    frames.at(-1).command='/guard-import claude-handoff.md';
    const messages=await send('get_messages');assert(JSON.stringify(messages.data).includes('Claude handoff'));
    assert.equal(count().length,beforePause,'Handoff/new/import must make no model calls');
    assert(frames.some(frame=>frame.lines.some(line=>line.includes('Guard switched'))));
    const result={recordedAt:new Date().toISOString(),runtime:'Pi 1.5.0 with real Guard extension; RPC transcript replay',fixtureProviders:true,realModelCalls:0,checks:{autoBindings:true,providerSwitch:true,contextCheckpoint:true,reservePause:true,handoff:true,newSession:true,import:true},frames};
    fs.mkdirSync(path.dirname(destination),{recursive:true});fs.writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({recording:destination,frames:frames.length,checks:result.checks,realModelCalls:0}));
  }finally{
    child.stdin.end();
    if(child.exitCode===null && child.signalCode===null){const closed=new Promise(resolve=>child.once('exit',resolve));child.kill();await closed;}
    await new Promise(resolve=>server.close(resolve));
    if(path.dirname(temp)===path.resolve(os.tmpdir()) && path.basename(temp).startsWith('guard-walkthrough-'))fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
