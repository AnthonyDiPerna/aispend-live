const assert = require("node:assert/strict");
const { buildPublicDemo, disjointBreakdown, publicCostBreakdown } = require("./export-public-demo");
const { buildSummary } = require("./ai-spend-dashboard-server");

const claude = disjointBreakdown("claude", {
  totalTokens: 100,
  tokens: {
    inputTokens: 10,
    cacheCreationInputTokens: 20,
    cacheReadInputTokens: 30,
    outputTokens: 40,
  },
});
assert.deepEqual(claude, {
  freshInputTokens: 10,
  cachedInputTokens: 30,
  cacheWriteTokens: 20,
  outputTokens: 40,
  unknownBreakdownTokens: 0,
});

const codex = disjointBreakdown("codex", {
  totalTokens: 14,
  tokens: { inputTokens: 10, cachedInputTokens: 5, outputTokens: 4 },
});
assert.deepEqual(codex, {
  freshInputTokens: 5,
  cachedInputTokens: 5,
  cacheWriteTokens: 0,
  outputTokens: 4,
  unknownBreakdownTokens: 0,
});

assert.equal(claude.freshInputTokens + claude.cachedInputTokens + claude.cacheWriteTokens + claude.outputTokens, 100);
assert.equal(codex.freshInputTokens + codex.cachedInputTokens + codex.outputTokens, 14);

const now = Date.now();
const makeEvent = ({ provider, model, daysAgo, totalTokens, dedupeKey, syntheticThreadTotal = false }) => {
  const timestampMs = now - daysAgo * 24 * 60 * 60 * 1000;
  const date = new Date(timestampMs).toISOString().slice(0, 10);
  return {
    provider,
    model,
    sessionId: `${provider}-${model}`,
    turnIndex: 1,
    file: `${provider}.jsonl`,
    dedupeKey,
    timestampMs,
    timestamp: new Date(timestampMs).toISOString(),
    date,
    hour: `${date} 12:00`,
    tokens: { inputTokens: totalTokens, outputTokens: 0, totalTokens },
    totalTokens,
    syntheticThreadTotal,
    costUsd: 0,
    costKnown: false,
    credits: 0,
    creditKnown: false,
  };
};
const fixtureSources = [
  { provider: "claude", files: 1, sessions: [], errors: [], rateLimitSnapshots: [], events: [
    makeEvent({ provider: "claude", model: "claude-opus-5-5", daysAgo: 1, totalTokens: 100, dedupeKey: "duplicate" }),
    makeEvent({ provider: "claude", model: "claude-opus-5-5", daysAgo: 2, totalTokens: 25, dedupeKey: "claude-day2" }),
    makeEvent({ provider: "claude", model: "claude-opus-5-5", daysAgo: 2, totalTokens: 900, dedupeKey: "synthetic", syntheticThreadTotal: true }),
    makeEvent({ provider: "claude", model: "claude-opus-5-5", daysAgo: 5, totalTokens: 1000, dedupeKey: "old" }),
  ] },
  { provider: "claude", files: 1, sessions: [], errors: [], rateLimitSnapshots: [], events: [
    makeEvent({ provider: "claude", model: "claude-opus-5-5", daysAgo: 1, totalTokens: 100, dedupeKey: "duplicate" }),
  ] },
  { provider: "codex", files: 1, sessions: [], errors: [], rateLimitSnapshots: [], events: [
    makeEvent({ provider: "codex", model: "gpt-6-astra", daysAgo: 1, totalTokens: 50, dedupeKey: "codex-day1" }),
  ] },
];
const fixtureSummary = buildSummary(fixtureSources, { days: 3, provider: "all", task: "auto" });
const fixtureDemo = buildPublicDemo(fixtureSummary, fixtureSources, 3);
const modelByDay = fixtureDemo.dailyByModel.reduce((map, row) => {
  map.set(row.period, (map.get(row.period) || 0) + row.tokens);
  return map;
}, new Map());
for (const row of fixtureDemo.daily) {
  assert.equal(modelByDay.get(row.period), row.tokens, `model daily rollup reconciles ${row.period}`);
}
assert.equal(fixtureDemo.dailyByModel.reduce((sum, row) => sum + row.tokens, 0), fixtureDemo.daily.reduce((sum, row) => sum + row.tokens, 0));
assert.equal(publicCostBreakdown({}, { costUsd: 0 }, 100).estimatedApiUsd, null, "missing catalog stays unknown");
assert.equal(publicCostBreakdown({ pricingKnown: true, outputPer1M: 0 }, { costUsd: 0 }, 100).estimatedApiUsd, 0, "known free-zero pricing stays zero");
// Public guidance must remain aggregate-only while demonstrating the real alerts.
fixtureSummary.insights.push({title: "One session is carrying the burn", detail: "SECRET_SESSION_TITLE"});
fixtureSummary.recommendations.push({title: "Summarize and restart", target: "SECRET_LOCAL_PATH", reason: "SECRET_SESSION_ID", doNow: ["SECRET_COMMAND"]});
fixtureSummary.observedRateLimits = [{provider: "codex", limitId: "SECRET_ACCOUNT_ID", windowMinutes: 300, usedPercent: 84, projectedPercent: null, status: "observed", resetAt: "2026-11-09T00:00:00Z"}];
const guidedDemo = buildPublicDemo(fixtureSummary, fixtureSources, 3);
assert(Array.isArray(guidedDemo.insights), "public demo includes aggregate insights");
assert(Array.isArray(guidedDemo.recommendations), "public demo includes safe next actions");
assert(guidedDemo.alertExamples.length === 2, "both five-hour and weekly alerts can be previewed");
for (const example of guidedDemo.alertExamples) {
  assert.equal(example.synthetic, true, "sample quota pressure is explicitly synthetic");
  assert.equal(example.title, "Protect the observed limit");
  assert(example.steps.some(step => /smallest check/.test(step)), "alert recommends focused verification");
  assert(example.steps.some(step => /compact handoff/.test(step)), "alert recommends a handoff");
}
assert(!JSON.stringify(guidedDemo).includes("SECRET_"), "public guidance cannot expose private session or account metadata");
console.log("Public demo breakdown, insights and privacy tests passed");
