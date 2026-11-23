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

const agy = disjointBreakdown("agy", {
  totalTokens: 140,
  tokens: {
    inputTokens: 20,
    cacheReadInputTokens: 100,
    cacheCreationInputTokens: 999,
    outputTokens: 20,
  },
});
assert.deepEqual(agy, {
  freshInputTokens: 20,
  cachedInputTokens: 100,
  cacheWriteTokens: 0,
  outputTokens: 20,
  unknownBreakdownTokens: 0,
});

assert.equal(claude.freshInputTokens + claude.cachedInputTokens + claude.cacheWriteTokens + claude.outputTokens, 100);
assert.equal(codex.freshInputTokens + codex.cachedInputTokens + codex.outputTokens, 14);
assert.equal(agy.freshInputTokens + agy.cachedInputTokens + agy.cacheWriteTokens + agy.outputTokens, 140);

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
  { provider: "agy", files: 1, sessions: [], errors: [], rateLimitSnapshots: [], events: [
    makeEvent({ provider: "agy", model: "gemini-4-neon-xhigh", daysAgo: 1, totalTokens: 80, dedupeKey: "agy-day1" }),
  ] },
];
const fixtureSummary = buildSummary(fixtureSources, { days: 3, provider: "all", task: "auto" });
const fixtureDemo = buildPublicDemo(fixtureSummary, fixtureSources, 3);
assert.equal(fixtureDemo.releaseVersion, require('../package.json').version);
assert(fixtureDemo.coverage.some((row) => row.source === "Antigravity JSONL / SQLite"), "AGY coverage source is labeled cleanly");
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
fixtureSummary.observedRateLimits = [
  {provider: "codex", limitId: "SECRET_ACCOUNT_ID", windowMinutes: 300, usedPercent: 84, projectedPercent: null, status: "observed", resetAt: "2026-11-09T00:00:00Z"},
  {provider: "agy", limitId: "SECRET_AGY_ACCOUNT", windowMinutes: 10080, usedPercent: 27, projectedPercent: null, status: "observed", resetAt: "2026-11-29T00:00:00Z"},
];
fixtureSummary.speedStats = {
  fastTokens: 250000,
  ultrafastTokens: 50000,
  standardTokens: 700000,
  unknownSpeedTokens: 10000,
  fastShare: 0.3,
  fastTurns: 14,
  ultrafastTurns: 2,
  secretPath: "SECRET_SPEED_PATH",
  byProvider: {
    codex: { fastTokens: 250000, ultrafastTokens: 50000, standardTokens: 500000, fastTurns: 14, ultrafastTurns: 2, note: "SECRET_NOTE" },
    SECRET_PROVIDER: { fastTokens: 999 },
  },
};
fixtureSummary.swarmStats = {
  swarmCount: 3,
  swarmWorkerSessions: 12,
  swarmWorkerTokens: 450000000,
  swarmShareOfAgy: 0.65,
  subagentTokens: 500000000,
  totalAgyTokens: 690000000,
  swarmIds: ["SECRET_SWARM_ID"],
  project: "SECRET_PROJECT_PATH",
};
const guidedDemo = buildPublicDemo(fixtureSummary, fixtureSources, 3);
assert(Array.isArray(guidedDemo.insights), "public demo includes aggregate insights");
assert(Array.isArray(guidedDemo.recommendations), "public demo includes safe next actions");
assert(guidedDemo.observedLimits.some((row) => row.limitId.startsWith("agy:")), "AGY observed limits retain safe provider prefix");
assert.equal(guidedDemo.speedStats.fastTokens, 250000, "sanitized speedStats preserves aggregate fastTokens");
assert.equal(guidedDemo.speedStats.ultrafastTokens, 50000, "sanitized speedStats preserves aggregate ultrafastTokens");
assert.equal(guidedDemo.speedStats.fastShare, 0.3, "sanitized speedStats preserves fastShare");
assert.equal(guidedDemo.swarmStats.swarmCount, 3, "sanitized swarmStats preserves swarmCount");
assert.equal(guidedDemo.swarmStats.swarmShareOfAgy, 0.65, "sanitized swarmStats preserves swarmShareOfAgy");
assert(guidedDemo.alertExamples.length === 2, "both five-hour and weekly alerts can be previewed");
for (const example of guidedDemo.alertExamples) {
  assert.equal(example.synthetic, true, "sample quota pressure is explicitly synthetic");
  assert.equal(example.title, "Protect the observed limit");
  assert(example.steps.some(step => /smallest check/.test(step)), "alert recommends focused verification");
  assert(example.steps.some(step => /compact handoff/.test(step)), "alert recommends a handoff");
}
assert(!JSON.stringify(guidedDemo).includes("SECRET_"), "public guidance and speed/swarm stats cannot expose private session, path, or account metadata");
console.log("Public demo breakdown, AGY, speed/swarm, insights and privacy tests passed");
