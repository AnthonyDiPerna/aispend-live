// Local, explainable adaptation. Advice can tighten bounds, never buy more usage.
const {cleanPolicy, buildPlan} = require('./usage-guard');

function buildAdvice(state, now = Date.now()) {
  const policy = cleanPolicy(state.policy);
  const changes = {}, reasons = [];
  const tighten = (key, value, reason) => {
    reasons.push(reason);
    if (policy[key] > value) { changes[key] = Math.min(changes[key] ?? policy[key], value); }
  };
  const insight = state.insights;
  const age = now - Date.parse(insight?.generatedAt);
  const requests = (insight?.providers || []).reduce((sum, row) => sum + row.requests, 0);
  const learned = age >= 0 && age <= 6 * 3600000 && requests >= 20;
  const metrics = learned ? insight.providers.flatMap(row => row.metrics) : [];
  const high = (id, threshold) => metrics.some(row => row.id === id && Number.isFinite(row.percent) && row.percent >= threshold);
  // Insights describe every session on the machine (native Claude Code, Codex, AGY). Guarded Pi tasks are
  // a different population, so a bound is tightened only when Pi's own tasks show the same pattern.
  const piTasks = Object.values(state.tasks || {}).filter(t => t.startedAt && now - Date.parse(t.startedAt) <= 24 * 3600000);
  const piLargeContext = piTasks.some(t => (t.contextTokens || 0) > 100000);
  const piSubagents = piTasks.some(t => (t.subagentCalls || 0) > 0);
  if (high('context', 40)) {
    if (piLargeContext) tighten('maxContextTokens', 80000, 'Large contexts dominate recent usage, including guarded Pi tasks. Checkpoint at 80k tokens to carry less history forward.');
    else reasons.push('Large contexts dominate native sessions on this machine. Guarded Pi tasks have stayed smaller, so their ceiling is unchanged.');
  }
  if (high('long', 40)) {
    reasons.push('Long session spans include idle time. Checkpoint at milestones; duration alone does not justify a shorter hard stop.');
  }
  if (high('subagents', 30)) {
    if (piSubagents) tighten('maxSubagentCalls', 0, 'Subagents account for a substantial share of recorded tokens, including guarded Pi tasks. Keep routine work in one agent.');
    else reasons.push('Subagents dominate native sessions on this machine; guarded Pi tasks have not fanned out, so their limits are unchanged.');
  }
  if (metrics.some(row => row.id === 'effort' && row.percent >= 40 && row.coveragePercent >= 50)) {
    reasons.push('High reasoning effort is common where recorded. Medium remains the automatic ceiling.');
    if (policy.maxThinkingLevel === 'high') { changes.maxThinkingLevel = 'medium'; }
  }
  if (policy.usageMode==='strict' && buildPlan(state, now).providers.some(row => row.status === 'pace')) {
    tighten('maxRequestsPerTask', 25, 'Measured allowance burn would reach a reserve before reset. Use shorter task batches.');
  }
  if(high('cache',50))reasons.push('Most recorded input is cached. Keep useful prefixes stable across tool follow-ups; clear only irrelevant history at a checkpoint.');
  return {learned, requests, observedAt: learned ? insight.generatedAt : null, changes,
    evidence:learned?insight.providers.filter(row=>row.requests>0).map(row=>({provider:row.provider,requests:row.requests,metrics:row.metrics.map(({id,percent})=>({id,percent}))})):[],
    reasons: [...new Set(reasons)],
    summary: learned ? 'Adapting to your recent local usage' : 'Protected defaults; learning your usage pattern',
    basis: learned ? 'Recomputed from the last 24 hours of local records. These signals overlap and are not quota weights.' : 'Personalization starts after 20 recorded requests with analysis less than six hours old. Reset protection is already active.'};
}

function applyAdvice(state, now = Date.now(), explicit = false) {
  if (!explicit && !state.policy.autoTune) { return null; }
  const advice = buildAdvice(state, now);
  if (!Object.keys(advice.changes).length) { return null; }
  state.policy = cleanPolicy({...state.policy, ...advice.changes});
  state.advisor = {appliedAt: new Date(now).toISOString(), changes: advice.changes, reasons: advice.reasons};
  return state.advisor;
}

function defaultBindings(models, current) {
  const result = {...current};
  for (const group of ['claude', 'codex', 'agy']) {
    if (result[group]) { continue; }
    const candidates = models.filter(model => model.group === group && model.auth === 'subscription');
    // Prefer a balanced family when present; names are drawn only from authenticated discovery.
    const preferred = candidates.find(model => /sonnet|(?:^|-)sol(?:-|$)|flash/i.test(model.id)) || candidates[0];
    if (preferred) { result[group] = {provider: preferred.provider, model: preferred.id}; }
  }
  return result;
}

module.exports = {buildAdvice, applyAdvice, defaultBindings};
