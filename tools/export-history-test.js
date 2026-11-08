const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  LEDGER_SCHEMA,
  ROW_COUNT_FIELDS,
  ROW_TOKEN_FIELDS,
  buildSummaryMarkdown,
  claudeProjectName,
  codexProjectName,
  exportHistory,
  finalizeLedger,
  makeFileFilter,
  mergeLedgers,
  mergeRow,
  safeProjectName,
} = require("./export-history");
const { parseClaude, parseCodex } = require("./ai-spend-dashboard-server");

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
}

function claudeAssistant(id, timestamp, model, usage, block) {
  return {
    type: "assistant",
    timestamp,
    sessionId: "claude-session-1",
    cwd: "H:\\devland\\aiv-git",
    requestId: `req-${id}`,
    message: { id, role: "assistant", model, usage, content: [{ type: block }] },
  };
}

function codexTokenCount(timestamp, last, total) {
  return {
    type: "event_msg",
    timestamp,
    payload: { type: "token_count", info: { last_token_usage: last, total_token_usage: total } },
  };
}

async function run() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ai-spend-history-test-"));
  const claudeRoot = path.join(root, "claude", "projects");
  const codexRoot = path.join(root, "codex", "sessions");
  const outPath = path.join(root, "out", "ledger.json");
  const statsCachePath = path.join(root, "stats-cache.json");

  // Claude: one message streamed as three records (thinking partial, then two
  // blocks with the final output count) plus a second distinct message.
  writeJsonl(path.join(claudeRoot, "H--devland-aiv-git", "claude-session-1.jsonl"), [
    { type: "user", timestamp: "2026-10-20T14:00:00.000Z", sessionId: "claude-session-1", cwd: "H:\\devland\\aiv-git", message: { role: "user", content: "SECRET_PROMPT" } },
    claudeAssistant("msg_1", "2026-10-20T14:00:01.000Z", "claude-fable-5-1", { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 8 }, "thinking"),
    claudeAssistant("msg_1", "2026-10-20T14:00:02.000Z", "claude-fable-5-1", { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 500 }, "text"),
    claudeAssistant("msg_1", "2026-10-20T14:00:02.500Z", "claude-fable-5-1", { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 3000, output_tokens: 500 }, "tool_use"),
    claudeAssistant("msg_2", "2026-10-20T14:05:00.000Z", "claude-fable-5-1", { input_tokens: 5, cache_creation_input_tokens: 0, cache_read_input_tokens: 4000, output_tokens: 100 }, "text"),
  ]);
  // Claude subagent sidechain with an unknown model (pricing must be null, not zero).
  writeJsonl(path.join(claudeRoot, "H--devland-aiv-git", "claude-session-1", "subagents", "agent-abc.jsonl"), [
    {
      type: "assistant",
      timestamp: "2026-10-21T09:00:00.000Z",
      sessionId: "claude-session-1",
      agentId: "abc",
      isSidechain: true,
      cwd: "H:\\devland\\aiv-git",
      message: { id: "msg_sub", role: "assistant", model: "mystery-model-v9", usage: { input_tokens: 1000, output_tokens: 50 }, content: [{ type: "text" }] },
    },
  ]);

  // Codex parent thread: two responses on gpt-6-luna.
  const parentUsageA = { input_tokens: 1000, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 1000 };
  const parentUsageB = { input_tokens: 1500, cached_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 0, total_tokens: 1800 };
  writeJsonl(path.join(codexRoot, "2026", "09", "01", "rollout-2026-09-01T09-00-00-thread-0.jsonl"), [
    { type: "session_meta", timestamp: "2026-09-01T13:00:00.000Z", payload: { id: "thread-0", session_id: "thread-0", cwd: "C:\\devland\\aiv-git", source: "vscode" } },
    { type: "turn_context", timestamp: "2026-09-01T13:00:00.500Z", payload: { cwd: "C:\\devland\\aiv-git", model: "gpt-6-luna", effort: "medium" } },
    codexTokenCount("2026-09-01T13:00:05.000Z", parentUsageA, parentUsageA),
    codexTokenCount("2026-09-01T13:00:25.000Z", { input_tokens: 500, cached_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 0, total_tokens: 800 }, parentUsageB),
  ]);

  // Codex: spawned subagent thread, effort under turn_context.effort, one
  // repeated token_count snapshot that must not count twice, and a replay of
  // the parent's history (same cumulative totals, written within milliseconds).
  writeJsonl(path.join(codexRoot, "2026", "09", "01", "rollout-2026-09-01T10-00-00-thread-1.jsonl"), [
    {
      type: "session_meta",
      timestamp: "2026-09-01T14:00:00.000Z",
      payload: { id: "thread-1", session_id: "thread-0", cwd: "C:\\devland\\aiv-git", parent_thread_id: "thread-0", forked_from_id: "thread-0", source: { subagent: { thread_spawn: { parent_thread_id: "thread-0", agent_nickname: "Cicero" } } } },
    },
    // Forks replay the parent's session_meta right after their own; it must not rename the thread.
    { type: "session_meta", timestamp: "2026-09-01T14:00:00.001Z", payload: { id: "thread-0", session_id: "thread-0", cwd: "C:\\devland\\aiv-git", source: "vscode" } },
    { type: "turn_context", timestamp: "2026-09-01T14:00:00.001Z", payload: { cwd: "C:\\devland\\aiv-git", model: "gpt-6-luna", effort: "medium" } },
    codexTokenCount("2026-09-01T14:00:00.002Z", parentUsageA, parentUsageA),
    codexTokenCount("2026-09-01T14:00:00.002Z", { input_tokens: 500, cached_input_tokens: 0, output_tokens: 300, reasoning_output_tokens: 0, total_tokens: 800 }, parentUsageB),
    { type: "turn_context", timestamp: "2026-09-01T14:00:00.500Z", payload: { cwd: "C:\\devland\\aiv-git", model: "gpt-6.1-sol", effort: "xhigh" } },
    { type: "response_item", timestamp: "2026-09-01T14:00:01.000Z", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "SECRET_CODEX_PROMPT" }] } },
    codexTokenCount("2026-09-01T14:00:05.000Z", { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 2100 }, { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 2100 }),
    codexTokenCount("2026-09-01T14:00:05.100Z", { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 2100 }, { input_tokens: 2000, cached_input_tokens: 1500, output_tokens: 100, reasoning_output_tokens: 20, total_tokens: 2100 }),
    codexTokenCount("2026-09-02T15:30:00.000Z", { input_tokens: 3000, cached_input_tokens: 0, output_tokens: 400, reasoning_output_tokens: 100, total_tokens: 3400 }, { input_tokens: 5000, cached_input_tokens: 1500, output_tokens: 500, reasoning_output_tokens: 120, total_tokens: 5500 }),
  ]);

  fs.writeFileSync(statsCachePath, JSON.stringify({
    version: 5,
    lastComputedDate: "2026-11-06",
    firstSessionDate: "2026-02-08T21:00:55.123Z",
    totalSessions: 664,
    totalMessages: 456182,
    modelUsage: {
      "claude-opus-5-5": { inputTokens: 100, outputTokens: 1000, cacheReadInputTokens: 50000, cacheCreationInputTokens: 2000 },
      "mystery-model-v9": { inputTokens: 10, outputTokens: 10, cacheReadInputTokens: 10, cacheCreationInputTokens: 10 },
    },
    dailyModelTokens: [{ date: "2026-08-29", tokensByModel: { "claude-opus-5-5": 123456 } }],
    dailyActivity: [{ date: "2026-08-29", messageCount: 10, sessionCount: 2, toolCallCount: 3 }],
  }), "utf8");

  // Parser-level checks for the fixes the ledger relies on.
  const claude = await parseClaude(claudeRoot, 0, { sessionsMetaRoot: path.join(root, "nope") });
  const mainClaude = claude.sessions.find((session) => !session.isSubagent);
  assert.equal(mainClaude.eventCount, 2, "three records of one message id count as one turn");
  assert.equal(mainClaude.tokens.outputTokens, 600, "final output count wins over the streamed partial");
  assert.equal(mainClaude.totalTokens, 10 + 200 + 3000 + 500 + 5 + 4000 + 100);
  assert.equal(claude.duplicateUsageRecords, 2);
  assert.equal(claude.mergedUsageRecords, 1);
  assert.equal(claudeProjectName(mainClaude), "aiv-git");
  assert.equal(claudeProjectName({ project: "H--devland-aiv-git", cwd: "" }), "devland-aiv-git");

  const codex = await parseCodex(codexRoot, 0, { includeSqlite: false, sessionIndexPath: path.join(root, "nope.jsonl") });
  assert.equal(codex.sessions.length, 2);
  const codexParent = codex.sessions.find((session) => session.id === "thread-0");
  const codexSession = codex.sessions.find((session) => session.id === "thread-1");
  assert(codexParent && codexSession, "the replayed parent session_meta must not rename the fork");
  assert.equal(codexParent.eventCount, 2);
  assert.equal(codexParent.totalTokens, 1800);
  assert.equal(codexParent.isSubagent, false);
  assert.equal(codex.repeatedTokenCounts, 1);
  assert.equal(codex.replayedTokenCounts, 2, "a fork's replay of the parent's history must not count again");
  assert.equal(codex.burstTokenCounts, 0);
  assert.equal(codexSession.eventCount, 2);
  assert.equal(codexSession.totalTokens, 5500);
  assert.equal(codexSession.isSubagent, true);
  assert.equal(codexSession.subagentKind, "thread_spawn");
  assert.equal(codexSession.parentSessionId, "thread-0");
  assert.equal(codexSession.reasoningEffort, "xhigh");
  assert.equal(codexProjectName(codexSession), "aiv-git");
  assert.equal(codexProjectName({ cwd: "" }), "unknown");
  assert.equal(safeProjectName("aispend-live-site"), "aispend-live-site");
  assert.equal(safeProjectName("wattles_5th_grade_slide_show"), "wattles_5th_grade_slide_show");
  assert.match(safeProjectName("2026-04-20-i-use-codex-cli-but-just"), /^untitled-[0-9a-f]{8}$/, "prompt-like folder names are hashed");
  assert.equal(safeProjectName("i-need-a-logo-for-my"), safeProjectName("i-need-a-logo-for-my"), "hashing is stable");
  assert(!safeProjectName("i-need-a-logo-for-my").includes("logo"));

  // Streaming mode must hand sessions to the callback without retaining them.
  let streamed = 0;
  const streamedCodex = await parseCodex(codexRoot, 0, { includeSqlite: false, collect: false, onSession: () => { streamed += 1; } });
  assert.equal(streamed, 2);
  assert.equal(streamedCodex.sessions.length, 0);
  assert.equal(streamedCodex.events.length, 0);

  // When the parent rollout is not scanned, the fork's millisecond-spaced replay still falls to the timing rule.
  const forkOnly = await parseCodex(codexRoot, 0, { includeSqlite: false, fileFilter: (fileInfo) => fileInfo.path.includes("thread-1") });
  assert.equal(forkOnly.sessions.length, 1);
  assert.equal(forkOnly.replayedTokenCounts, 0);
  assert.equal(forkOnly.burstTokenCounts, 1, "the second replayed event is dropped by the timing fallback");
  assert.equal(forkOnly.sessions[0].totalTokens, 5500 + 1000, "only the first replayed event leaks without the parent");

  const filter = makeFileFilter("codex", { since: "2026-09-01", until: "2026-08-31" });
  assert.equal(filter({ path: "rollout-2026-09-01T10-00-00-x.jsonl", mtimeMs: Date.now() }), false, "rollouts that start after --until are skipped");
  assert.equal(makeFileFilter("claude", { since: "2026-09-01" })({ path: "a.jsonl", mtimeMs: Date.parse("2026-08-01T00:00:00Z") }), false, "files last modified before --since are skipped");

  // First export.
  const baseArgs = { out: outPath, provider: "all", claudeRoot, codexRoot, statsCachePath, includeStatsCache: true, includeSqlite: false, quiet: true, sessionsMetaRoot: path.join(root, "nope"), sessionIndexPath: path.join(root, "nope.jsonl") };
  const first = await exportHistory(baseArgs);
  const ledger = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.equal(ledger.schema, LEDGER_SCHEMA);
  assert(ledger.generatedAt && ledger.firstGeneratedAt === ledger.generatedAt);
  assert(ledger.sourcesScanned.claude && ledger.sourcesScanned.codex);
  assert.equal(ledger.sourcesScanned.claude.filesScanned, 2);
  assert.equal(ledger.runs.length, 1);

  const expectedRowKeys = ["day", "provider", "model", "project"].concat(ROW_TOKEN_FIELDS, ROW_COUNT_FIELDS, ["effortTokens", "estimatedUsd", "pricingLabel"]);
  for (const row of ledger.rows) {
    assert.deepEqual(Object.keys(row).sort(), expectedRowKeys.slice().sort(), "row shape");
  }
  const dayKey = (iso) => {
    const d = new Date(iso);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const claudeRow = ledger.rows.find((row) => row.provider === "claude" && row.model === "claude-fable-5-1");
  assert(claudeRow, "expected a Claude Fable row");
  assert.equal(claudeRow.day, dayKey("2026-10-20T14:00:01.000Z"));
  assert.equal(claudeRow.project, "aiv-git");
  assert.equal(claudeRow.freshInputTokens, 15);
  assert.equal(claudeRow.cacheReadTokens, 7000);
  assert.equal(claudeRow.cacheWriteTokens, 200);
  assert.equal(claudeRow.outputTokens, 600);
  assert.equal(claudeRow.totalTokens, 7815);
  assert.equal(claudeRow.turns, 2);
  assert.equal(claudeRow.sessions, 1);
  assert.equal(claudeRow.subagentTokens, 0);
  assert.equal(claudeRow.effortTokens, null);
  assert.equal(claudeRow.pricedTokens, 7815);
  assert(Math.abs(claudeRow.estimatedUsd - (15 * 10 + 200 * 12.5 + 7000 * 0.25 + 600 * 50) / 1000000) < 1e-9);

  const mysteryRow = ledger.rows.find((row) => row.model === "mystery-model-v9");
  assert(mysteryRow, "unknown models still get a row");
  assert.strictEqual(mysteryRow.estimatedUsd, null, "unknown pricing must be null, never zero");
  assert.equal(mysteryRow.unpricedTokens, 1050);
  assert.equal(mysteryRow.subagentTokens, 1050);
  assert.equal(mysteryRow.subagentTurns, 1);

  const codexRows = ledger.rows.filter((row) => row.provider === "codex" && row.model === "gpt-6.1-sol");
  assert.equal(codexRows.length, 2, "codex turns on two local days make two rows");
  const codexTotal = codexRows.reduce((sum, row) => sum + row.totalTokens, 0);
  assert.equal(codexTotal, 5500, "repeated snapshot must not double count");
  assert.equal(codexRows.reduce((sum, row) => sum + row.cacheReadTokens, 0), 1500);
  assert.equal(codexRows.reduce((sum, row) => sum + row.freshInputTokens, 0), 3500);
  assert.equal(codexRows.reduce((sum, row) => sum + row.subagentTokens, 0), 5500);
  assert.deepEqual(codexRows.map((row) => Object.keys(row.effortTokens)), [["xhigh"], ["xhigh"]]);
  for (const row of codexRows) assert.equal(row.project, "aiv-git");
  const lunaRows = ledger.rows.filter((row) => row.provider === "codex" && row.model === "gpt-6-luna");
  assert.equal(lunaRows.length, 1, "the parent's history is counted once, not again in the fork");
  assert.equal(lunaRows[0].totalTokens, 1800);
  assert.equal(lunaRows[0].turns, 2);
  assert.equal(lunaRows[0].subagentTokens, 0);
  assert.deepEqual(lunaRows[0].effortTokens, { medium: 1800 });

  assert.equal(ledger.sessions.length, 4);
  const codexSummary = ledger.sessions.find((session) => session.provider === "codex" && session.isSubagent);
  assert.equal(codexSummary.key.length, 16);
  assert.equal(codexSummary.parentKey.length, 16);
  assert.equal(codexSummary.turns, 2);
  assert.equal(codexSummary.totalTokens, 5500);
  assert.equal(codexSummary.largestTurnTokens, 3400);
  assert.equal(codexSummary.isSubagent, true);
  assert.equal(codexSummary.reasoningEffort, "xhigh");
  assert(codexSummary.durationMinutes > 13 * 60);
  assert.equal(ledger.largestTurns[0].totalTokens, 4105, "largest turn is the second Claude message");
  assert.equal(ledger.largestTurns[0].model, "claude-fable-5-1");
  assert.equal(ledger.largestTurns.length, 7, "two Claude turns, one subagent turn, two parent and two fork Codex turns");

  assert.equal(ledger.coverage.providers.claude.daysWithUsage, 2);
  assert.equal(ledger.coverage.providers.codex.months.length >= 1, true);
  assert(ledger.coverage.sources.some((entry) => entry.source === "claude-jsonl" && entry.firstRecord.startsWith("2026-10-20")));
  assert(ledger.coverage.sources.some((entry) => entry.source === "codex-jsonl" && entry.lastScan.turns === 4 && entry.lastScan.sessions === 2));
  assert.equal(ledger.days.filter((day) => day.provider === "codex").length, 2);

  assert.equal(ledger.claudeStatsCacheTotals.models.length, 2);
  const statsOpus = ledger.claudeStatsCacheTotals.models.find((row) => row.model === "claude-opus-5-5");
  assert.equal(statsOpus.totalTokens, 53100);
  assert(Math.abs(statsOpus.estimatedUsd - (100 * 4 + 2000 * 5 + 50000 * 0.2 + 1000 * 20) / 1000000) < 1e-9);
  assert.strictEqual(ledger.claudeStatsCacheTotals.models.find((row) => row.model === "mystery-model-v9").estimatedUsd, null);
  assert.deepEqual(ledger.claudeStatsCacheDaily, [{ day: "2026-08-29", model: "claude-opus-5-5", totalTokens: 123456 }]);
  assert.equal(ledger.claudeStatsCacheActivity[0].messageCount, 10);

  const text = JSON.stringify(ledger);
  assert(!text.includes("SECRET_PROMPT") && !text.includes("SECRET_CODEX_PROMPT"), "ledger must not contain prompt text");
  assert(!text.includes("Cicero"), "ledger must not contain agent nicknames");
  assert(!text.includes("claude-session-1") && !text.includes("thread-1"), "ledger must hash session ids");

  // Second export over the same logs: identical rows (no double counting).
  await exportHistory(baseArgs);
  const second = JSON.parse(fs.readFileSync(outPath, "utf8"));
  assert.deepEqual(second.rows, ledger.rows, "re-scanning the same logs must not change rows");
  assert.deepEqual(second.sessions.map((session) => [session.key, session.turns, session.totalTokens]), ledger.sessions.map((session) => [session.key, session.turns, session.totalTokens]));
  assert.equal(second.runs.length, 2);
  assert.equal(second.firstGeneratedAt, ledger.firstGeneratedAt);
  assert(fs.existsSync(`${outPath}.bak`), "previous ledger is kept as .bak");

  // Merge semantics: pruned days survive, larger earlier values win, nulls defer to numbers.
  const pruned = JSON.parse(fs.readFileSync(outPath, "utf8"));
  pruned.rows.push({ ...claudeRow, day: "2026-03-01", totalTokens: 999, turns: 9, effortTokens: null, estimatedUsd: null });
  const inflated = pruned.rows.find((row) => row.provider === "claude" && row.model === "claude-fable-5-1" && row.day === claudeRow.day);
  inflated.outputTokens = 999999;
  inflated.estimatedUsd = null;
  fs.writeFileSync(outPath, JSON.stringify(pruned), "utf8");
  await exportHistory(baseArgs);
  const merged = JSON.parse(fs.readFileSync(outPath, "utf8"));
  const prunedRow = merged.rows.find((row) => row.day === "2026-03-01");
  assert(prunedRow && prunedRow.totalTokens === 999 && prunedRow.turns === 9, "rows for pruned days must survive");
  const mergedRow = merged.rows.find((row) => row.provider === "claude" && row.model === "claude-fable-5-1" && row.day === claudeRow.day);
  assert.equal(mergedRow.outputTokens, 999999, "merge keeps the max of each token field");
  assert.equal(mergedRow.totalTokens, claudeRow.totalTokens);
  assert(mergedRow.estimatedUsd > 0, "a null estimate defers to a known one");
  assert.equal(merged.coverage.providers.claude.firstDay, "2026-03-01");
  assert(merged.coverage.providers.claude.missingDayRanges.length >= 1, "gaps between rows are explicit");

  // Pure merge-max unit check and partial windows.
  const direct = mergeRow(
    { day: "d", provider: "p", model: "m", project: "x", freshInputTokens: 5, totalTokens: 10, turns: 1, effortTokens: { high: 4 }, estimatedUsd: 2, pricingLabel: "" },
    { day: "d", provider: "p", model: "m", project: "x", freshInputTokens: 3, totalTokens: 12, turns: 2, effortTokens: { high: 1, low: 7 }, estimatedUsd: 1, pricingLabel: "Label" },
  );
  assert.equal(direct.freshInputTokens, 5);
  assert.equal(direct.totalTokens, 12);
  assert.equal(direct.turns, 2);
  assert.deepEqual(direct.effortTokens, { high: 4, low: 7 });
  assert.equal(direct.estimatedUsd, 2);
  assert.equal(direct.pricingLabel, "Label");
  const emptyMerge = finalizeLedger(mergeLedgers(null, { generatedAt: "2026-01-01T00:00:00.000Z", dayTimezone: "UTC", sourcesScanned: {}, runs: [], coverage: { sources: [] }, rows: [], sessions: [], largestTurns: [], claudeStatsCacheTotals: null, claudeStatsCacheDaily: [], claudeStatsCacheActivity: [] }));
  assert.equal(emptyMerge.rows.length, 0);
  assert.equal(emptyMerge.coverage.providers.claude.firstDay, "");

  const windowOut = path.join(root, "out", "window.json");
  await exportHistory({ ...baseArgs, out: windowOut, provider: "claude", since: "2026-10-21", until: "2026-10-21" });
  const windowed = JSON.parse(fs.readFileSync(windowOut, "utf8"));
  assert.equal(windowed.rows.length, 1, "window keeps only rows inside --since/--until");
  assert.equal(windowed.rows[0].model, "mystery-model-v9");
  assert.equal(windowed.sessions.length, 1);
  assert(!windowed.sourcesScanned.codex, "single-provider runs only record that provider");

  const summary = buildSummaryMarkdown(merged, outPath);
  assert(summary.includes("## Tokens per month by provider"));
  assert(summary.includes("claude-fable-5-1"));
  assert(summary.includes("n/a (no pricing)"), "unknown pricing shows n/a in the summary");
  assert(!summary.includes("SECRET_PROMPT"));

  fs.rmSync(root, { recursive: true, force: true });
  console.log(`History export tests passed (${first.ledger.rows.length} fixture rows)`);
}

run().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
