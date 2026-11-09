import {createRequire} from 'node:module';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';

const require = createRequire(import.meta.url);
const {trimToolOutput, signature, DEFAULT_POLICY} = require('../../tools/usage-guard.js');
const {codexObservations} = require('../../tools/usage-guard-server.js');
const {buildHandoff,readHandoff} = require('../../tools/guard-handoff.js');

function group(provider: string) {
  if(provider==='claude-code') return 'claude';
  if(['openai','openai-codex'].includes(provider)) return 'codex';
  if(provider==='google-antigravity') return 'agy';
  return undefined;
}

export default function guard(pi: ExtensionAPI) {
  const endpoint = new URL(process.env.AI_SPEND_GUARD_URL || 'http://127.0.0.1:9021');
  if(endpoint.protocol!=='http:' || !['127.0.0.1','localhost'].includes(endpoint.hostname)) throw new Error('AI Spend Guard requires a local HTTP controller');
  const artifacts=process.env.AI_SPEND_GUARD_ARTIFACTS || join(homedir(),'.aispend-live','guard-artifacts');
  let taskId='', activeLease:string|undefined, removedChars=0, repeatedTools=0, lastTool='', pendingCompact=false, compactedThisRun=false;
  let policy={...DEFAULT_POLICY};
  let currentGroup:string|undefined;
  let waitingForAllowance=false, checking=false;
  let disposed=false;
  let localFailure:string|undefined;
  let lastHandoff:string|undefined;
  let watcher:ReturnType<typeof setInterval>|undefined;
  let guardArmed=false,restoringModel=false,pendingRepair=false,lastOperation='';
  const blockedOperations=new Set<string>();

  async function api(route:string, data?:unknown) {
    const response=await fetch(new URL(route,endpoint), {
      ...(data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),
      signal:AbortSignal.timeout(5000),
    });
    const body=await response.json();
    if(!response.ok) throw new Error(body.error || `Controller returned ${response.status}`);
    return body;
  }
  const isGuard=(ctx:ExtensionContext)=>ctx.model?.provider==='aispend' && ctx.model.id==='guard';
  const operation=(event:any)=>signature({tool:event.toolName,input:event.input});
  const persistBlocks=()=>pi.appendEntry('aispend.guard-blocks',{operations:[...blockedOperations]});
  const impact=(kind:string,extra:any={})=>api('/api/intervention',{id:randomUUID(),taskId,kind,...extra});
  const routing=(ctx:ExtensionContext)=>({currentProvider:currentGroup,availableProviders:[...new Set(available(ctx).map(m=>modelGroup(ctx,m)))],availableModels:available(ctx).map(m=>m.provider+'/'+m.id),contextTokens:ctx.getContextUsage()?.tokens||0});
  function statusLine(state:any){
    const labels:any={claude:'Claude',codex:'Codex',agy:'AGY'};
    const quotas=state.providers.filter((p:any)=>p.provider!=='api').map((p:any)=>{
      const rows=p.windows.filter((w:any)=>w.applies);
      return `${labels[p.provider]} ${rows.length?Math.min(...rows.map((w:any)=>w.remainingPercent)).toFixed(0)+'%':'?'}${['ready'].includes(p.status)?'':' ('+p.status+')'}`;
    });
    return `Guard · ${quotas.join(' | ')} · API ~$${Number(state.accounting?.apiEstimateUsd||0).toFixed(3)}`;
  }
  function watch(ctx:ExtensionContext) {
    if(watcher || !ctx.hasUI) return;
    watcher=setInterval(async()=>{
      if(checking || !isGuard(ctx) || !ctx.isIdle()) return;
      checking=true;
      try {
        const state=await api('/api/state');policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));
        if(!waitingForAllowance)return;
        const decision=await api('/api/readiness',{taskId,currentProvider:currentGroup,continuation:true,
          availableProviders:[...new Set(available(ctx).map(m=>modelGroup(ctx,m)))],availableModels:available(ctx).map(m=>m.provider+'/'+m.id),contextTokens:ctx.getContextUsage()?.tokens || 0,repeatedTools});
        if(['continue','switch'].includes(decision.action)) {
          waitingForAllowance=false;
          ctx.ui.notify('A fresh allowance is ready. Resuming the saved task.','info');
          pi.sendUserMessage('Resume the unfinished task from the saved checkpoint. Keep the original scope and acceptance criteria.');
        }
      } catch { /* Waiting never calls a model and offline stays paused. */ }
      finally {checking=false;}
    },30000);
    watcher.unref();
  }
  function available(ctx:ExtensionContext) {
    return ctx.modelRegistry.getAvailable().filter(model=>model.provider!=='aispend' && model.api!=='pi-virtual');
  }
  function modelGroup(ctx:ExtensionContext,model:any){return ctx.modelRegistry.isUsingOAuth(model) && group(model.provider)?group(model.provider):'api';}
  async function discover(ctx:ExtensionContext) {
    return api('/api/models',{models:available(ctx).map(model=>({group:modelGroup(ctx,model),provider:model.provider,id:model.id,auth:modelGroup(ctx,model)==='api'?'api':'subscription',cost:model.cost,contextWindow:model.contextWindow,maxTokens:model.maxTokens}))});
  }
  async function complete(totalTokens:number,failed=false,costEstimateUsd?:number) {
    if(!activeLease) return;
    const leaseId=activeLease;activeLease=undefined;
    const state=await api('/api/complete',{taskId,leaseId,totalTokens:Number.isFinite(totalTokens)?Math.max(0,totalTokens):0,removedChars,failed,costEstimateUsd});
    removedChars=0;
    return state;
  }
  function saveHandoff(ctx:ExtensionContext,reason:string) {
    const text=buildHandoff(ctx.sessionManager.getBranch(),reason);
    const file=join(artifacts,`handoff-${taskId}-${Date.now()}.md`);
    mkdirSync(artifacts,{recursive:true});writeFileSync(file,text,{mode:0o600});lastHandoff=file;
    return {file,text};
  }
  function checkpoint(ctx:ExtensionContext,reason:string) {
    pi.appendEntry('aispend.guard-checkpoint',{taskId,reason,at:new Date().toISOString()});
    ctx.ui.setStatus('aispend',`Guard paused: ${reason}`);
    try{const saved=saveHandoff(ctx,reason);void impact('handoff').catch(()=>{});ctx.ui.notify(`Guard: ${reason}\nLocal handoff saved: ${saved.file}\n/guard-new starts fresh from these excerpts; the original session is kept.`,'info');return true;}
    catch{ctx.ui.notify('Guard paused. Could not write a handoff; the original Pi session is still available.','warning');return false;}
  }

  pi.on('session_start',async(_event,ctx)=>{
    disposed=false;
    waitingForAllowance=false;repeatedTools=0;lastTool='';currentGroup=undefined;lastHandoff=undefined;
    pendingCompact=false;compactedThisRun=false;localFailure=undefined;
    pendingRepair=false;lastOperation='';blockedOperations.clear();guardArmed=isGuard(ctx);
    for(const entry of ctx.sessionManager.getBranch() as any[]){
      if(entry.type==='custom' && entry.customType==='aispend.guard-blocks'){blockedOperations.clear();for(const op of entry.data?.operations||[])blockedOperations.add(op);}
      if(entry.type==='custom' && entry.customType==='aispend.guard-armed')guardArmed=entry.data?.armed===true;
    }
    if(watcher){clearInterval(watcher);watcher=undefined;}
    taskId=signature(ctx.sessionManager.getSessionId());
    watch(ctx);
    try {const state=await discover(ctx);policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));}
    catch {ctx.ui.setStatus('aispend','Start AI Spend Guard on port 9021 · /guard');}
    if(guardArmed && !isGuard(ctx)){const model=ctx.modelRegistry.find('aispend','guard');if(model)await pi.setModel(model);}
  });
  pi.on('model_select',async(event,ctx)=>{
    if(restoringModel || !guardArmed || event.model.provider==='aispend')return;
    restoringModel=true;
    try{
      const selected=available(ctx).find(m=>m.provider===event.model.provider && m.id===event.model.id);
      if(selected && modelGroup(ctx,selected)!=='api'){
        await discover(ctx);await api('/api/binding',{group:modelGroup(ctx,selected),provider:selected.provider,model:selected.id});
      }
    }catch{ctx.ui.notify('Could not update the preferred model. Existing Guard routing is retained.','warning');}
    finally{
      const guarded=ctx.modelRegistry.find('aispend','guard');
      if(guarded)await pi.setModel(guarded);
      restoringModel=false;
    }
    ctx.ui.notify('Guard remains active. Subscription model choices update the preference; requests still pass the budget checks. /guard-unlock permits direct model selection.','info');
  });
  pi.on('session_shutdown',async()=>{disposed=true;if(watcher)clearInterval(watcher);watcher=undefined;waitingForAllowance=false;});
  pi.on('before_agent_start',async(_event,ctx)=>{
    if(!isGuard(ctx)) return;
    // A model can read this tiny stable instruction once; no per-turn context injection.
    return {systemPrompt:`${_event.systemPrompt}\n\nUse bounded tool output and focused checks. Preserve a concise task handoff when changing milestones. Do not spawn additional agents unless the user explicitly requests them. AI Spend Guard enforces a finite request budget; avoid repeated no-progress checks.`};
  });

  pi.registerVirtualModel({
    provider:'aispend',id:'guard',name:'AI Spend Guard',
    thinkingLevels:['low','medium','high'],contextWindow:200000,maxTokens:16000,
    async route(request,ctx) {
      taskId ||= signature(ctx.sessionManager.getSessionId());
      if(localFailure)throw new Error(`AI Spend Guard billing guard paused: ${localFailure}`);
      if(activeLease) await complete(0,true); // A failed provider call may have emitted no message_end.
      const models=available(ctx);
      const previous=request.failed?.model || request.previous?.model;
      const current=previous ? modelGroup(ctx,previous) : currentGroup;
      const decision=await api('/api/preflight',{
        taskId,currentProvider:current,continuation:request.reason!=='user',
        availableProviders:[...new Set(models.map(model=>modelGroup(ctx,model)))],
        availableModels:models.map(model=>model.provider+'/'+model.id),
        contextTokens:request.reason==='direct'?0:ctx.getContextUsage()?.tokens || 0,
        repeatedTools:request.reason==='direct'?0:repeatedTools,
        phase:request.reason==='direct'?'compact':'work',
      }).catch(error=>{throw new Error(`AI Spend Guard billing guard paused: controller unavailable (${error.message}). Start the local controller; no provider request was authorized.`);});
      policy=decision.policy || policy;
      if(decision.action==='compact') {
        pendingCompact=!compactedThisRun;
        checkpoint(ctx,pendingCompact?'Compacting at the context ceiling':'Context remains above the ceiling after compaction');
        throw new Error('AI Spend Guard billing guard paused for a context checkpoint.');
      }
      if(decision.action==='pause') {
        waitingForAllowance=['allowance','concurrency'].includes(decision.code);
        checkpoint(ctx,decision.reason);
        throw new Error(`AI Spend Guard billing guard paused: ${decision.reason}`);
      }
      activeLease=decision.leaseId;
      waitingForAllowance=false;
      const model=models.find(m=>m.provider===decision.binding.provider && m.id===decision.binding.model);
      if(!model) {await complete(0,true);throw new Error('AI Spend Guard billing guard paused: configured model is not authenticated.');}
      currentGroup=decision.provider;
      if(decision.action==='switch')ctx.ui.notify(`Guard switched to ${decision.provider} / ${model.id}: ${decision.reason || 'This subscription has a fresh usable allowance.'}`,'info');
      ctx.ui.setStatus('aispend',`Guard · ${decision.provider} · ${model.id}`);
      const levels=['off','minimal','low','medium','high','xhigh','max','ultra'];
      const requested=levels.includes(request.thinkingLevel)?request.thinkingLevel:'medium';
      const thinkingLevel=levels[Math.min(levels.indexOf(requested),levels.indexOf(policy.maxThinkingLevel))] as any;
      if(thinkingLevel!==requested)await impact('effort-cap');
      return {model:{...model,maxTokens:Math.min(model.maxTokens,policy.maxOutputTokens)},thinkingLevel};
    },
  });

  pi.on('message_end',async(event,ctx)=>{
    if(!activeLease || event.message.role!=='assistant') return;
    const message=event.message as any;
    const usage=message.usage || {};
    // Pi's totalTokens includes fresh, cached, cache writes, and output once.
    const tokens=usage.totalTokens ?? ((usage.input||0)+(usage.output||0)+(usage.cacheRead||0)+(usage.cacheWrite||0));
    const amount=usage.cost?.total;
    const cost=typeof amount==='number' && Number.isFinite(amount) && (amount>0 || tokens===0)?amount:undefined;
    try {const state=await complete(tokens,message.stopReason==='error' || message.stopReason==='aborted',cost);if(state)ctx.ui.setStatus('aispend',statusLine(state));}
    catch {localFailure='Usage accounting was not acknowledged. Check the controller before resuming.';ctx.ui.notify('Guard could not record usage. Further requests are paused.','warning');}
    for(const diagnostic of message.diagnostics || []) {
      if(diagnostic.type!=='claude-code.rate-limit') continue;
      const info=diagnostic.details || {};
      const utilization=info.utilization;
      const percent=typeof utilization==='number' && utilization>=0 && utilization<=1 ? utilization*100 : info.status==='rejected'?100:null;
      const minutes=info.rateLimitType==='five_hour'?300:info.rateLimitType==='seven_day'?10080:null;
      if(percent===null || !minutes || !info.resetsAt) continue;
      const reset=Number(info.resetsAt);
      await api('/api/observations',{observations:[{provider:'claude',windowId:minutes===300?'session':'weekly',windowMinutes:minutes,usedPercent:percent,
        resetAt:new Date(reset<1e12?reset*1000:reset).toISOString(),observedAt:new Date().toISOString(),source:'provider'}]}).catch(()=>{});
    }
  });
  pi.on('provider_stream_event',async event=>{
    if(group(event.provider)!=='codex')return;
    const data=event.data as any;
    const rows=codexObservations(data?.rate_limits || data?.rateLimits,new Date().toISOString());
    if(rows.length) await api('/api/observations',{observations:rows.map((row:any)=>({...row,source:'provider'}))}).catch(()=>{});
  });
  pi.on('tool_call',async(event,ctx)=>{
    if(!isGuard(ctx))return;
    if(localFailure)return {block:true,reason:localFailure};
    const op=operation(event);
    if(blockedOperations.has(op) || (op===lastOperation && repeatedTools>=policy.repeatedToolLimit-1)){
      blockedOperations.add(op);persistBlocks();pendingRepair=true;repeatedTools=policy.repeatedToolLimit;
      try{await impact('loop-block');}catch{localFailure='Could not record the blocked loop. Check the controller.';}
      return {block:true,reason:'Guard blocked a repeated operation before execution. A bounded recovery will use a different approach if the existing task budget permits.'};
    }
    if(!/^(subagent|subagents|spawn_agent|delegate|agent|task)$/i.test(event.toolName))return;
    try{const result=await api('/api/subagent',{taskId});if(!result.allowed){await impact('subagent-block');return {block:true,reason:result.reason};}}
    catch{return {block:true,reason:'Guard could not authorize a subagent.'};}
  });
  pi.on('tool_result',async(event,ctx)=>{
    if(!isGuard(ctx)) return;
    if(blockedOperations.has(operation(event)))return;
    const digest=signature({tool:event.toolName,input:event.input,result:event.content,isError:event.isError});
    repeatedTools=digest===lastTool?repeatedTools+1:1;lastTool=digest;lastOperation=operation(event);
    if(!['bash','powershell','grep','find','ls'].includes(event.toolName)) return;
    const total=event.content.filter((block:any)=>block.type==='text').reduce((n:number,block:any)=>n+block.text.length,0);
    if(total<=policy.maxToolOutputChars) return;
    const file=join(artifacts,`${randomUUID()}.txt`);
    try {
      mkdirSync(artifacts,{recursive:true});
      writeFileSync(file,event.content.filter((block:any)=>block.type==='text').map((block:any)=>block.text).join('\n'),{mode:0o600});
    } catch {
      localFailure='Tool output could not be saved. Check local storage before /guard-resume.';
      waitingForAllowance=false;checkpoint(ctx,localFailure);
      return {content:trimToolOutput(event.content,policy.maxToolOutputChars,'unavailable: local storage error').content,isError:true};
    }
    const trimmed=trimToolOutput(event.content,policy.maxToolOutputChars,file);
    try{await impact('tool-trim',{removedChars:trimmed.removedChars});}catch{localFailure='Could not record tool trimming. Check the controller before resuming.';}
    return {content:trimmed.content};
  });
  pi.on('turn_end',async(_event,ctx)=>{
    if(!isGuard(ctx))return;
    if(localFailure){checkpoint(ctx,localFailure);return {continue:false};}
    if((ctx.getContextUsage()?.tokens || 0)<policy.maxContextTokens*0.8) compactedThisRun=false;
    if(pendingRepair || repeatedTools>=policy.repeatedToolLimit){pendingRepair=true;waitingForAllowance=false;return {continue:false};}
    if((ctx.getContextUsage()?.tokens || 0)>policy.maxContextTokens && !compactedThisRun){pendingCompact=true;return {continue:false};}
  });
  pi.on('agent_end',async(_event,ctx)=>{
    if(activeLease) await complete(0,true).catch(()=>{localFailure='Could not settle the last request.';});
    if(pendingRepair && isGuard(ctx)){
      pendingRepair=false;
      if(localFailure || !checkpoint(ctx,'Repeated operation stopped before execution'))return;
      try{
        const repair=await api('/api/recovery',{taskId,...routing(ctx),repeatedTools});
        if(repair.action!=='repair'){ctx.ui.notify(`Guard paused: ${repair.reason}`,'warning');return;}
        repeatedTools=0;lastTool='';lastOperation='';
        ctx.ui.notify(`Guard automatic repair ${repair.attempt}/${policy.maxAutoRepairs}: changing approach. Original task and dollar budgets still apply.`,'info');
        pi.sendUserMessage('Guard automatic recovery: '+repair.reason+' Preserve the original goal and acceptance criteria. Use the saved findings; do not reread the entire history.',{deliverAs:'followUp'});
      }catch{localFailure='Recovery could not be authorized. The saved handoff is intact.';ctx.ui.notify(localFailure,'warning');}
      return;
    }
    if(!pendingCompact || !isGuard(ctx))return;
    pendingCompact=false;compactedThisRun=true;
    if(localFailure || !checkpoint(ctx,'Automatic context checkpoint'))return;
    const beforeTokens=ctx.getContextUsage()?.tokens;
    ctx.compact({
      customInstructions:'Preserve the user goal, unfinished acceptance criteria, changed files, failing checks, commands needed next, and decisions. Drop obsolete tool output and completed exploration. Do not claim unfinished work is done.',
      onComplete:()=>{
        if(disposed)return;
        // Compaction is counted as a request. Pi does not expose its exact token usage here.
        void complete(0).then(async()=>{
          const afterTokens=ctx.getContextUsage()?.tokens;
          await impact('compact',typeof beforeTokens==='number' && typeof afterTokens==='number'?{beforeTokens,afterTokens}:{});
          pi.sendUserMessage('Continue the existing task from the compacted checkpoint. Keep the current scope and acceptance criteria.');
        }).catch(()=>{localFailure='Compaction accounting was not acknowledged. Check the controller before resuming.';});
      },
      onError:()=>{if(disposed)return;void complete(0,true).catch(()=>{});ctx.ui.notify('Compaction could not complete. The saved session is intact; refresh the budget before resuming.','warning');},
    });
  });
  pi.registerCommand('guard',{
    description:'Activate automatic protection and show limits, reset planning and measured impact',
    handler:async(args,ctx)=>{try{
      let state=await discover(ctx);
      if(args.trim()!=='status'){
        state=await api('/api/policy',{autoTune:true,autoRecover:true});
        const model=ctx.modelRegistry.find('aispend','guard');if(!model || !await pi.setModel(model))throw Error('Guard model could not be activated');
        guardArmed=true;pi.appendEntry('aispend.guard-armed',{armed:true});
      }
      policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));
      const resets=state.resetTimeline.filter((w:any)=>w.windowId.includes('week') || w.provider==='codex').map((w:any)=>`${w.provider}: ${new Date(w.resetAt).toLocaleString()}`).join(' · ');
      const impact=state.impact||{};
      ctx.ui.notify(`${isGuard(ctx)?'Guard active':'Guard status only'} · ${statusLine(state)}\nResets: ${resets || 'awaiting readings'}\nProtection: ${policy.reservePercent}% reserve · ${policy.maxContextTokens.toLocaleString()} context · ${policy.maxTaskMinutes} min/task · ${policy.maxThinkingLevel} effort\nAutomatic repair: ${policy.autoRecover?'on':'off'}, at most ${policy.maxAutoRepairs}/task. Hard budgets never renew automatically.\nImpact: ${impact.removedChars||0} characters trimmed; ~${impact.estimatedInputTokensAvoided||0} input tokens avoided on completed replays; ${impact.loopBlocks||0} repeated tools blocked.\n${state.advice?.reasons?.join(' ') || 'Connected subscriptions are selected automatically. API fallback stays off.'}\n/guard-handoff saves notes. /guard-new starts fresh. /guard status only inspects.\nEvidence and optional settings: ${endpoint.origin}`,'info');
    }catch(error:any){ctx.ui.notify(`Guard could not activate: ${error.message}`,'error');}},
  });
  pi.registerCommand('guard-unlock',{
    description:'Allow direct model selection; direct models bypass Guard request protection',
    handler:async(_args,ctx)=>{await ctx.waitForIdle();guardArmed=false;waitingForAllowance=false;pi.appendEntry('aispend.guard-armed',{armed:false});ctx.ui.notify('Model selection unlocked. Guard still applies while aispend/guard is selected. Selecting a direct model bypasses its request, context, and dollar checks. /guard activates protection again.','warning');},
  });
  pi.registerCommand('guard-handoff',{
    description:'Save bounded goal, progress and checkpoint excerpts locally without a model call',
    handler:async(_args,ctx)=>{await ctx.waitForIdle();try{const saved=saveHandoff(ctx,'User requested a handoff');ctx.ui.notify(`Saved ${saved.file}\nReview these excerpts before /guard-new. No model call was made.`,'info');}catch{ctx.ui.notify('Could not save a handoff. Check local storage; the session is intact.','error');}},
  });
  pi.registerCommand('guard-import',{
    description:'Start fresh from a local Claude/Codex Markdown or text handoff without a model call',
    handler:async(args,ctx)=>{await ctx.waitForIdle();try{const file=resolve(ctx.cwd,args.trim().replace(/^"(.*)"$/,'$1'));const text=readHandoff(file);waitingForAllowance=false;await ctx.newSession({setup:async manager=>{manager.appendMessage({role:'user',content:[{type:'text',text}],timestamp:Date.now()});},withSession:async fresh=>{fresh.ui.notify('Imported bounded handoff into a fresh session. Original session and file preserved. Review it, then send your next instruction through Guard. No model call was made.','info');}});}catch(error:any){ctx.ui.notify(error.message || 'Could not import the handoff. The original session is intact.','error');}},
  });
  pi.registerCommand('guard-new',{
    description:'Start a fresh session with a bounded local handoff; preserve the original session',
    handler:async(_args,ctx)=>{await ctx.waitForIdle();try{const saved=saveHandoff(ctx,'User requested a fresh session');waitingForAllowance=false;const result=await ctx.newSession({setup:async manager=>{manager.appendMessage({role:'user',content:[{type:'text',text:saved.text}],timestamp:Date.now()});}});if(!result.cancelled)ctx.ui.notify(`Fresh session prepared from ${saved.file}. Original session preserved. Review the handoff and send your next instruction; no model request has started.`,'info');}catch{ctx.ui.notify('Could not start a fresh session. The original session is intact.','error');}},
  });
  pi.registerCommand('guard-resume',{
    description:'Resume the saved task after a budget or reset review; keeps existing task counters',
    handler:async(_args,ctx)=>{await ctx.waitForIdle();waitingForAllowance=false;localFailure=undefined;repeatedTools=0;lastTool='';lastOperation='';blockedOperations.clear();persistBlocks();pi.sendUserMessage('Continue the saved task from its latest checkpoint. Preserve the original scope and acceptance criteria.');},
  });
  pi.registerCommand('guard-hold',{
    description:'Cancel automatic resumption while waiting for allowance; /guard-resume continues manually',
    handler:async(_args,ctx)=>{waitingForAllowance=false;ctx.ui.notify('Automatic allowance resumption is on hold. Use /guard-resume when ready.','info');},
  });
}
