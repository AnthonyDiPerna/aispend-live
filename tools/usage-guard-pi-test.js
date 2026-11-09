const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const {spawn}=require('node:child_process');
const {createGuardServer}=require('./usage-guard-server');
const cli=path.join(process.env.AI_SPEND_PI_RUNTIME || path.resolve(__dirname,'../.guard-runtime'),'node_modules','@earendil-works','pi-coding-agent','dist','bundle','cli.js');
const extension=path.resolve(__dirname,'../integrations/pi/index.ts');
const fixture=path.resolve(__dirname,'../integrations/pi/test-fixtures/fake-provider.ts');
async function runCase(name,{used=20,loop=false,maxRequests=10,offline=false,compact=false,resume=false,storageFailure=false,api=false,apiEnabled=false,autoRecover=false,repairSuccess=false,activate=false}={}) {
  if(process.env.AI_SPEND_TEST_CASES && !process.env.AI_SPEND_TEST_CASES.split(',').includes(name))return;
  const rpc=compact || resume || autoRecover || activate;
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'guard-pi-'+name+'-'));
  const server=createGuardServer({stateDir:path.join(root,'state'),sync:false});
  const now=Date.now();
  server.guard.state().observations=[{provider:'claude',windowId:'weekly',windowMinutes:10080,usedPercent:used,resetAt:new Date(now+72*3600000).toISOString(),observedAt:new Date(now).toISOString(),source:'manual'}];
  server.guard.state().bindings={claude:{provider:'claude-code',model:'guard-fixture'}};
  server.guard.state().policy.maxRequestsPerTask=maxRequests;
  server.guard.state().policy.autoRecover=autoRecover;
  if(api){server.guard.state().bindings={api:{provider:'guard-api-fixture',model:'guard-fixture'}};Object.assign(server.guard.state().policy,{allowApiSpend:apiEnabled,apiDailyBudgetUsd:10,apiTaskBudgetUsd:10});}
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const agentDir=path.join(root,'agent');fs.mkdirSync(agentDir);
  fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({cacheWarming:'off',retry:{enabled:false},defaultProjectTrust:'never'}));
  const countFile=path.join(root,'count.txt');
  if(storageFailure)fs.writeFileSync(path.join(root,'output'),'A file blocks the archive directory.');
  const port=server.address().port;
  if(offline)await new Promise(resolve=>server.close(resolve));
  try {
    const outcome=await new Promise((resolve,reject)=>{
      const child=spawn(process.execPath,[cli,'--mode',rpc?'rpc':'json','--no-session','--no-extensions','--no-skills','--no-prompt-templates','--no-themes','--no-context-files','--no-approve','-e',fixture,'-e',extension,'--model',activate?'claude-code/guard-fixture':'aispend/guard',...(rpc?[]:['-p','Complete the offline guard fixture.'])],{
        cwd:root,windowsHide:true,env:{...process.env,PI_CODING_AGENT_DIR:agentDir,AI_SPEND_GUARD_URL:`http://127.0.0.1:${port}`,AI_SPEND_GUARD_ARTIFACTS:path.join(root,'output'),AI_SPEND_FIXTURE_COUNT:countFile,AI_SPEND_FIXTURE_LOOP:loop?'1':'0',AI_SPEND_FIXTURE_RECOVER:repairSuccess?'1':'0',AI_SPEND_FIXTURE_COMPACT:compact?'1':'0',AI_SPEND_FIXTURE_API:api?'1':'0'},stdio:[rpc?'pipe':'ignore','pipe','pipe']});
      let output='',errors='',buffer='';child.stdout.on('data',data=>{
        output+=data;buffer+=data;
        while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!rpc)continue;
          try{const event=JSON.parse(line);const count=fs.existsSync(countFile)?fs.readFileSync(countFile,'utf8').trim().split('\n').length:0;
            if(resume && event.type==='agent_settled' && count===0){const row=server.guard.state().observations[0];server.guard.state().observations=[{...row,usedPercent:20,observedAt:new Date().toISOString()}];}
            if(activate && event.type==='response' && event.id==='activate')child.stdin.write(JSON.stringify({id:'choose',type:'set_model',provider:'claude-code',modelId:'guard-fixture'})+'\n');
            if(activate && event.type==='response' && event.id==='choose')child.stdin.write(JSON.stringify({id:'state',type:'get_state'})+'\n');
            if(activate && event.type==='response' && event.id==='state'){
              assert.equal(event.data.model.provider,'aispend','physical selection must stay guarded');
              child.stdin.write(JSON.stringify({id:'run',type:'prompt',message:'Complete the offline guard fixture.'})+'\n');
            }
            const target=resume||activate?1:autoRecover?Math.min(4,maxRequests):10;
            if((event.type==='agent_settled' && count>=target) || (event.type==='compaction_end' && event.errorMessage))child.stdin.end();
          }catch{}
        }
      });child.stderr.on('data',data=>errors+=data);
      if(rpc)child.stdin.write(JSON.stringify({id:activate?'activate':'run',type:'prompt',message:activate?'/guard':'Complete the offline guard fixture.'})+'\n');
      let timeoutError;
      const timer=setTimeout(()=>{timeoutError=new Error(`${name} timed out\n${errors}\n${output.slice(-6500)}`);child.kill();},45000);
      child.on('error',reject);child.on('close',code=>{clearTimeout(timer);if(timeoutError)reject(timeoutError);else resolve({code,output,errors});});
    });
    const count=fs.existsSync(countFile)?fs.readFileSync(countFile,'utf8').trim().split('\n').length:0;
    const diagnostic=JSON.stringify({code:outcome.code,output:outcome.output.slice(-4000),errors:outcome.errors.slice(-2500)});
    if(name==='happy'){assert.equal(count,1,diagnostic);assert.ok(outcome.output.includes('Guard fixture completed.'),diagnostic);}
    if(name==='reserve' || name==='offline'){assert.equal(count,0,diagnostic);assert.ok(outcome.output.includes('Guard') || outcome.errors.includes('Guard'));}
    if(name==='loop'){assert.equal(count,3,diagnostic);assert.ok(outcome.output.includes('characters omitted from model context'),diagnostic);}
    if(name==='budget'){assert.equal(count,1,diagnostic);assert.ok(outcome.output.includes('request budget'),diagnostic);}
    if(name==='compact'){assert.equal(count,10,diagnostic);assert.ok(outcome.output.includes('Guard fixture completed.'),diagnostic);}
    if(name==='auto-resume'){assert.equal(count,1,diagnostic);assert.ok(outcome.output.includes('A fresh allowance is ready'),diagnostic);}
    if(name==='storage'){assert.equal(count,1,diagnostic);assert.ok(outcome.output.includes('local storage error'),diagnostic);}
    if(name==='api-off'){assert.equal(count,0,diagnostic);}
    if(name==='api-on'){assert.equal(count,1,diagnostic);assert.equal(server.guard.view().accounting.apiEstimateUsd,.001);assert.equal(server.guard.view().accounting.apiReservedUsd,0);}
    if(autoRecover){
      assert.equal(count,Math.min(4,maxRequests),diagnostic);
      assert.equal(fs.readFileSync(countFile+'.tools','utf8').trim().split('\n').length,2,'repeated operation never executes a third time');
      assert.equal(server.guard.view().impact.repairs,maxRequests===3?0:1,'at most one repair, never renew a task budget');
      assert(server.guard.view().impact.estimatedInputTokensAvoided>0,'show savings only after an observed replay');
      if(repairSuccess)assert(outcome.output.includes('Guard fixture completed.'),diagnostic);
    }
    if(activate){assert.equal(count,1,diagnostic);assert(server.guard.state().policy.autoTune);assert(server.guard.state().policy.autoRecover);}
    console.log(`Pi runtime ${name}: ${count} fixture requests; passed`);
  } finally {
    if(!offline)await new Promise(resolve=>server.close(resolve));
    const resolved=path.resolve(root),temp=path.resolve(os.tmpdir())+path.sep;
    if(resolved.startsWith(temp) && path.basename(resolved).startsWith('guard-pi-'))fs.rmSync(resolved,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}
(async()=>{await runCase('happy');await runCase('reserve',{used:95});await runCase('offline',{offline:true});await runCase('loop',{loop:true});await runCase('budget',{loop:true,maxRequests:1});await runCase('compact',{compact:true});await runCase('storage',{loop:true,storageFailure:true});await runCase('auto-resume',{resume:true,used:95});await runCase('api-off',{api:true});await runCase('api-on',{api:true,apiEnabled:true});await runCase('repair',{loop:true,autoRecover:true,repairSuccess:true});await runCase('repair-exhausted',{loop:true,autoRecover:true});await runCase('repair-budget',{loop:true,autoRecover:true,maxRequests:3});await runCase('activate',{activate:true});})().catch(error=>{console.error(error);process.exitCode=1;});
