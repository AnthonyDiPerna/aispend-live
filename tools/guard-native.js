const {buildPlan,decide,recoveryPlan}=require('./usage-guard');
const {recordImpact}=require('./guard-impact');
const {randomUUID}=require('node:crypto');
const COVERAGE={
  pi:{label:'Pi / Guard',gate:'Every routed model request',automatic:'Routing, effort/output caps, tool trimming, compaction, one loop repair',limits:'Only aispend/guard; in-flight work can overshoot.'},
  claude:{label:'Claude Code hooks',gate:'Prompts, tools and post-tool batches',automatic:'Reserve checks, tool-loop repair, fan-out blocking',limits:'No model routing or output replacement. Request count is a prompt/batch approximation; internal retries and compaction are outside this gate.'},
  codex:{label:'Codex hooks',gate:'Prompts and tools',automatic:'Reserve checks, tool-loop repair, fan-out blocking; model usage reporting',limits:'PreModelRequest is diagnostic only. Cannot stop every model call, clamp effort or compact automatically.'},
  agy:{label:'Antigravity hooks',gate:'Before each invocation and tool',automatic:'Reserve/request/time gates, repeated-failure repair, fan-out blocking',limits:'No routing, automatic compaction, output trimming or exact token/cost telemetry in these hooks.'},
};
function nativeEvent(state,data,now=Date.now()) {
  if(!['claude','codex','agy'].includes(data.harness) || !['prompt','pre-tool','post-tool','request','usage','batch','stop'].includes(data.event))throw Error('Unsupported harness event');
  if(typeof data.eventId!=='string' || !/^[\w-]{8,100}$/.test(data.eventId))throw Error('Invalid event ID');
  const id=data.taskId,task=state.tasks[id] ||= {id,harness:data.harness,requests:0,totalTokens:0,removedChars:0,status:'ready'};
  if(task.harness!==data.harness)throw Error('Harness task mismatch');
  task.seenNative ||= {};
  if(task.seenNative[data.eventId])return task.seenNative[data.eventId];
  const model=String(data.model||'unknown').slice(0,160);
  // Native clients retain their selected model. Routing bindings belong to Pi.
  const plan=buildPlan({...state,bindings:{...state.bindings,[data.harness]:{provider:data.harness,model}}},now);
  const policy=plan.policy;
  const input=()=>({...task,availableProviders:[data.harness],currentProvider:data.harness,continuation:true,contextTokens:0,repeatedTools:0});
  const record=kind=>recordImpact(state,{id:randomUUID(),taskId:id,kind,harness:data.harness},now);
  let result={action:'continue',reason:'Guard checked this supported boundary.',policy};
  const pause=reason=>{task.status='pause';return {action:'pause',reason,policy};};
  if(data.event==='usage'){
    if(Number.isFinite(data.totalTokens) && data.totalTokens>=0 && data.totalTokens<100000000)task.totalTokens+=data.totalTokens;
  }else if(data.event==='post-tool'){
    // AGY exposes errors but no successful tool result: only repeated failures qualify.
    if(data.operation && data.result){
      const digest=data.operation+':'+data.result;
      task.nativeRepeats=digest===task.nativeLastResult?(task.nativeRepeats||0)+1:1;
      task.nativeLastResult=digest;task.nativeLastOperation=data.operation;
    }else {task.nativeRepeats=0;task.nativeLastResult='';}
  }else if(data.event!=='stop'){
    let decision=decide(plan,input(),now);
    if(task.nativePaused)decision={action:'pause',reason:task.nativePaused};
    if(!['continue','switch'].includes(decision.action)){
      result=pause(decision.reason);record('budget-pause');
    }else if(data.event==='pre-tool'){
      const blocked=(task.nativeBlocked||[]).includes(data.operation);
      if(blocked || (data.operation===task.nativeLastOperation && task.nativeRepeats>=policy.repeatedToolLimit-1)){
        task.nativeBlocked=[...new Set([...(task.nativeBlocked||[]),data.operation])].slice(-100);record('loop-block');
        const repair=recoveryPlan(plan,{...input(),repeatedTools:policy.repeatedToolLimit},now);
        if(repair.action==='repair'){
          task.autoRepairs=repair.attempt;record('repair');
          result={action:'deny',repair:true,reason:'Guard automatic recovery: '+repair.reason,policy};
        }else {task.nativePaused=repair.reason;result=pause(repair.reason);}
      }else if(data.subagent){
        if((task.subagentCalls||0)>=policy.maxSubagentCalls){record('subagent-block');result={action:'deny',reason:'Guard blocked agent fan-out. Continue the current task without spawning another agent.',policy};}
        else task.subagentCalls=(task.subagentCalls||0)+1;
      }
    }
    // Codex model hooks cannot block: count attempts even if the decision says pause.
    if(data.event==='request' && (data.harness==='codex' || result.action==='continue') || data.harness==='claude' && ['prompt','batch'].includes(data.event) && result.action==='continue'){
      task.requests++;task.startedAt ||= new Date(now).toISOString();
    }
  }
  task.provider=data.harness;task.updatedAt=new Date(now).toISOString();
  task.seenNative[data.eventId]=result;
  const keys=Object.keys(task.seenNative);for(const key of keys.slice(0,-200))delete task.seenNative[key];
  state.harnesses ||= {};state.harnesses[data.harness]={lastSeenAt:task.updatedAt};
  return result;
}
module.exports={nativeEvent,COVERAGE};
