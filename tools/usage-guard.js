// Policy is deterministic. Token counts never stand in for subscription allowance.
const crypto = require('node:crypto');

const HOUR = 3600000;
const DEFAULT_POLICY = Object.freeze({
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
  maxThinkingLevel: 'medium',
  maxSubagentCalls: 0,
  allowApiSpend: false,
  apiDailyBudgetUsd: 0,
  apiTaskBudgetUsd: 0,
  maxOutputTokens: 4096,
  providerOrder: ['claude', 'codex', 'agy'],
});
const PROVIDERS = ['claude', 'codex', 'agy', 'api'];
const LIMITS = {
  reservePercent: [0, 50], freshnessMinutes: [5, 1440],
  maxRequestsPerTask: [1, 1000], maxTokensPerTask: [10000, 100000000],
  maxContextTokens: [8000, 1000000], maxToolOutputChars: [2000, 100000],
  repeatedToolLimit: [2, 10], maxConcurrentRequests: [1, 8],
  maxTaskMinutes: [5, 1440], maxSubagentCalls: [0, 20],
  apiDailyBudgetUsd: [0, 1000], apiTaskBudgetUsd: [0, 1000], maxOutputTokens: [512, 32000],
};

function cleanPolicy(input = {}) {
  const result = {...DEFAULT_POLICY};
  for (const [key, [min, max]] of Object.entries(LIMITS)) {
    if (input[key] === undefined) continue;
    if (!Number.isFinite(input[key]) || input[key] < min || input[key] > max) throw new Error(`Invalid ${key}: expected ${min} to ${max}`);
    result[key] = input[key];
  }
  if (input.providerOrder !== undefined) {
    if (!Array.isArray(input.providerOrder) || input.providerOrder.length !== 3 || new Set(input.providerOrder).size !== 3 || input.providerOrder.some(p=>!['claude','codex','agy'].includes(p))) throw new Error('providerOrder must contain claude, codex, and agy once each');
    result.providerOrder = [...input.providerOrder];
  }
  if(input.allowApiSpend!==undefined){if(typeof input.allowApiSpend!=='boolean')throw Error('allowApiSpend must be true or false');result.allowApiSpend=input.allowApiSpend;}
  if(input.autoTune!==undefined){if(typeof input.autoTune!=='boolean')throw Error('autoTune must be true or false');result.autoTune=input.autoTune;}
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

function windowPlan(samples, policy, now) {
  const latest = samples[samples.length-1];
  const resetMs = Date.parse(latest.resetAt);
  const ageMinutes = (now-Date.parse(latest.observedAt))/60000;
  const hoursLeft = Math.max(0, (resetMs-now)/HOUR);
  const remainingPercent = 100-latest.usedPercent;
  const usablePercent = Math.max(0, remainingPercent-policy.reservePercent);
  const expired = resetMs <= now;
  const stale = ageMinutes > policy.freshnessMinutes;
  // Use a sample at least five minutes apart, from this reset and at most 24h ago.
  const prior = samples.find(s=>s.resetAt === latest.resetAt &&
    Date.parse(s.observedAt) >= now-24*HOUR &&
    Date.parse(latest.observedAt)-Date.parse(s.observedAt) >= 5*60000);
  const slope = prior && latest.usedPercent >= prior.usedPercent
    ? (latest.usedPercent-prior.usedPercent)/((Date.parse(latest.observedAt)-Date.parse(prior.observedAt))/HOUR) : null;
  const safePercentPerDay = hoursLeft ? usablePercent/Math.max(1, hoursLeft/24) : null;
  const projectedUsedPercent = slope !== null && !stale && !expired ? latest.usedPercent+slope*hoursLeft : null;
  const runwayHours = slope > 0 && !stale && !expired ? usablePercent/slope : null;
  let status = expired ? 'verify-reset' : stale ? 'stale' : usablePercent <= 0 ? 'reserve' : projectedUsedPercent !== null && projectedUsedPercent > 100-policy.reservePercent ? 'pace' : 'ready';
  const message = {
    'verify-reset': 'Scheduled reset has passed. Obtain a new reading before spending; a timer is not proof of a refill.',
    stale: 'Refresh the allowance reading before using automatic routing.',
    reserve: 'The emergency reserve is protected. Continue with another ready subscription or wait.',
    pace: 'Recent consumption would reach the reserve before reset. Move routine work to another ready subscription.',
    ready: slope === null ? 'Allowance available. More observations are needed to forecast consumption.' : 'Recent measured pace fits before reset.',
  }[status];
  return {...latest, remainingPercent, usablePercent, hoursLeft, ageMinutes,
    safePercentPerDay, slopePercentPerHour: slope, projectedUsedPercent, runwayHours, status, message};
}

function buildPlan(state, now = Date.now()) {
  const policy = cleanPolicy(state.policy);
  const windows = new Map();
  for (const sample of state.observations || []) {
    const key = `${sample.provider}:${sample.windowId}`;
    const list = windows.get(key) || [];
    list.push(sample); windows.set(key, list);
  }
  const plans = [...windows.values()].map(list => {
    list.sort((a,b)=>Date.parse(a.observedAt)-Date.parse(b.observedAt));
    const newest = list[list.length-1];
    return windowPlan(list.filter(s=>s.resetAt === newest.resetAt), policy, now);
  });
  const severity = ['ready','pace','reserve','stale','verify-reset'];
  const providers = policy.providerOrder.map(provider=>{
    const bindings = state.bindings?.[provider];
    const model=String(bindings?.model || '').toLowerCase();
    const family=provider==='agy'?(model.includes('gemini')?'gemini':model?'claude-gpt':undefined):['opus','sonnet','haiku','fable'].find(f=>model.includes(f));
    const windows=plans.filter(w=>w.provider===provider).map(w=>({...w,applies:!w.modelFamily || !family || w.modelFamily===family || (w.modelFamily==='gemini-argon' && model.includes('argon'))}));
    const rows=windows.filter(w=>w.applies);
    const status = rows.length ? rows.reduce((a,b)=>severity.indexOf(a)>severity.indexOf(b.status)?a:b.status,'ready') : 'unknown';
    return {provider, status, windows, configured: Boolean(bindings?.provider && bindings?.model),
      binding: bindings || null, message:rows.length ? rows.find(r=>r.status===status).message : 'No allowance reading. Add the percentage and reset from the provider usage page.'};
  });
  const apiBinding=state.bindings?.api;
  providers.push({provider:'api',status:policy.allowApiSpend && policy.apiDailyBudgetUsd>0 && policy.apiTaskBudgetUsd>0?'ready':'disabled',windows:[],configured:Boolean(apiBinding),binding:apiBinding || null,message:policy.allowApiSpend?'Paid fallback. Every request reserves an estimated cost against daily and task caps.':'Paid fallback is off. Enable it explicitly and set both dollar caps.'});
  const ready = providers.filter(p=>p.status==='ready');
  // A provider is available only after ALL its constrained windows can reset.
  const resetCandidates = providers.map(p=>({provider:p.provider, resetAt:p.windows.some(w=>w.applies) ? new Date(Math.max(...p.windows.filter(w=>w.applies).map(w=>Date.parse(w.resetAt)))).toISOString() : null}));
  return {generatedAt:new Date(now).toISOString(), policy, providers,
    recommendedProvider:ready[0]?.provider || null,
    resetTimeline:plans.map(w=>({provider:w.provider, windowId:w.windowId, resetAt:w.resetAt, status:w.status, hoursLeft:w.hoursLeft})).sort((a,b)=>Date.parse(a.resetAt)-Date.parse(b.resetAt)),
    nextReviewAt: resetCandidates.filter(p=>p.resetAt && Date.parse(p.resetAt)>now).sort((a,b)=>Date.parse(a.resetAt)-Date.parse(b.resetAt))[0]?.resetAt || null,
    note:'Allowances belong to each subscription. They cannot be added together or converted from raw tokens. Reset events require fresh confirmation.'};
}

function decide(plan, task = {}, now = Date.now()) {
  const policy = plan.policy;
  const pause = (code, reason, extra = {})=>({action:'pause', code, reason, retryAt:plan.nextReviewAt, ...extra});
  if(task.startedAt && now-Date.parse(task.startedAt)>=policy.maxTaskMinutes*60000) return pause('time-budget','Task time budget reached. Review the checkpoint before renewing the task.');
  if ((task.requests || 0) >= policy.maxRequestsPerTask) return pause('request-budget','Task request budget reached. Review the saved session before raising its budget.');
  if ((task.totalTokens || 0) >= policy.maxTokensPerTask) return pause('token-budget','Task token budget reached. This is a local work limit, not a provider quota.');
  if ((task.repeatedTools || 0) >= policy.repeatedToolLimit) return pause('repeated-tools','Repeated identical tool results detected. Inspect the checkpoint before continuing.');
  if ((task.contextTokens || 0) > policy.maxContextTokens) return {action:'compact',code:'context',reason:'Context exceeds the configured ceiling. Save a focused checkpoint and compact once before continuing.'};
  const available = new Set(task.availableProviders || []);
  const eligible = plan.providers.filter(p=>p.status==='ready' && p.configured && available.has(p.provider));
  // Stay on the current provider through tool continuations to retain its cache.
  const selected = task.continuation ? eligible.find(p=>p.provider===task.currentProvider) || eligible[0] : eligible[0];
  if (!selected) return pause('allowance','No configured subscription has a fresh, on-pace allowance. Refresh readings or wait for a reset.');
  return {action:task.currentProvider && task.currentProvider!==selected.provider?'switch':'continue', code:'ready',
    provider:selected.provider, binding:selected.binding,
    reason:task.currentProvider===selected.provider?'Continue on this provider and preserve its prompt cache.':selected.provider==='api'?'Subscription routes are unavailable; use the explicitly enabled API budget.':`Use ${selected.provider}; its observed allowance fits the reset plan.`,
    decidedAt:new Date(now).toISOString()};
}

function trimToolOutput(content, maxChars, archivePath) {
  const total = content.filter(b=>b.type==='text').reduce((n,b)=>n+String(b.text).length,0);
  if (total <= maxChars) return {content, removedChars:0};
  // One shared allowance across all text blocks; image blocks remain intact.
  const joined = content.filter(b=>b.type==='text').map(b=>b.text).join('\n');
  const side = Math.floor(maxChars/2);
  const text = `${joined.slice(0,side)}\n\n[AI Spend Guard: ${joined.length-maxChars} characters omitted from model context. Full result: ${archivePath}]\n\n${joined.slice(-side)}`;
  return {content:[...content.filter(b=>b.type!=='text'),{type:'text',text}],removedChars:joined.length-maxChars};
}

function signature(value) { return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0,24); }
function initialState() { return {version:1, policy:{...DEFAULT_POLICY}, observations:[], bindings:{}, tasks:{}, events:[]}; }

module.exports = {DEFAULT_POLICY, PROVIDERS, cleanPolicy, observation, mergeObservations, buildPlan, decide, trimToolOutput, signature, initialState};
