const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildSummary,
  estimateCost,
  estimateCredits,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  parseClaude,
  parseCodex,
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

  const codexTokens = normalizeCodexUsage({
    input_tokens: 10,
    cached_input_tokens: 5,
    output_tokens: 4,
    total_tokens: 14,
  });
  assert.equal(codexTokens.totalTokens, 14);

  const claude = await parseClaude(claudeRoot, 0, { sessionsMetaRoot: claudeSessionsRoot });
  const codex = await parseCodex(codexRoot, 0, { sqlitePath: codexSqlitePath, sessionIndexPath: path.join(root, "codex", "session_index.jsonl") });
  assert.equal(claude.sessions.length, 2);
  assert.equal(codex.sessions.length, 2);
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
  assert(sqliteSession.credits > 0);
  assert.equal(sqliteSession.displayName, "Weapon overlay alignment");

  const summary = buildSummary([claude, codex], { days: 365, provider: "all" });
  assert.equal(summary.topEvents.length, 4);
  assert.equal(summary.totals.eventCount, 5);
  assert(summary.totals.totalTokens >= 135220);
  assert.equal(summary.totals.unknownCostTokens, 0);
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
  assert(summary.budgetSessions.fiveHour.some((session) => session.displayName === "Build spend dashboard" || session.displayName === "Weapon overlay alignment"));
  assert.equal(summary.planPace.selected.claude, "custom");
  assert.equal(summary.planPace.selected.codex, "custom");
  assert(summary.promptGuidance.some((item) => item.title.includes("GPT-6")));
  assert(summary.promptGuidance.some((item) => item.title === "Protect the 5h window"));

  const planSummary = buildSummary([claude, codex], {
    days: 365,
    provider: "all",
    claudePlan: "claude-ultra",
    codexPlan: "codex-plus",
  });
  assert.equal(planSummary.planPace.claude.unlimitedFiveHour, true);
  assert.equal(planSummary.planPace.codex.messageRange.min, 5);
  assert(planSummary.planPace.codex.estimatedFiveHourTokenBudgetMin > 0);
  assert(planSummary.planPace.codex.weeklyNote.includes("weekly limits"));

  process.env.AI_SPEND_5H_TOKEN_BUDGET = "3000";
  process.env.AI_SPEND_WEEKLY_TOKEN_BUDGET = "6000";
  const pacedSummary = buildSummary([claude, codex], { days: 365, provider: "all" });
  delete process.env.AI_SPEND_5H_TOKEN_BUDGET;
  delete process.env.AI_SPEND_WEEKLY_TOKEN_BUDGET;
  assert.equal(pacedSummary.budgetPace.fiveHour.status, "over");
  assert.equal(pacedSummary.weeklyPace.status, "over");
  assert(pacedSummary.budgetPace.fiveHour.remainingTokens === 0);
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

  fs.rmSync(root, { recursive: true, force: true });
  console.log("AI spend dashboard tests passed");
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
