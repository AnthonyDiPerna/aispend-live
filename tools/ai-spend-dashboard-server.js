const http = require("http");
const fs = require("fs");
const os = require("os");
const path = require("path");
const readline = require("readline");

const dashboardPath = path.resolve(__dirname, "ai-spend-dashboard.html");

const DEFAULT_PORT = Number(process.env.AI_SPEND_PORT || 9020);
const DEFAULT_DAYS = 7;
const MAX_TOP_EVENTS = 80;
const MAX_TOP_SESSIONS = 120;

const CLAUDE_PRICING = [
  { match: /opus/i, label: "Claude Opus", input: 15, cacheWrite5m: 18.75, cacheWrite1h: 30, cacheRead: 1.5, output: 75 },
  { match: /sonnet/i, label: "Claude Sonnet", input: 3, cacheWrite5m: 3.75, cacheWrite1h: 6, cacheRead: 0.3, output: 15 },
  { match: /haiku-?3\.5|haiku.*3\.5/i, label: "Claude Haiku 3.5", input: 0.8, cacheWrite5m: 1, cacheWrite1h: 1.6, cacheRead: 0.08, output: 4 },
  { match: /haiku/i, label: "Claude Haiku", input: 0.25, cacheWrite5m: 0.3, cacheWrite1h: 0.5, cacheRead: 0.03, output: 1.25 },
];

const OPENAI_PRICING = [
  { match: /^gpt-5\.5/i, label: "GPT-5.5", input: 5, cachedInput: 0.5, output: 30 },
  { match: /^gpt-5\.4-mini/i, label: "GPT-5.4 mini", input: 0.75, cachedInput: 0.075, output: 4.5 },
  { match: /^gpt-5\.4/i, label: "GPT-5.4", input: 2.5, cachedInput: 0.25, output: 15 },
  { match: /^gpt-5\.3-codex/i, label: "GPT-5.3 Codex estimate", input: 1.75, cachedInput: 0.175, output: 14, estimated: true },
  { match: /^gpt-5\.2-codex/i, label: "GPT-5.2 Codex", input: 1.75, cachedInput: 0.175, output: 14 },
  { match: /^gpt-5\.2/i, label: "GPT-5.2", input: 1.75, cachedInput: 0.175, output: 14 },
  { match: /^gpt-5/i, label: "GPT-5", input: 1.25, cachedInput: 0.125, output: 10 },
];

const PLAN_PRESETS = {
  claude: {
    custom: {
      label: "Custom/env",
      detail: "Use AI_SPEND_5H_TOKEN_BUDGET and AI_SPEND_WEEKLY_TOKEN_BUDGET.",
    },
    "claude-pro": {
      label: "Claude Pro",
      detail: "Officially described as about 45 short Claude messages per 5 hours; exact token caps are not published.",
      fiveHourMessages: { min: 45, max: 45 },
      weeklyNote: "Claude may apply weekly caps, but Anthropic does not publish numeric weekly token limits for individual plans.",
      source: "https://support.anthropic.com/en/articles/8324991-about-claude-s-pro-plan-usage/",
    },
    "claude-max-5x": {
      label: "Claude Max 5x ($100)",
      detail: "Officially described as 5x Pro, at least 225 short Claude messages per 5 hours; exact token caps are not published.",
      fiveHourMessages: { min: 225, max: 225 },
      weeklyNote: "Claude Max has weekly limits, including an all-model cap and a Sonnet-only cap, but numeric token caps are not published.",
      source: "https://support.anthropic.com/en/articles/11014257-about-claude-s-max-plan-usage/",
    },
    "claude-max-20x": {
      label: "Claude Max 20x ($200)",
      detail: "Officially described as 20x Pro, at least 900 short Claude messages per 5 hours; exact token caps are not published.",
      fiveHourMessages: { min: 900, max: 900 },
      weeklyNote: "Claude Max has weekly limits, including an all-model cap and a Sonnet-only cap, but numeric token caps are not published.",
      source: "https://support.anthropic.com/en/articles/11014257-about-claude-s-max-plan-usage/",
    },
  },
  codex: {
    custom: {
      label: "Custom/env",
      detail: "Use AI_SPEND_5H_TOKEN_BUDGET and AI_SPEND_WEEKLY_TOKEN_BUDGET.",
    },
    "codex-plus": {
      label: "Codex Plus / Business",
      detail: "Official Codex local-message range per 5 hours. Token estimate is calibrated from your local logs.",
      modelMessages: {
        gpt55: { min: 15, max: 80 },
        gpt54: { min: 20, max: 100 },
        gpt54mini: { min: 60, max: 350 },
        gpt53codex: { min: 30, max: 150 },
      },
      weeklyNote: "OpenAI says additional weekly limits may apply, but does not publish numeric weekly token caps.",
      source: "https://developers.openai.com/codex/pricing",
    },
    "codex-pro-5x": {
      label: "Codex Pro 5x ($100)",
      detail: "Current promo through May 31, 2026 applies 2x the listed Pro 5x Codex limits. Token estimate is calibrated from your local logs.",
      promoUntil: "2026-05-31",
      modelMessages: {
        gpt55: { min: 160, max: 800 },
        gpt54: { min: 200, max: 1000 },
        gpt54mini: { min: 600, max: 3500 },
        gpt53codex: { min: 300, max: 1500 },
      },
      weeklyNote: "OpenAI says additional weekly limits may apply, but does not publish numeric weekly token caps.",
      source: "https://developers.openai.com/codex/pricing",
    },
    "codex-pro-20x": {
      label: "Codex Pro 20x ($200)",
      detail: "Current promo through May 31, 2026 uses 25x Plus Codex limits. Token estimate is calibrated from your local logs.",
      promoUntil: "2026-05-31",
      modelMessages: {
        gpt55: { min: 375, max: 2000 },
        gpt54: { min: 500, max: 2500 },
        gpt54mini: { min: 1500, max: 8750 },
        gpt53codex: { min: 750, max: 3750 },
      },
      weeklyNote: "OpenAI says additional weekly limits may apply, but does not publish numeric weekly token caps.",
      source: "https://developers.openai.com/codex/pricing",
    },
    "codex-api": {
      label: "Codex API key",
      detail: "Usage-based API mode does not have the same subscription 5-hour cap; standard API limits and billing apply.",
      weeklyNote: "No subscription weekly cap is published for API-key usage.",
      source: "https://developers.openai.com/codex/pricing",
    },
  },
};

function numberValue(value) {
  const n = Number(value || 0);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function sanitizeSessionTitle(value, maxLength = 96) {
  const text = String(value == null ? "" : value)
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return "";
  return text.length > maxLength ? `${text.slice(0, Math.max(1, maxLength - 3))}...` : text;
}

function setSessionTitle(session, value, source, priority) {
  const title = sanitizeSessionTitle(value);
  if (!title) return false;
  const nextPriority = Number(priority || 1);
  if (!session.title || nextPriority >= (session.namePriority || 0)) {
    session.title = title;
    session.nameSource = source || "metadata";
    session.namePriority = nextPriority;
    return true;
  }
  return false;
}

function getSessionIdentity(session) {
  const title = sanitizeSessionTitle(session.title);
  if (title) {
    return {
      title,
      displayName: title,
      nameSource: session.nameSource || "metadata",
    };
  }

  const project = sanitizeSessionTitle(session.project || (session.cwd ? path.basename(session.cwd) : ""));
  if (project) {
    return {
      title: "",
      displayName: project,
      nameSource: "project path",
    };
  }

  const id = String(session.id || session.sessionId || "").trim();
  return {
    title: "",
    displayName: id ? `Session ${id.slice(0, 10)}` : "Unknown session",
    nameSource: "session id",
  };
}

function applySessionIdentityToEvents(session) {
  const identity = getSessionIdentity(session);
  session.title = identity.title;
  session.displayName = identity.displayName;
  session.nameSource = identity.nameSource;
  for (const event of session.events) {
    event.title = identity.title;
    event.displayName = identity.displayName;
    event.nameSource = identity.nameSource;
  }
}

function cacheHitRatio(tokens) {
  const cached = numberValue(tokens.cachedInputTokens) + numberValue(tokens.cacheReadInputTokens);
  const inputLike = numberValue(tokens.inputTokens)
    + numberValue(tokens.cachedInputTokens)
    + numberValue(tokens.cacheCreationInputTokens)
    + numberValue(tokens.cacheCreation1hInputTokens)
    + numberValue(tokens.cacheReadInputTokens);
  return inputLike > 0 ? cached / inputLike : 0;
}

function emptyTokens() {
  return {
    inputTokens: 0,
    cacheCreationInputTokens: 0,
    cacheCreation1hInputTokens: 0,
    cacheReadInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
  };
}

function addTokens(target, source) {
  for (const key of Object.keys(emptyTokens())) {
    target[key] += numberValue(source[key]);
  }
  return target;
}

function tokenTotal(tokens) {
  const explicit = numberValue(tokens.totalTokens);
  if (explicit > 0) return explicit;
  return numberValue(tokens.inputTokens)
    + numberValue(tokens.cacheCreationInputTokens)
    + numberValue(tokens.cacheCreation1hInputTokens)
    + numberValue(tokens.cacheReadInputTokens)
    + numberValue(tokens.outputTokens);
}

function parseTimestampMs(value, fallbackMs) {
  const ms = Date.parse(value || "");
  return Number.isFinite(ms) ? ms : fallbackMs;
}

function localDateKey(ms) {
  const d = new Date(ms);
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function localHourKey(ms) {
  const d = new Date(ms);
  const hour = String(d.getHours()).padStart(2, "0");
  return `${localDateKey(ms)} ${hour}:00`;
}

function safeJsonParse(line) {
  try {
    return JSON.parse(line);
  } catch (_) {
    return null;
  }
}

async function readJsonLines(filePath, onObject) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parsed = safeJsonParse(trimmed);
    if (!parsed || typeof parsed !== "object") continue;
    onObject(parsed, lineNumber);
  }
}

