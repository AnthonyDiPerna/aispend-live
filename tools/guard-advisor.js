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
  if (high('context', 40)) {
    tighten('maxContextTokens', 80000, 'Large contexts dominate recent usage. Checkpoint at 80k tokens to carry less history forward.');
  }
  if (high('long', 40)) {
    tighten('maxTaskMinutes', 30, 'Long sessions dominate recent usage. Review a saved handoff after 30 minutes of task time.');
  }
  if (high('subagents', 30)) {
    tighten('maxSubagentCalls', 0, 'Subagents account for a substantial share of recorded tokens. Keep routine work in one agent.');
    tighten('maxConcurrentRequests', 1, 'Keep one guarded request in flight to reduce parallel allowance burn.');
  }
  if (metrics.some(row => row.id === 'effort' && row.percent >= 40 && row.coveragePercent >= 50)) {
    reasons.push('High reasoning effort is common where recorded. Medium remains the automatic ceiling.');
    if (policy.maxThinkingLevel === 'high') { changes.maxThinkingLevel = 'medium'; }
  }
  if (buildPlan(state, now).providers.some(row => row.status === 'pace')) {
    tighten('maxRequestsPerTask', 25, 'Measured allowance burn would reach a reserve before reset. Use shorter task batches.');
  }
  return {learned, requests, observedAt: learned ? insight.generatedAt : null, changes,
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
