import {createRequire} from 'node:module';
import {mkdirSync,writeFileSync,existsSync,readdirSync,readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';
import {homedir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {ExtensionAPI, ExtensionContext} from '@earendil-works/pi-coding-agent';

const require = createRequire(import.meta.url);
const {trimToolOutput, signature, DEFAULT_POLICY} = require('../../tools/usage-guard.js');
const {codexObservations} = require('../../tools/usage-guard-server.js');
const {buildHandoff,readHandoff} = require('../../tools/guard-handoff.js');

// Local CLI bridges (official Claude bridge, agy acp bridge) run on the login the
// CLI already holds; Pi has no OAuth token for them, so group them by provider id.
const BRIDGE_PROVIDERS: Record<string,string> = {'claude-code':'claude','antigravity':'agy','antigravity-acp':'agy'};
function group(provider: string) {
  if(BRIDGE_PROVIDERS[provider]) return BRIDGE_PROVIDERS[provider];
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
  let taskRule:{provider:string,model:string|null,match:string}|undefined;
  let waitingForAllowance=false, checking=false;
  let disposed=false;
  let localFailure:string|undefined;
  let lastHandoff:string|undefined;
  let lastPauseKey='',lastPauseAt=0;
  let contextWarned=false;
  let watcher:ReturnType<typeof setInterval>|undefined;
  let guardArmed=false,restoringModel=false,pendingRepair=false,lastOperation='';
  const blockedOperations=new Set<string>();
  const wrappedProviders=new Map<string,any>();
  const originalProvider=Symbol.for('aispend.guard.original-provider');

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
  // Footer: one glance. Subscriptions in priority order with remaining %, the active route marked
  // with its measured burn, then the single next step (run-out, switch, or the next reset).
  const span=(h:number)=>!Number.isFinite(h)||h<0?"?":h<1?Math.max(1,Math.round(h*60))+"m":h<48?Math.round(h)+"h":Math.round(h/24)+"d";
  function statusLine(state:any){
    const labels:any={claude:"Claude",codex:"Codex",agy:"AGY"};
    const order:string[]=state.policy?.providerOrder||["claude","codex","agy"];
    const lowest=(p:any)=>p.windows.filter((w:any)=>w.applies).sort((a:any,b:any)=>a.remainingPercent-b.remainingPercent)[0];
    const rows=order.map(id=>state.providers.find((p:any)=>p.provider===id)).filter(Boolean).map((p:any)=>({p,w:lowest(p)}));
    const cells=rows.map(({p,w})=>{
      const active=p.provider===currentGroup;
      let cell=(active?"▸":"")+labels[p.provider]+" "+(w?Math.max(0,w.remainingPercent).toFixed(0)+"%":"?");
      if(p.status==="depleted")cell+="∅";
      if(p.status==="blocked")cell+="⛔";
      if(active && w && Number.isFinite(w.slopePercentPerHour) && w.slopePercentPerHour>=0.1)cell+=" −"+(w.slopePercentPerHour<1?w.slopePercentPerHour.toFixed(1):Math.round(w.slopePercentPerHour))+"%/h";
      return cell;
    });
    const current=rows.find(r=>r.p.provider===currentGroup);
    const fallback=rows.find(r=>r.p.provider!==currentGroup && r.p.status==="ready" && r.w && r.w.remainingPercent>(state.policy?.reservePercent??10));
    const bridge=rows.find(r=>r.p.provider===state.policy?.bridgeProvider && r.p.provider!==currentGroup);
    let next="";
    if(current && ["depleted","stale","verify-reset"].includes(current.p.status))next=fallback?"switch to "+labels[fallback.p.provider]:"wait for a fresh reading";
    else if(current?.w && Number.isFinite(current.w.depletionHours) && current.w.depletionHours<current.w.hoursLeft)next=labels[current.p.provider]+" runs out in "+span(current.w.depletionHours)+(fallback?", then "+labels[fallback.p.provider]:"");
    else if(bridge?.w)next=labels[bridge.p.provider]+" resets in "+span(bridge.w.hoursLeft);
    else if(current?.w)next=labels[current.p.provider]+" resets in "+span(current.w.hoursLeft);
    const api=Number(state.accounting?.apiEstimateUsd||0);
    const win=state.windows;
    const windows=win && win.active>1?` · ${win.active} windows/${win.slots} slot${win.slots===1?"":"s"}`:"";
    if(win && win.active>win.slots && !next.includes("slot"))next=(next?next+"; ":"")+`${win.active} windows share ${win.slots} slot${win.slots===1?"":"s"}, /guard-windows ${Math.min(8,win.active)}`;
    return "Guard · "+cells.join(" · ")+windows+(next?" · next: "+next:"")+(api>0?" · API $"+api.toFixed(2):"");
  }
  function watch(ctx:ExtensionContext) {
    if(watcher || !ctx.hasUI) return;
    watcher=setInterval(async()=>{
      if(checking || !isGuard(ctx) || !ctx.isIdle()) return;
      checking=true;
      try {
        const state=await api('/api/state?task='+taskId);policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));
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
  function modelGroup(ctx:ExtensionContext,model:any){const g=group(model.provider);return g && (BRIDGE_PROVIDERS[model.provider] || ctx.modelRegistry.isUsingOAuth(model))?g:'api';}
  function guardProviderOptions(ctx:ExtensionContext,id:string){
    if(wrappedProviders.has(id) && ctx.modelRegistry.getRegisteredNativeProvider(id)===wrappedProviders.get(id))return;
    const registered:any=ctx.modelRegistry.getProvider(id);
    if(!registered)throw Error('Selected provider disappeared before dispatch');
    const original=registered[originalProvider] || registered;
    // Pi 1.5 resolves router models back through its catalog, discarding cloned
    // maxTokens fields. Apply the ceiling to the provider's actual call options.
    // Providers may have no server-side output limit (notably Codex subscription).
    const wrap=(method:'stream'|'streamSimple')=>(model:any,context:any,options:any={})=>{
      if(disposed || !activeLease)return original[method](model,context,options);
      const ceiling=Math.min(model.maxTokens>0?model.maxTokens:Infinity,policy.maxOutputTokens,options.maxTokens>0?options.maxTokens:Infinity);
      return original[method]({...model,maxTokens:ceiling},context,{...options,maxTokens:ceiling});
    };
    const wrapped={...original,[originalProvider]:original,stream:wrap('stream'),streamSimple:wrap('streamSimple')};
    pi.registerProvider(wrapped);wrappedProviders.set(id,wrapped);
  }
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
    if(reason===lastPauseKey && Date.now()-lastPauseAt<60000)return true; // same pause repeating: keep the first handoff
    lastPauseKey=reason;lastPauseAt=Date.now();
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
    taskId=signature(ctx.sessionManager.getSessionId());taskRule=undefined;contextWarned=false;
    watch(ctx);
    try {const state=await discover(ctx);policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));}
    catch {ctx.ui.setStatus('aispend','Start AI Spend Guard on port 9021 · /guard');}
    if(guardArmed && !isGuard(ctx)){const model=ctx.modelRegistry.find('aispend','guard');if(model)await pi.setModel(model);}
    try{const recent=blastOffPoints(1)[0];const fresh=!ctx.sessionManager.getEntries().some((e:any)=>e.type==='message');
      if(recent && fresh && ctx.hasUI && Date.now()-recent.savedAt<48*3600000)ctx.ui.notify(`Checkpoint available (${age(recent.savedAt)}): "${recent.goal}". /guard-start continues from it instead of starting cold.`,'info');}catch{}
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
        preferredProvider:taskRule?.provider,preferredModel:taskRule?.model||undefined,
      }).catch(error=>{throw new Error(`AI Spend Guard billing guard paused: controller unavailable (${error.message}). Start the local controller; no provider request was authorized.`);});
      policy=decision.policy || policy;
      if(decision.autoFixNote)ctx.ui.notify(decision.autoFixNote,'info');
      if(decision.contextAdvisory && !contextWarned){contextWarned=true;ctx.ui.notify(decision.contextAdvisory,'warning');}
      if(decision.action==='compact') {
        pendingCompact=!compactedThisRun;
      void api('/api/learning',{action:'lesson',code:'context-stuck',taskId}).catch(()=>{});
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
      guardProviderOptions(ctx,model.provider);
      return {model,thinkingLevel};
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
    description:'Activate Guard; continuous, preserve, max, strict, or status. Shows limits, banked resets and impact',
    handler:async(args,ctx)=>{try{
      const choice=args.trim().toLowerCase();
      if(!['','status','continuous','preserve','max','strict'].includes(choice))throw Error('Use /guard, /guard continuous, /guard preserve, /guard max, /guard strict, or /guard status');
      let state=await discover(ctx);
      if(choice!=='status'){
        state=await api('/api/policy',{autoTune:true,autoRecover:true,...(choice?{usageMode:choice}:{})});
        const model=ctx.modelRegistry.find('aispend','guard');if(!model || !await pi.setModel(model))throw Error('Guard model could not be activated');
        guardArmed=true;pi.appendEntry('aispend.guard-armed',{armed:true});
      }
      policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));
      const resets=state.resetTimeline.filter((w:any)=>w.windowId.includes('week') || w.provider==='codex').map((w:any)=>`${w.provider}: ${new Date(w.resetAt).toLocaleString()}`).join(' · ');
      const impact=state.impact||{};
      const credits=(state.resetCredits||[]).filter((c:any)=>c.availableCount!==null).map((c:any)=>`${c.provider}: ${c.usableCount} banked (${c.status})${c.nextExpiryAt?', expires '+new Date(c.nextExpiryAt).toLocaleString():''}`).join(' · ');
      ctx.ui.notify(`Mode: ${policy.usageMode}. ${policy.usageMode==='strict'?'Reserve and pace are hard gates.':'Fresh positive allowance stays usable; pace is a warning.'}\n${state.bridge?'Plan toward '+state.bridge.provider+' returning '+new Date(state.bridge.targetAt).toLocaleString()+'. Refill must be confirmed.':'Use connected subscriptions in your preferred order.'}\n${credits || 'Banked resets: inventory not reported.'}\nRedeem a credit in the provider (Codex /usage); Guard confirms the new allowance. /guard preserve stretches use; /guard max prioritizes available allowance.`, 'info');
      ctx.ui.notify(`${isGuard(ctx)?'Guard active':'Guard status only'} · ${statusLine(state)}\nResets: ${resets || 'awaiting readings'}\nProtection: ${policy.reservePercent}% reserve ${policy.usageMode==='strict'?'gate':'target'} · ${policy.maxContextTokens.toLocaleString()} context · ${policy.maxTaskMinutes} min/task · ${policy.maxThinkingLevel} effort\nAutomatic repair: ${policy.autoRecover?'on':'off'}, at most ${policy.maxAutoRepairs}/task. Hard budgets never renew automatically.\nImpact: ${impact.removedChars||0} characters trimmed; ~${impact.estimatedInputTokensAvoided||0} input tokens avoided on completed replays; ${impact.loopBlocks||0} repeated tools blocked.\n${state.advice?.reasons?.join(' ') || 'Connected subscriptions are selected automatically. API fallback stays off.'}\n/guard-handoff saves notes. /guard-new starts fresh. /guard status only inspects.\nEvidence and optional settings: ${endpoint.origin}`,'info');
    }catch(error:any){ctx.ui.notify(`Guard could not activate: ${error.message}`,'error');}},
  });
  // Priority order: pick in a list (mouse-clickable in fullscreen Pi, arrows otherwise), name it, or let
  // "auto" apply use-it-or-lose-it: usable allowances first, soonest reset first; unusable ones last.
  // Model aliases a person would type. Resolved against the models Pi actually has at request time.
  const MODEL_ALIASES:Record<string,[string,string|null]>={argon:['agy','argon'],hydrogen:['agy','hydrogen'],flash:['agy','flash'],gemini:['agy',null],antigravity:['agy',null],agy:['agy',null],
    opus:['claude','opus'],fable:['claude','fable'],sonnet:['claude','sonnet'],haiku:['claude','haiku'],claude:['claude',null],
    sol:['codex','sol'],luna:['codex','luna'],astra:['codex','astra'],codex:['codex',null],gpt:['codex',null],openai:['codex',null]};
  function matchRule(text:string){
    const t=text.toLowerCase();
    const hit=(policy.routingRules||[]).filter((r:any)=>t.includes(r.match)).sort((a:any,b:any)=>b.match.length-a.match.length)[0];
    return hit?{provider:hit.provider,model:hit.model,match:hit.match}:undefined;
  }
  // "all translations use argon", "website updates -> argon", "code changes on opus"
  function parseRuleRequest(text:string):{match:string,provider:string,model:string|null}|null{
    const t=text.trim().toLowerCase();
    if(t.length>120 || t.startsWith('/'))return null;
    const m=/^(?:all |every |any )?(.{2,60}?)\s+(?:should |always |must )?(?:use|uses|go to|goes to|run on|runs on|on|with|->|=>|→)\s+(?:the )?([a-z0-9. -]{2,40})$/.exec(t);
    if(!m)return null;
    const alias=m[2].replace(/\b(model|models|please)\b/g,'').trim().split(/\s+/)[0];
    const target=MODEL_ALIASES[alias];if(!target)return null;
    const match=m[1].replace(/^(my|the|our)\s+/,'').replace(/\s+(tasks?|work|requests?|changes?|updates?)$/,(s)=>s).trim();
    if(match.length<2)return null;
    return {match,provider:target[0],model:target[1]};
  }
  async function saveRule(rule:{match:string,provider:string,model:string|null},ctx:ExtensionContext){
    const rules=[...(policy.routingRules||[]).filter((r:any)=>r.match!==rule.match),rule].slice(-20);
    const state=await api('/api/policy',{routingRules:rules});policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));
    ctx.ui.notify(`Rule saved: "${rule.match}" → ${ORDER_LABELS[rule.provider]}${rule.model?' ('+rule.model+')':''}. Applies to new tasks whose first message mentions it; matched locally, never sent to a model. /guard-rule list shows all.`,'info');
  }
  const ORDER_LABELS:any={claude:'Claude',codex:'Codex',agy:'AGY (Antigravity)'};
  async function setOrder(order:string[],why:string,ctx:ExtensionContext){
    const state=await api('/api/policy',{providerOrder:order});policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));
    ctx.ui.notify(`Priority: ${order.map(id=>ORDER_LABELS[id]).join(' > ')}. ${why}Routing follows this order from the next request; the footer shows it left to right.`,'info');
  }
  // Plain-text priority requests ("use agy then codex then claude", "codex first", "prefer claude over codex")
  // are applied locally and never sent to a model. Only short, idle, typed messages qualify.
  const ALIASES:[RegExp,string][]=[[/\b(claude|anthropic|fable|opus|sonnet)\b/g,'claude'],[/\b(codex|openai|gpt|chatgpt)\b/g,'codex'],[/\b(agy|antigravity|gemini|argon|google)\b/g,'agy']];
  function parseOrderRequest(text:string):string[]|null{
    const t=text.trim().toLowerCase();
    if(t.length>140 || t.split(String.fromCharCode(10)).length>1 || t.startsWith('/'))return null;
    if(!/\b(use|prefer|priority|prioriti[sz]e|order|first|then|before|over|switch to|route)\b/.test(t))return null;
    // Reject sentences that look like real work rather than a routing preference.
    if(/\b(fix|write|edit|build|run|test|implement|refactor|add|remove|create|explain|why|how|what|which|where|\?)\b/.test(t))return null;
    const hits:{at:number,id:string}[]=[];
    for(const [re,id] of ALIASES){let m;re.lastIndex=0;while((m=re.exec(t)))hits.push({at:m.index,id});}
    const seen=[...new Set(hits.sort((a,b)=>a.at-b.at).map(h=>h.id))];
    if(seen.length<2 && !/\bfirst\b/.test(t))return null;
    if(seen.length<1)return null;
    // "prefer X over Y" / "X before Y" keep X first; "then" keeps appearance order.
    const rest=(policy.providerOrder||['claude','codex','agy']).filter((id:string)=>!seen.includes(id));
    return [...seen,...rest];
  }
  pi.on('input',async(event:any,ctx:ExtensionContext)=>{
    if(event.source!=='interactive' || event.streamingBehavior || event.images?.length)return {action:'continue'};
    const t=event.text.trim().toLowerCase();
    const block=t.length<=80 && !t.startsWith('/') && /^(block|don'?t (touch|use)|do not (touch|use)|no|stop using|unblock)\b/.test(t)?t:null;
    if(block){
      const ids=[...new Set([...block.matchAll(/\b(claude|codex|agy|antigravity|gemini|argon)\b/g)].map(m=>/^(agy|antigravity|gemini|argon)$/.test(m[1])?'agy':m[1]))];
      if(ids.length){const clear=block.startsWith('unblock');const next=clear?(policy.blockedProviders||[]).filter((b:string)=>!ids.includes(b)):[...new Set([...(policy.blockedProviders||[]),...ids])].slice(0,2);
        try{const state=await api('/api/policy',{blockedProviders:next});policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));ctx.ui.notify((next.length?'Blocked: '+next.map((b:string)=>ORDER_LABELS[b]).join(', '):'No subscription is blocked.')+' Set from your message without a model call.','info');}
        catch(error:any){ctx.ui.notify(`Guard block not changed: ${error.message}`,'error');}
        return {action:'handled'};}
    }
    const win=/^(?:allow |use |run |i have |we have )?(\d)\s+(?:pi\s+)?windows?(?:\s+(?:open|at once|now))?\.?$/.exec(event.text.trim().toLowerCase());
    if(win){try{await setWindows(parseInt(win[1],10),ctx);}catch(error:any){ctx.ui.notify(`Guard windows not changed: ${error.message}`,'error');}return {action:'handled'};}
    const ruleRequest=parseRuleRequest(event.text);
    if(ruleRequest){try{await saveRule(ruleRequest,ctx);}catch(error:any){ctx.ui.notify(`Guard rule not saved: ${error.message}`,'error');}return {action:'handled'};}
    const order=parseOrderRequest(event.text);
    if(!order){
      // Ordinary work: a matching rule steers this task from its next request on.
      const rule=matchRule(event.text);
      if(rule && (taskRule?.provider!==rule.provider || taskRule?.model!==rule.model)){taskRule=rule;ctx.ui.notify(`Rule "${rule.match}": routing this task to ${ORDER_LABELS[rule.provider]}${rule.model?' ('+rule.model+')':''}.`,'info');}
      return {action:'continue'};
    }
    try{await setOrder(order,'Set from your message without a model call. ',ctx);}
    catch(error:any){ctx.ui.notify(`Guard order not changed: ${error.message}`,'error');}
    return {action:'handled'};
  });
  pi.registerCommand('guard-order',{
    description:'Set subscription priority: pick from a list, /guard-order auto (soonest reset with usable allowance first), or /guard-order codex claude agy',
    handler:async(args,ctx)=>{try{
      const labels:any={claude:'Claude',codex:'Codex',agy:'AGY (Antigravity)'};
      const ids=Object.keys(labels);
      let state=await discover(ctx);
      const words=args.trim().toLowerCase().split(/[s,>]+/).filter(Boolean);
      let order:string[]=[],why='';
      if(words[0]==='auto'){
        const reserve=state.policy?.reservePercent??10;
        const rank=(id:string)=>{const p=state.providers.find((x:any)=>x.provider===id);const w=p?.windows?.filter((x:any)=>x.applies).sort((a:any,b:any)=>a.remainingPercent-b.remainingPercent)[0];
          const usable=Boolean(w) && w.remainingPercent>reserve && !['depleted','stale','verify-reset'].includes(p.status);
          return {id,usable,hours:w?w.hoursLeft:Infinity};};
        order=ids.map(rank).sort((a,b)=>Number(b.usable)-Number(a.usable) || a.hours-b.hours).map(r=>r.id);
        why='Use-it-or-lose-it: usable allowances first, the one that resets soonest in front; unusable ones wait at the back.';
      } else if(words.length){
        order=words.map(w=>w.startsWith('ag')||w.startsWith('ant')?'agy':w);
        if(order.length!==3 || new Set(order).size!==3 || order.some(o=>!ids.includes(o)))throw Error('Name all three once: /guard-order codex claude agy');
      } else {
        if(!ctx.hasUI)throw Error('Pick interactively, or /guard-order codex claude agy');
        const remaining=[...ids];
        for(const slot of ['first','second']){
          const choice=await ctx.ui.select(`Which subscription ${slot}?`,remaining.map(id=>labels[id]));
          if(!choice)return;
          const id=remaining.find(x=>labels[x]===choice)!;order.push(id);remaining.splice(remaining.indexOf(id),1);
        }
        order.push(remaining[0]);
      }
      await setOrder(order,why,ctx);
    }catch(error:any){ctx.ui.notify(`Guard order not changed: ${error.message}`,'error');}},
  });
  // Saved handoffs are the durable memory between sessions. List the newest per task with its goal
  // so work continues from a checkpoint instead of restarting with no context.
  function blastOffPoints(limit=8){
    if(!existsSync(artifacts))return [];
    const byTask=new Map<string,{file:string,task:string,savedAt:number,goal:string,reason:string}>();
    for(const name of readdirSync(artifacts)){
      const m=/^handoff-([0-9a-f]+)-(\d+)\.md$/.exec(name);if(!m)continue;
      const savedAt=Number(m[2]);const prev=byTask.get(m[1]);if(prev && prev.savedAt>=savedAt)continue;
      let text='';try{text=readFileSync(join(artifacts,name),'utf8').slice(0,6000);}catch{continue;}
      const goal=(/## Original goal\s+([\s\S]*?)(?:\n## |$)/.exec(text)?.[1]||'').replace(/\s+/g,' ').trim().slice(0,140);
      const reason=(/Reason: ([^\n]*)/.exec(text)?.[1]||'').replace(/\.+$/,'').slice(0,80);
      byTask.set(m[1],{file:join(artifacts,name),task:m[1].slice(0,8),savedAt,goal:goal||'(no goal excerpt)',reason});
    }
    return [...byTask.values()].sort((a,b)=>b.savedAt-a.savedAt).slice(0,limit);
  }
  const age=(ms:number)=>{const h=(Date.now()-ms)/3600000;return h<1?Math.max(1,Math.round(h*60))+'m ago':h<48?Math.round(h)+'h ago':Math.round(h/24)+'d ago';};
  pi.registerCommand('guard-start',{
    description:'Continue from a saved checkpoint: lists recent handoffs (newest per task) and opens a fresh session from the one you pick',
    handler:async(_args,ctx)=>{await ctx.waitForIdle();try{
      const points=blastOffPoints();
      if(!points.length){ctx.ui.notify('No saved handoffs yet. Guard writes one at every pause, and /guard-handoff saves one on demand.','info');return;}
      if(!ctx.hasUI)throw Error('Pick interactively, or /guard-import <file>');
      const labels=points.map(p=>`${age(p.savedAt)} · ${p.goal}${p.reason?' · paused: '+p.reason:''}`);
      const choice=await ctx.ui.select('Continue from which checkpoint?',labels);
      if(!choice)return;
      const point=points[labels.indexOf(choice)];
      const text=readHandoff(point.file);waitingForAllowance=false;
      await ctx.newSession({setup:async manager=>{manager.appendMessage({role:'user',content:[{type:'text',text}],timestamp:Date.now()});},withSession:async fresh=>{fresh.ui.notify(`Blast-off from a checkpoint saved ${age(point.savedAt)}. Review the excerpts, then send your next instruction through Guard. No model call was made.`,'info');}});
    }catch(error:any){ctx.ui.notify(error.message||'Could not open the checkpoint. The current session is intact.','error');}},
  });
  async function setWindows(n:number,ctx:ExtensionContext){
    if(!Number.isInteger(n) || n<1 || n>8)throw Error('Choose 1 to 8 concurrent guarded requests');
    const state=await api('/api/policy',{maxConcurrentRequests:n});policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));
    const open=state.windows?.active||1;
    ctx.ui.notify(`${n} guarded request${n===1?'':'s'} may run at once across all Pi windows (${open} open now). Each window keeps its own task budget; allowance readings and the reserve are shared. More slots means faster burn of the same subscription.`,'info');
  }
  pi.registerCommand('guard-lessons',{
    description:'What Guard learned: recent adjustments with reasons and undo ids, and per-route scores',
    handler:async(args,ctx)=>{try{
      const undoId=/^undo\s+(\S+)$/i.exec(args.trim());
      const view=undoId?await api('/api/learning',{action:'undo',id:undoId[1]}):(await api('/api/state?task='+taskId)).learning;
      const adj=(view.adjustments||[]).slice(-6).map((a:any)=>`${a.undoneAt?'(undone) ':''}${a.key}: ${Array.isArray(a.from)?a.from.join(','):a.from} → ${Array.isArray(a.to)?a.to.join(','):a.to} · ${a.reason}${a.undoneAt?'':' · /guard-lessons undo '+a.id}`);
      const routes=(view.routeScores||[]).slice(0,6).map((r:any)=>`${r.route}: ${r.requests} req, ${r.tokensPerRequest===null?'?':r.tokensPerRequest.toLocaleString()} tok/req, ${r.pauses} pauses, ${r.compactions} compactions, ${r.loopBlocks} loop blocks`);
      ctx.ui.notify((adj.length?'Adjustments:\n'+adj.join('\n'):'No adjustments yet. Guard learns from pauses you renew, compactions that cannot land, and completed requests.')+'\n\nRoutes (7 days):\n'+(routes.join('\n')||'no completed guarded requests yet'),'info');
    }catch(error:any){ctx.ui.notify(`Guard lessons unavailable: ${error.message}`,'error');}},
  });
  pi.registerCommand('guard-windows',{
    description:'How many Pi windows may make guarded requests at the same time (1-8); /guard-windows shows the count',
    handler:async(args,ctx)=>{try{
      const n=parseInt(args.trim(),10);
      if(!args.trim()){const state=await api('/api/state?task='+taskId);const w=state.windows||{active:1,slots:policy.maxConcurrentRequests};ctx.ui.notify(`${w.active} window${w.active===1?'':'s'} open, ${w.slots} slot${w.slots===1?'':'s'}, ${w.inFlight||0} request${w.inFlight===1?'':'s'} in flight. /guard-windows N sets the slots.`,'info');return;}
      await setWindows(n,ctx);
    }catch(error:any){ctx.ui.notify(`Guard windows not changed: ${error.message}`,'error');}},
  });
  pi.registerCommand('guard-rule',{
    description:'Task routing rules: /guard-rule translations -> argon, /guard-rule list, /guard-rule remove translations',
    handler:async(args,ctx)=>{try{
      const text=args.trim();
      if(!text || /^list$/i.test(text)){const rules=policy.routingRules||[];ctx.ui.notify(rules.length?rules.map((r:any)=>`"${r.match}" → ${ORDER_LABELS[r.provider]}${r.model?' ('+r.model+')':''}`).join('\n'):'No routing rules. Try: /guard-rule translations -> argon','info');return;}
      const rm=/^(?:remove|delete|clear)\s+(.+)$/i.exec(text);
      if(rm){const key=rm[1].trim().toLowerCase();const rules=(policy.routingRules||[]).filter((r:any)=>r.match!==key);const state=await api('/api/policy',{routingRules:rules});policy=state.policy;ctx.ui.notify(`Removed rule "${key}".`,'info');return;}
      const rule=parseRuleRequest(text.includes('->')||text.includes('→')?text:text.replace(/\s+(use|on|with)\s+/,' -> '));
      if(!rule)throw Error('Use: /guard-rule <what> -> <argon|opus|fable|sonnet|sol|luna|claude|codex|agy>');
      await saveRule(rule,ctx);
    }catch(error:any){ctx.ui.notify(`Guard rule not saved: ${error.message}`,'error');}},
  });
  pi.registerCommand('guard-block',{
    description:'Block a subscription from routing (/guard-block claude); /guard-block none clears',
    handler:async(args,ctx)=>{try{
      const words=args.trim().toLowerCase().split(/[s,]+/).filter(Boolean).map(w=>w.startsWith('ag')||w.startsWith('ant')||w.startsWith('gem')?'agy':w);
      const blocked=words.includes('none')?[]:words;
      if(blocked.some(b=>!['claude','codex','agy'].includes(b)))throw Error('Use /guard-block claude, /guard-block codex agy, or /guard-block none');
      const state=await api('/api/policy',{blockedProviders:blocked});policy=state.policy;ctx.ui.setStatus('aispend',statusLine(state));
      ctx.ui.notify(blocked.length?`Blocked: ${blocked.map(b=>ORDER_LABELS[b]).join(', ')}. Guard pauses instead of routing there. /guard-block none clears.`:'No subscription is blocked.','info');
    }catch(error:any){ctx.ui.notify(`Guard block not changed: ${error.message}`,'error');}},
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