function listJsonlFiles(root) {
  const out = [];
  if (!root || !fs.existsSync(root)) return out;
  const stack = [root];
  while (stack.length > 0) {
    const current = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".jsonl")) {
        let stat = null;
        try {
          stat = fs.statSync(fullPath);
        } catch (_) {
          stat = null;
        }
        out.push({
          path: fullPath,
          size: stat ? stat.size : 0,
          mtimeMs: stat ? stat.mtimeMs : 0,
        });
      }
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

function findClaudePricing(model) {
  const modelName = String(model || "");
  return CLAUDE_PRICING.find((pricing) => pricing.match.test(modelName)) || null;
}

function findOpenAiPricing(model) {
  const modelName = String(model || "");
  return OPENAI_PRICING.find((pricing) => pricing.match.test(modelName)) || null;
}

function estimateCost(provider, model, tokens) {
  if (provider === "claude") {
    const pricing = findClaudePricing(model);
    if (!pricing) return { usd: 0, known: false, label: "Unknown Claude model" };
    const usd = (
      numberValue(tokens.inputTokens) * pricing.input
      + numberValue(tokens.cacheCreationInputTokens) * pricing.cacheWrite5m
      + numberValue(tokens.cacheCreation1hInputTokens) * pricing.cacheWrite1h
      + numberValue(tokens.cacheReadInputTokens) * pricing.cacheRead
      + numberValue(tokens.outputTokens) * pricing.output
    ) / 1000000;
    return { usd, known: true, label: pricing.label, estimated: Boolean(pricing.estimated) };
  }

  if (provider === "codex") {
    const pricing = findOpenAiPricing(model);
    if (!pricing) return { usd: 0, known: false, label: "Unknown OpenAI model" };
    const input = numberValue(tokens.inputTokens);
    const cached = Math.min(numberValue(tokens.cachedInputTokens), input);
    const uncached = Math.max(0, input - cached);
    const usd = (
      uncached * pricing.input
      + cached * pricing.cachedInput
      + numberValue(tokens.outputTokens) * pricing.output
    ) / 1000000;
    return { usd, known: true, label: pricing.label, estimated: Boolean(pricing.estimated) };
  }

  return { usd: 0, known: false, label: "Unknown provider" };
}

function normalizeClaudeUsage(usage) {
  const tokens = emptyTokens();
  if (!usage || typeof usage !== "object") return tokens;

  tokens.inputTokens = numberValue(usage.input_tokens);
  tokens.outputTokens = numberValue(usage.output_tokens);
  tokens.cacheCreationInputTokens = numberValue(usage.cache_creation_input_tokens);
  tokens.cacheReadInputTokens = numberValue(usage.cache_read_input_tokens);

  if (usage.cache_creation && typeof usage.cache_creation === "object") {
    for (const [key, value] of Object.entries(usage.cache_creation)) {
      if (/1h|hour/i.test(key)) {
        tokens.cacheCreation1hInputTokens += numberValue(value);
      } else {
        tokens.cacheCreationInputTokens += numberValue(value);
      }
    }
  }

  tokens.totalTokens = tokenTotal(tokens);
  return tokens;
}

function normalizeCodexUsage(usage) {
  const tokens = emptyTokens();
  if (!usage || typeof usage !== "object") return tokens;
  tokens.inputTokens = numberValue(usage.input_tokens);
  tokens.cachedInputTokens = numberValue(usage.cached_input_tokens);
  tokens.outputTokens = numberValue(usage.output_tokens);
  tokens.reasoningOutputTokens = numberValue(usage.reasoning_output_tokens);
  tokens.totalTokens = numberValue(usage.total_tokens) || (tokens.inputTokens + tokens.outputTokens);
  return tokens;
}

function diffCodexTotals(current, previous) {
  const out = emptyTokens();
  if (!current || typeof current !== "object") return out;
  const prior = previous || {};
  out.inputTokens = Math.max(0, numberValue(current.input_tokens) - numberValue(prior.input_tokens));
  out.cachedInputTokens = Math.max(0, numberValue(current.cached_input_tokens) - numberValue(prior.cached_input_tokens));
  out.outputTokens = Math.max(0, numberValue(current.output_tokens) - numberValue(prior.output_tokens));
  out.reasoningOutputTokens = Math.max(0, numberValue(current.reasoning_output_tokens) - numberValue(prior.reasoning_output_tokens));
  out.totalTokens = Math.max(0, numberValue(current.total_tokens) - numberValue(prior.total_tokens));
  if (out.totalTokens === 0) out.totalTokens = out.inputTokens + out.outputTokens;
  return out;
}

function createSession(provider, fileInfo, root) {
  const filePath = fileInfo.path || String(fileInfo);
  const relPath = path.relative(root, filePath);
  return {
    provider,
    id: path.basename(filePath, ".jsonl"),
    file: filePath,
    relativeFile: relPath,
    project: path.basename(path.dirname(filePath)),
    cwd: "",
    model: "unknown",
    title: "",
    displayName: "",
    nameSource: "",
    namePriority: 0,
    startMs: 0,
    endMs: 0,
    eventCount: 0,
    messageCount: 0,
    costUsd: 0,
    knownCostUsd: 0,
    unknownCostTokens: 0,
    pricingLabels: new Set(),
    tokens: emptyTokens(),
    events: [],
  };
}

function addEvent(session, event) {
  session.eventCount += 1;
  session.startMs = session.startMs ? Math.min(session.startMs, event.timestampMs) : event.timestampMs;
  session.endMs = Math.max(session.endMs || 0, event.timestampMs);
  session.model = session.model === "unknown" && event.model ? event.model : session.model;
  addTokens(session.tokens, event.tokens);
  session.costUsd += event.costUsd;
  if (event.costKnown) {
    session.knownCostUsd += event.costUsd;
  } else {
    session.unknownCostTokens += tokenTotal(event.tokens);
  }
  if (event.pricingLabel) session.pricingLabels.add(event.pricingLabel);
  session.events.push(event);
}

function readCodexSessionIndex(root) {
  const indexPath = path.resolve(process.env.CODEX_SESSION_INDEX || path.join(root, "..", "session_index.jsonl"));
  const names = new Map();
  if (!fs.existsSync(indexPath)) return names;
  let body = "";
  try {
    body = fs.readFileSync(indexPath, "utf8");
  } catch (_) {
    return names;
  }

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const record = safeJsonParse(trimmed);
    if (!record || typeof record !== "object") continue;
    const id = sanitizeSessionTitle(record.id, 160);
    const title = sanitizeSessionTitle(record.thread_name || record.title || record.name);
    if (id && title) names.set(id, { title, source: "Codex thread name" });
  }
  return names;
}

async function parseClaude(root, sinceMs) {
  const files = listJsonlFiles(root);
  const sessions = [];
  const events = [];
  const errors = [];
  for (const fileInfo of files) {
    if (sinceMs && fileInfo.mtimeMs && fileInfo.mtimeMs < sinceMs - 7 * 86400000) continue;
    const session = createSession("claude", fileInfo, root);
    let turnIndex = 0;
    try {
      await readJsonLines(fileInfo.path, (record) => {
        if (record.timestamp) {
          const ms = parseTimestampMs(record.timestamp, fileInfo.mtimeMs || Date.now());
          session.startMs = session.startMs ? Math.min(session.startMs, ms) : ms;
          session.endMs = Math.max(session.endMs || 0, ms);
        }
        if (record.sessionId) session.id = String(record.sessionId);
        if (record.cwd) session.cwd = String(record.cwd);
        if (record.messageCount) session.messageCount = Math.max(session.messageCount, numberValue(record.messageCount));
        if (record.type === "custom-title") setSessionTitle(session, record.customTitle, "Claude custom title", 5);
        if (record.type === "agent-name") setSessionTitle(session, record.agentName, "Claude agent name", 3);

        const message = record.message && typeof record.message === "object" ? record.message : null;
        const usage = message && message.usage ? message.usage : null;
        if (!usage) return;

        const tokens = normalizeClaudeUsage(usage);
        if (tokenTotal(tokens) <= 0) return;
        turnIndex += 1;
        const model = String(message.model || record.model || session.model || "unknown");
        if (model !== "unknown") session.model = model;
        const timestampMs = parseTimestampMs(record.timestamp, fileInfo.mtimeMs || Date.now());
        const cost = estimateCost("claude", model, tokens);
        const event = {
          provider: "claude",
          id: `${session.id}:${turnIndex}`,
          sessionId: session.id,
          turnIndex,
          file: session.relativeFile,
          project: session.project,
          cwd: session.cwd,
          model,
          timestampMs,
          timestamp: new Date(timestampMs).toISOString(),
          date: localDateKey(timestampMs),
          hour: localHourKey(timestampMs),
          tokens,
          totalTokens: tokenTotal(tokens),
          costUsd: cost.usd,
          costKnown: cost.known,
          pricingLabel: cost.label,
          pricingEstimated: Boolean(cost.estimated),
        };
        addEvent(session, event);
        events.push(event);
      });
    } catch (err) {
      errors.push({ file: fileInfo.path, error: err && err.message ? err.message : String(err) });
    }
    if (session.eventCount > 0) {
      applySessionIdentityToEvents(session);
      sessions.push(finalizeSession(session));
    }
  }
  return { provider: "claude", root, files: files.length, sessions, events, errors };
}

