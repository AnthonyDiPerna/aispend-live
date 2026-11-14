// Policy is deterministic. Token counts never stand in for subscription allowance.
const crypto = require('node:crypto');

const HOUR = 3600000;
const DEFAULT_POLICY = Object.freeze({
  usageMode: 'continuous',
  bridgeProvider: 'claude',
  reservePercent: 10,
  freshnessMinutes: 15,
  maxRequestsPerTask: 40,
  maxTokensPerTask: 8000000,
  maxContextTokens: 120000,
  maxToolOutputChars: 16000,
  repeatedToolLimit: 3,
  maxConcurrentRequests: 1,
  maxTaskMinutes: 60,
  autoTune: true,
  autoRecover: true,
  maxAutoRepairs: 1,
  maxThinkingLevel: 'medium',
  maxSubagentCalls: 0,
  allowApiSpend: false,
  apiDailyBudgetUsd: 0,
  apiTaskBudgetUsd: 0,
  maxOutputTokens: 4096,
  providerOrder: ['claude', 'codex', 'agy'],
  blockedProviders: [],
  routingRules: [],
  contextAdvisoryProviders: ['antigravity', 'antigravity-acp'],
});
const PROVIDERS = ['claude', 'codex', 'agy', 'api'];
const LIMITS = {
  reservePercent: [0, 50], freshnessMinutes: [5, 1440],
  maxRequestsPerTask: [1, 1000], maxTokensPerTask: [10000, 100000000],
  maxContextTokens: [8000, 1000000], maxToolOutputChars: [2000, 100000],
  repeatedToolLimit: [2, 10], maxConcurrentRequests: [1, 8],
  maxTaskMinutes: [5, 1440], maxSubagentCalls: [0, 20],
  maxAutoRepairs: [0, 3],
  apiDailyBudgetUsd: [0, 1000], apiTaskBudgetUsd: [0, 1000], maxOutputTokens: [512, 32000],
};

function cleanPolicy(input = {}) {
  const result = {...DEFAULT_POLICY};
  if(input.usageMode!==undefined){if(!['continuous','preserve','max','strict'].includes(input.usageMode))throw Error('Invalid usage mode');result.usageMode=input.usageMode;}
  if(input.bridgeProvider!==undefined){if(!['claude','codex','agy'].includes(input.bridgeProvider))throw Error('Invalid bridge provider');result.bridgeProvider=input.bridgeProvider;}
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (input[key] === undefined) continue;
    if (!Number.isFinite(input[key]) || input[key] < min || input[key] > max) throw new Error(`Invalid ${key}: expected ${min} to ${max}`);
    result[key] = input[key];
  }
  if (input.providerOrder !== undefined) {
    if (!Array.isArray(input.providerOrder) || input.providerOrder.length !== 3 || new Set(input.providerOrder).size !== 3 || input.providerOrder.some(p=>!['claude','codex','agy'].includes(p))) throw new Error('providerOrder must contain claude, codex, and agy once each');
    result.providerOrder = [...input.providerOrder];
  }
  if (input.blockedProviders !== undefined) {
    if (!Array.isArray(input.blockedProviders) || input.blockedProviders.some(p=>!['claude','codex','agy'].includes(p)) || input.blockedProviders.length>2) throw new Error('blockedProviders may list up to two of claude, codex, agy');
    result.blockedProviders = [...new Set(input.blockedProviders)];
  }
  if (input.contextAdvisoryProviders !== undefined) {
    if (!Array.isArray(input.contextAdvisoryProviders) || input.contextAdvisoryProviders.length > 10 || input.contextAdvisoryProviders.some(p => !/^[a-z0-9._:\/-]{2,80}$/.test(String(p)))) throw new Error('contextAdvisoryProviders must list provider ids');
    result.contextAdvisoryProviders = [...new Set(input.contextAdvisoryProviders.map(String))];
  }
  if (input.routingRules !== undefined) {
    if (!Array.isArray(input.routingRules) || input.routingRules.length > 20) throw new Error('routingRules may hold up to 20 rules');
    result.routingRules = input.routingRules.map(rule => {
      const match = String(rule?.match || '').trim().toLowerCase();
      if (match.length < 2 || match.length > 60 || !['claude','codex','agy'].includes(rule?.provider)) throw new Error('Each rule needs match text (2-60 chars) and a provider: claude, codex, agy');
      const model = rule.model === undefined || rule.model === null || rule.model === '' ? null : String(rule.model).trim().toLowerCase();
      if (model !== null && !/^[a-z0-9._:\/-]{2,80}$/.test(model)) throw new Error('Rule model must be a model id or alias');
      return {match, provider: rule.provider, model};
    });
  }
  if(input.allowApiSpend!==undefined){if(typeof input.allowApiSpend!=='boolean')throw Error('allowApiSpend must be true or false');result.allowApiSpend=input.allowApiSpend;}
  if(input.autoTune!==undefined){if(typeof input.autoTune!=='boolean')throw Error('autoTune must be true or false');result.autoTune=input.autoTune;}
  if(input.autoRecover!==undefined){if(typeof input.autoRecover!=='boolean')throw Error('autoRecover must be true or false');result.autoRecover=input.autoRecover;}
  if(!Number.isInteger(result.maxAutoRepairs))throw Error('maxAutoRepairs must be an integer');
  if(input.maxThinkingLevel!==undefined){if(!['off','low','medium','high'].includes(input.maxThinkingLevel))throw Error('Invalid thinking ceiling');result.maxThinkingLevel=input.maxThinkingLevel;}
  return result;
}

