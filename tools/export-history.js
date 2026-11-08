const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const {
  findClaudePricing,
  listJsonlFiles,
  numberValue,
  parseClaude,
  parseCodex,
} = require("./ai-spend-dashboard-server");

const LEDGER_SCHEMA = "ai-spend-live-history-ledger/v1";
const MAX_LARGEST_TURNS = 100;
const MAX_RUN_HISTORY = 60;
const SESSION_KEY_CHARS = 16;
const PROGRESS_INTERVAL_MS = 5000;
const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const MS_PER_DAY = 86400000;
const BYTES_PER_MB = 1048576;
const KB_PER_MB = 1024;
const TOKENS_PER_MILLION = 1000000;
const USD_DECIMALS = 6;
const SUMMARY_TOP_COUNT = 10;
const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const CODEX_ROLLOUT_DATE = /rollout-(\d{4}-\d{2}-\d{2})T/i;
const CLAUDE_PROJECT_DRIVE_PREFIX = /^[A-Za-z]--/;
const PROJECT_DATE_PREFIX = /^\d{4}-\d{2}-\d{2}[-_]?/;
const PROJECT_HASH_CHARS = 8;
const PROSE_MIN_TOKENS = 3;
// Some task folders are named after the prompt that created them; those names
// are user content and are replaced by a stable hash.
const PROSE_STOPWORDS = new Set([
  "i", "a", "an", "the", "to", "my", "me", "we", "you", "this", "that", "it", "is", "in", "on", "for", "of",
  "and", "but", "or", "with", "into", "from", "how", "what", "want", "need", "can", "do", "make", "please",
  "just", "use", "add", "added", "fix", "help", "turn", "create", "build", "write",
]);
const PROVIDERS = ["claude", "codex"];
const SOURCE_CLAUDE_JSONL = "claude-jsonl";
const SOURCE_CODEX_JSONL = "codex-jsonl";
const SOURCE_CODEX_SQLITE = "codex-sqlite";
const ROW_TOKEN_FIELDS = [
  "freshInputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "reasoningOutputTokens",
  "totalTokens",
  "breakdownUnknownTokens",
];
const ROW_COUNT_FIELDS = ["turns", "sessions", "subagentTokens", "subagentTurns", "pricedTokens", "unpricedTokens"];
const SESSION_MAX_FIELDS = [
  "turns",
  "totalTokens",
  "freshInputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "outputTokens",
  "breakdownUnknownTokens",
  "largestTurnTokens",
];
const STATS_MODEL_FIELDS = ["freshInputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens", "totalTokens"];
const PRIVACY_NOTE = "Aggregates, model IDs, project directory names, and hashed session ids only. No prompt text, titles, or user content.";
const MERGE_NOTE = "Rows merge by (day, provider, model, project) taking the max of every token field, so re-scanning the same logs never double counts and days whose logs were pruned keep their earlier row.";

function usage() {
  return [
    "Usage: node tools/export-history.js --out <ledger.json> [options]",
    "",
    "Walks every local Claude JSONL transcript and Codex rollout (plus Codex state",
    "SQLite thread totals), aggregates usage per day x provider x model x project,",
    "and merges the result into a durable ledger file.",
    "",
    "Options:",
    "  --out <path>            Ledger JSON to create or merge into (required)",
    "  --since YYYY-MM-DD      Only aggregate days on/after this date (local time)",
    "  --until YYYY-MM-DD      Only aggregate days on/before this date (local time)",
    "  --provider <name>       claude | codex | all (default all)",
    "  --claude-root <dir>     Claude projects root (default ~/.claude/projects)",
    "  --codex-root <dir>      Codex sessions root (default $CODEX_HOME/sessions)",
    "  --stats-cache <file>    Claude stats-cache.json (default ~/.claude/stats-cache.json)",
    "  --no-stats-cache        Skip the stats-cache blocks",
    "  --no-sqlite             Skip Codex state SQLite thread recovery",
    "  --summary-out <file>    Also write a Markdown summary of the merged ledger",
    "  --summary-only          Only regenerate the summary from the existing ledger",
    "  --quiet                 Suppress progress output",
  ].join("\n");
}