async function parseCodex(root, sinceMs) {
  const files = listJsonlFiles(root);
  const sessionNames = readCodexSessionIndex(root);
  const sessions = [];
  const events = [];
  const errors = [];
  for (const fileInfo of files) {
    if (sinceMs && fileInfo.mtimeMs && fileInfo.mtimeMs < sinceMs - 7 * 86400000) continue;
    const session = createSession("codex", fileInfo, root);
    let previousTotalUsage = null;
    let turnIndex = 0;
    try {
      await readJsonLines(fileInfo.path, (record) => {
        const timestampMs = parseTimestampMs(record.timestamp, fileInfo.mtimeMs || Date.now());
        session.startMs = session.startMs ? Math.min(session.startMs, timestampMs) : timestampMs;
        session.endMs = Math.max(session.endMs || 0, timestampMs);

        const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
        if (record.type === "session_meta") {
          if (payload.id) {
            session.id = String(payload.id);
            const indexed = sessionNames.get(session.id);
            if (indexed) setSessionTitle(session, indexed.title, indexed.source, 5);
          }
          if (payload.agent_nickname) setSessionTitle(session, payload.agent_nickname, "Codex agent name", 2);
          if (payload.cwd) {
            session.cwd = String(payload.cwd);
            session.project = path.basename(session.cwd);
          }
          if (payload.model) session.model = String(payload.model);
          return;
        }

        if (record.type === "turn_context") {
          if (payload.cwd) {
            session.cwd = String(payload.cwd);
            session.project = path.basename(session.cwd);
          }
          if (payload.model) session.model = String(payload.model);
          return;
        }

        if (record.type !== "event_msg" || payload.type !== "token_count") return;
        const info = payload.info && typeof payload.info === "object" ? payload.info : {};
        let tokens = null;
        if (info.last_token_usage) {
          tokens = normalizeCodexUsage(info.last_token_usage);
        } else if (info.total_token_usage) {
          tokens = diffCodexTotals(info.total_token_usage, previousTotalUsage);
        }
        if (info.total_token_usage) previousTotalUsage = info.total_token_usage;
        if (!tokens || tokenTotal(tokens) <= 0) return;

        turnIndex += 1;
        const model = String(info.model || payload.model || session.model || "unknown");
        const cost = estimateCost("codex", model, tokens);
        const event = {
          provider: "codex",
          id: `${session.id}:${turnIndex}`,
          sessionId: session.id,
          turnIndex,
          file: session.relativeFile,
          project: session.project,
          cwd: session.cwd,
          model,
          timestampMs,
          timestamp: new Date(timestampMs).toISOString(),
          date: localDateKey(timestampMs),
          hour: localHourKey(timestampMs),
          tokens,
          totalTokens: tokenTotal(tokens),
          costUsd: cost.usd,
          costKnown: cost.known,
          pricingLabel: cost.label,
          pricingEstimated: Boolean(cost.estimated),
        };
        addEvent(session, event);
        events.push(event);
      });
    } catch (err) {
      errors.push({ file: fileInfo.path, error: err && err.message ? err.message : String(err) });
    }
    if (session.eventCount > 0) {
      for (const event of session.events) {
        if (!event.model || event.model === "unknown") event.model = session.model || "unknown";
      }
      applySessionIdentityToEvents(session);
      sessions.push(finalizeSession(session));
    }
  }
  return { provider: "codex", root, files: files.length, sessions, events, errors };
}

function finalizeSession(session) {
  const tokens = session.tokens;
  const durationMs = Math.max(0, (session.endMs || 0) - (session.startMs || 0));
  const identity = getSessionIdentity(session);
  return {
    provider: session.provider,
    id: session.id,
    file: session.relativeFile,
    project: session.project || "",
    cwd: session.cwd || "",
    model: session.model || "unknown",
    title: identity.title,
    displayName: identity.displayName,
    nameSource: identity.nameSource,
    startMs: session.startMs || 0,
    endMs: session.endMs || 0,
    start: session.startMs ? new Date(session.startMs).toISOString() : "",
    end: session.endMs ? new Date(session.endMs).toISOString() : "",
    durationMinutes: durationMs / 60000,
    eventCount: session.eventCount,
    messageCount: session.messageCount,
    tokens,
    totalTokens: tokenTotal(tokens),
    cacheHitRatio: cacheHitRatio(tokens),
    costUsd: session.costUsd,
    knownCostUsd: session.knownCostUsd,
    unknownCostTokens: session.unknownCostTokens,
    pricingLabels: Array.from(session.pricingLabels).sort(),
  };
}

function addGroup(map, key, base) {
  if (!map.has(key)) {
    map.set(key, Object.assign({
      costUsd: 0,
      knownCostUsd: 0,
      unknownCostTokens: 0,
      eventCount: 0,
      tokens: emptyTokens(),
      totalTokens: 0,
    }, base || {}));
  }
  return map.get(key);
}

function includeProvider(providerFilter, provider) {
  return providerFilter === "all" || providerFilter === provider;
}

function compactEvent(event) {
  return {
    provider: event.provider,
    sessionId: event.sessionId,
    turnIndex: event.turnIndex,
    file: event.file,
    project: event.project,
    cwd: event.cwd,
    title: event.title || "",
    displayName: event.displayName || "",
    nameSource: event.nameSource || "",
    model: event.model,
    timestamp: event.timestamp,
    timestampMs: event.timestampMs,
    totalTokens: event.totalTokens,
    tokens: event.tokens,
    costUsd: event.costUsd,
    costKnown: event.costKnown,
    pricingLabel: event.pricingLabel,
    pricingEstimated: event.pricingEstimated,
    recommendation: buildTurnRecommendation(event),
  };
}

function buildSummary(parsed, options) {
  const nowMs = Date.now();
  const days = Math.max(1, Number(options.days || DEFAULT_DAYS));
  const sinceMs = nowMs - days * 86400000;
  const providerFilter = String(options.provider || "all").toLowerCase();
  const allEvents = [];
  const allSessions = [];
  const totals = {
    costUsd: 0,
    knownCostUsd: 0,
    unknownCostTokens: 0,
    eventCount: 0,
    sessionCount: 0,
    tokens: emptyTokens(),
    totalTokens: 0,
  };
  const windows = {
    lastHour: makeWindowTotal(),
    last5h: makeWindowTotal(),
    today: makeWindowTotal(),
    last24h: makeWindowTotal(),
    last7d: makeWindowTotal(),
    selectedRange: makeWindowTotal(),
  };
  const providerMap = new Map();
  const modelMap = new Map();
  const dayMap = new Map();
  const hourMap = new Map();
  const sessionMap = new Map();
  const fiveHourSessionMap = new Map();
  const weeklySessionMap = new Map();
  const planWindowStats = createPlanWindowStats();

  for (const source of parsed) {
    for (const event of source.events) {
      if (!includeProvider(providerFilter, event.provider)) continue;

      const sessionKey = `${event.provider}:${event.sessionId}:${event.file}`;
      const inLastHour = event.timestampMs >= nowMs - 3600000;
      const inLast5h = event.timestampMs >= nowMs - 5 * 3600000;
      const inLast24h = event.timestampMs >= nowMs - 86400000;
      const inLast7d = event.timestampMs >= nowMs - 7 * 86400000;

      if (inLastHour) {
        addWindowTotal(windows.lastHour, event);
        addProviderPlanWindow(planWindowStats, event, "lastHour");
      }
      if (inLast5h) {
        addWindowTotal(windows.last5h, event);
        addProviderPlanWindow(planWindowStats, event, "last5h");
        addEventToRangeSession(addRangeSession(fiveHourSessionMap, sessionKey, event), event);
      }
      if (inLast24h) addWindowTotal(windows.last24h, event);
      if (inLast7d) {
        addWindowTotal(windows.last7d, event);
        addProviderPlanWindow(planWindowStats, event, "last7d");
        addEventToRangeSession(addRangeSession(weeklySessionMap, sessionKey, event), event);
      }
      if (localDateKey(event.timestampMs) === localDateKey(nowMs)) addWindowTotal(windows.today, event);

      if (event.timestampMs < sinceMs) continue;
      allEvents.push(event);
      addWindowTotal(totals, event);
      addWindowTotal(windows.selectedRange, event);

      const providerGroup = addGroup(providerMap, event.provider, { provider: event.provider });
      addWindowTotal(providerGroup, event);

      const modelKey = `${event.provider}:${event.model || "unknown"}`;
      const modelGroup = addGroup(modelMap, modelKey, { provider: event.provider, model: event.model || "unknown" });
      addWindowTotal(modelGroup, event);

      const dayKey = `${event.date}:${event.provider}`;
      const dayGroup = addGroup(dayMap, dayKey, { date: event.date, provider: event.provider });
      addWindowTotal(dayGroup, event);

      const hourKey = `${event.hour}:${event.provider}`;
      const hourGroup = addGroup(hourMap, hourKey, { hour: event.hour, provider: event.provider });
      addWindowTotal(hourGroup, event);

      const sessionGroup = addRangeSession(sessionMap, sessionKey, event);
      addEventToRangeSession(sessionGroup, event);
    }
  }

  allSessions.push(...Array.from(sessionMap.values()));
  totals.sessionCount = allSessions.length;
  totals.totalTokens = tokenTotal(totals.tokens);

  const providerTotals = Array.from(providerMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  const modelTotals = Array.from(modelMap.values()).sort((a, b) => b.totalTokens - a.totalTokens);
  const daily = Array.from(dayMap.values()).sort((a, b) => a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider));
  const hourly = Array.from(hourMap.values()).sort((a, b) => a.hour.localeCompare(b.hour) || a.provider.localeCompare(b.provider));
  const topEvents = allEvents
    .slice()
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, MAX_TOP_EVENTS)
    .map(compactEvent);
  const topSessions = allSessions
    .slice()
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, MAX_TOP_SESSIONS)
    .map(stripRangeSession);
  for (const session of topSessions) {
    session.recommendation = buildSessionRecommendation(session, totals);
  }

  const budgetPace = buildBudgetPace(windows);
  const weeklyPace = budgetPace.weekly;
  const planPace = buildPlanPace(planWindowStats, options);
  const budgetSessions = buildBudgetSessions(fiveHourSessionMap, weeklySessionMap, budgetPace);
  const insightContext = { totals, windows, providerTotals, modelTotals, topSessions, topEvents, weeklyPace, budgetPace, budgetSessions, planPace };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    range: { days, since: new Date(sinceMs).toISOString(), provider: providerFilter },
    roots: {
      claude: parsed.find((source) => source.provider === "claude"),
      codex: parsed.find((source) => source.provider === "codex"),
    },
    totals,
    windows,
    providerTotals,
    modelTotals,
    daily,
    hourly,
    topSessions,
    topEvents,
    budgetPace,
    planPace,
    weeklyPace,
    budgetSessions,
    promptGuidance: buildPromptGuidance(insightContext),
    insights: buildInsights(insightContext),
    recommendations: buildRecommendations(insightContext),
    pricingNotice: "Costs and plan token budgets are estimates from local logs, not provider invoices or official subscription counters. Claude/Codex publish message windows, not fixed token caps; set env budgets for exact local targets.",
  };
}