function observation(input, now = Date.now()) {
  if (!input || !PROVIDERS.includes(input.provider)) throw new Error('Unknown provider');
  const usedPercent = input.usedPercent;
  if (typeof usedPercent !== 'number' || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100) throw new Error('Used percentage must be between 0 and 100');
  const reset = Date.parse(input.resetAt);
  const measured = Date.parse(input.observedAt);
  if (!Number.isFinite(reset) || !Number.isFinite(measured) || measured > now + 60000 || measured > reset) throw new Error('Invalid reset or observation time');
  const windowMinutes = input.windowMinutes;
  if (!Number.isFinite(windowMinutes) || windowMinutes < 1 || windowMinutes > 44640) throw new Error('Invalid window duration');
  if (reset - measured > (windowMinutes + 60) * 60000) throw new Error('Reset is outside this allowance window');
  const windowId = String(input.windowId || (windowMinutes >= 1440 ? 'weekly' : 'session'));
  if (!/^[a-zA-Z0-9_.:-]{1,80}$/.test(windowId)) throw new Error('Invalid window identifier');
  return {
    provider: input.provider, windowId, windowMinutes, usedPercent,
    resetAt: new Date(reset).toISOString(), observedAt: new Date(measured).toISOString(),
    source: ['codex-log', 'codex-rpc', 'claude-log', 'claude-usage', 'agy-cli', 'provider', 'manual', 'demo'].includes(input.source) ? input.source : 'manual',
    ...(['opus','sonnet','haiku','fable','gemini','gemini-argon','claude-gpt'].includes(input.modelFamily)?{modelFamily:input.modelFamily}:{}),
  };
}

function mergeObservations(previous, incoming, now = Date.now()) {
  const map = new Map();
  for (const row of [...previous, ...incoming.map(v=>observation(v, now))]) {
    if (Date.parse(row.observedAt) < now - 31 * 24 * HOUR) continue;
    map.set([row.provider, row.windowId, row.resetAt, row.observedAt].join('|'), row);
  }
  return [...map.values()].sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt)).slice(-2000);
}