function parseArgs(argv) {
  const out = {
    out: "",
    since: "",
    until: "",
    provider: "all",
    claudeRoot: "",
    codexRoot: "",
    statsCachePath: "",
    includeStatsCache: true,
    includeSqlite: true,
    summaryOut: "",
    summaryOnly: false,
    quiet: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--out") out.out = String(argv[++i] || "");
    else if (arg === "--since") out.since = String(argv[++i] || "");
    else if (arg === "--until") out.until = String(argv[++i] || "");
    else if (arg === "--provider") out.provider = String(argv[++i] || "all").toLowerCase();
    else if (arg === "--claude-root") out.claudeRoot = String(argv[++i] || "");
    else if (arg === "--codex-root") out.codexRoot = String(argv[++i] || "");
    else if (arg === "--stats-cache") out.statsCachePath = String(argv[++i] || "");
    else if (arg === "--no-stats-cache") out.includeStatsCache = false;
    else if (arg === "--no-sqlite") out.includeSqlite = false;
    else if (arg === "--summary-out") out.summaryOut = String(argv[++i] || "");
    else if (arg === "--summary-only") out.summaryOnly = true;
    else if (arg === "--quiet") out.quiet = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function assertDayKey(value, flag) {
  if (value && !DAY_KEY_PATTERN.test(value)) {
    throw new Error(`${flag} must be YYYY-MM-DD, got "${value}"`);
  }
  return value;
}

function localMidnightMs(dayKey) {
  if (!dayKey) return 0;
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day).getTime();
}

function dayKeyFromMs(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function nextDayKey(dayKey) {
  return dayKeyFromMs(localMidnightMs(dayKey) + MS_PER_DAY + MS_PER_DAY / 2);
}

function dayDiff(fromKey, toKey) {
  return Math.round((localMidnightMs(toKey) - localMidnightMs(fromKey)) / MS_PER_DAY);
}

function roundUsd(value) {
  return value == null ? null : Number(Number(value).toFixed(USD_DECIMALS));
}

function maxNullable(a, b) {
  if (a == null) return b == null ? null : b;
  if (b == null) return a;
  return Math.max(a, b);
}

function sessionKey(provider, id) {
  return crypto.createHash("sha256").update(`${provider}:${String(id || "")}`).digest("hex").slice(0, SESSION_KEY_CHARS);
}

function rowKey(row) {
  return `${row.day}|${row.provider}|${row.model}|${row.project}`;
}

function safeProjectName(name) {
  const raw = String(name || "").trim();
  if (!raw) return "unknown";
  const tokens = raw.replace(PROJECT_DATE_PREFIX, "").toLowerCase().split(/[-_\s]+/).filter(Boolean);
  const prose = tokens.length >= PROSE_MIN_TOKENS && tokens.some((token) => PROSE_STOPWORDS.has(token));
  if (!prose) return raw;
  return `untitled-${crypto.createHash("sha256").update(raw).digest("hex").slice(0, PROJECT_HASH_CHARS)}`;
}

function claudeProjectName(session) {
  const dirName = String(session.project || "").trim();
  const cwd = String(session.cwd || "").trim();
  if (cwd) {
    const encoded = cwd.replace(/[^A-Za-z0-9]/g, "-");
    const base = path.basename(cwd);
    if (base && (!dirName || encoded === dirName)) {
      return safeProjectName(base);
    }
  }
  return safeProjectName(dirName.replace(CLAUDE_PROJECT_DRIVE_PREFIX, ""));
}

function codexProjectName(session) {
  const cwd = String(session.cwd || "").trim();
  return safeProjectName(cwd ? path.basename(cwd) : "");
}

function projectName(provider, session) {
  return provider === "claude" ? claudeProjectName(session) : codexProjectName(session);
}

function sourceName(provider, session) {
  if (provider === "claude") return SOURCE_CLAUDE_JSONL;
  return session.sourceType === "sqlite" ? SOURCE_CODEX_SQLITE : SOURCE_CODEX_JSONL;
}

// Disjoint token components shared by both providers. Codex reports cached
// tokens as a subset of input_tokens; Claude reports them separately.
function eventComponents(event) {
  const tokens = event.tokens || {};
  const rawInput = numberValue(tokens.inputTokens);
  const cachedSubset = event.provider === "codex" ? Math.min(rawInput, numberValue(tokens.cachedInputTokens)) : 0;
  const freshInputTokens = event.provider === "codex" ? rawInput - cachedSubset : rawInput;
  const cacheReadTokens = event.provider === "codex" ? cachedSubset : numberValue(tokens.cacheReadInputTokens);
  const cacheWriteTokens = numberValue(tokens.cacheCreationInputTokens) + numberValue(tokens.cacheCreation1hInputTokens);
  const outputTokens = numberValue(tokens.outputTokens);
  const reasoningOutputTokens = numberValue(tokens.reasoningOutputTokens);
  const totalTokens = numberValue(event.totalTokens);
  const known = freshInputTokens + cacheReadTokens + cacheWriteTokens + outputTokens;
  return {
    freshInputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens,
    totalTokens,
    breakdownUnknownTokens: Math.max(0, totalTokens - known),
  };
}

function emptyRow(day, provider, model, project) {
  const row = { day, provider, model, project };
  for (const field of ROW_TOKEN_FIELDS) row[field] = 0;
  for (const field of ROW_COUNT_FIELDS) row[field] = 0;
  row.effortTokens = null;
  row.estimatedUsd = null;
  row.pricingLabel = "";
  return row;
}

function addEffort(row, effort, tokens) {
  const key = String(effort || "").trim().toLowerCase();
  if (!key) return;
  if (!row.effortTokens) row.effortTokens = {};
  row.effortTokens[key] = numberValue(row.effortTokens[key]) + tokens;
}

function createScanAccumulator(window) {
  const rows = new Map();
  const rowSessions = new Map();
  const sessions = new Map();
  const largestTurns = [];
  const sources = new Map();

  function inWindow(day) {
    if (window.since && day < window.since) return false;
    if (window.until && day > window.until) return false;
    return true;
  }

  function touchSource(provider, source, timestampMs, tokens) {
    const key = `${provider}:${source}`;
    const entry = sources.get(key) || {
      provider,
      source,
      firstRecord: "",
      lastRecord: "",
      sessionKeys: new Set(),
      turns: 0,
      tokens: 0,
    };
    const iso = new Date(timestampMs).toISOString();
    if (!entry.firstRecord || iso < entry.firstRecord) entry.firstRecord = iso;
    if (!entry.lastRecord || iso > entry.lastRecord) entry.lastRecord = iso;
    entry.turns += 1;
    entry.tokens += tokens;
    sources.set(key, entry);
    return entry;
  }

  function considerLargestTurn(candidate) {
    if (largestTurns.length >= MAX_LARGEST_TURNS && candidate.totalTokens <= largestTurns[largestTurns.length - 1].totalTokens) {
      return;
    }
    let index = largestTurns.findIndex((item) => candidate.totalTokens > item.totalTokens);
    if (index < 0) index = largestTurns.length;
    largestTurns.splice(index, 0, candidate);
    if (largestTurns.length > MAX_LARGEST_TURNS) largestTurns.pop();
  }

  function addSession(provider, session, events) {
    const scoped = events.filter((event) => inWindow(event.date));
    if (scoped.length === 0) return false;
    const source = sourceName(provider, session);
    const project = projectName(provider, session);
    const key = sessionKey(provider, session.id);
    const summary = {
      key,
      provider,
      project,
      model: String(session.model || "unknown"),
      source,
      isSubagent: Boolean(session.isSubagent),
      subagentKind: String(session.subagentKind || ""),
      parentKey: session.parentSessionId ? sessionKey(provider, session.parentSessionId) : "",
      reasoningEffort: String(session.reasoningEffort || ""),
      start: "",
      end: "",
      durationMinutes: 0,
      firstDay: "",
      lastDay: "",
      turns: 0,
      totalTokens: 0,
      freshInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      breakdownUnknownTokens: 0,
      largestTurnTokens: 0,
      estimatedUsd: null,
    };
    let pricedUsd = 0;
    let priced = false;
    let firstMs = 0;
    let lastMs = 0;
    for (const event of events) {
      const parts = eventComponents(event);
      summary.turns += 1;
      summary.totalTokens += parts.totalTokens;
      summary.freshInputTokens += parts.freshInputTokens;
      summary.cacheReadTokens += parts.cacheReadTokens;
      summary.cacheWriteTokens += parts.cacheWriteTokens;
      summary.outputTokens += parts.outputTokens;
      summary.breakdownUnknownTokens += parts.breakdownUnknownTokens;
      if (!event.syntheticThreadTotal) {
        summary.largestTurnTokens = Math.max(summary.largestTurnTokens, parts.totalTokens);
      }
      if (event.costKnown) {
        priced = true;
        pricedUsd += numberValue(event.costUsd);
      }
      if (!summary.firstDay || event.date < summary.firstDay) summary.firstDay = event.date;
      if (!summary.lastDay || event.date > summary.lastDay) summary.lastDay = event.date;
      firstMs = firstMs ? Math.min(firstMs, event.timestampMs) : event.timestampMs;
      lastMs = Math.max(lastMs, event.timestampMs);
    }
    summary.estimatedUsd = priced ? pricedUsd : null;
    const startMs = numberValue(session.startMs) || firstMs;
    const endMs = Math.max(startMs, numberValue(session.endMs) || lastMs);
    summary.start = new Date(startMs).toISOString();
    summary.end = new Date(endMs).toISOString();
    summary.durationMinutes = Math.max(0, (endMs - startMs) / MS_PER_MINUTE);
    const existing = sessions.get(key);
    sessions.set(key, existing ? sumSession(existing, summary) : summary);

    for (const event of scoped) {
      const parts = eventComponents(event);
      const model = String(event.model || "unknown");
      const row = rows.get(`${event.date}|${provider}|${model}|${project}`) || emptyRow(event.date, provider, model, project);
      const rk = rowKey(row);
      for (const field of ROW_TOKEN_FIELDS) row[field] += parts[field];
      row.turns += 1;
      if (session.isSubagent) {
        row.subagentTokens += parts.totalTokens;
        row.subagentTurns += 1;
      }
      if (event.costKnown) {
        row.pricedTokens += parts.totalTokens;
        row.estimatedUsd = numberValue(row.estimatedUsd) + numberValue(event.costUsd);
      } else {
        row.unpricedTokens += parts.totalTokens;
      }
      if (event.pricingLabel && !row.pricingLabel) row.pricingLabel = String(event.pricingLabel);
      addEffort(row, event.reasoningEffort, parts.totalTokens);
      rows.set(rk, row);
      const touched = rowSessions.get(rk) || new Set();
      touched.add(key);
      rowSessions.set(rk, touched);
      touchSource(provider, source, event.timestampMs, parts.totalTokens);
      if (event.syntheticThreadTotal) continue;
      considerLargestTurn({
        day: event.date,
        timestamp: new Date(event.timestampMs).toISOString(),
        provider,
        model,
        project,
        sessionKey: key,
        turnIndex: numberValue(event.turnIndex),
        isSubagent: Boolean(session.isSubagent),
        totalTokens: parts.totalTokens,
        freshInputTokens: parts.freshInputTokens,
        cacheReadTokens: parts.cacheReadTokens,
        cacheWriteTokens: parts.cacheWriteTokens,
        outputTokens: parts.outputTokens,
        breakdownUnknownTokens: parts.breakdownUnknownTokens,
        estimatedUsd: event.costKnown ? roundUsd(event.costUsd) : null,
      });
    }
    const sourceEntry = sources.get(`${provider}:${source}`);
    if (sourceEntry) sourceEntry.sessionKeys.add(key);
    return true;
  }

  function finish() {
    const rowList = Array.from(rows.values()).map((row) => {
      const touched = rowSessions.get(rowKey(row));
      row.sessions = touched ? touched.size : 0;
      row.estimatedUsd = row.pricedTokens > 0 ? roundUsd(row.estimatedUsd) : null;
      return row;
    });
    return {
      rows: rowList,
      sessions: Array.from(sessions.values()).map((session) => ({ ...session, estimatedUsd: roundUsd(session.estimatedUsd) })),
      largestTurns: largestTurns.slice(),
      sources: Array.from(sources.values()).map(({ sessionKeys, ...entry }) => ({ ...entry, sessions: sessionKeys.size })),
    };
  }

  return { addSession, finish };
}

function mergeRow(existing, fresh) {
  const merged = { ...existing };
  for (const field of ROW_TOKEN_FIELDS.concat(ROW_COUNT_FIELDS)) {
    merged[field] = Math.max(numberValue(existing[field]), numberValue(fresh[field]));
  }
  if (existing.effortTokens || fresh.effortTokens) {
    merged.effortTokens = {};
    const keys = new Set(Object.keys(existing.effortTokens || {}).concat(Object.keys(fresh.effortTokens || {})));
    for (const key of keys) {
      merged.effortTokens[key] = Math.max(
        numberValue(existing.effortTokens && existing.effortTokens[key]),
        numberValue(fresh.effortTokens && fresh.effortTokens[key]),
      );
    }
  } else {
    merged.effortTokens = null;
  }
  merged.estimatedUsd = roundUsd(maxNullable(existing.estimatedUsd, fresh.estimatedUsd));
  merged.pricingLabel = fresh.pricingLabel || existing.pricingLabel || "";
  return merged;
}

// Within one scan the same session id can surface from two files; their usage
// adds up. Across runs (mergeSession) the same session is re-read, so max wins.
function sumSession(existing, fresh) {
  const merged = mergeSession(existing, fresh);
  for (const field of SESSION_MAX_FIELDS) {
    if (field === "largestTurnTokens") continue;
    merged[field] = numberValue(existing[field]) + numberValue(fresh[field]);
  }
  merged.estimatedUsd = existing.estimatedUsd == null && fresh.estimatedUsd == null
    ? null
    : numberValue(existing.estimatedUsd) + numberValue(fresh.estimatedUsd);
  return merged;
}

function mergeSession(existing, fresh) {
  const merged = { ...existing };
  for (const field of SESSION_MAX_FIELDS) {
    merged[field] = Math.max(numberValue(existing[field]), numberValue(fresh[field]));
  }
  merged.start = [existing.start, fresh.start].filter(Boolean).sort()[0] || "";
  merged.end = [existing.end, fresh.end].filter(Boolean).sort().pop() || "";
  merged.firstDay = [existing.firstDay, fresh.firstDay].filter(Boolean).sort()[0] || "";
  merged.lastDay = [existing.lastDay, fresh.lastDay].filter(Boolean).sort().pop() || "";
  merged.durationMinutes = merged.start && merged.end
    ? Math.max(0, (Date.parse(merged.end) - Date.parse(merged.start)) / MS_PER_MINUTE)
    : Math.max(numberValue(existing.durationMinutes), numberValue(fresh.durationMinutes));
  merged.isSubagent = Boolean(existing.isSubagent || fresh.isSubagent);
  for (const field of ["project", "model", "source", "subagentKind", "parentKey", "reasoningEffort"]) {
    merged[field] = fresh[field] || existing[field] || "";
  }
  merged.estimatedUsd = roundUsd(maxNullable(existing.estimatedUsd, fresh.estimatedUsd));
  return merged;
}

function mergeLargestTurns(existing, fresh) {
  const byKey = new Map();
  for (const turn of (existing || []).concat(fresh || [])) {
    const key = `${turn.sessionKey}:${turn.turnIndex}`;
    const current = byKey.get(key);
    if (!current || numberValue(turn.totalTokens) > numberValue(current.totalTokens)) {
      byKey.set(key, turn);
    }
  }
  return Array.from(byKey.values())
    .sort((a, b) => b.totalTokens - a.totalTokens || a.timestamp.localeCompare(b.timestamp))
    .slice(0, MAX_LARGEST_TURNS);
}

function mergeSourceCoverage(existing, fresh, scanAt) {
  const merged = new Map();
  for (const entry of existing || []) {
    merged.set(`${entry.provider}:${entry.source}`, { ...entry });
  }
  for (const entry of fresh || []) {
    const key = `${entry.provider}:${entry.source}`;
    const current = merged.get(key);
    merged.set(key, {
      provider: entry.provider,
      source: entry.source,
      firstRecord: [current && current.firstRecord, entry.firstRecord].filter(Boolean).sort()[0] || "",
      lastRecord: [current && current.lastRecord, entry.lastRecord].filter(Boolean).sort().pop() || "",
      lastScanAt: scanAt,
      lastScan: {
        sessions: entry.sessions,
        turns: entry.turns,
        tokens: entry.tokens,
      },
    });
  }
  return Array.from(merged.values()).sort((a, b) => a.provider.localeCompare(b.provider) || a.source.localeCompare(b.source));
}

function mergeStatsCache(existing, fresh) {
  if (!fresh) return existing || null;
  if (!existing) return fresh;
  const models = new Map();
  for (const row of existing.models || []) models.set(row.model, { ...row });
  for (const row of fresh.models || []) {
    const current = models.get(row.model);
    if (!current) {
      models.set(row.model, { ...row });
      continue;
    }
    for (const field of STATS_MODEL_FIELDS) {
      current[field] = Math.max(numberValue(current[field]), numberValue(row[field]));
    }
    current.estimatedUsd = roundUsd(maxNullable(current.estimatedUsd, row.estimatedUsd));
    current.pricingLabel = row.pricingLabel || current.pricingLabel;
  }
  return {
    ...fresh,
    firstSessionDate: [existing.firstSessionDate, fresh.firstSessionDate].filter(Boolean).sort()[0] || "",
    totalSessions: Math.max(numberValue(existing.totalSessions), numberValue(fresh.totalSessions)),
    totalMessages: Math.max(numberValue(existing.totalMessages), numberValue(fresh.totalMessages)),
    models: Array.from(models.values()).sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

function mergeKeyedMax(existing, fresh, keyOf, fields) {
  const merged = new Map();
  for (const row of (existing || []).concat(fresh || [])) {
    const key = keyOf(row);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...row });
      continue;
    }
    for (const field of fields) {
      current[field] = Math.max(numberValue(current[field]), numberValue(row[field]));
    }
  }
  return Array.from(merged.values()).sort((a, b) => keyOf(a).localeCompare(keyOf(b)));
}

function mergeLedgers(existing, fresh) {
  const base = existing && existing.schema === LEDGER_SCHEMA ? existing : null;
  const rows = new Map();
  for (const row of (base && base.rows) || []) rows.set(rowKey(row), { ...row });
  for (const row of fresh.rows || []) {
    const key = rowKey(row);
    rows.set(key, rows.has(key) ? mergeRow(rows.get(key), row) : { ...row });
  }
  const sessions = new Map();
  for (const session of (base && base.sessions) || []) sessions.set(session.key, { ...session });
  for (const session of fresh.sessions || []) {
    sessions.set(session.key, sessions.has(session.key) ? mergeSession(sessions.get(session.key), session) : { ...session });
  }
  const runs = ((base && base.runs) || []).concat(fresh.runs || []).slice(-MAX_RUN_HISTORY);
  return {
    schema: LEDGER_SCHEMA,
    generatedAt: fresh.generatedAt,
    firstGeneratedAt: (base && base.firstGeneratedAt) || fresh.generatedAt,
    dayTimezone: fresh.dayTimezone || (base && base.dayTimezone) || "",
    privacy: PRIVACY_NOTE,
    mergeRule: MERGE_NOTE,
    sourcesScanned: Object.assign({}, (base && base.sourcesScanned) || {}, fresh.sourcesScanned || {}),
    runs,
    coverage: {
      sources: mergeSourceCoverage(base && base.coverage && base.coverage.sources, fresh.coverage && fresh.coverage.sources, fresh.generatedAt),
    },
    rows: Array.from(rows.values()).sort((a, b) => rowKey(a).localeCompare(rowKey(b))),
    days: [],
    sessions: Array.from(sessions.values()).sort((a, b) => a.start.localeCompare(b.start) || a.key.localeCompare(b.key)),
    largestTurns: mergeLargestTurns(base && base.largestTurns, fresh.largestTurns),
    claudeStatsCacheTotals: mergeStatsCache(base && base.claudeStatsCacheTotals, fresh.claudeStatsCacheTotals),
    claudeStatsCacheDaily: mergeKeyedMax(base && base.claudeStatsCacheDaily, fresh.claudeStatsCacheDaily, (row) => `${row.day}|${row.model}`, ["totalTokens"]),
    claudeStatsCacheActivity: mergeKeyedMax(base && base.claudeStatsCacheActivity, fresh.claudeStatsCacheActivity, (row) => row.day, ["messageCount", "sessionCount", "toolCallCount"]),
  };
}

function buildDays(rows) {
  const days = new Map();
  for (const row of rows) {
    const key = `${row.day}|${row.provider}`;
    const day = days.get(key) || {
      day: row.day,
      provider: row.provider,
      freshInputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      breakdownUnknownTokens: 0,
      turns: 0,
      subagentTokens: 0,
      estimatedUsd: null,
      unpricedTokens: 0,
    };
    for (const field of ["freshInputTokens", "cacheReadTokens", "cacheWriteTokens", "outputTokens", "totalTokens", "breakdownUnknownTokens", "turns", "subagentTokens", "unpricedTokens"]) {
      day[field] += numberValue(row[field]);
    }
    if (row.estimatedUsd != null) day.estimatedUsd = numberValue(day.estimatedUsd) + row.estimatedUsd;
    days.set(key, day);
  }
  return Array.from(days.values())
    .map((day) => ({ ...day, estimatedUsd: roundUsd(day.estimatedUsd) }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.provider.localeCompare(b.provider));
}

function missingDayRanges(daysWithUsage) {
  const sorted = Array.from(daysWithUsage).sort();
  const ranges = [];
  for (let i = 1; i < sorted.length; i += 1) {
    const gap = dayDiff(sorted[i - 1], sorted[i]);
    if (gap > 1) {
      const from = nextDayKey(sorted[i - 1]);
      ranges.push({ from, to: dayKeyFromMs(localMidnightMs(sorted[i]) - MS_PER_DAY / 2), days: gap - 1 });
    }
  }
  return ranges;
}

function buildCoverage(ledger) {
  const coverage = { sources: ledger.coverage.sources, providers: {}, notes: [] };
  for (const provider of PROVIDERS) {
    const days = new Set(ledger.rows.filter((row) => row.provider === provider).map((row) => row.day));
    const sorted = Array.from(days).sort();
    const sources = ledger.coverage.sources.filter((entry) => entry.provider === provider);
    coverage.providers[provider] = {
      firstDay: sorted[0] || "",
      lastDay: sorted[sorted.length - 1] || "",
      spanDays: sorted.length > 1 ? dayDiff(sorted[0], sorted[sorted.length - 1]) + 1 : sorted.length,
      daysWithUsage: sorted.length,
      months: Array.from(new Set(sorted.map((day) => day.slice(0, 7)))),
      missingDayRanges: missingDayRanges(days),
      sources: sources.map((entry) => entry.source),
    };
  }
  coverage.notes.push("Claude Code prunes transcripts after roughly 30 days; days before the earliest Claude row survive only because an earlier export captured them.");
  coverage.notes.push("Codex state SQLite rows contribute whole-thread token totals dated by the thread's last update and carry no fresh/cache/output breakdown (see breakdownUnknownTokens).");
  coverage.notes.push("claudeStatsCacheTotals is a whole-history lower bound per model from stats-cache.json and is kept separate from the ledger rows.");
  return coverage;
}

function finalizeLedger(ledger) {
  ledger.days = buildDays(ledger.rows);
  ledger.coverage = buildCoverage(ledger);
  return ledger;
}

function readStatsCache(statsCachePath) {
  if (!statsCachePath || !fs.existsSync(statsCachePath)) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(statsCachePath, "utf8"));
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const models = Object.entries(parsed.modelUsage || {}).map(([model, usage]) => {
    const freshInputTokens = numberValue(usage.inputTokens);
    const outputTokens = numberValue(usage.outputTokens);
    const cacheReadTokens = numberValue(usage.cacheReadInputTokens);
    const cacheWriteTokens = numberValue(usage.cacheCreationInputTokens);
    const pricing = findClaudePricing(model);
    const estimatedUsd = pricing
      ? roundUsd((freshInputTokens * pricing.input + cacheWriteTokens * pricing.cacheWrite5m + cacheReadTokens * pricing.cacheRead + outputTokens * pricing.output) / TOKENS_PER_MILLION)
      : null;
    return {
      model,
      freshInputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      totalTokens: freshInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens,
      estimatedUsd,
      pricingLabel: pricing ? pricing.label : "",
    };
  }).sort((a, b) => b.totalTokens - a.totalTokens);
  const daily = [];
  for (const entry of Array.isArray(parsed.dailyModelTokens) ? parsed.dailyModelTokens : []) {
    for (const [model, tokens] of Object.entries(entry.tokensByModel || {})) {
      daily.push({ day: String(entry.date || ""), model, totalTokens: numberValue(tokens) });
    }
  }
  const activity = (Array.isArray(parsed.dailyActivity) ? parsed.dailyActivity : []).map((entry) => ({
    day: String(entry.date || ""),
    messageCount: numberValue(entry.messageCount),
    sessionCount: numberValue(entry.sessionCount),
    toolCallCount: numberValue(entry.toolCallCount),
  }));
  return {
    totals: {
      source: statsCachePath,
      capturedAt: new Date().toISOString(),
      lastComputedDate: String(parsed.lastComputedDate || ""),
      firstSessionDate: String(parsed.firstSessionDate || ""),
      totalSessions: numberValue(parsed.totalSessions),
      totalMessages: numberValue(parsed.totalMessages),
      pricingNote: "Standard-tier API list prices applied to whole-history totals; cache writes priced at the 5-minute rate.",
      models,
    },
    daily,
    activity,
  };
}

function codexFileDay(fileInfo) {
  const match = CODEX_ROLLOUT_DATE.exec(path.basename(fileInfo.path));
  return match ? match[1] : "";
}

// A file can only hold events between its start day (Codex rollout name) and
// its mtime, so these bounds are enough to skip files outside the window.
function makeFileFilter(provider, window) {
  const sinceMs = localMidnightMs(window.since);
  return (fileInfo) => {
    if (sinceMs && fileInfo.mtimeMs && fileInfo.mtimeMs < sinceMs) return false;
    if (provider === "codex" && window.until) {
      const startDay = codexFileDay(fileInfo);
      if (startDay && startDay > window.until) return false;
    }
    return true;
  };
}

function formatElapsed(ms) {
  const totalSeconds = Math.round(ms / MS_PER_SECOND);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m${String(seconds).padStart(2, "0")}s` : `${seconds}s`;
}

function createProgress(label, totalFiles, totalBytes, quiet) {
  const startedAt = Date.now();
  let lastPrint = 0;
  let doneFiles = 0;
  let doneBytes = 0;
  let peakRssMb = 0;
  const log = (force) => {
    const now = Date.now();
    peakRssMb = Math.max(peakRssMb, process.memoryUsage().rss / BYTES_PER_MB);
    if (quiet || (!force && now - lastPrint < PROGRESS_INTERVAL_MS)) return;
    lastPrint = now;
    const elapsed = now - startedAt;
    const share = totalBytes > 0 ? doneBytes / totalBytes : 0;
    const eta = share > 0 && share < 1 ? formatElapsed(elapsed / share - elapsed) : "-";
    process.stderr.write(`[${label}] ${doneFiles}/${totalFiles} files, ${(doneBytes / BYTES_PER_MB / KB_PER_MB).toFixed(2)}/${(totalBytes / BYTES_PER_MB / KB_PER_MB).toFixed(2)} GB (${(share * 100).toFixed(1)}%), elapsed ${formatElapsed(elapsed)}, eta ${eta}, rss ${Math.round(peakRssMb)} MB\n`);
  };
  return {
    onFile(fileInfo) {
      doneFiles += 1;
      doneBytes += numberValue(fileInfo.size);
      log(false);
    },
    finish() {
      log(true);
      return { durationMs: Date.now() - startedAt, files: doneFiles, bytes: doneBytes, peakRssMb: Math.round(peakRssMb) };
    },
  };
}

function resolveRoots(args) {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  return {
    claudeRoot: path.resolve(args.claudeRoot || process.env.CLAUDE_PROJECTS_ROOT || path.join(os.homedir(), ".claude", "projects")),
    codexRoot: path.resolve(args.codexRoot || process.env.CODEX_SESSIONS_ROOT || path.join(codexHome, "sessions")),
    statsCachePath: args.includeStatsCache
      ? path.resolve(args.statsCachePath || process.env.CLAUDE_STATS_CACHE || path.join(os.homedir(), ".claude", "stats-cache.json"))
      : "",
  };
}

async function scanProvider(provider, root, args, window, accumulator) {
  const fileFilter = makeFileFilter(provider, window);
  const candidates = listJsonlFiles(root).filter(fileFilter);
  const totalBytes = candidates.reduce((sum, file) => sum + numberValue(file.size), 0);
  const progress = createProgress(provider, candidates.length, totalBytes, args.quiet);
  const options = {
    collect: false,
    fileFilter,
    onFile: (fileInfo) => progress.onFile(fileInfo),
    onSession: (session, events) => accumulator.addSession(provider, session, events),
  };
  if (provider === "codex") {
    options.includeSqlite = args.includeSqlite !== false;
    if (args.sqlitePath) options.sqlitePath = args.sqlitePath;
    if (args.sessionIndexPath) options.sessionIndexPath = args.sessionIndexPath;
  } else if (args.sessionsMetaRoot) {
    options.sessionsMetaRoot = args.sessionsMetaRoot;
  }
  const result = provider === "claude"
    ? await parseClaude(root, 0, options)
    : await parseCodex(root, 0, options);
  const timing = progress.finish();
  const scanned = {
    provider,
    root,
    scannedAt: new Date().toISOString(),
    filesOnDisk: numberValue(result.files),
    filesScanned: numberValue(result.scannedFiles),
    bytesScanned: timing.bytes,
    durationMs: timing.durationMs,
    peakRssMb: timing.peakRssMb,
    errors: (result.errors || []).length,
  };
  if (provider === "claude") {
    scanned.duplicateUsageRecords = numberValue(result.duplicateUsageRecords);
    scanned.mergedUsageRecords = numberValue(result.mergedUsageRecords);
  } else {
    scanned.repeatedTokenCounts = numberValue(result.repeatedTokenCounts);
    scanned.replayedTokenCounts = numberValue(result.replayedTokenCounts);
    scanned.burstTokenCounts = numberValue(result.burstTokenCounts);
    scanned.sqliteThreads = numberValue(result.sqliteThreads);
    scanned.sqlitePath = result.sqlitePath || "";
  }
  return { scanned, errors: result.errors || [] };
}

function selectedProviders(providerArg) {
  const value = String(providerArg || "all").toLowerCase();
  if (value === "all") return PROVIDERS.slice();
  if (!PROVIDERS.includes(value)) {
    throw new Error(`--provider must be one of claude, codex, all (got "${value}")`);
  }
  return [value];
}

function readLedger(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  if (!parsed || parsed.schema !== LEDGER_SCHEMA) {
    throw new Error(`${filePath} is not a ${LEDGER_SCHEMA} ledger; refusing to overwrite it`);
  }
  return parsed;
}

function writeFileAtomic(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, body, "utf8");
  if (fs.existsSync(filePath)) {
    fs.copyFileSync(filePath, `${filePath}.bak`);
  }
  fs.renameSync(tempPath, filePath);
}

async function exportHistory(args) {
  const outPath = path.resolve(args.out);
  const window = {
    since: assertDayKey(args.since, "--since"),
    until: assertDayKey(args.until, "--until"),
  };
  const providers = selectedProviders(args.provider);
  const roots = resolveRoots(args);
  const existing = readLedger(outPath);
  const accumulator = createScanAccumulator(window);
  const startedAt = Date.now();
  const sourcesScanned = {};
  const errors = [];
  for (const provider of providers) {
    const root = provider === "claude" ? roots.claudeRoot : roots.codexRoot;
    const outcome = await scanProvider(provider, root, args, window, accumulator);
    sourcesScanned[provider] = outcome.scanned;
    errors.push(...outcome.errors.map((error) => ({ provider, ...error })));
  }
  const scan = accumulator.finish();
  const statsCache = roots.statsCachePath ? readStatsCache(roots.statsCachePath) : null;
  const generatedAt = new Date().toISOString();
  const maxRss = process.resourceUsage().maxRSS / KB_PER_MB;
  const fresh = {
    schema: LEDGER_SCHEMA,
    generatedAt,
    dayTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "",
    sourcesScanned,
    runs: [{
      at: generatedAt,
      since: window.since || "",
      until: window.until || "",
      providers,
      durationMs: Date.now() - startedAt,
      peakRssMb: Math.round(maxRss),
      rows: scan.rows.length,
      sessions: scan.sessions.length,
      errors: errors.length,
    }],
    coverage: { sources: scan.sources },
    rows: scan.rows,
    sessions: scan.sessions,
    largestTurns: scan.largestTurns,
    claudeStatsCacheTotals: statsCache ? statsCache.totals : null,
    claudeStatsCacheDaily: statsCache ? statsCache.daily : [],
    claudeStatsCacheActivity: statsCache ? statsCache.activity : [],
  };
  const ledger = finalizeLedger(mergeLedgers(existing, fresh));
  writeFileAtomic(outPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return { ledger, fresh, errors, outPath, durationMs: Date.now() - startedAt, peakRssMb: Math.round(maxRss) };
}

function formatInt(value) {
  return Math.round(numberValue(value)).toLocaleString("en-US");
}

function formatUsd(value) {
  return value == null ? "n/a" : `$${Number(value).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatShare(numerator, denominator) {
  return denominator > 0 ? `${((numerator / denominator) * 100).toFixed(1)}%` : "n/a";
}

function formatMinutes(value) {
  const minutes = Math.round(numberValue(value));
  if (minutes >= 1440) return `${(minutes / 1440).toFixed(1)} d`;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)} h`;
  return `${minutes} min`;
}

function markdownTable(headers, rows) {
  const lines = [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`];
  for (const row of rows) lines.push(`| ${row.join(" | ")} |`);
  return lines.join("\n");
}

