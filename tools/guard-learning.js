// Feedback loop: learn from what Guard did and what you did next. Every adjustment is
// bounded, explained, recorded with its evidence, and undoable. Nothing here buys usage.
const {cleanPolicy} = require('./usage-guard');

const MAX_LESSONS = 200;
const RENEWAL_WINDOW_MS = 30 * 60000;   // a renewal this soon after a pause means the pause was in your way
const LOOKBACK_MS = 7 * 24 * 3600000;
const REQUEST_STEPS = [40, 60, 90, 135, 200, 300, 400];

function lessons(state) { state.learning ||= {lessons: [], adjustments: []}; return state.learning; }

// Record an observation. kind: pause | compact | renew | complete | policy
function recordLesson(state, lesson, now = Date.now()) {
  const l = lessons(state);
  l.lessons.push({at: new Date(now).toISOString(), ...lesson});
  l.lessons = l.lessons.slice(-MAX_LESSONS);
}

function withinLookback(row, now) { return now - Date.parse(row.at) <= LOOKBACK_MS; }

// Per route (provider + model) outcomes from finished requests: what each route costs per request
// and how often tasks on it hit a Guard rule. Scores inform; they do not switch models by themselves.
function routeScores(state, now = Date.now()) {
  const rows = lessons(state).lessons.filter(row => withinLookback(row, now));
  const byRoute = new Map();
  const bucket = key => byRoute.get(key) || byRoute.set(key, {route: key, requests: 0, tokens: 0, pauses: 0, compactions: 0, loopBlocks: 0, failed: 0, tasks: new Set()}).get(key);
  for (const row of rows) {
    if (!row.provider) continue;
    const b = bucket(row.provider + (row.model ? '/' + row.model : ''));
    if (row.taskId) b.tasks.add(row.taskId);
    if (row.kind === 'complete') { b.requests++; b.tokens += row.tokens || 0; if (row.failed) b.failed++; }
    if (row.kind === 'pause') b.pauses++;
    if (row.kind === 'compact') b.compactions++;
    if (row.kind === 'loop-block') b.loopBlocks++;
  }
  return [...byRoute.values()].map(b => ({...b, tasks: b.tasks.size,
    tokensPerRequest: b.requests ? Math.round(b.tokens / b.requests) : null,
    pausesPerTask: b.tasks.size ? Math.round(100 * b.pauses / b.tasks.size) / 100 : null}))
    .sort((a, b) => b.requests - a.requests);
}

// Rules. Each returns {key, to, reason, evidence} or null.
function renewalRule(state, policy, now) {
  const rows = lessons(state).lessons.filter(row => withinLookback(row, now));
  const pauses = rows.filter(row => row.kind === 'pause' && row.code === 'request-budget');
  const renewed = pauses.filter(p => rows.some(r => r.kind === 'renew' && r.taskId === p.taskId && Date.parse(r.at) - Date.parse(p.at) >= 0 && Date.parse(r.at) - Date.parse(p.at) <= RENEWAL_WINDOW_MS));
  const since = lessons(state).adjustments.filter(a => a.key === 'maxRequestsPerTask' && !a.undoneAt).map(a => Date.parse(a.at)).sort().pop() || 0;
  const fresh = renewed.filter(p => Date.parse(p.at) > since);
  if (fresh.length < 2) return null;
  const next = REQUEST_STEPS.find(step => step > policy.maxRequestsPerTask);
  if (!next) return null;
  return {key: 'maxRequestsPerTask', to: next, reason: `You renewed the request budget within ${RENEWAL_WINDOW_MS / 60000} minutes of a pause ${fresh.length} times this week. Starting tasks at ${next} requests removes that interruption; the time, token and loop rules still apply.`, evidence: fresh.map(p => p.at)};
}

function bridgeContextRule(state, policy, now) {
  const rows = lessons(state).lessons.filter(row => withinLookback(row, now));
  const stuck = rows.filter(row => row.kind === 'pause' && row.code === 'context-stuck' && row.providerId);
  const ids = [...new Set(stuck.map(row => row.providerId))].filter(id => !(policy.contextAdvisoryProviders || []).includes(id));
  if (!ids.length) return null;
  return {key: 'contextAdvisoryProviders', to: [...(policy.contextAdvisoryProviders || []), ...ids], reason: `Compaction could not lower the context on ${ids.join(', ')}: that bridge keeps the conversation on its own side, so the ceiling became a dead end. It is now advisory there; Guard warns and suggests a fresh session instead of pausing.`, evidence: stuck.map(row => row.at)};
}

function learn(state, now = Date.now()) {
  const policy = cleanPolicy(state.policy);
  const applied = [];
  for (const rule of [renewalRule, bridgeContextRule]) {
    const change = rule(state, policy, now);
    if (!change) continue;
    const from = policy[change.key];
    const next = cleanPolicy({...state.policy, [change.key]: change.to});
    state.policy = next;
    const record = {id: `${change.key}-${now}`, at: new Date(now).toISOString(), key: change.key, from, to: change.to, reason: change.reason, evidence: change.evidence};
    lessons(state).adjustments.push(record);
    lessons(state).adjustments = lessons(state).adjustments.slice(-50);
    applied.push(record);
  }
  return applied;
}

function undo(state, id, now = Date.now()) {
  const record = lessons(state).adjustments.find(a => a.id === id && !a.undoneAt);
  if (!record) throw new Error('No such adjustment, or it was already undone');
  state.policy = cleanPolicy({...state.policy, [record.key]: record.from});
  record.undoneAt = new Date(now).toISOString();
  return record;
}

function learningView(state, now = Date.now()) {
  const l = lessons(state);
  return {lessons: l.lessons.slice(-30), adjustments: l.adjustments.slice(-20), routeScores: routeScores(state, now),
    method: 'Rules read the last seven days of pauses, renewals, compactions and completions. Each adjustment is one bounded step, explained, and undoable. Route scores compare tokens per request and Guard interruptions per task; they inform your rules and do not switch models by themselves.'};
}

module.exports = {recordLesson, learn, undo, learningView, routeScores, REQUEST_STEPS};