function windowPlan(samples, policy, now, targetAt = null) {
  const latest = samples[samples.length-1];
  const resetMs = Date.parse(latest.resetAt);
  const ageMinutes = (now-Date.parse(latest.observedAt))/60000;
  const hoursLeft = Math.max(0, (resetMs-now)/HOUR);
  const remainingPercent = 100-latest.usedPercent;
  const usablePercent = Math.max(0, remainingPercent-policy.reservePercent);
  const planningHours = Math.max(0,(Math.min(resetMs,targetAt || resetMs)-now)/HOUR);
  const expired = resetMs <= now;
  const stale = ageMinutes > policy.freshnessMinutes;
  // A redeemed reset can lower usage without changing the scheduled reset timestamp.
  // Forecast only the monotonic segment after the most recent counter decrease.
  let segmentStart=0;
  for(let i=1;i<samples.length;i++)if(samples[i].usedPercent<samples[i-1].usedPercent)segmentStart=i;
  const refillObservedAt=segmentStart?samples[segmentStart].observedAt:null;
  // Use a sample at least five minutes apart, from this reset and at most 24h ago.
  const prior = samples.slice(segmentStart).find(s=>s.resetAt === latest.resetAt &&
    Date.parse(s.observedAt) >= now-24*HOUR &&
    Date.parse(latest.observedAt)-Date.parse(s.observedAt) >= 5*60000);
  const slope = prior && latest.usedPercent >= prior.usedPercent
    ? (latest.usedPercent-prior.usedPercent)/((Date.parse(latest.observedAt)-Date.parse(prior.observedAt))/HOUR) : null;
  const safePercentPerDay = planningHours ? usablePercent/(planningHours/24) : null;
  const projectedUsedPercent = slope !== null && !stale && !expired ? latest.usedPercent+slope*planningHours : null;
  const runwayHours = slope > 0 && !stale && !expired ? usablePercent/slope : null;
  const depletionHours = slope > 0 && !stale && !expired ? remainingPercent/slope : null;
  let status = expired ? 'verify-reset' : stale ? 'stale' : remainingPercent<=0 ? 'depleted' : usablePercent <= 0 ? 'reserve' : projectedUsedPercent !== null && projectedUsedPercent > 100-policy.reservePercent ? 'pace' : 'ready';
  const message = {
    'verify-reset': 'Scheduled reset has passed. Obtain a new reading before spending; a timer is not proof of a refill.',
    stale: 'Refresh the allowance reading before using automatic routing.',
    depleted: 'This allowance is exhausted. Use another subscription, redeem a banked reset in the provider, or wait for a confirmed refill.',
    reserve: policy.usageMode==='strict'?'The reserve is protected in strict mode. Use another ready subscription or wait.':'Allowance is below the reserve target. Work can continue with shorter context and bounded output.',
    pace: policy.usageMode==='strict'?'Recent consumption would reach the reserve before reset. Strict mode waits or changes provider.':'Recent consumption would reach the reserve target before the planned handoff. Work can continue; use a steadier subscription when available.',
    ready: slope === null ? 'Allowance available. More observations are needed to forecast consumption.' : 'Recent measured pace fits the reset plan.',
  }[status];
  return {...latest, remainingPercent, usablePercent, hoursLeft, ageMinutes,
    refillObservedAt,planningUntil:new Date(now+planningHours*HOUR).toISOString(),safePercentPerDay, slopePercentPerHour: slope, projectedUsedPercent, runwayHours, depletionHours, status, message};
}

// A credit is an option, never an allowance. No plan function redeems or adds it to a meter.
function resetCreditPlan(state, provider, windows, policy, now) {
  const native=state.resetCredits?.[provider],report=state.resetCreditReports?.[provider];
  const inventory=native?.availableCount!==null && Number.isInteger(native?.availableCount)?native:report;
  if(!inventory)return {provider,status:'unknown',availableCount:null,usableCount:null,credits:[],source:null,message:'Banked reset inventory is not reported by this connection.'};
  const source=inventory.source || 'manual',isManual=source==='manual';
  const stale=!Number.isFinite(Date.parse(inventory.observedAt)) || now-Date.parse(inventory.observedAt)>policy.freshnessMinutes*60000;
  const credits=(inventory.credits || []).map(c=>({...c,expired:Boolean(c.expiresAt && Date.parse(c.expiresAt)<=now)}));
  const expired=credits.filter(c=>c.status==='available' && c.expired).length;
  const usableCount=Math.max(0,inventory.availableCount-expired);
  const expiries=credits.filter(c=>c.status==='available'&&!c.expired&&c.expiresAt).map(c=>c.expiresAt).sort();
  const nextExpiryAt=expiries[0] || null;
  const reportedExpiryAt=report?.credits?.map(c=>c.expiresAt).filter(Boolean).sort()[0] || null;
  const planningExpiryAt=[nextExpiryAt,reportedExpiryAt].filter(Boolean).sort()[0] || null;
  const constrained=windows.filter(w=>w.applies);
  const depleted=constrained.some(w=>w.status==='depleted');
  const depletion=constrained.map(w=>w.depletionHours).filter(n=>Number.isFinite(n));
  const depletionHours=depletion.length?Math.min(...depletion):null;
  const expirySoon=planningExpiryAt && Date.parse(planningExpiryAt)-now<=24*HOUR;
  const projectedGap=constrained.some(w=>w.depletionHours!==null && w.depletionHours<(Date.parse(w.planningUntil)-now)/HOUR);
  const trusted=!stale&&!isManual;
  let action='hold',message=usableCount?'Keep this reset banked while the current allowance lasts.':'No unexpired reset credits are recorded.';
  if(usableCount && (depleted || expirySoon || projectedGap)){
    action=trusted?'consider-reset':'verify-credit';
    message=depleted?'Allowance is exhausted. A reset may let you continue after you redeem it and a fresh reading confirms the refill.':expirySoon?'A reset expires within 24 hours. Check its value before it expires.':'At the recent pace, allowance may run out before the next handoff. Keep the reset ready or choose Stretch mode.';
  }
  if(stale&&!isManual){action='refresh';message='Refresh the credit inventory before relying on it. The last reading is retained.';}
  return {provider,status:isManual?'reported':stale?'stale':'connected',availableCount:inventory.availableCount,usableCount,credits,source,observedAt:inventory.observedAt,
    nextExpiryAt,reportedExpiryAt,planningExpiryAt,depletionHours,action,message,reportedScope:report?.scope || null,
    note:'Redeem in the provider. Guard reads the resulting allowance; it never redeems a credit or assumes 100% from an inventory change.'};
}