function addRangeSession(map, key, event) {
  if (!map.has(key)) {
    map.set(key, {
      provider: event.provider,
      id: event.sessionId,
      file: event.file,
      project: event.project || "",
      cwd: event.cwd || "",
      title: event.title || "",
      displayName: event.displayName || event.title || "",
      nameSource: event.nameSource || "",
      model: event.model || "unknown",
      startMs: event.timestampMs,
      endMs: event.timestampMs,
      start: event.timestamp,
      end: event.timestamp,
      durationMinutes: 0,
      eventCount: 0,
      messageCount: 0,
      tokens: emptyTokens(),
      totalTokens: 0,
      cacheHitRatio: 0,
      costUsd: 0,
      knownCostUsd: 0,
      unknownCostTokens: 0,
      pricingLabels: [],
      _pricingLabels: new Set(),
    });
  }
  return map.get(key);
}

function addEventToRangeSession(session, event) {
  session.startMs = Math.min(session.startMs, event.timestampMs);
  session.endMs = Math.max(session.endMs, event.timestampMs);
  session.start = new Date(session.startMs).toISOString();
  session.end = new Date(session.endMs).toISOString();
  session.durationMinutes = Math.max(0, session.endMs - session.startMs) / 60000;
  session.eventCount += 1;
  if ((!session.model || session.model === "unknown") && event.model) session.model = event.model;
  if ((!session.title || !session.displayName) && (event.title || event.displayName)) {
    session.title = event.title || session.title || "";
    session.displayName = event.displayName || event.title || session.displayName || "";
    session.nameSource = event.nameSource || session.nameSource || "metadata";
  }
  addTokens(session.tokens, event.tokens);
  session.totalTokens = tokenTotal(session.tokens);
  session.cacheHitRatio = cacheHitRatio(session.tokens);
  session.costUsd += event.costUsd;
  if (event.costKnown) {
    session.knownCostUsd += event.costUsd;
  } else {
    session.unknownCostTokens += event.totalTokens;
  }
  if (event.pricingLabel) {
    session._pricingLabels.add(event.pricingLabel);
    session.pricingLabels = Array.from(session._pricingLabels).sort();
  }
}

function stripRangeSession(session) {
  const copy = Object.assign({}, session);
  delete copy._pricingLabels;
  return copy;
}

function makeWindowTotal() {
  return {
    costUsd: 0,
    knownCostUsd: 0,
    unknownCostTokens: 0,
    eventCount: 0,
    sessionCount: 0,
    tokens: emptyTokens(),
    totalTokens: 0,
  };
}

function addWindowTotal(target, event) {
  target.costUsd += numberValue(event.costUsd);
  if (event.costKnown) {
    target.knownCostUsd += numberValue(event.costUsd);
  } else {
    target.unknownCostTokens += event.totalTokens;
  }
  target.eventCount += 1;
  addTokens(target.tokens, event.tokens);
  target.totalTokens = tokenTotal(target.tokens);
}

function createPlanWindowStats() {
  return {
    claude: createProviderPlanWindowStats("claude"),
    codex: createProviderPlanWindowStats("codex"),
  };
}

function createProviderPlanWindowStats(provider) {
  return {
    provider,
    lastHour: makeWindowTotal(),
    last5h: makeWindowTotal(),
    last7d: makeWindowTotal(),
    modelHour: new Map(),
    model5h: new Map(),
    model7d: new Map(),
  };
}

function addProviderPlanWindow(stats, event, windowName) {
  const providerStats = stats[event.provider] || (stats[event.provider] = createProviderPlanWindowStats(event.provider));
  const total = providerStats[windowName];
  if (!total) return;
  addWindowTotal(total, event);

  const modelMap = windowName === "lastHour" ? providerStats.modelHour : windowName === "last5h" ? providerStats.model5h : providerStats.model7d;
  const model = event.model || "unknown";
  const modelGroup = addGroup(modelMap, model, { provider: event.provider, model });
  addWindowTotal(modelGroup, event);
}

function readBudgetTokens(names) {
  for (const name of names) {
    const value = numberValue(process.env[name]);
    if (value > 0) return value;
  }
  return 0;
}

function readFiveHourBudgetTokens() {
  return readBudgetTokens([
    "AI_SPEND_5H_TOKEN_BUDGET",
    "AI_SPEND_5H_BUDGET_TOKENS",
    "AI_SPEND_5_HOUR_TOKEN_BUDGET",
    "AI_SPEND_FIVE_HOUR_TOKEN_BUDGET",
  ]);
}

function readWeeklyBudgetTokens() {
  return readBudgetTokens([
    "AI_SPEND_WEEKLY_TOKEN_BUDGET",
    "AI_SPEND_WEEKLY_BUDGET_TOKENS",
  ]);
}

function buildBudgetPace(windows) {
  return {
    fiveHour: buildFiveHourPace(windows),
    weekly: buildWeeklyPace(windows),
  };
}

function budgetStatus({ budgetTokens, usedTokens, projectedTokens, unsetText, okText, watchText, riskText, overText }) {
  const usedRatio = budgetTokens > 0 ? usedTokens / budgetTokens : 0;
  const projectedRatio = budgetTokens > 0 ? projectedTokens / budgetTokens : 0;
  const remainingTokens = budgetTokens > 0 ? Math.max(0, budgetTokens - usedTokens) : 0;
  const projectedRemainingTokens = budgetTokens > 0 ? Math.max(0, budgetTokens - projectedTokens) : 0;
  const overageTokens = budgetTokens > 0 ? Math.max(0, usedTokens - budgetTokens) : 0;
  let status = "unset";
  let statusText = unsetText;

  if (budgetTokens > 0) {
    if (usedRatio >= 1) {
      status = "over";
      statusText = overText(overageTokens);
    } else if (projectedRatio >= 1) {
      status = "risk";
      statusText = riskText(projectedTokens);
    } else if (usedRatio >= 0.8 || projectedRatio >= 0.8) {
      status = "watch";
      statusText = watchText(remainingTokens, projectedRemainingTokens);
    } else {
      status = "ok";
      statusText = okText(remainingTokens);
    }
  }

  return {
    budgetTokens,
    usedTokens,
    projectedTokens,
    remainingTokens,
    projectedRemainingTokens,
    overageTokens,
    usedRatio,
    projectedRatio,
    status,
    statusText,
  };
}

function buildFiveHourPace(windows) {
  const budgetTokens = readFiveHourBudgetTokens();
  const last5hTokens = numberValue(windows.last5h.totalTokens);
  const lastHourTokens = numberValue(windows.lastHour.totalTokens);
  const projected5hAtHourPace = lastHourTokens * 5;
  const projected5hTokens = Math.max(last5hTokens, projected5hAtHourPace);
  const status = budgetStatus({
    budgetTokens,
    usedTokens: last5hTokens,
    projectedTokens: projected5hTokens,
    unsetText: "Set AI_SPEND_5H_TOKEN_BUDGET to compare rolling 5-hour burn with your short-window envelope.",
    okText: (remaining) => `${formatCount(remaining)} tokens remain in the rolling 5-hour envelope.`,
    watchText: (remaining) => `${formatCount(remaining)} tokens remain; current pace is close to the 5-hour envelope.`,
    riskText: (projected) => `Current hour pace projects ${formatCount(projected)} tokens across 5 hours, above the envelope.`,
    overText: (overage) => `Rolling 5-hour usage is ${formatCount(overage)} tokens over the envelope.`,
  });

  return {
    window: "5h",
    envVar: "AI_SPEND_5H_TOKEN_BUDGET",
    last5hTokens,
    lastHourTokens,
    projected5hAtHourPace,
    projected5hTokens,
    ...status,
  };
}

