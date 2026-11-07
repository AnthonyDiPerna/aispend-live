const fs = require("fs");
const path = require("path");

const { buildWorkflowGuidance, buildSummary, parseAllUsage } = require("./ai-spend-dashboard-server");

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function cacheReuse(tokens) {
  const inputLike = numberValue(tokens.inputTokens)
    + numberValue(tokens.cachedInputTokens)
    + numberValue(tokens.cacheCreationInputTokens)
    + numberValue(tokens.cacheCreation1hInputTokens)
    + numberValue(tokens.cacheReadInputTokens);
  const cached = numberValue(tokens.cachedInputTokens) + numberValue(tokens.cacheReadInputTokens);
  return inputLike > 0 ? cached / inputLike : 0;
}

function disjointBreakdown(provider, row) {
  const tokens = row.tokens || {};
  const rawInput = numberValue(tokens.inputTokens);
  const rawCached = numberValue(tokens.cachedInputTokens);
  const cachedInputTokens = provider === "codex"
    ? Math.min(rawInput, rawCached)
    : numberValue(tokens.cacheReadInputTokens);
  const freshInputTokens = provider === "codex"
    ? Math.max(0, rawInput - cachedInputTokens)
    : rawInput;
  const cacheWriteTokens = numberValue(tokens.cacheCreationInputTokens)
    + numberValue(tokens.cacheCreation1hInputTokens);
  const outputTokens = numberValue(tokens.outputTokens);
  const knownBreakdown = freshInputTokens + cachedInputTokens + cacheWriteTokens + outputTokens;
  const unknownBreakdownTokens = Math.max(0, numberValue(row.totalTokens) - knownBreakdown);
  return { freshInputTokens, cachedInputTokens, cacheWriteTokens, outputTokens, unknownBreakdownTokens };
}

function publicCostBreakdown(catalog, row, outputTokens) {
  const costKnown = catalog && catalog.pricingKnown === true;
  const estimatedOutputUsd = costKnown && Number.isFinite(Number(catalog.outputPer1M))
    ? outputTokens * Number(catalog.outputPer1M) / 1000000
    : null;
  const estimatedInputUsd = costKnown && estimatedOutputUsd != null
    ? Math.max(0, Number(row.costUsd || 0) - estimatedOutputUsd)
    : null;
  return {
    costKnown,
    estimatedInputUsd,
    estimatedOutputUsd,
    estimatedApiUsd: costKnown ? Number(row.costUsd || 0) : null,
  };
}

function buildModelDaily(summary, sources, days, dailyDates) {
  const modelKeys = (summary.modelTotals || []).map((row) => ({
    key: `${row.provider}:${row.model || "unknown"}`,
    provider: row.provider,
    model: row.model || "unknown",
  }));
  const rows = [];
  for (const identity of modelKeys) {
    const filteredSources = sources.map((source) => ({
      ...source,
      events: (source.events || []).filter((event) => (
        event.provider === identity.provider
        && (event.model || "unknown") === identity.model
      )),
    }));
    const filtered = buildSummary(filteredSources, { days, provider: "all", task: "auto" });
    for (const row of filtered.daily || []) {
      const dayIndex = dailyDates.indexOf(row.date);
      if (dayIndex < 0) continue;
      rows.push({
        key: identity.key,
        model: identity.model,
        date: row.date,
        period: `Day ${dayIndex + 1}`,
        tokens: numberValue(row.totalTokens),
      });
    }
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key));
}

function parseArgs(argv) {
  const out = { days: 7, output: path.resolve(__dirname, "..", "public", "demo-data.json") };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--days") out.days = Math.max(1, Number(argv[++i] || 7));
    if (argv[i] === "--out") out.output = path.resolve(String(argv[++i] || out.output));
  }
  return out;
}