function effectivePolicy(configured, pressure) {
  const policy={...configured};
  if(policy.usageMode==='preserve'){
    policy.maxContextTokens=Math.min(policy.maxContextTokens,60000);
    policy.maxOutputTokens=Math.min(policy.maxOutputTokens,2048);
    policy.maxToolOutputChars=Math.min(policy.maxToolOutputChars,8000);
    if(['medium','high'].includes(policy.maxThinkingLevel))policy.maxThinkingLevel='low';
  }else if(policy.usageMode==='continuous' && pressure){
    policy.maxContextTokens=Math.min(policy.maxContextTokens,80000);
    policy.maxOutputTokens=Math.min(policy.maxOutputTokens,3072);
  }
  // Mode overlays do not rewrite configured caps or renew any task budget.
  return policy;
}

function buildPlan(state, now = Date.now()) {
  const policy = cleanPolicy(state.policy);
  const windows = new Map();
  for (const sample of state.observations || []) {
    const key = `${sample.provider}:${sample.windowId}`;
    const list = windows.get(key) || [];
    list.push(sample); windows.set(key, list);
  }
  const lists = [...windows.values()].map(list => {
    list.sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
    const newest = list[list.length-1];
    return list.filter(s=>s.resetAt === newest.resetAt);
  });
  const severity = ['ready','pace','reserve','depleted','stale','verify-reset'];
  const makeProviders = plans=>policy.providerOrder.map(provider=>{
    const bindings = state.bindings?.[provider];
    const model=String(bindings?.model || '').toLowerCase();
    const family=provider==='agy'?(model.includes('gemini')?'gemini':model?'claude-gpt':undefined):['opus','sonnet','haiku','fable'].find(f=>model.includes(f));
    const windows=plans.filter(w=>w.provider===provider).map(w=>({...w,applies:!w.modelFamily || !family || w.modelFamily===family || (w.modelFamily==='gemini-argon' && model.includes('argon'))}));
    const rows=windows.filter(w=>w.applies);
    const status = rows.length ? rows.reduce((a,b)=>severity.indexOf(a)>severity.indexOf(b.status)?a:b.status,'ready') : 'unknown';
    return {provider, status, windows, configured: Boolean(bindings?.provider && bindings?.model),
      binding: bindings || null, message:rows.length ? rows.find(r=>r.status===status).message : 'No allowance reading. Add the percentage and reset from the provider usage page.'};
  });
  let plans=lists.map(list=>windowPlan(list,policy,now));
  let providers=makeProviders(plans);
  const target=providers.find(p=>p.provider===policy.bridgeProvider);
  const targetWindows=target?.windows.filter(w=>w.applies) || [];
  const targetMs=targetWindows.length?Math.max(...targetWindows.map(w=>Date.parse(w.resetAt))):null;
  const bridge=policy.usageMode!=='strict' && target?.configured && target.status!=='ready' && targetMs>now
    ?{provider:target.provider,targetAt:new Date(targetMs).toISOString(),confirmed:false,message:'Plan toward this scheduled return; a fresh provider reading must confirm the refill.'}:null;
  if(bridge){plans=lists.map(list=>windowPlan(list,policy,now,targetMs));providers=makeProviders(plans);}
  const apiBinding=state.bindings?.api;
  providers.push({provider:'api',status:policy.allowApiSpend && policy.apiDailyBudgetUsd>0 && policy.apiTaskBudgetUsd>0?'ready':'disabled',windows:[],configured:Boolean(apiBinding),binding:apiBinding || null,message:policy.allowApiSpend?'Paid fallback. Every request reserves an estimated cost against daily and task caps.':'Paid fallback is off. Enable it explicitly and set both dollar caps.'});
  for(const p of providers){
    if((policy.blockedProviders||[]).includes(p.provider)){p.status='blocked';p.message='Blocked by you. Guard will not route here until you unblock it.';}
    p.allowanceEligible=p.status==='ready' || (policy.usageMode!=='strict' && ['pace','reserve'].includes(p.status));
    p.routable=p.allowanceEligible&&p.configured;
  }
  const ready = providers.filter(p=>p.routable).sort((a,b)=>routeRank(a,policy)-routeRank(b,policy));
  const pressure=ready.length>0 && ready[0].provider!=='api' && ready[0].status!=='ready';
  // A provider is available only after ALL its constrained windows can reset.
  const resetCandidates = providers.map(p=>({provider:p.provider, resetAt:p.windows.some(w=>w.applies) ? new Date(Math.max(...p.windows.filter(w=>w.applies).map(w=>Date.parse(w.resetAt)))).toISOString() : null}));
  return {generatedAt:new Date(now).toISOString(), configuredPolicy:policy,policy:effectivePolicy(policy,pressure), providers,bridge,
    resetCredits:providers.filter(p=>p.provider!=='api').map(p=>resetCreditPlan(state,p.provider,p.windows,policy,now)),
    recommendedProvider:ready[0]?.provider || null,
    resetTimeline:plans.map(w=>({provider:w.provider, windowId:w.windowId, resetAt:w.resetAt, status:w.status, hoursLeft:w.hoursLeft})).sort((a,b)=>Date.parse(a.resetAt)-Date.parse(b.resetAt)),
    nextReviewAt: resetCandidates.filter(p=>p.resetAt && Date.parse(p.resetAt)>now).sort((a,b)=>Date.parse(a.resetAt)-Date.parse(b.resetAt))[0]?.resetAt || null,
    note:'Allowances belong to each subscription. They cannot be added together or converted from raw tokens. Reset events require fresh confirmation.'};
}