function buildWeeklyPace(windows) {
  const budgetTokens = readWeeklyBudgetTokens();
  const last7dTokens = numberValue(windows.last7d.totalTokens);
  const last24hTokens = numberValue(windows.last24h.totalTokens);
  const lastHourTokens = numberValue(windows.lastHour.totalTokens);
  const projected7dAt24hPace = last24hTokens * 7;
  const projected7dAtHourPace = lastHourTokens * 24 * 7;
  const projected7dTokens = Math.max(last7dTokens, projected7dAt24hPace, projected7dAtHourPace);
  const status = budgetStatus({
    budgetTokens,
    usedTokens: last7dTokens,
    projectedTokens: projected7dTokens,
    unsetText: "Set AI_SPEND_WEEKLY_TOKEN_BUDGET to compare rolling 7-day burn with your weekly envelope.",
    okText: (remaining) => `${formatCount(remaining)} tokens remain in the rolling weekly envelope.`,
    watchText: (remaining) => `${formatCount(remaining)} tokens remain; keep new work scoped.`,
    riskText: () => "Current pace projects past the weekly envelope before the week is done.",
    overText: (overage) => `Rolling 7-day usage is ${formatCount(overage)} tokens over the weekly envelope.`,
  });

  return {
    window: "weekly",
    envVar: "AI_SPEND_WEEKLY_TOKEN_BUDGET",
    budgetTokens,
    last7dTokens,
    last24hTokens,
    lastHourTokens,
    projected7dAt24hPace,
    projected7dAtHourPace,
    projected7dTokens,
    ...status,
  };
}

function buildBudgetSessionRows(map, budget, limit = 8) {
  const windowTotal = numberValue(budget.usedTokens);
  const budgetTokens = numberValue(budget.budgetTokens);
  return Array.from(map.values())
    .sort((a, b) => b.totalTokens - a.totalTokens)
    .slice(0, limit)
    .map(stripRangeSession)
    .map((session) => ({
      ...session,
      shareOfWindow: windowTotal > 0 ? session.totalTokens / windowTotal : 0,
      shareOfBudget: budgetTokens > 0 ? session.totalTokens / budgetTokens : 0,
      remainingAfterSessionTokens: budgetTokens > 0 ? Math.max(0, budgetTokens - session.totalTokens) : 0,
    }));
}

function buildBudgetSessions(fiveHourSessionMap, weeklySessionMap, budgetPace) {
  return {
    fiveHour: buildBudgetSessionRows(fiveHourSessionMap, budgetPace.fiveHour),
    weekly: buildBudgetSessionRows(weeklySessionMap, budgetPace.weekly),
  };
}

function buildPlanPace(stats, options) {
  const claudePlan = resolvePlanId("claude", options.claudePlan);
  const codexPlan = resolvePlanId("codex", options.codexPlan);
  return {
    selected: {
      claude: claudePlan,
      codex: codexPlan,
    },
    presets: {
      claude: planOptions("claude"),
      codex: planOptions("codex"),
    },
    claude: buildProviderPlanPace("claude", claudePlan, stats.claude || createProviderPlanWindowStats("claude")),
    codex: buildProviderPlanPace("codex", codexPlan, stats.codex || createProviderPlanWindowStats("codex")),
  };
}

function resolvePlanId(provider, requested) {
  const envName = provider === "claude" ? "AI_SPEND_CLAUDE_PLAN" : "AI_SPEND_CODEX_PLAN";
  const value = String(requested || process.env[envName] || "custom").toLowerCase();
  return PLAN_PRESETS[provider] && PLAN_PRESETS[provider][value] ? value : "custom";
}

function planOptions(provider) {
  return Object.entries(PLAN_PRESETS[provider] || {}).map(([id, preset]) => ({
    id,
    label: preset.label,
    detail: preset.detail || "",
  }));
}

function buildProviderPlanPace(provider, planId, providerStats) {
  const preset = PLAN_PRESETS[provider][planId] || PLAN_PRESETS[provider].custom;
  const last5h = providerStats.last5h || makeWindowTotal();
  const last7d = providerStats.last7d || makeWindowTotal();
  const lastHour = providerStats.lastHour || makeWindowTotal();
  const dominantModel = dominantModelRow(providerStats.model5h) || dominantModelRow(providerStats.model7d);
  const modelKey = provider === "codex" ? codexModelLimitKey(dominantModel ? dominantModel.model : "") : "";
  const messageRange = provider === "claude" ? preset.fiveHourMessages : preset.modelMessages ? preset.modelMessages[modelKey] : null;
  const fallbackAverage = last7d.eventCount > 0 ? last7d.totalTokens / last7d.eventCount : 0;
  const averageTokensPerTurn = last5h.eventCount > 0 ? last5h.totalTokens / last5h.eventCount : fallbackAverage;
  const minBudgetTokens = messageRange && averageTokensPerTurn > 0 ? Math.round(messageRange.min * averageTokensPerTurn) : 0;
  const maxBudgetTokens = messageRange && averageTokensPerTurn > 0 ? Math.round((messageRange.max || messageRange.min) * averageTokensPerTurn) : 0;
  const projected5hTokens = Math.max(last5h.totalTokens, lastHour.totalTokens * 5);
  const status = planLimitStatus(last5h.totalTokens, projected5hTokens, minBudgetTokens, maxBudgetTokens);

  return {
    provider,
    planId,
    label: preset.label,
    detail: preset.detail || "",
    source: preset.source || "",
    promoUntil: preset.promoUntil || "",
    dominantModel: dominantModel ? dominantModel.model : "",
    modelLimitKey: modelKey,
    messageRange: messageRange || null,
    averageTokensPerTurn,
    lastHourTokens: lastHour.totalTokens,
    usedTokens: last5h.totalTokens,
    weeklyUsedTokens: last7d.totalTokens,
    estimatedFiveHourTokenBudgetMin: minBudgetTokens,
    estimatedFiveHourTokenBudgetMax: maxBudgetTokens,
    remainingTokensMin: minBudgetTokens > 0 ? Math.max(0, minBudgetTokens - last5h.totalTokens) : 0,
    remainingTokensMax: maxBudgetTokens > 0 ? Math.max(0, maxBudgetTokens - last5h.totalTokens) : 0,
    projected5hTokens,
    weeklyNote: preset.weeklyNote || "No numeric weekly token limit is published for this preset.",
    status: status.status,
    statusText: status.statusText,
  };
}

function dominantModelRow(modelMap) {
  const rows = Array.from((modelMap || new Map()).values());
  return rows.sort((a, b) => b.totalTokens - a.totalTokens)[0] || null;
}

function codexModelLimitKey(model) {
  const value = String(model || "");
  if (/^gpt-5\.4-mini/i.test(value)) return "gpt54mini";
  if (/^gpt-5\.4/i.test(value)) return "gpt54";
  if (/^gpt-5\.3-codex/i.test(value)) return "gpt53codex";
  if (/^gpt-5\.5/i.test(value)) return "gpt55";
  if (/codex/i.test(value)) return "gpt53codex";
  return "gpt55";
}

function planLimitStatus(usedTokens, projectedTokens, minBudgetTokens, maxBudgetTokens) {
  if (minBudgetTokens <= 0) {
    return {
      status: "unset",
      statusText: "No plan token estimate is available yet. Pick a plan and generate some local usage, or set custom budget env vars.",
    };
  }
  const upper = maxBudgetTokens || minBudgetTokens;
  if (usedTokens >= upper) {
    return {
      status: "over",
      statusText: `Observed 5-hour usage is over the upper estimated plan range by ${formatCount(usedTokens - upper)} tokens.`,
    };
  }
  if (usedTokens >= minBudgetTokens) {
    return {
      status: "risk",
      statusText: `Observed 5-hour usage is already inside the plan's published range; heavy turns may hit the cap before reset.`,
    };
  }
  if (projectedTokens >= upper) {
    return {
      status: "risk",
      statusText: `Current hour pace projects over the upper estimated plan range before the 5-hour window ends.`,
    };
  }
  if (projectedTokens >= minBudgetTokens || usedTokens >= minBudgetTokens * 0.8) {
    return {
      status: "watch",
      statusText: `Current usage is close to the lower estimated plan range.`,
    };
  }
  return {
    status: "ok",
    statusText: `Current 5-hour usage is below the estimated plan range.`,
  };
}

function providerDisplay(provider) {
  if (provider === "claude") return "Claude Code";
  if (provider === "codex") return "Codex CLI";
  return sanitizeSessionTitle(provider || "AI CLI");
}

function sessionDisplayName(session) {
  return sanitizeSessionTitle(
    session.displayName
      || session.title
      || session.project
      || session.id
      || session.sessionId
      || "Unknown session",
    88,
  );
}

function contextTokenRatio(tokens) {
  const inputLike = numberValue(tokens.inputTokens)
    + numberValue(tokens.cachedInputTokens)
    + numberValue(tokens.cacheCreationInputTokens)
    + numberValue(tokens.cacheCreation1hInputTokens)
    + numberValue(tokens.cacheReadInputTokens);
  const total = tokenTotal(tokens);
  return total > 0 ? inputLike / total : 0;
}

function sumModelTokens(modelTotals, pattern) {
  return (modelTotals || []).reduce((sum, row) => (
    pattern.test(String(row.model || "")) ? sum + numberValue(row.totalTokens) : sum
  ), 0);
}