function buildPublicDemo(summary, sources, days) {
  const totalTokens = numberValue(summary.totals.totalTokens);
  const catalogByKey = new Map((summary.modelCatalog || []).map((row) => [`${row.provider}:${row.id}`, row]));
  const models = (summary.modelTotals || []).map((row) => {
    const catalog = catalogByKey.get(`${row.provider}:${row.model}`) || {};
    const breakdown = disjointBreakdown(row.provider, row);
    const inputTokens = breakdown.freshInputTokens;
    const cachedInputTokens = breakdown.cachedInputTokens;
    const outputTokens = breakdown.outputTokens;
    const cost = publicCostBreakdown(catalog, row, outputTokens);
    return {
      key: `${row.provider}:${row.model || "unknown"}`,
      provider: row.provider,
      model: row.model || "unknown",
      tokens: row.totalTokens,
      turns: row.eventCount,
      share: totalTokens > 0 ? row.totalTokens / totalTokens : 0,
      inputTokens,
      cachedInputTokens,
      outputTokens,
      cacheWriteTokens: breakdown.cacheWriteTokens,
      unknownBreakdownTokens: Math.max(numberValue(row.breakdownUnknownTokens), breakdown.unknownBreakdownTokens),
      estimatedInputUsd: cost.estimatedInputUsd,
      estimatedOutputUsd: cost.estimatedOutputUsd,
      estimatedApiUsd: cost.estimatedApiUsd,
      pricingKnown: cost.costKnown,
    };
  });
  const daily = (summary.daily || []).reduce((map, row) => {
    const key = row.date;
    if (!map.has(key)) map.set(key, { tokens: 0, turns: 0 });
    const item = map.get(key);
    item.tokens += numberValue(row.totalTokens);
    item.turns += numberValue(row.eventCount);
    return map;
  }, new Map());
  const modelKnownBreakdown = models.reduce((sum, row) => sum
    + row.inputTokens + row.cachedInputTokens + row.cacheWriteTokens + row.outputTokens, 0);
  const aggregateUnknownBreakdown = Math.max(
    numberValue(summary.totals.breakdownUnknownTokens),
    Math.max(0, totalTokens - modelKnownBreakdown),
  );
  const dailyDates = Array.from(daily.keys()).sort().slice(-7);
  const modelDaily = buildModelDaily(summary, sources, days, dailyDates);
  const cacheInputLike = models.reduce((sum, row) => sum + row.inputTokens + row.cachedInputTokens + row.cacheWriteTokens, 0);
  const cacheReuseRatio = cacheInputLike > 0
    ? models.reduce((sum, row) => sum + row.cachedInputTokens, 0) / cacheInputLike
    : 0;
  const dailyRows = Array.from(daily.values()).slice(-7).map((row, index) => ({
    period: `Day ${index + 1}`,
    tokens: row.tokens,
    turns: row.turns,
  }));
  const sourceCoverage = sources
    .filter((source) => numberValue(source.files) > 0 || (source.events || []).length > 0)
    .map((source) => ({
      source: source.provider === "claude"
        ? "Claude JSONL"
        : source.provider === "codex"
          ? "Codex JSONL / state SQLite"
          : "Normalized JSON / JSONL import",
      files: numberValue(source.files),
      events: (source.events || []).length,
      sessions: (source.sessions || []).length,
    }));
  const pace = (value) => ({
    status: value.status,
    usedTokens: value.usedTokens || value.last7dTokens || value.last5hTokens || 0,
    projectedTokens: value.projectedTokens || value.projected7dTokens || value.projected5hTokens || 0,
    measuredTokensPerHour: value.measuredTokensPerHour || 0,
    hasLocalBudget: numberValue(value.budgetTokens) > 0,
  });
  const workflow = buildWorkflowGuidance(summary, "auto").map((item) => ({
    title: item.title,
    target: item.target,
    detail: item.detail,
    steps: item.doNow,
  }));
  return {
    schema: "ai-spend-live-public-demo/v1",
    generatedOn: new Date().toISOString().slice(0, 10),
    period: `Recent ${days}-day example`,
    privacy: "Aggregate example only: no prompts, titles, paths, session IDs, environment values, or credentials.",
    coverageNote: "This example reflects supported local sources only; it is not an all-cloud or all-chat tracker.",
    coverage: sourceCoverage,
    totals: {
      tokens: summary.totals.totalTokens,
      turns: summary.totals.eventCount,
      sessions: summary.totals.sessionCount,
      breakdownUnknownTokens: aggregateUnknownBreakdown,
      cacheReuse: cacheReuseRatio,
      cacheReuseScope: "known token breakdown only",
      estimatedApiUsd: summary.totals.costUsd,
      inputTokens: models.reduce((sum, row) => sum + row.inputTokens, 0),
      cachedInputTokens: models.reduce((sum, row) => sum + row.cachedInputTokens, 0),
      cacheWriteTokens: models.reduce((sum, row) => sum + row.cacheWriteTokens, 0),
      outputTokens: models.reduce((sum, row) => sum + row.outputTokens, 0),
      estimatedInputUsd: models.reduce((sum, row) => sum + Number(row.estimatedInputUsd || 0), 0),
      estimatedOutputUsd: models.reduce((sum, row) => sum + Number(row.estimatedOutputUsd || 0), 0),
    },
    models,
    daily: dailyRows,
    dailyByModel: modelDaily,
    pacing: {
      fiveHour: pace(summary.budgetPace.fiveHour),
      weekly: pace(summary.budgetPace.weekly),
    },
    observedLimits: (summary.observedRateLimits || []).map((row) => ({
      limitId: row.limitId,
      windowMinutes: row.windowMinutes,
      usedPercent: row.usedPercent,
      projectedPercent: row.projectedPercent,
      status: row.status,
      resetKnown: Boolean(row.resetAt),
    })),
    subagents: {
      tokens: summary.subagentStats.subagentTokens,
      share: summary.subagentStats.subagentShare,
      sessions: summary.subagentStats.subagentSessionCount,
    },
    workflow,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const sources = await parseAllUsage({ days: args.days });
  const summary = buildSummary(sources, { days: args.days, provider: "all", task: "auto" });
  const output = buildPublicDemo(summary, sources, args.days);
  fs.mkdirSync(path.dirname(args.output), { recursive: true });
  fs.writeFileSync(args.output, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`Wrote sanitized public demo: ${args.output}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = { buildModelDaily, buildPublicDemo, disjointBreakdown, publicCostBreakdown };
