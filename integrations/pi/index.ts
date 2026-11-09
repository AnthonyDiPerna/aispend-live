import {createRequire} from 'node:module';
import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';

const require = createRequire(import.meta.url);
const {trimToolOutput, signature, DEFAULT_POLICY} = require('../../tools/usage-guard.js');
const {codexObservations} = require('../../tools/usage-guard-server.js');

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
  let watcher:ReturnType<typeof setInterval>|undefined;

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
  function checkpoint(ctx:ExtensionContext,reason:string) {
    pi.appendEntry('aispend.guard-checkpoint',{taskId,reason,at:new Date().toISOString()});
    ctx.ui.setStatus('aispend',`Guard paused: ${reason}`);
  }

  pi.on('session_start',async(_event,ctx)=>{
    disposed=false;
    waitingForAllowance=false;repeatedTools=0;lastTool='';currentGroup=undefined;
    if(watcher){clearInterval(watcher);watcher=undefined;}
    taskId=signature(ctx.sessionManager.getSessionId());
    watch(ctx);
    try {const state=await discover(ctx);policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));}
    catch {ctx.ui.setStatus('aispend','Start AI Spend Guard on port 9021 · /guard');}
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
      ctx.ui.setStatus('aispend',`Guard · ${decision.provider} · ${model.id}`);
      const levels=['off','minimal','low','medium','high','xhigh','max','ultra'];
      const requested=levels.includes(request.thinkingLevel)?request.thinkingLevel:'medium';
      const thinkingLevel=levels[Math.min(levels.indexOf(requested),levels.indexOf(policy.maxThinkingLevel))] as any;
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
    if(!isGuard(ctx) || !/^(subagent|subagents|spawn_agent|delegate|agent|task)$/i.test(event.toolName))return;
    try{const result=await api('/api/subagent',{taskId});if(!result.allowed)return {block:true,reason:result.reason};}
    catch{return {block:true,reason:'Guard could not authorize a subagent.'};}
  });
  pi.on('tool_result',async(event,ctx)=>{
    if(!isGuard(ctx)) return;
    const digest=signature({tool:event.toolName,input:event.input,result:event.content,isError:event.isError});
    repeatedTools=digest===lastTool?repeatedTools+1:1;lastTool=digest;
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
    removedChars+=trimmed.removedChars;
    return {content:trimmed.content};
  });
  pi.on('turn_end',async(_event,ctx)=>{
    if(!isGuard(ctx))return;
    if(localFailure){checkpoint(ctx,localFailure);return {continue:false};}
    if((ctx.getContextUsage()?.tokens || 0)<policy.maxContextTokens*0.8) compactedThisRun=false;
    if(repeatedTools>=policy.repeatedToolLimit){waitingForAllowance=false;checkpoint(ctx,'Repeated identical tool results');return {continue:false};}
    if((ctx.getContextUsage()?.tokens || 0)>policy.maxContextTokens && !compactedThisRun){pendingCompact=true;return {continue:false};}
  });
  pi.on('agent_end',async(_event,ctx)=>{
    if(activeLease) await complete(0,true).catch(()=>{});
    if(!pendingCompact || !isGuard(ctx))return;
    pendingCompact=false;compactedThisRun=true;
    checkpoint(ctx,'Automatic context checkpoint');
    ctx.compact({
      customInstructions:'Preserve the user goal, unfinished acceptance criteria, changed files, failing checks, commands needed next, and decisions. Drop obsolete tool output and completed exploration. Do not claim unfinished work is done.',
      onComplete:()=>{
        if(disposed)return;
        // Compaction is counted as a request. Pi does not expose its exact token usage here.
        void complete(0).catch(()=>{}).then(()=>pi.sendUserMessage('Continue the existing task from the compacted checkpoint. Keep the current scope and acceptance criteria.'));
      },
      onError:()=>{if(disposed)return;void complete(0,true).catch(()=>{});ctx.ui.notify('Compaction could not complete. The saved session is intact; refresh the budget before resuming.','warning');},
    });
  });
  pi.registerCommand('guard',{
    description:'Connect to AI Spend Guard, discover subscription models, and show reset planning',
    handler:async(_args,ctx)=>{try{const state=await discover(ctx);policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));const resets=state.resetTimeline.filter((w:any)=>w.windowId.includes('week') || w.provider==='codex').map((w:any)=>`${w.provider}: ${new Date(w.resetAt).toLocaleString()}`).join(' · ');ctx.ui.notify(`${statusLine(state)}\nResets: ${resets || 'awaiting readings'}\nConfigure models and budgets: ${endpoint.origin}`,'info');}catch(error:any){ctx.ui.notify(`Start the local guard controller: ${error.message}`,'error');}},
  });
  pi.registerCommand('guard-resume',{
    description:'Resume the saved task after a budget or reset review; keeps existing task counters',
    handler:async(_args,ctx)=>{await ctx.waitForIdle();waitingForAllowance=false;localFailure=undefined;repeatedTools=0;lastTool='';pi.sendUserMessage('Continue the saved task from its latest checkpoint. Preserve the original scope and acceptance criteria.');},
  });
  pi.registerCommand('guard-hold',{
    description:'Cancel automatic resumption while waiting for allowance; /guard-resume continues manually',
    handler:async(_args,ctx)=>{waitingForAllowance=false;ctx.ui.notify('Automatic allowance resumption is on hold. Use /guard-resume when ready.','info');},
  });
}