function buildPromptGuidance(summary) {
  const totalTokens = numberValue(summary.totals.totalTokens);
  const gpt55Tokens = sumModelTokens(summary.modelTotals, /^gpt-5\.5/i);
  const gpt55Share = totalTokens > 0 ? gpt55Tokens / totalTokens : 0;
  const last24 = summary.windows.last24h;
  const lastHour = summary.windows.lastHour;
  const hourSpike = lastHour.totalTokens > 0 && last24.totalTokens > 0 && lastHour.totalTokens > (last24.totalTokens / 24) * 2.5;
  const pace = summary.weeklyPace || {};
  const fiveHour = summary.budgetPace && summary.budgetPace.fiveHour ? summary.budgetPace.fiveHour : {};
  const fiveHourPressure = fiveHour.status === "risk" || fiveHour.status === "over";

  return [
    {
      severity: gpt55Share >= 0.35 ? "high" : "info",
      title: "Use GPT-5.5 for planning gates",
      target: gpt55Tokens > 0 ? `${formatCount(gpt55Tokens)} GPT-5.5 tokens` : "Model routing",
      detail: "Spend frontier reasoning on ambiguity: goal, risks, write set, acceptance criteria, and review. Move execution to Codex once the path is clear.",
      doNow: [
        "Ask for the plan and success criteria first.",
        "Hand Codex exact files, tests, and allowed side effects for the implementation pass.",
      ],
    },
    {
      severity: hourSpike || fiveHourPressure ? "high" : "info",
      title: "Do not use /fast for discovery",
      target: fiveHour.budgetTokens > 0 ? `${formatCount(fiveHour.remainingTokens)} 5h remaining` : hourSpike ? "Last-hour spike" : "Fast mode",
      detail: "/fast is best after the write set is known. During exploration it can burn through many more turns before the scope is stable.",
      doNow: [
        "Use /fast for bounded edits, formatting, and small test loops.",
        "Turn it off for repo-wide search, architecture tradeoffs, and unclear debugging.",
      ],
    },
    {
      severity: "info",
      title: "Start with low or medium effort",
      target: "Reasoning effort",
      detail: "Treat higher effort as a measured escalation. It is not automatically better when instructions conflict or the task is open-ended.",
      doNow: [
        "Use low or medium for scoped implementation.",
        "Use high or xhigh only for hard planning, review, or async tasks where quality improves enough to justify the burn.",
      ],
    },
    {
      severity: fiveHourPressure ? "high" : "info",
      title: "Protect the 5h window",
      target: fiveHour.budgetTokens > 0 ? `${formatCount(fiveHour.usedTokens)} of ${formatCount(fiveHour.budgetTokens)}` : "5h budget",
      detail: fiveHour.statusText || "Set a 5-hour envelope to catch short burst limits before the weekly chart moves.",
      doNow: [
        "Treat the 5-hour remaining number as the fast-mode guardrail.",
        "When it is low, finish the current scoped edit or checkpoint and pause broad discovery.",
      ],
    },
    {
      severity: pace.status === "risk" || pace.status === "over" ? "high" : "info",
      title: "Pace the weekly envelope",
      target: pace.budgetTokens > 0 ? `${formatCount(pace.last7dTokens)} of ${formatCount(pace.budgetTokens)}` : "Weekly budget",
      detail: pace.statusText || "Track projected runout, not just total spend.",
      doNow: [
        "Watch last-hour pace against the rolling 7-day envelope.",
        "If projected use crosses the envelope, summarize, narrow, or lower effort before continuing.",
      ],
    },
  ];
}

function quotePowerShellPath(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `'${text.replace(/'/g, "''")}'`;
}

function launchCommandForSession(session) {
  const tool = session.provider === "claude" ? "claude" : session.provider === "codex" ? "codex" : "";
  if (!tool) return "";
  const cwd = quotePowerShellPath(session.cwd);
  return cwd ? `cd ${cwd}; ${tool}` : tool;
}

function targetCliWindow(session) {
  const cwd = sanitizeSessionTitle(session.cwd || session.project || "", 120);
  const suffix = cwd ? ` in ${cwd}` : "";
  return `${providerDisplay(session.provider)} window for "${sessionDisplayName(session)}"${suffix}`;
}

function handoffPrompt(session) {
  return [
    `Summarize this ${providerDisplay(session.provider)} session so I can restart cleanly.`,
    "Include: current goal, files touched, commands/tests run, decisions made, blockers, and the next 3 actions.",
    "Keep it compact and do not restate old conversation history.",
  ].join(" ");
}

function scopePrompt(session) {
  if (session.provider === "codex") {
    return "Before editing, inspect only the files needed for the next step and tell me the smallest safe write set. Do not sweep the whole repo unless I ask.";
  }
  return "Before continuing, ask me for the exact files, screenshots, or failing command output you need. Do not keep pulling the whole prior thread forward.";
}

function buildSessionRecommendation(session, totals) {
  const totalTokens = tokenTotal(session.tokens);
  const share = totals && totals.totalTokens > 0 ? totalTokens / totals.totalTokens : 0;
  const cacheRatio = cacheHitRatio(session.tokens);
  const contextRatio = contextTokenRatio(session.tokens);
  const durationMinutes = numberValue(session.durationMinutes);
  const name = sessionDisplayName(session);
  const launch = launchCommandForSession(session);
  const restartCli = session.provider === "claude"
    ? "After the summary, type /clear in that Claude Code window or close the terminal and start a new Claude session."
    : "After the handoff, close that Codex CLI tab/window and start a new Codex session for the next task.";

  if (share >= 0.25 || (durationMinutes >= 240 && totalTokens >= 100000)) {
    return {
      label: "Summarize and restart",
      severity: "high",
      detail: `"${name}" is ${Math.round(share * 100)}% of the selected range and has been active for ${formatDurationMinutes(durationMinutes)}.`,
      ask: handoffPrompt(session),
      cli: [
        `Target: ${targetCliWindow(session)}`,
        restartCli,
        launch,
      ].filter(Boolean),
    };
  }

  if (cacheRatio < 0.2 && totalTokens >= 10000) {
    return {
      label: "Narrow context first",
      severity: "high",
      detail: `Only ${Math.round(cacheRatio * 100)}% cache reuse. The next broad ask will likely burn fresh input tokens again.`,
      ask: scopePrompt(session),
      cli: [
        `Target: ${targetCliWindow(session)}`,
        "Run a local search first, then paste only the relevant files or errors.",
        'rg -n "<symbol-or-error>" .',
      ],
    };
  }

  if (session.provider === "claude" && contextRatio >= 0.9 && totalTokens >= 10000) {
    return {
      label: "Clear stale context",
      severity: "high",
      detail: "Most of the burn is context. Keep the decisions, not the whole conversation.",
      ask: handoffPrompt(session),
      cli: [
        `Target: ${targetCliWindow(session)}`,
        "Type /clear after saving the handoff, then continue with the compact summary only.",
        launch,
      ].filter(Boolean),
    };
  }

  if (session.provider === "codex" && durationMinutes >= 180) {
    return {
      label: "Checkpoint the Codex run",
      severity: "info",
      detail: `This Codex session has run for ${formatDurationMinutes(durationMinutes)}. Long agent runs should leave a compact handoff before the next task.`,
      ask: "List changed files, tests run, current blockers, and the smallest next task. Do not continue into a new feature without my approval.",
      cli: [
        `Target: ${targetCliWindow(session)}`,
        "Close this Codex window after the checkpoint if it is not actively working.",
        launch,
      ].filter(Boolean),
    };
  }

  return {
    label: "Keep scoped",
    severity: "info",
    detail: "This session is not the main limit driver in the selected range. Keep the next ask narrow.",
    ask: scopePrompt(session),
    cli: [
      `Target: ${targetCliWindow(session)}`,
      "Keep one terminal window per task and close stale duplicates.",
    ],
  };
}

function buildTurnRecommendation(event) {
  const total = numberValue(event.totalTokens);
  const tokens = event.tokens || emptyTokens();
  const contextRatio = contextTokenRatio(tokens);
  const cached = numberValue(tokens.cachedInputTokens) + numberValue(tokens.cacheReadInputTokens);
  const inputLike = numberValue(tokens.inputTokens)
    + numberValue(tokens.cachedInputTokens)
    + numberValue(tokens.cacheCreationInputTokens)
    + numberValue(tokens.cacheCreation1hInputTokens)
    + numberValue(tokens.cacheReadInputTokens);

  if (total >= 1000000 || contextRatio >= 0.9) {
    return {
      label: "Break into smaller asks",
      detail: "Ask for a file list or plan first, then run the edit/review in a second turn.",
      ask: "First identify the 5-10 files or decisions that matter. Do not analyze the whole repo yet.",
      cli: [
        'rg -n "<symbol-or-error>" .',
        "Paste the narrowed file list into the next agent turn.",
      ],
    };
  }

  if (inputLike > 0 && cached / inputLike < 0.2 && total >= 10000) {
    return {
      label: "Avoid fresh-context repeat",
      detail: "This turn did not reuse much cache. Repeating it broadly will spend again.",
      ask: "Before continuing, tell me exactly what context you still need and which files can be ignored.",
      cli: [
        "Start a fresh task with only the relevant files, command output, and desired result.",
      ],
    };
  }

  return {
    label: "Use as spike clue",
    detail: "If this turn caused the limit event, reduce the next prompt to one subsystem or one failing command.",
    ask: "Restate the next step as a narrow task with explicit files and acceptance criteria.",
    cli: [],
  };
}

