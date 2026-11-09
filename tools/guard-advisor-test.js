const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), vm = require('node:vm');
const {initialState} = require('./usage-guard');
const {buildAdvice,applyAdvice,defaultBindings} = require('./guard-advisor');
const {buildHandoff,readHandoff} = require('./guard-handoff');
const now = Date.now(), state = initialState();
assert.equal(buildAdvice(state,now).learned,false);
state.insights={generatedAt:new Date(now).toISOString(),providers:[{requests:30,metrics:[{id:'context',percent:90},{id:'long',percent:60},{id:'subagents',percent:50},{id:'effort',percent:80,coveragePercent:90}]}]};
state.policy.maxThinkingLevel='high';state.policy.maxSubagentCalls=5;
const proposal=buildAdvice(state,now);
assert.equal(proposal.learned,true);assert.equal(proposal.changes.maxContextTokens,80000);
assert.equal(proposal.changes.maxTaskMinutes,30);assert.equal(proposal.changes.maxSubagentCalls,0);
state.policy.autoTune=false;const before=JSON.stringify(state.policy);
assert.equal(applyAdvice(state,now),null);assert.equal(JSON.stringify(state.policy),before);
assert(applyAdvice(state,now,true));assert.equal(state.policy.allowApiSpend,false);
assert.equal(state.policy.apiDailyBudgetUsd,0);assert.equal(state.policy.maxThinkingLevel,'medium');
state.policy.maxContextTokens=32000;assert.equal(buildAdvice(state,now).changes.maxContextTokens,undefined,'never loosen a tighter user cap');
state.insights.generatedAt=new Date(now-7*3600000).toISOString();assert.equal(buildAdvice(state,now).learned,false,'stale analysis does not tune');
state.insights.generatedAt=new Date(now).toISOString();state.insights.providers[0].requests=2;
assert.equal(buildAdvice(state,now).learned,false,'small samples do not tune');
const models=[{group:'claude',provider:'claude-code',id:'opus-example',auth:'subscription'},{group:'claude',provider:'claude-code',id:'sonnet-example',auth:'subscription'},{group:'api',provider:'paid',id:'fast',auth:'api'}];
assert.equal(defaultBindings(models,{}).claude.model,'sonnet-example');
assert.equal(defaultBindings(models,{claude:{provider:'claude-code',model:'opus-example'}}).claude.model,'opus-example');
assert.equal(defaultBindings(models,{}).api,undefined,'never auto-connect API spending');
const entries=[{type:'message',message:{role:'user',content:[{type:'text',text:'Build a reset planner.'}]}},{type:'message',message:{role:'assistant',content:[{type:'text',text:'Next: verify the reset before resuming.'},{type:'toolCall',name:'edit',arguments:{path:'planner.js'}}]}},{type:'compaction',summary:'Reset edge case is unfinished.'}];
const handoff=buildHandoff(entries,'Budget reached',now);
assert(handoff.includes('Build a reset planner.'));assert(handoff.includes('Reset edge case is unfinished.'));assert(handoff.includes('planner.js'));
assert(buildHandoff([{type:'message',message:{role:'user',content:'x'.repeat(1000000)}}],'pause',now).length<17000);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'guard-handoff-test-'));
try{
  fs.writeFileSync(path.join(temp,'claude.md'),'Goal from Claude\n'+'a'.repeat(20000));
  assert(readHandoff(path.join(temp,'claude.md')).includes('Goal from Claude'));
  assert(readHandoff(path.join(temp,'claude.md')).length<17000);
  assert.throws(()=>readHandoff(path.join(temp,'auth.json')),/Markdown or text/);
}finally{for(const file of fs.readdirSync(temp)){fs.unlinkSync(path.join(temp,file));}fs.rmdirSync(temp);}
// Execute the shipped static adapter: every selector must offer and accept choices.
const html=fs.readFileSync(path.join(__dirname,'../public/guard.html'),'utf8');
const adapter=html.slice(html.indexOf('<script>')+8,html.indexOf('const $=id=>'));
const sandbox={console};vm.createContext(sandbox);vm.runInContext(adapter,sandbox);
(async()=>{
  for(const group of ['claude','codex','agy','api']){
    const choices=vm.runInContext('playgroundView().models',sandbox).filter(model=>model.group===group);
    assert(choices.length>=2,group+' must have useful example choices');
    sandbox.selection={group,provider:choices[1].provider,model:choices[1].id};
    await vm.runInContext("playgroundApi('/api/binding',selection)",sandbox);
    assert.equal(vm.runInContext('playgroundState.bindings[selection.group].model',sandbox),choices[1].id);
  }
  assert.equal(vm.runInContext('playgroundState.policy.allowApiSpend',sandbox),false);
  sandbox.selection={group:'api',provider:'unknown',model:'unknown'};
  await assert.rejects(vm.runInContext("playgroundApi('/api/binding',selection)",sandbox),/example models/);
  await assert.rejects(vm.runInContext("playgroundApi('/api/preflight',{})",sandbox),/Public playground/);
  console.log('Usage advice, conservative adaptation, model defaults, bounded handoffs/imports and public model selections passed');
})().catch(error=>{console.error(error);process.exitCode=1;});