function routeRank(provider,policy){
  if(provider.provider==='api')return 100;
  return policy.usageMode==='max'?0:['ready','pace','reserve'].indexOf(provider.status);
}

function decide(plan, task = {}, now = Date.now()) {
  const policy = plan.policy;
  const pause = (code, reason, extra = {})=>({action:'pause', code, reason, retryAt:plan.nextReviewAt, ...extra});
  if(task.startedAt && now-Date.parse(task.startedAt)>=policy.maxTaskMinutes*60000) return pause('time-budget','Task time budget reached. Review the checkpoint before renewing the task.');
  if ((task.requests || 0) >= policy.maxRequestsPerTask) return pause('request-budget','Task request budget reached. Review the saved session before raising its budget.');
  if ((task.totalTokens || 0) >= policy.maxTokensPerTask) return pause('token-budget','Task token budget reached. This is a local work limit, not a provider quota.');
  if ((task.repeatedTools || 0) >= policy.repeatedToolLimit) return pause('repeated-tools','Repeated identical tool results detected. Inspect the checkpoint before continuing.');
  const overContext = (task.contextTokens || 0) > policy.maxContextTokens;
  const available = new Set(task.availableProviders || []);
  const eligible = plan.providers.filter(p=>p.allowanceEligible && p.configured && available.has(p.provider) &&
    (!Array.isArray(task.availableModels) || task.availableModels.includes(p.binding.provider+'/'+p.binding.model)))
    .sort((a,b)=>routeRank(a,policy)-routeRank(b,policy));
  // A task rule names the provider (and optionally a model) for this task. It wins when that
  // provider is eligible; tool continuations still stay on the current provider to keep its cache.
  const preferred = task.preferredProvider ? eligible.find(p=>p.provider===task.preferredProvider) : null;
  let selected = task.continuation ? eligible.find(p=>p.provider===task.currentProvider) || preferred || eligible[0] : preferred || eligible[0];
  if (selected && preferred === selected && task.preferredModel && selected.binding) {
    const wanted = String(task.preferredModel).toLowerCase();
    const candidates = (task.availableModels || []).filter(m => m.startsWith(selected.binding.provider + '/')).map(m => m.slice(selected.binding.provider.length + 1));
    const exact = candidates.find(m => m.toLowerCase() === wanted);
    const alias = exact || candidates.filter(m => m.toLowerCase().includes(wanted)).sort().reverse()[0];
    if (alias) selected = {...selected, binding: {...selected.binding, model: alias}};
  }
  // The context ceiling is enforced by compaction, which only works where Pi holds the history.
  // A CLI bridge that keeps its own conversation gets a warning and a fresh-session hint instead.
  if (overContext) {
    const advisory = selected && (policy.contextAdvisoryProviders || []).includes(selected.binding?.provider);
    if (!advisory) return {action:'compact',code:'context',reason:'Context exceeds the configured ceiling. Save a focused checkpoint and compact once before continuing.'};
  }
  if (!selected) return pause('allowance',policy.usageMode==='strict'?'No configured subscription has a fresh, on-pace allowance in strict mode.':'No configured route has fresh, positive allowance. Refresh readings, redeem an available reset in the provider, or wait for a confirmed refill.');
  return {action:task.currentProvider && task.currentProvider!==selected.provider?'switch':'continue', code:'ready',
    provider:selected.provider, binding:selected.binding,warning:['pace','reserve'].includes(selected.status)?selected.message:null,
    contextAdvisory:overContext?`Context is above the ${policy.maxContextTokens.toLocaleString()}-token ceiling and this route cannot be compacted from Pi. Finish the step, then /guard-new for a fresh session from a handoff.`:null,
    reason:(preferred===selected?`Task rule: use ${selected.provider}${task.preferredModel?' ('+selected.binding.model+')':''}.`:task.currentProvider===selected.provider?'Continue on this provider and preserve its prompt cache.':selected.provider==='api'?'Subscription routes are unavailable; use the explicitly enabled API budget.':`Use ${selected.provider}; fresh allowance is available.`)+(selected.status!=='ready'?' Pacing is advisory in this mode; work protections remain active.':''),
    decidedAt:new Date(now).toISOString()};
}