function buildRecommendations(summary) {
  const recommendations = [];
  const used = new Set();
  const topSession = summary.topSessions[0];
  const topEvent = summary.topEvents[0];
  const claude = summary.providerTotals.find((item) => item.provider === "claude");
  const codex = summary.providerTotals.find((item) => item.provider === "codex");
  const last24 = summary.windows.last24h;
  const lastHour = summary.windows.lastHour;
  const weeklyPace = summary.weeklyPace || {};
  const fiveHourPace = summary.budgetPace && summary.budgetPace.fiveHour ? summary.budgetPace.fiveHour : {};
  const topFiveHourSession = summary.budgetSessions && summary.budgetSessions.fiveHour ? summary.budgetSessions.fiveHour[0] : null;
  const gpt55Tokens = sumModelTokens(summary.modelTotals, /^gpt-5\.5/i);
  const gpt55Share = summary.totals.totalTokens > 0 ? gpt55Tokens / summary.totals.totalTokens : 0;
  const recentCutoffMs = Date.now() - 2 * 3600000;

  function push(key, item) {
    if (!item || used.has(key)) return;
    used.add(key);
    recommendations.push(item);
  }

  if (fiveHourPace.status === "risk" || fiveHourPace.status === "over") {
    push("five-hour-pace", {
      severity: "high",
      title: "Stop the 5h drain",
      target: fiveHourPace.budgetTokens > 0 ? `${formatCount(fiveHourPace.remainingTokens)} tokens remaining` : "5h envelope",
      reason: fiveHourPace.statusText,
      doNow: [
        "Pause /fast and broad discovery until the rolling 5-hour pressure drops.",
        "Finish only the current bounded edit, then checkpoint the session.",
        topFiveHourSession ? `Inspect "${sessionDisplayName(topFiveHourSession)}" first; it is the top 5-hour burner.` : "Open Budget By Session and inspect the top 5-hour burner first.",
      ],
      ask: "Give me a checkpoint and the one smallest next action. Do not keep searching or editing until I approve continuing this session.",
      cli: [
        topFiveHourSession ? `Target: ${targetCliWindow(topFiveHourSession)}` : "",
        topFiveHourSession ? launchCommandForSession(topFiveHourSession) : "",
      ].filter(Boolean),
    });
  }

  if (weeklyPace.status === "risk" || weeklyPace.status === "over") {
    push("weekly-pace", {
      severity: "high",
      title: "Slow the weekly burn",
      target: weeklyPace.budgetTokens > 0 ? `${formatCount(weeklyPace.remainingTokens)} tokens remaining` : "Weekly envelope",
      reason: weeklyPace.statusText,
      doNow: [
        "Stop open-ended fast-mode work until the next task is bounded.",
        "Summarize active sessions and continue only with the file list, failing command, and acceptance criteria.",
        "Use low or medium effort for scoped execution; reserve high effort for planning or review.",
      ],
      ask: "Before continuing, give me the smallest next action, the exact files involved, and the acceptance test. Do not scan more context unless I approve it.",
      cli: [
        'rg -n "<error-or-symbol>" .',
        "Run only the specific failing command or test target.",
      ],
    });
  }

  if (topSession) {
    const action = topSession.recommendation || buildSessionRecommendation(topSession, summary.totals);
    push(`session:${topSession.provider}:${topSession.id}:${topSession.file}`, {
      severity: action.severity,
      title: action.label,
      target: targetCliWindow(topSession),
      reason: action.detail,
      doNow: [
        "Save a compact handoff before doing more work in this session.",
        topSession.provider === "claude" ? "Use /clear or start a fresh Claude Code window after the handoff." : "Close this Codex CLI window after the handoff if the task is done or stale.",
      ],
      ask: action.ask,
      cli: action.cli,
    });
  }

  const recentSessions = summary.topSessions.filter((session) => session.endMs >= recentCutoffMs);
  if (recentSessions.length >= 2) {
    const names = recentSessions.slice(0, 4).map((session) => `${providerDisplay(session.provider)}: ${sessionDisplayName(session)}`).join("; ");
    push("recent-sessions", {
      severity: "high",
      title: "Close duplicate active agents",
      target: `${recentSessions.length} sessions had log activity in the last 2 hours`,
      reason: "Parallel stale terminals can keep adding turns, miss cache, and make it unclear which agent is burning tokens.",
      doNow: [
        `Check these windows first: ${names}.`,
        "Keep the one doing active useful work; close or Ctrl+C the others.",
        "Before closing, ask each uncertain session for a 6-bullet checkpoint.",
      ],
      ask: "Give me a checkpoint only: current task, files changed, command currently running, blockers, and whether this session should be closed.",
      cli: [
        "In stale Claude Code windows: ask for the checkpoint, then type /clear or close the tab.",
        "In stale Codex CLI windows: ask for the checkpoint, then Ctrl+C or close the terminal tab.",
      ],
    });
  }

  if (lastHour.totalTokens > 0 && last24.totalTokens > 0 && lastHour.totalTokens > (last24.totalTokens / 24) * 2.5) {
    push("hour-spike", {
      severity: "high",
      title: "Pause the current spike",
      target: "Last-hour usage",
      reason: `The last hour used ${formatCount(lastHour.totalTokens)} tokens, above the 24 hour average pace.`,
      doNow: [
        "Stop broad follow-up prompts until you know which session caused the spike.",
        "Open Largest Turns, find the matching session, and split the next ask by file group or failing command.",
        "Do not use /fast again until the write set and acceptance test are explicit.",
      ],
      ask: "Before continuing, propose a smaller next step that uses the fewest files, names the acceptance test, and avoids re-reading old context.",
      cli: [
        'rg -n "<error-or-symbol>" .',
        "Paste only the relevant output into the next Claude/Codex turn.",
      ],
    });
  }

  const lowCacheSession = summary.topSessions
    .filter((session) => session.totalTokens >= 10000 && cacheHitRatio(session.tokens) < 0.2)
    .sort((a, b) => b.totalTokens - a.totalTokens)[0];
  if (lowCacheSession) {
    push(`low-cache:${lowCacheSession.provider}:${lowCacheSession.id}:${lowCacheSession.file}`, {
      severity: "high",
      title: "Stop repeating uncached context",
      target: targetCliWindow(lowCacheSession),
      reason: `"${sessionDisplayName(lowCacheSession)}" has ${Math.round(cacheHitRatio(lowCacheSession.tokens) * 100)}% cache reuse in this range.`,
      doNow: [
        "Do a local search or file list first.",
        "Ask the agent to work only from that narrowed context.",
        "If the task changed, start a fresh session instead of dragging old context forward.",
      ],
      ask: scopePrompt(lowCacheSession),
      cli: [
        'rg -n "<symbol-or-error>" .',
        launchCommandForSession(lowCacheSession),
      ].filter(Boolean),
    });
  }

  if (claude && summary.totals.totalTokens > 0 && claude.totalTokens / summary.totals.totalTokens >= 0.65) {
    push("route-claude", {
      severity: "info",
      title: "Route mechanical sweeps to Codex",
      target: "Provider split",
      reason: `Claude is ${Math.round((claude.totalTokens / summary.totals.totalTokens) * 100)}% of selected tokens.`,
      doNow: [
        "Use Codex for repo search, mechanical edits, and test-loop fixes.",
        "Bring Claude the narrowed result for architecture, UX, or review decisions.",
      ],
      ask: "Codex: inspect the repo for this exact issue, return the relevant files and a minimal patch plan, and do not edit until I approve the write set.",
      cli: [
        "codex",
        "claude",
      ],
    });
  }

  if (gpt55Share >= 0.35) {
    push("route-gpt55", {
      severity: "info",
      title: "Move from planning to execution",
      target: `${formatCount(gpt55Tokens)} GPT-5.5 tokens in this range`,
      reason: "GPT-5.5 is best spent on ambiguous planning, tradeoffs, and review. Once scope is clear, keep the edit loop in Codex with a bounded prompt.",
      doNow: [
        "Ask GPT-5.5 for the write set, risks, and acceptance criteria.",
        "Execute with GPT-5.3 Codex using low or medium effort unless the task stays ambiguous.",
        "Bring the completed diff back for review only if the decision quality matters.",
      ],
      ask: "Plan only: identify the exact files, success criteria, risks, and test command. Do not implement in this turn.",
      cli: [
        "codex",
        "Use a scoped Codex prompt with exact files and tests.",
      ],
    });
  }

  if (topEvent) {
    push(`turn:${topEvent.provider}:${topEvent.sessionId}:${topEvent.turnIndex}`, {
      severity: topEvent.totalTokens >= 1000000 ? "high" : "info",
      title: topEvent.recommendation ? topEvent.recommendation.label : "Reduce the largest turn",
      target: `${providerDisplay(topEvent.provider)} turn ${topEvent.turnIndex} in "${sessionDisplayName(topEvent)}"`,
      reason: `The largest turn used ${formatCount(topEvent.totalTokens)} tokens.`,
      doNow: [
        "Do not repeat that prompt shape.",
        "Ask for a plan or file list first, then run the expensive reasoning step second.",
      ],
      ask: topEvent.recommendation ? topEvent.recommendation.ask : "Restate the next step as a narrow task with explicit files and acceptance criteria.",
      cli: topEvent.recommendation ? topEvent.recommendation.cli : [],
    });
  }

  if (codex && codex.tokens && numberValue(codex.tokens.inputTokens) > 0) {
    const codexCache = numberValue(codex.tokens.cachedInputTokens) / numberValue(codex.tokens.inputTokens);
    if (codexCache < 0.35) {
      push("codex-cache", {
        severity: "info",
        title: "Make Codex tasks more repeatable",
        target: "Codex cache reuse",
        reason: `Codex cache reuse is ${Math.round(codexCache * 100)}% in this range.`,
        doNow: [
          "Keep Codex prompts deterministic: exact files, exact command, exact acceptance criteria.",
          "Avoid bouncing one Codex session between unrelated repos or feature areas.",
        ],
        ask: "Work only on this file set and this failing command. If more context is required, ask before scanning more of the repo.",
        cli: [
          "npm test",
          'rg -n "<failing-test-or-symbol>" .',
        ],
      });
    }
  }

  if (recommendations.length === 0) {
    recommendations.push({
      severity: "info",
      title: "Narrow the time window",
      target: "Selected range",
      reason: "No single obvious limit driver stands out in this range.",
      doNow: [
        "Switch to 1 day or Claude-only/Codex-only.",
        "Start with the largest session and largest turn after the range changes.",
      ],
      ask: "Given this smaller range, identify the one session I should close, clear, split, or reroute first.",
      cli: [],
    });
  }

  return recommendations.slice(0, 6);
}

