const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const {
  buildSummary,
  buildObservedRateLimits,
  cacheHitRatio,
  contextTokenRatio,
  createServer,
  estimateCost,
  estimateCredits,
  extractEffortFromModel,
  normalizeAgyUsage,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  normalizeImportedUsage,
  parseAgy,
  parseAllUsage,
  parseClaude,
  parseCodex,
  parseImportedUsage,
  buildWorkflowGuidance,
} = require("./ai-spend-dashboard-server");

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-spend-test-"));
  const claudeRoot = path.join(root, "claude", "projects");
  const claudeSessionsRoot = path.join(root, "claude", "sessions");
  const codexRoot = path.join(root, "codex", "sessions");
  const codexSqlitePath = path.join(root, "codex", "state_5.sqlite");
  const importRoot = path.join(root, "imports");
  const recentIso = new Date(Date.now() - 60000).toISOString();
  const recentEpochSec = Math.floor((Date.now() - 120000) / 1000);

  fs.mkdirSync(claudeSessionsRoot, { recursive: true });
  fs.writeFileSync(
    path.join(claudeSessionsRoot, "900.json"),
    JSON.stringify({
      pid: 900,
      sessionId: "claude-parent-session",
      cwd: "C:\\devland\\aiv-git",
      name: "launch-taketoon-platform",
      status: "busy",
      updatedAt: Date.now() - 30000,
    }),
    "utf8",
  );

  writeJsonl(path.join(claudeRoot, "project-a", "claude-session.jsonl"), [
    {
      type: "custom-title",
      sessionId: "claude-session",
      customTitle: "AIV dashboard polish",
    },
    {
      type: "user",
      timestamp: "2026-05-04T12:00:00.000Z",
      sessionId: "claude-session",
      cwd: "C:\\devland\\aiv-git",
      message: { role: "user", content: "SECRET_PROMPT_TEXT" },
    },
    {
      type: "assistant",
      timestamp: "2026-05-04T12:00:03.000Z",
      sessionId: "claude-session",
      cwd: "C:\\devland\\aiv-git",
      message: {
        role: "assistant",
        model: "claude-opus-5-5",
        usage: {
          input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 3000,
          output_tokens: 400,
        },
      },
    },
  ]);

  writeJsonl(
    path.join(claudeRoot, "project-a", "claude-parent-session", "subagents", "agent-a0145c46.jsonl"),
    [
      {
        type: "user",
        timestamp: recentIso,
        sessionId: "claude-parent-session",
        agentId: "a0145c46",
        slug: "parallel-pudding-worker",
        isSidechain: true,
        cwd: "C:\\devland\\aiv-git",
        message: { role: "user", content: "SECRET_SUBAGENT_PROMPT" },
      },
      {
        type: "assistant",
        timestamp: recentIso,
        sessionId: "claude-parent-session",
        agentId: "a0145c46",
        slug: "parallel-pudding-worker",
        isSidechain: true,
        cwd: "C:\\devland\\aiv-git",
        message: {
          role: "assistant",
          model: "claude-fable-5-1",
          usage: {
            input_tokens: 500,
            cache_creation_input_tokens: 100,
            cache_read_input_tokens: 1400,
            output_tokens: 200,
          },
        },
      },
    ],
  );

  writeJsonl(path.join(root, "codex", "session_index.jsonl"), [
    {
      id: "codex-session",
      thread_name: "Build spend dashboard",
      updated_at: "2026-05-04T13:00:03.000Z",
    },
    {
      id: "codex-sqlite-thread",
      thread_name: "Weapon overlay alignment",
      updated_at: recentIso,
    },
  ]);

  const { DatabaseSync } = require("node:sqlite");
  const db = new DatabaseSync(codexSqlitePath);
  db.exec(`
    CREATE TABLE threads (
      id TEXT PRIMARY KEY,
      rollout_path TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      cwd TEXT NOT NULL,
      title TEXT NOT NULL,
      sandbox_policy TEXT NOT NULL,
      approval_mode TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      agent_nickname TEXT,
      agent_role TEXT,
      model TEXT,
      reasoning_effort TEXT
    );
  `);
  const insertThread = db.prepare(`
    INSERT INTO threads (
      id, rollout_path, created_at, updated_at, source, model_provider, cwd,
      title, sandbox_policy, approval_mode, tokens_used, agent_nickname, agent_role, model, reasoning_effort
    ) VALUES (?, ?, ?, ?, 'cli', 'openai', ?, ?, 'workspace-write', 'on-request', ?, ?, ?, ?, ?)
  `);
  insertThread.run(
    "codex-sqlite-thread",
    path.join(codexRoot, "2026", "07", "19", "missing-rollout.jsonl"),
    recentEpochSec - 600,
    recentEpochSec,
    "C:\\devland\\aiv-git",
    "SECRET_SQLITE_PROMPT_TEXT do not expose this raw prompt in dashboard",
    125000,
    "Boyle",
    "implementer",
    "gpt-6-astra",
    "xhigh",
  );
  db.close();

  writeJsonl(path.join(codexRoot, "2026", "05", "04", "rollout-test.jsonl"), [
    {
      type: "session_meta",
      timestamp: "2026-05-04T13:00:00.000Z",
      payload: {
        id: "codex-session",
        cwd: "C:\\devland\\aiv-git",
        model_provider: "openai",
      },
    },
    {
      type: "turn_context",
      timestamp: "2026-05-04T13:00:00.001Z",
      payload: {
        cwd: "C:\\devland\\aiv-git",
        model: "gpt-6.1-sol",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-05-04T13:00:02.000Z",
      payload: {
        type: "token_count",
        rate_limits: {
          limit_id: "codex",
          primary: { used_percent: 12, window_minutes: 10080, resets_at: Math.floor(Date.now() / 1000) + 3600 },
        },
        info: {
          last_token_usage: {
            input_tokens: 2000,
            cached_input_tokens: 1000,
            output_tokens: 120,
            reasoning_output_tokens: 20,
            total_tokens: 2120,
          },
          total_token_usage: {
            input_tokens: 2000,
            cached_input_tokens: 1000,
            output_tokens: 120,
            reasoning_output_tokens: 20,
            total_tokens: 2120,
          },
        },
      },
    },
    {
      type: "event_msg",
      timestamp: recentIso,
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 3000,
            cached_input_tokens: 0,
            output_tokens: 400,
            reasoning_output_tokens: 100,
            total_tokens: 3500,
          },
          total_token_usage: {
            input_tokens: 5000,
            cached_input_tokens: 1000,
            output_tokens: 520,
            reasoning_output_tokens: 120,
            total_tokens: 5620,
          },
        },
      },
    },
  ]);

  const claudeTokens = normalizeClaudeUsage({
    input_tokens: 10,
    cache_creation_input_tokens: 20,
    cache_read_input_tokens: 30,
    output_tokens: 40,
  });
  assert.equal(claudeTokens.totalTokens, 100);
  const claudeBreakdownTokens = normalizeClaudeUsage({
    input_tokens: 10,
    cache_creation_input_tokens: 20,
    cache_creation: { ephemeral_5m_input_tokens: 15, ephemeral_1h_input_tokens: 5 },
    cache_read_input_tokens: 30,
    output_tokens: 40,
  });
  assert.equal(claudeBreakdownTokens.cacheCreationInputTokens, 15, "cache_creation breakdown must not be added on top of the total");
  assert.equal(claudeBreakdownTokens.cacheCreation1hInputTokens, 5);
  assert.equal(claudeBreakdownTokens.totalTokens, 100);

  const codexTokens = normalizeCodexUsage({
    input_tokens: 10,
    cached_input_tokens: 5,
    output_tokens: 4,
    total_tokens: 14,
  });
  assert.equal(codexTokens.totalTokens, 14);

  const importedTokens = normalizeImportedUsage({
    input_tokens: 100,
    cached_input_tokens: 25,
    output_tokens: 10,
    total_tokens: 135,
  });
  assert.equal(importedTokens.totalTokens, 135);

  writeJsonl(path.join(importRoot, "runner.jsonl"), [
    {
      id: "imported-turn-1",
      timestamp: recentIso,
      provider: "local-runner",
      model: "mystery-model-v9",
      session_id: "import-session",
      is_subagent: true,
      usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10, total_tokens: 135 },
    },
    {
      id: "imported-turn-1",
      timestamp: recentIso,
      provider: "local-runner",
      model: "mystery-model-v9",
      session_id: "import-session",
      is_subagent: true,
      usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10, total_tokens: 135 },
    },
  ]);

  const claude = await parseClaude(claudeRoot, 0, { sessionsMetaRoot: claudeSessionsRoot });
  const codex = await parseCodex(codexRoot, 0, { sqlitePath: codexSqlitePath, sessionIndexPath: path.join(root, "codex", "session_index.jsonl") });
  const imported = await parseImportedUsage(importRoot, 0);
  assert.equal(claude.sessions.length, 2);
  assert.equal(codex.sessions.length, 2);
  assert(codex.rateLimitSnapshots.length > 0, "Codex rate-limit snapshots should be parsed");
  assert.equal(imported.events.length, 1, "duplicate imported IDs must not double count");
  assert.equal(imported.events[0].model, "mystery-model-v9");
  assert.equal(imported.events[0].isSubagent, true);
  const mainClaudeEvent = claude.events.find((event) => event.sessionId === "claude-session");
  const firstCodexEvent = codex.events.find((event) => event.sessionId === "codex-session" && event.turnIndex === 1);
  const secondCodexEvent = codex.events.find((event) => event.sessionId === "codex-session" && event.turnIndex === 2);
  assert.equal(mainClaudeEvent.totalTokens, 4600);
  assert.equal(firstCodexEvent.totalTokens, 2120);
  assert.equal(secondCodexEvent.totalTokens, 3500);
  assert.equal(firstCodexEvent.model, "gpt-6.1-sol");
  assert.equal(mainClaudeEvent.displayName, "AIV dashboard polish");
  assert.equal(firstCodexEvent.displayName, "Build spend dashboard");

  const fableCost = estimateCost("claude", "claude-fable-5-1", { inputTokens: 1000000, outputTokens: 100000 });
  assert.equal(fableCost.known, true);
  assert.equal(fableCost.usd, 15);
  const opus55Cost = estimateCost("claude", "claude-opus-5-5", { inputTokens: 1000000, outputTokens: 100000 });
  assert.equal(opus55Cost.known, true);
  assert.equal(opus55Cost.label, "Claude Opus 5.5");
  assert.equal(opus55Cost.usd, 6);
  const sonnet55Cost = estimateCost("claude", "claude-sonnet-5-5", { inputTokens: 1000000, outputTokens: 100000 });
  assert.equal(sonnet55Cost.known, true);
  assert.equal(sonnet55Cost.usd, 3);
  const haiku55LongCost = estimateCost("claude", "claude-haiku-5-5", { inputTokens: 120000, outputTokens: 12000 });
  assert.equal(haiku55LongCost.known, true);
  assert.equal(haiku55LongCost.pricingTier, "long");
  assert.equal(haiku55LongCost.usd, 0.09);
  const haiku45Cost = estimateCost("claude", "claude-haiku-4-5-20251001", { inputTokens: 1000000, outputTokens: 0 });
  assert.equal(haiku45Cost.known, true);
  assert.equal(haiku45Cost.usd, 1);
  const astraCost = estimateCost("codex", "gpt-6-astra", { inputTokens: 100000, cachedInputTokens: 0, outputTokens: 10000 });
  assert.equal(astraCost.known, true);
  assert.equal(astraCost.label, "GPT-6 Astra");
  assert.equal(astraCost.usd, 1.5);
  const solCost = estimateCost("codex", "gpt-6.1-sol", { inputTokens: 100000, cachedInputTokens: 0, outputTokens: 10000 });
  assert.equal(solCost.known, true);
  assert.equal(solCost.label, "GPT-6.1 Sol");
  assert.equal(solCost.usd, 0.3);
  const terraCost = estimateCost("codex", "gpt-6.1-terra", { inputTokens: 100000, cachedInputTokens: 0, outputTokens: 10000 });
  assert.equal(terraCost.known, true);
  assert.equal(terraCost.label, "GPT-6.1 Terra");
  assert.equal(terraCost.usd, 0.15);
  const lunaCost = estimateCost("codex", "gpt-6-luna", { inputTokens: 100000, cachedInputTokens: 0, outputTokens: 10000 });
  assert.equal(lunaCost.known, true);
  assert.equal(lunaCost.label, "GPT-6 Luna");
  assert.equal(lunaCost.usd, 0.015);
  const longSolCost = estimateCost("codex", "gpt-6.1-sol", { inputTokens: 300000, cachedInputTokens: 0, outputTokens: 30000 });
  assert.equal(longSolCost.pricingTier, "long");
  assert.equal(longSolCost.usd, 1.65);
  const solCredits = estimateCredits("codex", "gpt-6.1-sol", { inputTokens: 1000000, cachedInputTokens: 500000, outputTokens: 100000 });
  assert.equal(solCredits.known, true);
  assert.equal(solCredits.credits, 51.25);

  const subagentSession = claude.sessions.find((s) => s.isSubagent);
  assert(subagentSession, "expected subagent session to be flagged");
  assert.notEqual(subagentSession.project, "subagents");
  assert.equal(subagentSession.project, "project-a");
  assert(subagentSession.displayName.includes("launch-taketoon-platform"));
  assert.equal(subagentSession.liveStatus, "busy");

  const sqliteSession = codex.sessions.find((s) => s.id === "codex-sqlite-thread");
  assert(sqliteSession, "expected codex sqlite thread fallback session");
  assert.equal(sqliteSession.model, "gpt-6-astra");
  assert.equal(sqliteSession.reasoningEffort, "xhigh");
  assert.equal(sqliteSession.totalTokens, 125000);
  assert.equal(sqliteSession.credits, 0, "SQLite totals must not fabricate credits from an inferred breakdown");
  assert(sqliteSession.unknownCostTokens >= 125000);
  assert.equal(sqliteSession.displayName, "Weapon overlay alignment");

  const summary = buildSummary([claude, codex], { days: 365, provider: "all" });
  assert.equal(summary.topEvents.length, 4);
  assert.equal(summary.totals.eventCount, 5);
  assert(summary.totals.totalTokens >= 135220);
  assert(summary.totals.breakdownUnknownTokens >= 125000);
  assert.equal(summary.windows.last5h.breakdownUnknownTokens, 0);
  assert(summary.totals.unknownCostTokens >= 125000);
  assert(summary.totals.credits > 0);
  assert(Array.isArray(summary.modelCatalog) && summary.modelCatalog.length >= 10);
  const astraCatalog = summary.modelCatalog.find((model) => model.id === "gpt-6-astra");
  assert(astraCatalog, "expected GPT-6 Astra in the model catalog");
  assert.equal(astraCatalog.contextWindow, 1050000);
  assert.equal(astraCatalog.inputPer1M, 10);
  assert.equal(astraCatalog.creditInputPer1M, 250);
  assert(summary.subagentStats && summary.subagentStats.subagentTokens === 127200);
  assert(summary.topSessions.some((session) => session.displayName === "AIV dashboard polish"));
  assert(summary.topSessions.some((session) => session.displayName === "Build spend dashboard"));
  assert(summary.topSessions.some((session) => session.displayName === "Weapon overlay alignment"));
  assert(summary.recommendations.length > 0);
  assert(summary.recommendations[0].ask.includes("Summarize"));
  assert(summary.topSessions.some((session) => session.recommendation && session.recommendation.label));
  assert(summary.topEvents.some((event) => event.recommendation && event.recommendation.label));
  assert.equal(summary.weeklyPace.status, "unset");
  assert.equal(summary.budgetPace.fiveHour.status, "unset");
  assert(summary.windows.last5h.totalTokens >= 3500);
  assert.equal(summary.windows.last5h.totalTokens, 5700, "SQLite cumulative totals must not inflate fresh pacing windows");
  assert(summary.budgetSessions.fiveHour.some((session) => session.displayName === "Build spend dashboard" || session.displayName === "Weapon overlay alignment"));
  assert.equal(summary.planPace.selected.claude, "custom");
  assert.equal(summary.planPace.selected.codex, "custom");
  assert(summary.promptGuidance.some((item) => item.title.includes("GPT-6")));
  assert(summary.promptGuidance.some((item) => item.title === "Protect the 5h window"));
  assert(summary.recommendations.some((item) => /handoff|restart/i.test(`${item.title} ${item.reason}`)));

  const importedSummary = buildSummary([claude, codex, imported], { days: 365, provider: "all", task: "implement" });
  const unknownCatalog = importedSummary.modelCatalog.find((model) => model.id === "mystery-model-v9");
  assert(unknownCatalog, "observed model IDs must appear in the catalog");
  assert.equal(unknownCatalog.pricingKnown, false);
  assert(importedSummary.modelTotals.some((model) => model.model === "mystery-model-v9"));
  assert(importedSummary.workflowGuidance.some((item) => item.title.includes("implementation")));
  const workflow = buildWorkflowGuidance(importedSummary, "review");
  assert(workflow.some((item) => /review/i.test(item.title)));

  const rateNow = Date.now();
  const rateLimits = buildObservedRateLimits([
    { provider: "codex", limitId: "codex:primary", limitName: "weekly", windowMinutes: 10080, resetAt: rateNow + 4 * 3600000, usedPercent: 20, timestampMs: rateNow - 3600000 },
    { provider: "codex", limitId: "codex:primary", limitName: "weekly", windowMinutes: 10080, resetAt: rateNow + 4 * 3600000, usedPercent: 30, timestampMs: rateNow - 1800000 },
    { provider: "codex", limitId: "codex:primary", limitName: "weekly", windowMinutes: 10080, resetAt: rateNow + 8 * 3600000, usedPercent: 2, timestampMs: rateNow - 600000 },
    { provider: "codex", limitId: "codex:secondary", limitName: "short", windowMinutes: 300, resetAt: rateNow - 600000, usedPercent: 80, timestampMs: rateNow - 3 * 3600000 },
  ], rateNow, true);
  assert.equal(rateLimits.length, 3);
  const projectedRate = rateLimits.find((item) => item.limitId === "codex:primary" && item.resetAt === new Date(rateNow + 4 * 3600000).toISOString());
  assert(projectedRate && projectedRate.projectedPercent !== null, "fresh same-reset samples should project");
  const resetRate = rateLimits.find((item) => item.resetAt === new Date(rateNow + 8 * 3600000).toISOString());
  assert(resetRate && resetRate.projectedPercent === null, "reset changes must not reuse the prior slope");
  const staleRate = rateLimits.find((item) => item.limitId === "codex:secondary");
  assert(staleRate && staleRate.status === "stale");

  const pressureNow = Date.now();
  const pressureReset = pressureNow + 4 * 3600000;
  const pressureSummary = buildSummary([{
    provider: "codex",
    sessions: [],
    events: [],
    rateLimitSnapshots: [
      { provider: "codex", limitId: "codex:primary", limitName: "weekly", windowMinutes: 10080, resetAt: pressureReset, usedPercent: 82, timestampMs: pressureNow - 30 * 60000 },
      { provider: "codex", limitId: "codex:primary", limitName: "weekly", windowMinutes: 10080, resetAt: pressureReset, usedPercent: 88, timestampMs: pressureNow - 10 * 60000 },
    ],
  }], { days: 365, provider: "all" });
  assert(pressureSummary.recommendations.some((item) => item.title === "Protect the observed limit"));
  assert(pressureSummary.recommendations.some((item) => /measured|observed/i.test(item.reason)));
  assert(pressureSummary.insights.some((item) => item.title === "Observed limit pressure"));

  const oldSlopeSummary = buildSummary([{
    provider: "codex", sessions: [], events: [],
    rateLimitSnapshots: [
      { provider: "codex", limitId: "codex:primary", limitName: "5h", windowMinutes: 300, resetAt: pressureReset, usedPercent: 10, timestampMs: pressureNow - 3 * 3600000 },
      { provider: "codex", limitId: "codex:primary", limitName: "5h", windowMinutes: 300, resetAt: pressureReset, usedPercent: 70, timestampMs: pressureNow - 10 * 60000 },
    ],
  }], { days: 365, provider: "all" });
  assert.equal(oldSlopeSummary.observedRateLimits[0].projectedPercent, null, "A stale earlier sample must not support a forecast");
  assert(!oldSlopeSummary.recommendations.some((item) => item.title === "Protect the observed limit"), "Stale slopes must not cause a limit warning");

  const expiredSummary = buildSummary([{
    provider: "codex", sessions: [], events: [],
    rateLimitSnapshots: [{ provider: "codex", limitId: "codex:primary", limitName: "5h", windowMinutes: 300, resetAt: pressureNow - 30000, usedPercent: 95, timestampMs: pressureNow - 60000 }],
  }], { days: 365, provider: "all" });
  assert.equal(expiredSummary.observedRateLimits[0].fresh, false, "A reset window must not remain fresh");
  assert(!expiredSummary.recommendations.some((item) => item.title === "Protect the observed limit"), "Expired windows must not cause a current limit warning");

  const planSummary = buildSummary([claude, codex], {
    days: 365,
    provider: "all",
    claudePlan: "claude-ultra",
    codexPlan: "codex-plus",
  });
  assert.equal(planSummary.planPace.claude.unlimitedFiveHour, true);
  assert.equal(planSummary.planPace.codex.messageRange.min, 15, "plan estimates must use timestamped usage, not SQLite cumulative totals");
  assert(planSummary.planPace.codex.estimatedFiveHourTokenBudgetMin > 0);
  assert(planSummary.planPace.codex.weeklyNote.includes("weekly limits"));

  process.env.AI_SPEND_5H_TOKEN_BUDGET = "3000";
  process.env.AI_SPEND_WEEKLY_TOKEN_BUDGET = "6000";
  const pacedSummary = buildSummary([claude, codex], { days: 365, provider: "all" });
  delete process.env.AI_SPEND_5H_TOKEN_BUDGET;
  delete process.env.AI_SPEND_WEEKLY_TOKEN_BUDGET;
  assert.equal(pacedSummary.budgetPace.fiveHour.status, "over");
  assert.equal(pacedSummary.weeklyPace.status, "risk");
  assert.equal(pacedSummary.budgetPace.fiveHour.remainingTokens, 0);
  assert(pacedSummary.recommendations.some((item) => item.title === "Stop the 5h drain"));
  assert(pacedSummary.recommendations.some((item) => item.title === "Slow the weekly burn"));
  assert(pacedSummary.budgetSessions.fiveHour[0].shareOfBudget > 0);
  assert(pacedSummary.promptGuidance.some((item) => item.title === "Pace the weekly envelope"));

  const payloadText = JSON.stringify(summary);
  assert(!payloadText.includes("SECRET_PROMPT_TEXT"), "summary must not expose prompt text");
  assert(!payloadText.includes("SECRET_SUBAGENT_PROMPT"), "summary must not expose subagent prompt text");
  assert(!payloadText.includes("SECRET_SQLITE_PROMPT_TEXT"), "summary must not expose sqlite thread prompt text");
  assert(payloadText.includes("claude"));
  assert(payloadText.includes("codex"));

  // --- New v0.7.0 tests: Codex cacheHitRatio/contextTokenRatio fix, /fast, Claude effort/speed/thinking, model catalog, parseAgy & /swarm, /api/guard-proxy ---
  const codexHighCache = { inputTokens: 10000, cachedInputTokens: 9000, outputTokens: 500, totalTokens: 10500 };
  assert(Math.abs(cacheHitRatio(codexHighCache) - 0.9) < 1e-9, "Codex cacheHitRatio must not double-count cachedInputTokens (>50% possible)");
  assert(Math.abs(contextTokenRatio(codexHighCache) - (10000 / 10500)) < 1e-9, "Codex contextTokenRatio must stay <= 1");
  const claudeCacheSample = { inputTokens: 1000, cacheCreationInputTokens: 200, cacheCreation1hInputTokens: 100, cacheReadInputTokens: 3000, cachedInputTokens: 0, outputTokens: 400, totalTokens: 4700 };
  assert(Math.abs(cacheHitRatio(claudeCacheSample) - (3000 / 4300)) < 1e-9, "Claude cacheHitRatio stays exact");
  assert(Math.abs(contextTokenRatio(claudeCacheSample) - (4300 / 4700)) < 1e-9, "Claude contextTokenRatio stays exact");

  // Claude thinking_tokens & Codex cache_write_input_tokens normalization
  const claudeThinking = normalizeClaudeUsage({
    input_tokens: 100,
    cache_read_input_tokens: 500,
    output_tokens: 200,
    output_tokens_details: { thinking_tokens: 80 },
  });
  assert.equal(claudeThinking.reasoningOutputTokens, 80, "Claude thinking_tokens preserved in reasoningOutputTokens");
  assert.equal(claudeThinking.totalTokens, 800, "thinking_tokens is a subset of output_tokens and must not inflate totalTokens");
  const codexCacheWrite = normalizeCodexUsage({
    input_tokens: 1000,
    cached_input_tokens: 800,
    cache_write_input_tokens: 150,
    output_tokens: 100,
    total_tokens: 1100,
  });
  assert.equal(codexCacheWrite.cacheCreationInputTokens, 150, "Codex cache_write_input_tokens captured in cacheCreationInputTokens");
  assert.equal(codexCacheWrite.totalTokens, 1100);

  // Effort suffix & AGY disjoint token normalization
  assert.equal(extractEffortFromModel("gemini-4-neon-xhigh"), "xhigh");
  assert.equal(extractEffortFromModel("gemini-4-carbon-high"), "high");
  assert.equal(extractEffortFromModel("gemini-3.8-flash-medium"), "medium");
  assert.equal(extractEffortFromModel("claude-opus-5-5"), "");
  const agyTokens = normalizeAgyUsage({ input_tokens: 1000, cache_read_tokens: 9000, output_tokens: 250 });
  assert.equal(agyTokens.cacheReadInputTokens, 9000);
  assert.equal(agyTokens.cachedInputTokens, 0);
  assert.equal(agyTokens.totalTokens, 10250, "AGY input + cache_read + output are disjoint");
  assert(Math.abs(cacheHitRatio(agyTokens) - 0.9) < 1e-9, "AGY cacheHitRatio uses disjoint cacheReadInputTokens");

  // Unverified newer models must not fabricate costs or mis-match legacy regexes
  const fable52Cost = estimateCost("claude", "claude-fable-5-2", { inputTokens: 1000000, outputTokens: 100000 });
  assert.equal(fable52Cost.known, false, "claude-fable-5-2 pricing must stay unknown instead of mis-matching legacy fable-5");
  assert.equal(fable52Cost.label, "Claude Fable 5.2");
  assert.equal(fable52Cost.usd, 0);
  const gpt62SolCost = estimateCost("codex", "gpt-6.2-sol", { inputTokens: 1000000, outputTokens: 100000 });
  assert.equal(gpt62SolCost.known, false);
  assert.equal(gpt62SolCost.label, "GPT-6.2 Sol");
  const gpt62AstraCost = estimateCost("codex", "gpt-6.2-astra", { inputTokens: 1000000, outputTokens: 100000 });
  assert.equal(gpt62AstraCost.known, false);
  const neonCost = estimateCost("agy", "gemini-4-neon-xhigh", agyTokens);
  assert.equal(neonCost.known, false);
  assert.equal(neonCost.label, "Gemini 4 Neon");
  for (const [prov, id] of [
    ["claude", "claude-fable-5-2"],
    ["codex", "gpt-6.2-sol"],
    ["codex", "gpt-6.2-astra"],
    ["agy", "gemini-4-neon"],
    ["agy", "gemini-4-carbon"],
    ["agy", "gemini-4-argon"],
    ["agy", "gemini-4-hydrogen"],
    ["agy", "gemini-3.8-flash"],
  ]) {
    const entry = summary.modelCatalog.find((m) => m.provider === prov && m.id === id);
    assert(entry, `expected ${prov}:${id} in modelCatalog`);
    assert.equal(entry.pricingKnown, false, `${prov}:${id} must have pricingKnown: false`);
  }

  // Claude effort/speed + Codex /fast (thread_settings_applied) + AGY /swarm fixture
  const speedClaudeRoot = path.join(root, "speed-claude", "projects");
  writeJsonl(path.join(speedClaudeRoot, "proj-fast", "claude-fast.jsonl"), [
    {
      type: "assistant",
      timestamp: recentIso,
      sessionId: "claude-fast",
      cwd: "C:\\devland\\aispend-live",
      effort: "high",
      perTurnEffort: "max",
      message: {
        id: "msg_fast_1",
        role: "assistant",
        model: "claude-fable-5-2",
        output_config: { effort: "high" },
        usage: {
          input_tokens: 400,
          cache_read_input_tokens: 1600,
          output_tokens: 200,
          output_tokens_details: { thinking_tokens: 60 },
          speed: "fast",
          service_tier: "standard",
        },
      },
    },
  ]);

  const speedCodexRoot = path.join(root, "speed-codex", "sessions");
  writeJsonl(path.join(speedCodexRoot, "2026", "11", "22", "rollout-fast.jsonl"), [
    {
      type: "session_meta",
      timestamp: recentIso,
      payload: { id: "codex-fast-session", cwd: "C:\\devland\\aispend-live", model_provider: "openai" },
    },
    {
      timestamp: recentIso,
      ordinal: 2,
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_id: "codex-fast-session",
        thread_settings: {
          model: "gpt-6.2-sol",
          service_tier: "priority",
          reasoning_effort: "xhigh",
          cwd: "C:\\devland\\aispend-live",
        },
      },
    },
    {
      timestamp: recentIso,
      ordinal: 3,
      type: "event_msg",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 5000,
            cached_input_tokens: 4000,
            cache_write_input_tokens: 200,
            output_tokens: 500,
            reasoning_output_tokens: 100,
            total_tokens: 5500,
          },
          total_token_usage: {
            input_tokens: 5000,
            cached_input_tokens: 4000,
            cache_write_input_tokens: 200,
            output_tokens: 500,
            reasoning_output_tokens: 100,
            total_tokens: 5500,
          },
        },
      },
    },
  ]);

  // AGY fixture with coordinator + swarm worker (missing per-step model -> member fallback) + standalone subagent + SQLite metadata
  const agyRoot = path.join(root, "agy");
  const coordId = "11111111-1111-1111-1111-111111111111";
  const workerId = "22222222-2222-2222-2222-222222222222";
  const subId = "33333333-3333-3333-3333-333333333333";
  fs.mkdirSync(path.join(agyRoot, "brain", coordId, ".system_generated", "swarm"), { recursive: true });
  fs.writeFileSync(
    path.join(agyRoot, "brain", coordId, ".system_generated", "swarm", "swarm.json"),
    JSON.stringify({ version: 1, backend: "local", swarm_id: coordId, created_at: recentIso }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(agyRoot, "brain", coordId, ".system_generated", "swarm", "members.json"),
    JSON.stringify({
      title: "SECRET_AGY_SWARM_TITLE",
      members: {
        coordinator: { conversation_id: coordId, model: "gemini-4-neon-xhigh", role: "coordinator" },
        "data-engine": { conversation_id: workerId, applied_model: "gemini-4-carbon-high", role: "worker" },
      },
    }),
    "utf8",
  );
  writeJsonl(path.join(agyRoot, "brain", coordId, ".system_generated", "swarm", "board.jsonl"), [
    { seq: 1, agent: "coordinator", text: "SECRET_AGY_BOARD_TEXT" },
  ]);
  fs.mkdirSync(path.join(agyRoot, "brain", coordId, ".system_generated", "subagents"), { recursive: true });
  fs.writeFileSync(
    path.join(agyRoot, "brain", coordId, ".system_generated", "subagents", `${subId}.json`),
    JSON.stringify({
      conversationId: subId,
      state: "SUBAGENT_STATE_ALIVE",
      subagentDescriptor: { typeName: "researcher", role: "SECRET_AGY_SUBAGENT_ROLE" },
      workspaceUris: ["file:///C:/devland/aispend-live"],
    }),
    "utf8",
  );
  writeJsonl(path.join(agyRoot, "brain", coordId, ".system_generated", "logs", "transcript.jsonl"), [
    { step_index: 0, type: "USER_INPUT", created_at: recentIso, text: "SECRET_AGY_PROMPT" },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: recentIso, model: "gemini-4-neon-xhigh", input_tokens: 1000, cache_read_tokens: 4000, output_tokens: 500, thinking: "SECRET_AGY_THINKING" },
  ]);
  writeJsonl(path.join(agyRoot, "brain", workerId, ".system_generated", "logs", "transcript.jsonl"), [
    { step_index: 0, type: "SYSTEM_MESSAGE", created_at: recentIso, text: "SECRET_AGY_WORKER_PROMPT" },
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: recentIso, input_tokens: 2000, cache_read_tokens: 8000, output_tokens: 1000 },
  ]);
  writeJsonl(path.join(agyRoot, "brain", subId, ".system_generated", "logs", "transcript.jsonl"), [
    { step_index: 1, type: "PLANNER_RESPONSE", status: "DONE", created_at: recentIso, model: "gemini-3.8-flash-medium", input_tokens: 500, cache_read_tokens: 1500, output_tokens: 100 },
  ]);

  const agyDb = new DatabaseSync(path.join(agyRoot, "conversation_summaries.db"));
  agyDb.exec(`
    CREATE TABLE conversation_summaries (
      conversation_id TEXT PRIMARY KEY,
      title TEXT,
      preview TEXT,
      step_count INTEGER,
      last_modified_time TEXT,
      workspace_uris TEXT,
      status TEXT,
      project_id TEXT,
      agent_name TEXT,
      parent_conversation_id TEXT,
      nesting_depth INTEGER,
      killed INTEGER
    );
  `);
  const insertAgySummary = agyDb.prepare(`
    INSERT INTO conversation_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insertAgySummary.run(coordId, "SECRET_AGY_SQLITE_TITLE", "SECRET_AGY_SQLITE_PREVIEW", 10, recentIso, '["file:///C:/devland/aispend-live"]', "CASCADE_RUN_STATUS_RUNNING", "default-cli-project", "", null, 0, 0);
  insertAgySummary.run(workerId, "SECRET_AGY_WORKER_TITLE", "SECRET_AGY_WORKER_PREVIEW", 5, recentIso, '["file:///C:/devland/aispend-live"]', "CASCADE_RUN_STATUS_IDLE", "default-cli-project", "data-engine", coordId, 1, 0);
  insertAgySummary.run(subId, "SECRET_AGY_SUB_TITLE", "SECRET_AGY_SUB_PREVIEW", 3, recentIso, '["file:///C:/devland/aispend-live"]', "CASCADE_RUN_STATUS_IDLE", "default-cli-project", "research", coordId, 1, 0);
  agyDb.close();

  const speedClaude = await parseClaude(speedClaudeRoot, 0, { sessionsMetaRoot: path.join(root, "nope") });
  const speedCodex = await parseCodex(speedCodexRoot, 0, { includeSqlite: false, sessionIndexPath: path.join(root, "nope.jsonl") });
  const agy = await parseAgy(agyRoot, 0);

  assert.equal(speedClaude.events[0].reasoningEffort, "high");
  assert.equal(speedClaude.events[0].serviceTier, "fast");
  assert.equal(speedClaude.events[0].tokens.reasoningOutputTokens, 60);
  assert.equal(speedClaude.events[0].costKnown, false, "claude-fable-5-2 must stay unpriced");

  assert.equal(speedCodex.events[0].model, "gpt-6.2-sol");
  assert.equal(speedCodex.events[0].serviceTier, "fast", "Codex thread_settings_applied service_tier=priority maps to fast");
  assert.equal(speedCodex.events[0].reasoningEffort, "xhigh");
  assert.equal(speedCodex.events[0].tokens.cacheCreationInputTokens, 200);
  assert(Math.abs(speedCodex.sessions[0].cacheHitRatio - 0.8) < 1e-9, "Codex session cacheHitRatio can exceed 50% (80%)");

  assert.equal(agy.sessions.length, 3);
  assert.equal(agy.swarms, 1);
  const agyCoord = agy.sessions.find((s) => s.id === coordId);
  const agyWorker = agy.sessions.find((s) => s.id === workerId);
  const agySub = agy.sessions.find((s) => s.id === subId);
  assert(agyCoord && !agyCoord.isSubagent && agyCoord.swarmId === coordId && agyCoord.project === "aispend-live" && agyCoord.liveStatus === "running");
  assert.equal(agyCoord.totalTokens, 5500);
  assert.equal(agyCoord.reasoningEffort, "xhigh");
  assert(agyWorker && agyWorker.isSubagent && agyWorker.subagentKind === "swarm_worker" && agyWorker.swarmId === coordId);
  assert.equal(agyWorker.model, "gemini-4-carbon-high", "missing per-step AGY model falls back to swarm member model");
  assert.equal(agyWorker.reasoningEffort, "high");
  assert.equal(agyWorker.totalTokens, 11000);
  assert(Math.abs(agyWorker.cacheHitRatio - 0.8) < 1e-9);
  assert(agySub && agySub.isSubagent && agySub.subagentKind === "subagent" && !agySub.swarmId);
  assert.equal(agySub.reasoningEffort, "medium");
  assert.equal(agySub.totalTokens, 2100);

  const v07Summary = buildSummary([speedClaude, speedCodex, agy], { days: 7, provider: "all" });
  assert(v07Summary.roots.agy && v07Summary.roots.agy.provider === "agy");
  assert.equal(v07Summary.speedStats.fastTurns, 2);
  assert.equal(v07Summary.speedStats.fastTokens, 2200 + 5500);
  assert.equal(v07Summary.speedStats.byProvider.codex.fastTokens, 5500);
  assert.equal(v07Summary.speedStats.byProvider.claude.fastTokens, 2200);
  assert.equal(v07Summary.swarmStats.swarmCount, 1);
  assert.equal(v07Summary.swarmStats.swarmWorkerSessions, 1);
  assert.equal(v07Summary.swarmStats.swarmWorkerTokens, 11000);
  assert.equal(v07Summary.swarmStats.subagentTokens, 11000 + 2100);
  assert.equal(v07Summary.swarmStats.totalAgyTokens, 5500 + 11000 + 2100);
  assert(Math.abs(v07Summary.swarmStats.swarmShareOfAgy - (11000 / 18600)) < 1e-9);
  const v07Text = JSON.stringify(v07Summary);
  assert(!v07Text.includes("SECRET_AGY_"), "AGY summary must never expose raw prompts, board text, or sqlite titles/previews");

  // parseAllUsage gracefully skips missing AGY root or includeAgy: false
  const skippedAgy = await parseAllUsage({
    days: 7,
    claudeRoot: speedClaudeRoot,
    codexRoot: speedCodexRoot,
    agyRoot: path.join(root, "missing-agy"),
    includeSqlite: false,
    sessionsMetaRoot: path.join(root, "nope"),
    sessionIndexPath: path.join(root, "nope.jsonl"),
  });
  assert.equal(skippedAgy.find((s) => s.provider === "agy").events.length, 0);
  const includedAgy = await parseAllUsage({
    days: 7,
    claudeRoot: speedClaudeRoot,
    codexRoot: speedCodexRoot,
    agyRoot,
    includeSqlite: false,
    sessionsMetaRoot: path.join(root, "nope"),
    sessionIndexPath: path.join(root, "nope.jsonl"),
  });
  assert.equal(includedAgy.find((s) => s.provider === "agy").events.length, 3);

  // /api/guard-proxy route forwards Guard /api/state (including optimizer) on same origin
  const mockGuard = http.createServer((req, res) => {
    if (req.url === "/api/state") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, optimizer: { strategy: "accelerate", headline: "Use AGY /swarm" } }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => mockGuard.listen(0, "127.0.0.1", resolve));
  const dashServer = createServer();
  await new Promise((resolve) => dashServer.listen(0, "127.0.0.1", resolve));
  const prevGuardUrl = process.env.AI_SPEND_GUARD_URL;
  process.env.AI_SPEND_GUARD_URL = `http://127.0.0.1:${mockGuard.address().port}`;
  try {
    const proxyRes = await fetch(`http://127.0.0.1:${dashServer.address().port}/api/guard-proxy`);
    assert.equal(proxyRes.status, 200);
    const proxyBody = await proxyRes.json();
    assert.equal(proxyBody.optimizer.strategy, "accelerate");
  } finally {
    if (prevGuardUrl === undefined) delete process.env.AI_SPEND_GUARD_URL;
    else process.env.AI_SPEND_GUARD_URL = prevGuardUrl;
    await new Promise((resolve) => dashServer.close(resolve));
    await new Promise((resolve) => mockGuard.close(resolve));
  }

  fs.rmSync(root, { recursive: true, force: true });
  console.log("AI spend dashboard tests passed");
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