function sumRows(rows) {
  const total = { freshInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0, totalTokens: 0, breakdownUnknownTokens: 0, turns: 0, subagentTokens: 0, pricedTokens: 0, unpricedTokens: 0, estimatedUsd: null };
  for (const row of rows) {
    for (const field of Object.keys(total)) {
      if (field === "estimatedUsd") {
        if (row.estimatedUsd != null) total.estimatedUsd = numberValue(total.estimatedUsd) + row.estimatedUsd;
      } else {
        total[field] += numberValue(row[field]);
      }
    }
  }
  return total;
}

function cacheReadShare(total) {
  return formatShare(total.cacheReadTokens, total.freshInputTokens + total.cacheReadTokens + total.cacheWriteTokens);
}

function groupRows(rows, keyOf) {
  const groups = new Map();
  for (const row of rows) {
    const key = keyOf(row);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return groups;
}

function formatEstimate(total) {
  if (total.pricedTokens > 0) {
    return total.unpricedTokens > 0 ? `${formatUsd(total.estimatedUsd)} (partial)` : formatUsd(total.estimatedUsd);
  }
  return total.breakdownUnknownTokens >= total.totalTokens && total.totalTokens > 0 ? "n/a (no breakdown)" : "n/a (no pricing)";
}

function buildSummaryMarkdown(ledger, ledgerPath) {
  const lines = [];
  const rows = ledger.rows || [];
  const coverage = ledger.coverage || { providers: {}, sources: [], notes: [] };
  lines.push("# AI Spend history summary");
  lines.push("");
  lines.push(`Generated ${ledger.generatedAt} from \`${path.basename(ledgerPath)}\` (days are local ${ledger.dayTimezone || "time"}). ${PRIVACY_NOTE}`);
  lines.push("");
  lines.push("## Coverage");
  lines.push("");
  for (const provider of PROVIDERS) {
    const info = coverage.providers[provider];
    if (!info || !info.firstDay) {
      lines.push(`- **${provider}**: no rows.`);
      continue;
    }
    const months = info.months.join(", ");
    const gaps = info.missingDayRanges.length > 0
      ? info.missingDayRanges.map((range) => `${range.from}..${range.to} (${range.days}d)`).join(", ")
      : "none";
    lines.push(`- **${provider}**: ${info.firstDay} to ${info.lastDay}, ${info.daysWithUsage} of ${info.spanDays} days have usage. Months: ${months}. Missing day ranges: ${gaps}.`);
  }
  lines.push("");
  lines.push(markdownTable(
    ["Provider", "Source", "First record", "Last record", "Last scan", "Sessions", "Turns", "Tokens"],
    coverage.sources.map((entry) => [
      entry.provider,
      entry.source,
      entry.firstRecord || "-",
      entry.lastRecord || "-",
      entry.lastScanAt || "-",
      formatInt(entry.lastScan && entry.lastScan.sessions),
      formatInt(entry.lastScan && entry.lastScan.turns),
      formatInt(entry.lastScan && entry.lastScan.tokens),
    ]),
  ));
  lines.push("");
  for (const note of coverage.notes || []) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## Tokens per month by provider");
  lines.push("");
  const months = Array.from(new Set(rows.map((row) => row.day.slice(0, 7)))).sort();
  lines.push(markdownTable(
    ["Month", "Claude tokens", "Claude est. USD", "Codex tokens", "Codex est. USD", "Codex no-breakdown (SQLite)", "Total tokens"],
    months.map((month) => {
      const monthRows = rows.filter((row) => row.day.startsWith(month));
      const claude = sumRows(monthRows.filter((row) => row.provider === "claude"));
      const codex = sumRows(monthRows.filter((row) => row.provider === "codex"));
      return [
        month,
        formatInt(claude.totalTokens),
        claude.totalTokens > 0 ? formatEstimate(claude) : "-",
        formatInt(codex.totalTokens),
        codex.totalTokens > 0 ? formatEstimate(codex) : "-",
        formatInt(codex.breakdownUnknownTokens),
        formatInt(claude.totalTokens + codex.totalTokens),
      ];
    }),
  ));
  lines.push("");
  lines.push("Months with only no-breakdown tokens come from Codex state SQLite thread totals (rollouts no longer on disk); they carry no fresh/cache/output split and no USD estimate.");
  lines.push("");

  lines.push("## Per-model totals");
  lines.push("");
  const modelGroups = groupRows(rows, (row) => `${row.provider}|${row.model}`);
  const modelRows = Array.from(modelGroups.entries())
    .map(([key, group]) => ({ key, provider: group[0].provider, model: group[0].model, total: sumRows(group) }))
    .sort((a, b) => b.total.totalTokens - a.total.totalTokens);
  lines.push(markdownTable(
    ["Provider", "Model", "Fresh input", "Cache read", "Cache write", "Output", "Unknown breakdown", "Total", "Turns", "Cache-read share", "Est. USD"],
    modelRows.map((row) => [
      row.provider,
      row.model,
      formatInt(row.total.freshInputTokens),
      formatInt(row.total.cacheReadTokens),
      formatInt(row.total.cacheWriteTokens),
      formatInt(row.total.outputTokens),
      formatInt(row.total.breakdownUnknownTokens),
      formatInt(row.total.totalTokens),
      formatInt(row.total.turns),
      cacheReadShare(row.total),
      formatEstimate(row.total),
    ]),
  ));
  lines.push("");
  lines.push("Est. USD is the API-equivalent list price for the priced tokens of each model. Models without configured pricing show n/a (no pricing); SQLite-only thread totals show n/a (no breakdown); (partial) means some of the model's tokens were SQLite-only lumps that could not be priced. Nothing is counted as zero.");
  lines.push("");

  lines.push("## Cache-read share");
  lines.push("");
  const all = sumRows(rows);
  lines.push(`- All providers: ${cacheReadShare(all)} of prompt-side tokens were cache reads (${formatInt(all.cacheReadTokens)} of ${formatInt(all.freshInputTokens + all.cacheReadTokens + all.cacheWriteTokens)}).`);
  for (const provider of PROVIDERS) {
    const total = sumRows(rows.filter((row) => row.provider === provider));
    lines.push(`- ${provider}: ${cacheReadShare(total)} (fresh ${formatInt(total.freshInputTokens)}, cache read ${formatInt(total.cacheReadTokens)}, cache write ${formatInt(total.cacheWriteTokens)}, output ${formatInt(total.outputTokens)}, breakdown unknown ${formatInt(total.breakdownUnknownTokens)}).`);
  }
  lines.push("");

  lines.push("## Per-project totals");
  lines.push("");
  const projectGroups = groupRows(rows, (row) => `${row.provider}|${row.project}`);
  lines.push(markdownTable(
    ["Provider", "Project", "Tokens", "Turns", "Est. USD"],
    Array.from(projectGroups.values())
      .map((group) => ({ provider: group[0].provider, project: group[0].project, total: sumRows(group) }))
      .sort((a, b) => b.total.totalTokens - a.total.totalTokens)
      .map((row) => [row.provider, row.project, formatInt(row.total.totalTokens), formatInt(row.total.turns), formatEstimate(row.total)]),
  ));
  lines.push("");
  lines.push("Projects are directory basenames; folders whose names read like a prompt are replaced by a stable `untitled-<hash>` label.");
  lines.push("");

  lines.push("## Subagent share");
  lines.push("");
  for (const provider of PROVIDERS) {
    const total = sumRows(rows.filter((row) => row.provider === provider));
    const sessions = (ledger.sessions || []).filter((session) => session.provider === provider);
    const subagentSessions = sessions.filter((session) => session.isSubagent).length;
    const label = provider === "claude" ? "sidechain subagents" : "spawned/guardian sub-threads";
    lines.push(`- ${provider}: ${formatShare(total.subagentTokens, total.totalTokens)} of tokens (${formatInt(total.subagentTokens)} of ${formatInt(total.totalTokens)}) ran in ${label}; ${formatInt(subagentSessions)} of ${formatInt(sessions.length)} sessions.`);
  }
  lines.push("");

  const effortTotals = new Map();
  for (const row of rows) {
    for (const [effort, tokens] of Object.entries(row.effortTokens || {})) {
      const key = `${row.provider}|${effort}`;
      effortTotals.set(key, (effortTotals.get(key) || 0) + numberValue(tokens));
    }
  }
  if (effortTotals.size > 0) {
    lines.push("## Reasoning-effort buckets");
    lines.push("");
    lines.push(markdownTable(
      ["Provider", "Effort", "Tokens"],
      Array.from(effortTotals.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([key, tokens]) => [key.split("|")[0], key.split("|")[1], formatInt(tokens)]),
    ));
    lines.push("");
  }

  lines.push(`## ${SUMMARY_TOP_COUNT} largest single turns`);
  lines.push("");
  lines.push(markdownTable(
    ["Day", "Provider", "Model", "Project", "Tokens", "Fresh", "Cache read", "Cache write", "Output", "Subagent"],
    (ledger.largestTurns || []).slice(0, SUMMARY_TOP_COUNT).map((turn) => [
      turn.day,
      turn.provider,
      turn.model,
      turn.project,
      formatInt(turn.totalTokens),
      formatInt(turn.freshInputTokens),
      formatInt(turn.cacheReadTokens),
      formatInt(turn.cacheWriteTokens),
      formatInt(turn.outputTokens),
      turn.isSubagent ? "yes" : "no",
    ]),
  ));
  lines.push("");

  lines.push(`## ${SUMMARY_TOP_COUNT} longest sessions`);
  lines.push("");
  lines.push(markdownTable(
    ["Provider", "Source", "Project", "Model", "Start", "Duration", "Turns", "Tokens", "Largest turn", "Subagent"],
    (ledger.sessions || [])
      .slice()
      .sort((a, b) => b.durationMinutes - a.durationMinutes)
      .slice(0, SUMMARY_TOP_COUNT)
      .map((session) => [
        session.provider,
        session.source,
        session.project,
        session.model,
        session.start.slice(0, 16).replace("T", " "),
        formatMinutes(session.durationMinutes),
        formatInt(session.turns),
        formatInt(session.totalTokens),
        formatInt(session.largestTurnTokens),
        session.isSubagent ? "yes" : "no",
      ]),
  ));
  lines.push("");

  lines.push(`## ${SUMMARY_TOP_COUNT} largest sessions by tokens`);
  lines.push("");
  lines.push(markdownTable(
    ["Provider", "Source", "Project", "Model", "Start", "Duration", "Turns", "Tokens", "Est. USD", "Subagent"],
    (ledger.sessions || [])
      .slice()
      .sort((a, b) => b.totalTokens - a.totalTokens)
      .slice(0, SUMMARY_TOP_COUNT)
      .map((session) => [
        session.provider,
        session.source,
        session.project,
        session.model,
        session.start.slice(0, 16).replace("T", " "),
        formatMinutes(session.durationMinutes),
        formatInt(session.turns),
        formatInt(session.totalTokens),
        formatUsd(session.estimatedUsd),
        session.isSubagent ? "yes" : "no",
      ]),
  ));
  lines.push("");
  lines.push("codex-sqlite sessions are whole-thread totals recovered from the state database for rollouts no longer on disk; their turn count is 1 by construction and their duration is created-to-updated.");
  lines.push("");

  const stats = ledger.claudeStatsCacheTotals;
  if (stats) {
    lines.push("## Claude stats-cache whole-history totals (lower bound)");
    lines.push("");
    lines.push(`First session ${stats.firstSessionDate || "-"}, last computed ${stats.lastComputedDate || "-"}, ${formatInt(stats.totalSessions)} sessions, ${formatInt(stats.totalMessages)} messages. ${stats.pricingNote || ""}`);
    lines.push("");
    lines.push(markdownTable(
      ["Model", "Fresh input", "Cache read", "Cache write", "Output", "Total", "Est. USD"],
      (stats.models || []).map((row) => [
        row.model,
        formatInt(row.freshInputTokens),
        formatInt(row.cacheReadTokens),
        formatInt(row.cacheWriteTokens),
        formatInt(row.outputTokens),
        formatInt(row.totalTokens),
        formatUsd(row.estimatedUsd),
      ]),
    ));
    const statsTotal = (stats.models || []).reduce((sum, row) => sum + numberValue(row.totalTokens), 0);
    const statsUsd = (stats.models || []).reduce((sum, row) => sum + numberValue(row.estimatedUsd), 0);
    const ledgerClaude = sumRows(rows.filter((row) => row.provider === "claude"));
    lines.push("");
    lines.push(`Stats-cache total ${formatInt(statsTotal)} tokens (${formatUsd(statsUsd)}) versus ${formatInt(ledgerClaude.totalTokens)} Claude tokens in surviving transcripts: ${formatShare(ledgerClaude.totalTokens, statsTotal)} of the whole-history Claude volume still has per-day detail.`);
    const dailyDays = new Set((ledger.claudeStatsCacheDaily || []).map((row) => row.day));
    const activityDays = new Set((ledger.claudeStatsCacheActivity || []).map((row) => row.day));
    lines.push(`stats-cache dailyModelTokens covers ${dailyDays.size} days, dailyActivity covers ${activityDays.size} days.`);
    lines.push("");
  }

  lines.push("## Scan provenance");
  lines.push("");
  for (const [provider, scanned] of Object.entries(ledger.sourcesScanned || {})) {
    const extras = provider === "claude"
      ? `duplicate usage records skipped ${formatInt(scanned.duplicateUsageRecords)} (merged final counts ${formatInt(scanned.mergedUsageRecords)})`
      : `repeated token_count snapshots skipped ${formatInt(scanned.repeatedTokenCounts)}, fork-replayed parent events skipped ${formatInt(scanned.replayedTokenCounts)} (plus ${formatInt(scanned.burstTokenCounts)} by the timing fallback), SQLite-only threads ${formatInt(scanned.sqliteThreads)}`;
    lines.push(`- ${provider}: ${formatInt(scanned.filesScanned)} of ${formatInt(scanned.filesOnDisk)} files (${(numberValue(scanned.bytesScanned) / BYTES_PER_MB / KB_PER_MB).toFixed(2)} GB) in ${formatElapsed(scanned.durationMs)} at ${scanned.scannedAt}, peak RSS ${formatInt(scanned.peakRssMb)} MB, ${formatInt(scanned.errors)} file errors; ${extras}.`);
  }
  lines.push("");
  return `${lines.join("\n")}\n`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(usage());
    return;
  }
  if (!args.out) {
    console.error(usage());
    throw new Error("--out is required");
  }
  if (args.summaryOnly) {
    const ledger = readLedger(path.resolve(args.out));
    if (!ledger) throw new Error(`No ledger at ${args.out}`);
    const summaryPath = path.resolve(args.summaryOut || path.join(path.dirname(args.out), "ai-spend-summary.md"));
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, buildSummaryMarkdown(finalizeLedger(ledger), path.resolve(args.out)), "utf8");
    console.log(`Wrote summary: ${summaryPath}`);
    return;
  }
  const result = await exportHistory(args);
  const { ledger } = result;
  console.log(`Wrote ledger: ${result.outPath}`);
  console.log(`Rows ${ledger.rows.length}, sessions ${ledger.sessions.length}, largest turns ${ledger.largestTurns.length}, wall ${formatElapsed(result.durationMs)}, peak RSS ${result.peakRssMb} MB`);
  for (const [provider, scanned] of Object.entries(result.fresh.sourcesScanned)) {
    console.log(`  ${provider}: ${scanned.filesScanned}/${scanned.filesOnDisk} files, ${(scanned.bytesScanned / BYTES_PER_MB / KB_PER_MB).toFixed(2)} GB, ${formatElapsed(scanned.durationMs)}, ${scanned.errors} errors`);
  }
  if (result.errors.length > 0) {
    console.log(`File errors (${result.errors.length}):`);
    for (const error of result.errors.slice(0, 20)) console.log(`  ${error.provider}: ${error.file}: ${error.error}`);
  }
  if (args.summaryOut) {
    const summaryPath = path.resolve(args.summaryOut);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, buildSummaryMarkdown(ledger, result.outPath), "utf8");
    console.log(`Wrote summary: ${summaryPath}`);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  LEDGER_SCHEMA,
  ROW_COUNT_FIELDS,
  ROW_TOKEN_FIELDS,
  buildSummaryMarkdown,
  claudeProjectName,
  codexProjectName,
  createScanAccumulator,
  eventComponents,
  exportHistory,
  finalizeLedger,
  makeFileFilter,
  mergeLedgers,
  mergeRow,
  mergeSession,
  readStatsCache,
  safeProjectName,
};