function buildInsights(summary) {
  const insights = [];
  const claude = summary.providerTotals.find((item) => item.provider === "claude");
  const codex = summary.providerTotals.find((item) => item.provider === "codex");
  const topSession = summary.topSessions[0];
  const topEvent = summary.topEvents[0];
  const last24 = summary.windows.last24h;
  const lastHour = summary.windows.lastHour;

  if (claude && summary.totals.totalTokens > 0) {
    const claudeShare = claude.totalTokens / summary.totals.totalTokens;
    if (claudeShare >= 0.65) {
      insights.push({
        severity: "high",
        title: "Claude dominates this range",
        detail: `Claude accounts for ${Math.round(claudeShare * 100)}% of selected tokens. That is the first place to look for limit pressure.`,
      });
    }
  }

  if (last24.totalTokens > 0) {
    const hourlyPace = Math.round(last24.totalTokens / 24);
    insights.push({
      severity: last24.totalTokens >= 1000000 ? "high" : "info",
      title: "24 hour burn pace",
      detail: `${formatCount(last24.totalTokens)} tokens in the last 24 hours, about ${formatCount(hourlyPace)} tokens/hour on average.`,
    });
  }

  if (lastHour.totalTokens > 0 && last24.totalTokens > 0) {
    const expectedHour = last24.totalTokens / 24;
    if (lastHour.totalTokens > expectedHour * 2.5) {
      insights.push({
        severity: "high",
        title: "Current hour is spiking",
        detail: `The last hour used ${formatCount(lastHour.totalTokens)} tokens, well above the 24 hour average pace.`,
      });
    }
  }

  if (topSession && summary.totals.totalTokens > 0) {
    const share = topSession.totalTokens / summary.totals.totalTokens;
    if (share >= 0.25) {
      const name = topSession.displayName || topSession.id.slice(0, 10);
      insights.push({
        severity: "high",
        title: "One session is carrying the burn",
        detail: `${topSession.provider} session "${name}" is ${Math.round(share * 100)}% of selected tokens.`,
      });
    }
  }

  const recentCutoffMs = Date.now() - 2 * 3600000;
  const recentSessions = summary.topSessions.filter((session) => session.endMs >= recentCutoffMs);
  if (recentSessions.length >= 2) {
    const lowCache = recentSessions
      .filter((session) => session.totalTokens >= 10000 && cacheHitRatio(session.tokens) < 0.2)
      .sort((a, b) => b.totalTokens - a.totalTokens)[0];
    if (lowCache) {
      const name = lowCache.displayName || lowCache.id.slice(0, 10);
      insights.push({
        severity: "high",
        title: "Recent session without much cache",
        detail: `${recentSessions.length} sessions were active in the last 2 hours. "${name}" ran for ${formatDurationMinutes(lowCache.durationMinutes)} with ${formatCount(lowCache.totalTokens)} tokens and ${Math.round(cacheHitRatio(lowCache.tokens) * 100)}% cache reuse.`,
      });
    } else {
      insights.push({
        severity: "info",
        title: "Recently active sessions",
        detail: `${recentSessions.length} sessions had log activity in the last 2 hours. This is inferred from local logs, not live process state.`,
      });
    }
  }

  if (topEvent) {
    insights.push({
      severity: "info",
      title: "Largest single turn",
      detail: `${topEvent.provider} turn ${topEvent.turnIndex} used ${formatCount(topEvent.totalTokens)} tokens on ${topEvent.model || "unknown model"}.`,
    });
  }

  if (claude) {
    const inputLike = numberValue(claude.tokens.inputTokens)
      + numberValue(claude.tokens.cacheCreationInputTokens)
      + numberValue(claude.tokens.cacheCreation1hInputTokens)
      + numberValue(claude.tokens.cacheReadInputTokens);
    if (claude.totalTokens > 0 && inputLike / claude.totalTokens >= 0.9) {
      insights.push({
        severity: "high",
        title: "Claude burn is mostly context",
        detail: "Over 90% of Claude tokens are input or cached context. Long conversations and repeated context reads are likely limit drivers.",
      });
    }
  }

  if (codex) {
    const cached = numberValue(codex.tokens.cachedInputTokens);
    const input = numberValue(codex.tokens.inputTokens);
    if (input > 0) {
      insights.push({
        severity: "info",
        title: "Codex cache reuse",
        detail: `${Math.round((cached / input) * 100)}% of Codex input tokens were cached in this range.`,
      });
    }
  }

  if (insights.length === 0) {
    insights.push({
      severity: "info",
      title: "No obvious spike",
      detail: "Token usage is spread across sessions in this range. Narrow the date window to isolate a limit event.",
    });
  }

  return insights.slice(0, 8);
}

function formatCount(value) {
  const n = Math.round(numberValue(value));
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

function formatDurationMinutes(value) {
  const minutes = Math.max(0, Math.round(numberValue(value)));
  if (minutes >= 1440) return `${(minutes / 1440).toFixed(1)}d`;
  if (minutes >= 60) return `${(minutes / 60).toFixed(1)}h`;
  return `${minutes}m`;
}

async function parseAllUsage(options) {
  const days = Math.max(1, Number(options.days || DEFAULT_DAYS));
  const logDays = Math.max(days, 7);
  const sinceMs = Date.now() - logDays * 86400000;
  const claudeRoot = path.resolve(options.claudeRoot || process.env.CLAUDE_PROJECTS_ROOT || path.join(os.homedir(), ".claude", "projects"));
  const codexRoot = path.resolve(options.codexRoot || process.env.CODEX_SESSIONS_ROOT || path.join(os.homedir(), ".codex", "sessions"));
  const [claude, codex] = await Promise.all([
    parseClaude(claudeRoot, sinceMs),
    parseCodex(codexRoot, sinceMs),
  ]);
  return [claude, codex];
}

function respond(res, status, body, contentType) {
  res.statusCode = status;
  res.setHeader("Content-Type", contentType || "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(body);
}

function respondJson(res, status, payload) {
  respond(res, status, JSON.stringify(payload), "application/json; charset=utf-8");
}

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, body) => {
    if (err) {
      respond(res, 404, "Not found");
      return;
    }
    respond(res, 200, body, contentType || "text/html; charset=utf-8");
  });
}

function parseQuery(req) {
  const url = new URL(req.url, "http://127.0.0.1");
  return { path: url.pathname, query: url.searchParams };
}

function createServer() {
  return http.createServer(async (req, res) => {
    const parsed = parseQuery(req);
    if (req.method !== "GET") {
      respondJson(res, 405, { ok: false, error: "Method not allowed" });
      return;
    }

    if (parsed.path === "/" || parsed.path === "/dashboard") {
      serveFile(res, dashboardPath, "text/html; charset=utf-8");
      return;
    }

    if (parsed.path === "/favicon.ico") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (parsed.path === "/health") {
      respondJson(res, 200, { ok: true, name: "ai-spend-dashboard" });
      return;
    }

    if (parsed.path === "/api/summary") {
      try {
        const days = Math.max(1, Number(parsed.query.get("days") || DEFAULT_DAYS));
        const provider = String(parsed.query.get("provider") || "all").toLowerCase();
        const claudePlan = String(parsed.query.get("claudePlan") || "").toLowerCase();
        const codexPlan = String(parsed.query.get("codexPlan") || "").toLowerCase();
        const sources = await parseAllUsage({ days });
        const summary = buildSummary(sources, { days, provider, claudePlan, codexPlan });
        respondJson(res, 200, summary);
      } catch (err) {
        respondJson(res, 500, {
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      }
      return;
    }

    respond(res, 404, "Not found");
  });
}

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, days: DEFAULT_DAYS, provider: "all", claudePlan: "", codexPlan: "", summary: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--summary") out.summary = true;
    else if (arg === "--days") out.days = Number(argv[++i] || DEFAULT_DAYS);
    else if (arg === "--provider") out.provider = String(argv[++i] || "all").toLowerCase();
    else if (arg === "--claude-plan") out.claudePlan = String(argv[++i] || "").toLowerCase();
    else if (arg === "--codex-plan") out.codexPlan = String(argv[++i] || "").toLowerCase();
    else if (arg === "--port") out.port = Number(argv[++i] || DEFAULT_PORT);
    else if (/^\d+$/.test(arg)) out.port = Number(arg);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.summary) {
    const sources = await parseAllUsage({ days: args.days });
    const summary = buildSummary(sources, { days: args.days, provider: args.provider, claudePlan: args.claudePlan, codexPlan: args.codexPlan });
    console.log(JSON.stringify({
      generatedAt: summary.generatedAt,
      range: summary.range,
      totals: summary.totals,
      providerTotals: summary.providerTotals,
      budgetPace: summary.budgetPace,
      planPace: summary.planPace,
      weeklyPace: summary.weeklyPace,
      budgetSessions: summary.budgetSessions,
      promptGuidance: summary.promptGuidance,
      insights: summary.insights,
      recommendations: summary.recommendations,
    }, null, 2));
    return;
  }

  const server = createServer();
  server.listen(args.port, "127.0.0.1", () => {
    console.log(`AI Spend dashboard: http://127.0.0.1:${args.port}/`);
  });
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  buildSummary,
  estimateCost,
  listJsonlFiles,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  parseAllUsage,
  parseClaude,
  parseCodex,
};