// A repair changes the approach, never the allowance or the original task budget.
function recoveryPlan(plan, task, now = Date.now()) {
  const trigger=decide(plan,task,now);
  if(trigger.code!=='repeated-tools')return {...trigger,action:'pause'};
  if(!plan.policy.autoRecover || (task.autoRepairs||0)>=plan.policy.maxAutoRepairs)
    return {action:'pause',code:'repair-limit',reason:'Automatic repair allowance reached. Review the saved handoff; task budgets remain in force.'};
  const next=decide(plan,{...task,repeatedTools:0},now);
  if(!['continue','switch'].includes(next.action))return next;
  return {...next,action:'repair',code:'repeated-tools',attempt:(task.autoRepairs||0)+1,
    reason:'Repeated operation blocked. Use existing findings and try one different, narrow approach, or report the blocker. Do not repeat the blocked operation or expand the task.'};
}

function trimToolOutput(content, maxChars, archivePath) {
  const total = content.filter(b=>b.type==='text').reduce((n,b)=>n+String(b.text).length,0);
  if (total <= maxChars) return {content, removedChars:0};
  // One shared allowance across all text blocks; image blocks remain intact.
  const joined = content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const side = Math.floor(maxChars/2);
  const text = `${joined.slice(0,side)}\n\n[AI Spend Guard: ${joined.length-maxChars} characters omitted from model context. Full result: ${archivePath}]\n\n${joined.slice(-side)}`;
  return {content:[...content.filter(b=>b.type!=='text'),{type:'text',text}],removedChars:Math.max(0,total-text.length)};
}

function signature(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24); }
function initialState() { return {version:1, policy:{...DEFAULT_POLICY}, observations:[], bindings:{}, tasks:{}, events:[]}; }

module.exports = {DEFAULT_POLICY, PROVIDERS, cleanPolicy, observation, mergeObservations, buildPlan, decide, recoveryPlan, trimToolOutput, signature, initialState};
