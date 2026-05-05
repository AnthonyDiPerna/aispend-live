const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  buildSummary,
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
  const codexRoot = path.join(root, "codex", "sessions");
  const recentIso = new Date(Date.now() - 60000).toISOString();

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
        model: "claude-opus-4-7",
        usage: {
          input_tokens: 1000,
          cache_creation_input_tokens: 200,
          cache_read_input_tokens: 3000,
          output_tokens: 400,
        },
      },
    },
  ]);

  writeJsonl(path.join(root, "codex", "session_index.jsonl"), [
    {
      id: "codex-session",
      thread_name: "Build spend dashboard",
      updated_at: "2026-05-04T13:00:03.000Z",
    },
  ]);

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
        model: "gpt-5.5",
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

  const claude = await parseClaude(claudeRoot, 0);
  const codex = await parseCodex(codexRoot, 0);
  assert.equal(claude.sessions.length, 1);
  assert.equal(codex.sessions.length, 1);
  assert.equal(claude.events[0].totalTokens, 4600);
  assert.equal(codex.events[0].totalTokens, 2120);
  assert.equal(codex.events[1].totalTokens, 3500);
  assert.equal(codex.events[0].model, "gpt-5.5");
  assert.equal(claude.events[0].displayName, "AIV dashboard polish");
  assert.equal(codex.events[0].displayName, "Build spend dashboard");

  const summary = buildSummary([claude, codex], { days: 365, provider: "all" });
  assert.equal(summary.topEvents.length, 3);
  assert(summary.totals.totalTokens >= 6720);
  assert(summary.topSessions.some((session) => session.displayName === "AIV dashboard polish"));
  assert(summary.topSessions.some((session) => session.displayName === "Build spend dashboard"));
  assert(summary.recommendations.length > 0);
  assert(summary.recommendations[0].ask.includes("Summarize"));
  assert(summary.topSessions.some((session) => session.recommendation && session.recommendation.label));
  assert(summary.topEvents.some((event) => event.recommendation && event.recommendation.label));
  assert.equal(summary.weeklyPace.status, "unset");
  assert.equal(summary.budgetPace.fiveHour.status, "unset");
  assert(summary.windows.last5h.totalTokens >= 3500);
  assert(summary.budgetSessions.fiveHour.some((session) => session.displayName === "Build spend dashboard"));
  assert.equal(summary.planPace.selected.claude, "custom");
  assert.equal(summary.planPace.selected.codex, "custom");
  assert(summary.promptGuidance.some((item) => item.title.includes("GPT-5.5")));
  assert(summary.promptGuidance.some((item) => item.title === "Protect the 5h window"));

  const planSummary = buildSummary([claude, codex], {
    days: 365,
    provider: "all",
    claudePlan: "claude-max-20x",
    codexPlan: "codex-pro-5x",
  });
  assert.equal(planSummary.planPace.claude.messageRange.min, 900);
  assert.equal(planSummary.planPace.codex.messageRange.min, 160);
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
  assert(payloadText.includes("claude"));
  assert(payloadText.includes("codex"));

  fs.rmSync(root, { recursive: true, force: true });
  console.log("AI spend dashboard tests passed");
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
