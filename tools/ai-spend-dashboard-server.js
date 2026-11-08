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
const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_NOT_FOUND = 404;
const HTTP_METHOD_NOT_ALLOWED = 405;
const HTTP_SERVER_ERROR = 500;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;
const MS_PER_DAY = 86400000;
const TOKENS_PER_MILLION = 1000000;
const OPENAI_LONG_CONTEXT_THRESHOLD = 272000;
const LIMIT_WARNING_USED_PERCENT = 80;
const LIMIT_WARNING_PROJECTED_PERCENT = 90;

const CLAUDE_PRICING = [
  {
    match: /opus-?5[.-]5/i,
    id: "claude-opus-5-5",
    label: "Claude Opus 5.5",
    input: 4,
    cacheWrite5m: 5,
    cacheWrite1h: 8,
    cacheRead: 0.2,
    output: 20,
    contextWindow: 1000000,
    role: "Frontier architecture, deep review, and complex multi-agent orchestration",
  },
  {
    match: /opus-?5/i,
    id: "claude-opus-5",
    label: "Claude Opus 5",
    input: 5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    output: 25,
    contextWindow: 1000000,
    role: "Deep reasoning and multi-file architecture",
  },
  {
    match: /opus/i,
    id: "claude-opus-4",
    label: "Claude Opus",
    input: 5,
    cacheWrite5m: 6.25,
    cacheWrite1h: 10,
    cacheRead: 0.5,
    output: 25,
    contextWindow: 1000000,
    role: "Legacy high-capability reasoning and review (Opus 4.5-4.8)",
  },
  {
    match: /fable-?5[.-]1/i,
    id: "claude-fable-5-1",
    label: "Claude Fable 5.1",
    input: 10,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 0.25,
    output: 50,
    contextWindow: 1000000,
    role: "Demanding reasoning and long-horizon agentic work",
  },
  {
    match: /fable/i,
    id: "claude-fable-5",
    label: "Claude Fable 5",
    input: 10,
    cacheWrite5m: 12.5,
    cacheWrite1h: 20,
    cacheRead: 1,
    output: 50,
    contextWindow: 1000000,
    role: "Previous Fable tier",
  },
  {
    match: /sonnet-?5[.-]5/i,
    id: "claude-sonnet-5-5",
    label: "Claude Sonnet 5.5",
    input: 2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
    cacheRead: 0.1,
    output: 10,
    contextWindow: 1000000,
    role: "Best combination of speed and intelligence",
  },
  {
    match: /sonnet-?5/i,
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    input: 2,
    cacheWrite5m: 2.5,
    cacheWrite1h: 4,
    cacheRead: 0.2,
    output: 10,
    contextWindow: 1000000,
    role: "Previous balanced coding model",
  },
  {
    match: /sonnet/i,
    id: "claude-sonnet-4",
    label: "Claude Sonnet",
    input: 3,
    cacheWrite5m: 3.75,
    cacheWrite1h: 6,
    cacheRead: 0.3,
    output: 15,
    contextWindow: 1000000,
    role: "Balanced coding model (Sonnet 4.6)",
  },
  {
    match: /haiku-?5[.-]5|haiku.*5\.5/i,
    id: "claude-haiku-5-5",
    label: "Claude Haiku 5.5",
    input: 0.1,
    cacheWrite5m: 0.125,
    cacheWrite1h: 0.2,
    cacheRead: 0.01,
    output: 0.5,
    longContextThreshold: 100000,
    longContextInput: 0.5,
    longContextCacheWrite5m: 0.625,
    longContextCacheWrite1h: 1,
    longContextCacheRead: 0.05,
    longContextOutput: 2.5,
    contextWindow: 1000000,
    role: "High-volume, latency-sensitive classification, extraction, and routing",
  },
  {
    match: /haiku-?4[.-]5|haiku.*4\.5/i,
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    input: 1,
    cacheWrite5m: 1.25,
    cacheWrite1h: 2,
    cacheRead: 0.1,
    output: 5,
    contextWindow: 200000,
    role: "High-speed repo exploration and lightweight subagents",
  },
  {
    match: /haiku-?3\.5|haiku.*3\.5/i,
    id: "claude-haiku-3-5",
    label: "Claude Haiku 3.5",
    input: 0.8,
    cacheWrite5m: 1,
    cacheWrite1h: 1.6,
    cacheRead: 0.08,
    output: 4,
    contextWindow: 200000,
    role: "Legacy fast model",
  },
  {
    match: /haiku/i,
    id: "claude-haiku",
    label: "Claude Haiku",
    input: 0.25,
    cacheWrite5m: 0.3,
    cacheWrite1h: 0.5,
    cacheRead: 0.03,
    output: 1.25,
    contextWindow: 200000,
    role: "Legacy compact model",
  },
];

const OPENAI_PRICING = [
  {
    match: /^gpt-6-astra/i,
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
    input: 10,
    cachedInput: 1,
    output: 50,
    longContextInput: 20,
    longContextCachedInput: 2,
    longContextOutput: 75,
    creditInput: 250,
    creditCachedInput: 25,
    creditOutput: 1250,
    contextWindow: 1050000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    role: "Most capable model for demanding reasoning, coding, computer use, and research",
  },
  {
    match: /^gpt-6\.1-sol/i,
    id: "gpt-6.1-sol",
    label: "GPT-6.1 Sol",
    input: 2,
    cachedInput: 0.1,
    output: 10,
    longContextInput: 4,
    longContextCachedInput: 0.2,
    longContextOutput: 15,
    creditInput: 50,
    creditCachedInput: 2.5,
    creditOutput: 250,
    contextWindow: 1050000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    role: "Near-Astra performance for complex coding and professional work at lower cost",
  },
  {
    match: /^gpt-6\.1-terra/i,
    id: "gpt-6.1-terra",
    label: "GPT-6.1 Terra",
    input: 1,
    cachedInput: 0.05,
    output: 5,
    longContextInput: 2,
    longContextCachedInput: 0.1,
    longContextOutput: 7.5,
    creditInput: 25,
    creditCachedInput: 1.25,
    creditOutput: 125,
    contextWindow: 1050000,
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    role: "Fast, efficient visual reasoning, computer use, and writing model",
  },
  {
    match: /^gpt-6-sol/i,
    id: "gpt-6-sol",
    label: "GPT-6 Sol",
    input: 2,
    cachedInput: 0.2,
    output: 10,
    longContextInput: 4,
    longContextCachedInput: 0.4,
    longContextOutput: 15,
    creditInput: 50,
    creditCachedInput: 5,
    creditOutput: 250,
    contextWindow: 1050000,
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    role: "Previous-generation Sol for complex coding and agentic workflows",
  },
  {
    match: /^gpt-6-luna/i,
    id: "gpt-6-luna",
    label: "GPT-6 Luna",
    input: 0.1,
    cachedInput: 0.01,
    output: 0.5,
    longContextInput: 0.2,
    longContextCachedInput: 0.02,
    longContextOutput: 0.75,
    creditInput: 2.5,
    creditCachedInput: 0.25,
    creditOutput: 12.5,
    contextWindow: 1050000,
    efforts: ["none", "low", "medium", "high", "xhigh", "max"],
    role: "Most efficient model for focused, high-volume tasks",
  },
  {
    match: /^gpt-5\.6-sol/i,
    id: "gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    input: 4,
    cachedInput: 0.4,
    output: 20,
    longContextInput: 8,
    longContextCachedInput: 0.8,
    longContextOutput: 30,
    creditInput: 100,
    creditCachedInput: 10,
    creditOutput: 500,
    contextWindow: 1050000,
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    role: "Legacy frontier agentic coding model",
  },
  {
    match: /^gpt-5\.6-terra/i,
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
    input: 2,
    cachedInput: 0.2,
    output: 12,
    longContextInput: 4,
    longContextCachedInput: 0.4,
    longContextOutput: 18,
    creditInput: 50,
    creditCachedInput: 5,
    creditOutput: 300,
    contextWindow: 1050000,
    efforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
    role: "Legacy balanced agentic coding model",
  },
  {
    match: /^gpt-5\.6-luna/i,
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    input: 0.2,
    cachedInput: 0.02,
    output: 1.2,
    longContextInput: 0.4,
    longContextCachedInput: 0.04,
    longContextOutput: 1.8,
    creditInput: 5,
    creditCachedInput: 0.5,
    creditOutput: 30,
    contextWindow: 1050000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    role: "Legacy fast agentic coding model",
  },
  {
    match: /^gpt-5\.5/i,
    id: "gpt-5.5",
    label: "GPT-5.5",
    input: 5,
    cachedInput: 0.5,
    output: 30,
    contextWindow: 272000,
    efforts: ["low", "medium", "high", "xhigh"],
    role: "Frontier model for complex coding, research, and planning gates",
  },
  {
    match: /^gpt-5\.4-mini/i,
    id: "gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    input: 0.75,
    cachedInput: 0.075,
    output: 4.5,
    contextWindow: 272000,
    efforts: ["low", "medium", "high", "xhigh"],
    role: "Small, fast, and cost-efficient model for simpler coding tasks",
  },
  {
    match: /^gpt-5\.4/i,
    id: "gpt-5.4",
    label: "GPT-5.4",
    input: 2.5,
    cachedInput: 0.25,
    output: 15,
    contextWindow: 272000,
    efforts: ["low", "medium", "high", "xhigh"],
    role: "Strong model for everyday coding",
  },
  {
    match: /^gpt-5\.3-codex-spark/i,
    id: "gpt-5.3-codex-spark",
    label: "GPT-5.3 Codex Spark",
    input: 1,
    cachedInput: 0.1,
    output: 8,
    estimated: true,
    contextWindow: 128000,
    efforts: ["low", "medium", "high", "xhigh"],
    role: "Ultra-fast coding model for tight edit-and-test loops",
  },
  {
    match: /^gpt-5\.3-codex/i,
    id: "gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    input: 1.75,
    cachedInput: 0.175,
    output: 14,
    estimated: true,
    contextWindow: 272000,
    efforts: ["low", "medium", "high", "xhigh"],
    role: "Dedicated Codex implementation model",
  },
  {
    match: /^codex-auto-review/i,
    id: "codex-auto-review",
    label: "Codex Auto Review",
    input: 1.25,
    cachedInput: 0.125,
    output: 10,
    estimated: true,
    contextWindow: 272000,
    efforts: ["low", "medium", "high", "xhigh", "max"],
    role: "Automatic approval and safety review model for Codex",
  },
  {
    match: /^gpt-5\.2-codex/i,
    id: "gpt-5.2-codex",
    label: "GPT-5.2 Codex",
    input: 1.75,
    cachedInput: 0.175,
    output: 14,
    contextWindow: 200000,
    role: "Legacy Codex model",
  },
  {
    match: /^gpt-5\.2/i,
    id: "gpt-5.2",
    label: "GPT-5.2",
    input: 1.75,
    cachedInput: 0.175,
    output: 14,
    contextWindow: 200000,
    role: "Legacy GPT-5.2 model",
  },
  {
    match: /^gpt-5/i,
    id: "gpt-5",
    label: "GPT-5",
    input: 1.25,
    cachedInput: 0.125,
    output: 10,
    contextWindow: 200000,
    role: "Base GPT-5 tier",
  },
];

function buildModelCatalog(observedModels) {
  const claudeRows = CLAUDE_PRICING.map((item) => ({
    provider: "claude",
    id: item.id,
    label: item.label,
    inputPer1M: item.input,
    cachedInputPer1M: item.cacheRead,
    cacheWrite5mPer1M: item.cacheWrite5m,
    outputPer1M: item.output,
    longContextThreshold: item.longContextThreshold || 0,
    longContextInputPer1M: item.longContextInput == null ? null : item.longContextInput,
    longContextCachedInputPer1M: item.longContextCacheRead == null ? null : item.longContextCacheRead,
    longContextOutputPer1M: item.longContextOutput == null ? null : item.longContextOutput,
    creditInputPer1M: null,
    creditCachedInputPer1M: null,
    creditOutputPer1M: null,
    contextWindow: item.contextWindow || 200000,
    efforts: [],
    estimated: Boolean(item.estimated),
    pricingKnown: true,
    role: item.role || "",
  }));
  const codexRows = OPENAI_PRICING.map((item) => ({
    provider: "codex",
    id: item.id,
    label: item.label,
    inputPer1M: item.input,
    cachedInputPer1M: item.cachedInput,
    cacheWrite5mPer1M: null,
    outputPer1M: item.output,
    longContextThreshold: item.longContextInput == null ? 0 : OPENAI_LONG_CONTEXT_THRESHOLD,
    longContextInputPer1M: item.longContextInput == null ? null : item.longContextInput,
    longContextCachedInputPer1M: item.longContextCachedInput == null ? null : item.longContextCachedInput,
    longContextOutputPer1M: item.longContextOutput == null ? null : item.longContextOutput,
    creditInputPer1M: item.creditInput == null ? null : item.creditInput,
    creditCachedInputPer1M: item.creditCachedInput == null ? null : item.creditCachedInput,
    creditOutputPer1M: item.creditOutput == null ? null : item.creditOutput,
    contextWindow: item.contextWindow || 272000,
    efforts: item.efforts || [],
    estimated: Boolean(item.estimated),
    pricingKnown: true,
    role: item.role || "",
  }));
  const rows = [...claudeRows, ...codexRows];
  const known = new Set(rows.map((row) => `${row.provider}:${row.id}`));
  for (const observed of observedModels || []) {
    const provider = String(observed.provider || "imported").toLowerCase();
    const id = String(observed.model || "unknown").trim() || "unknown";
    const key = `${provider}:${id}`;
    if (known.has(key)) {
      continue;
    }
    known.add(key);
    rows.push({
      provider,
      id,
      label: id,
      inputPer1M: null,
      cachedInputPer1M: null,
      cacheWrite5mPer1M: null,
      outputPer1M: null,
      longContextThreshold: 0,
      longContextInputPer1M: null,
      longContextCachedInputPer1M: null,
      longContextOutputPer1M: null,
      creditInputPer1M: null,
      creditCachedInputPer1M: null,
      creditOutputPer1M: null,
      contextWindow: 0,
      efforts: [],
      estimated: false,
      pricingKnown: false,
      role: "Observed in local usage; pricing is not configured for this model ID.",
    });
  }
  return rows;
}

const PLAN_PRESETS = {
  claude: {
    custom: {
      label: "Custom/env",
      detail: "Use AI_SPEND_5H_TOKEN_BUDGET and AI_SPEND_WEEKLY_TOKEN_BUDGET.",
    },
    "claude-pro": {
      label: "Claude Pro ($20)",
      detail: "Claude publishes five-hour and weekly limits but no fixed message or token cap; use the Claude Usage page for the authoritative remaining allowance.",
      weeklyNote: "The five-hour limit is shared across Claude apps and Claude Code, with a weekly limit across all models.",
      source: "https://support.claude.com/en/articles/8325606-what-is-the-pro-plan",
    },
    "claude-max-5x": {
      label: "Claude Max 5x ($100)",
      detail: "Five times Pro usage every five hours and every week; Anthropic does not publish a fixed token cap.",
      weeklyNote: "Max has a general weekly limit plus a separate weekly Fable limit.",
      source: "https://support.claude.com/en/articles/11049741-what-is-the-max-plan",
    },
    "claude-ultra": {
      label: "Claude Ultra ($200)",
      detail: "Ultra replaced Max 20x. Verified accounts have no five-hour limit and receive ten times Pro usage each week.",
      unlimitedFiveHour: true,
      unlimitedText: "Verified Ultra accounts have no five-hour limit; the weekly allowance still applies.",
      weeklyNote: "Ultra has a general weekly limit plus a separate weekly Fable limit.",
      source: "https://support.claude.com/en/articles/17728952-what-is-the-ultra-plan",
    },
  },
  codex: {
    custom: {
      label: "Custom/env",
      detail: "Use AI_SPEND_5H_TOKEN_BUDGET and AI_SPEND_WEEKLY_TOKEN_BUDGET.",
    },
    "codex-plus": {
      label: "Codex Plus ($20)",
      detail: "Official local-message ranges per five hours. Estimates vary with task size, context, reasoning, tools, and caching.",
      modelMessages: {
        gpt6astra: { min: 5, max: 45 },
        gpt61sol: { min: 15, max: 160 },
        gpt61terra: { min: 35, max: 285 },
        gpt6sol: { min: 15, max: 150 },
        gpt6luna: { min: 350, max: 3000 },
      },
      weeklyNote: "Local messages and cloud chats share the allowance; weekly limits may also apply.",
      source: "https://learn.chatgpt.com/docs/pricing",
    },
    "codex-business": {
      label: "Codex Business ($20-$25/user)",
      detail: "Standard Business has the same published five-hour local-message ranges as Plus.",
      modelMessages: {
        gpt6astra: { min: 5, max: 45 },
        gpt61sol: { min: 15, max: 160 },
        gpt61terra: { min: 35, max: 285 },
        gpt6sol: { min: 15, max: 150 },
        gpt6luna: { min: 350, max: 3000 },
      },
      weeklyNote: "Local messages and cloud chats share the allowance; weekly limits may also apply.",
      source: "https://learn.chatgpt.com/docs/pricing",
    },
    "codex-pro-100": {
      label: "Codex Pro $100",
      detail: "Current Pro plans have no five-hour limit; weekly and fair-use limits still apply.",
      unlimitedFiveHour: true,
      unlimitedText: "No five-hour limit is currently published for Pro.",
      weeklyNote: "Check the Codex usage dashboard for current weekly limits and reset times.",
      source: "https://learn.chatgpt.com/docs/pricing",
    },
    "codex-pro-200": {
      label: "Codex Pro $200",
      detail: "Current Pro plans have no five-hour limit; weekly and fair-use limits still apply.",
      unlimitedFiveHour: true,
      unlimitedText: "No five-hour limit is currently published for Pro.",
      weeklyNote: "Check the Codex usage dashboard for current weekly limits and reset times.",
      source: "https://learn.chatgpt.com/docs/pricing",
    },
    "codex-pro-500": {
      label: "Codex Pro $500",
      detail: "Current Pro plans have no five-hour limit and Pro $500 includes Ultrafast access.",
      unlimitedFiveHour: true,
      unlimitedText: "No five-hour limit is currently published for Pro.",
      weeklyNote: "Ultrafast consumes included usage at 8x for Astra and GPT-6.1 Sol; weekly limits still apply.",
      source: "https://learn.chatgpt.com/docs/pricing",
    },
    "codex-enterprise-flex": {
      label: "Enterprise/Edu flexible",
      detail: "Flexible-pricing workspaces have no fixed rate limits; usage scales with credits.",
      unlimitedFiveHour: true,
      unlimitedText: "No fixed five-hour rate limit; usage scales with workspace credits.",
      weeklyNote: "Workspace credit policies and admin controls apply.",
      source: "https://learn.chatgpt.com/docs/pricing",
    },
    "codex-api": {
      label: "Codex API key",
      detail: "Usage-based API mode does not have a subscription 5-hour cap; standard API tier limits and per-token billing apply.",
      weeklyNote: "No subscription weekly cap is published for API-key usage.",
      unlimitedFiveHour: true,
      unlimitedText: "API-key usage has no subscription five-hour cap.",
      source: "https://developers.openai.com/api/docs/pricing",
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

async function readJsonLines(filePath, onObject, onRawLine) {
  const stream = fs.createReadStream(filePath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let lineNumber = 0;
  for await (const line of rl) {
    lineNumber += 1;
    const trimmed = line.trim();
    if (!trimmed) continue;
    // An optional raw-line hook may fully handle a line (return true) so large
    // irrelevant records never pay for JSON.parse.
    if (onRawLine && onRawLine(trimmed, lineNumber)) continue;
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
    const promptTokens = numberValue(tokens.inputTokens)
      + numberValue(tokens.cacheCreationInputTokens)
      + numberValue(tokens.cacheCreation1hInputTokens)
      + numberValue(tokens.cacheReadInputTokens);
    const isLongContext = pricing.longContextThreshold > 0 && promptTokens > pricing.longContextThreshold;
    const inputRate = isLongContext ? pricing.longContextInput : pricing.input;
    const cacheWrite5mRate = isLongContext ? pricing.longContextCacheWrite5m : pricing.cacheWrite5m;
    const cacheWrite1hRate = isLongContext ? pricing.longContextCacheWrite1h : pricing.cacheWrite1h;
    const cacheReadRate = isLongContext ? pricing.longContextCacheRead : pricing.cacheRead;
    const outputRate = isLongContext ? pricing.longContextOutput : pricing.output;
    const usd = (
      numberValue(tokens.inputTokens) * inputRate
      + numberValue(tokens.cacheCreationInputTokens) * cacheWrite5mRate
      + numberValue(tokens.cacheCreation1hInputTokens) * cacheWrite1hRate
      + numberValue(tokens.cacheReadInputTokens) * cacheReadRate
      + numberValue(tokens.outputTokens) * outputRate
    ) / 1000000;
    return {
      usd,
      known: true,
      label: pricing.label,
      estimated: Boolean(pricing.estimated),
      pricingTier: isLongContext ? "long" : "standard",
    };
  }

  if (provider === "codex") {
    const pricing = findOpenAiPricing(model);
    if (!pricing) return { usd: 0, known: false, label: "Unknown OpenAI model" };
    const input = numberValue(tokens.inputTokens);
    const cached = Math.min(numberValue(tokens.cachedInputTokens), input);
    const uncached = Math.max(0, input - cached);
    const isLongContext = input > OPENAI_LONG_CONTEXT_THRESHOLD && pricing.longContextInput != null;
    const inputRate = isLongContext ? pricing.longContextInput : pricing.input;
    const cachedInputRate = isLongContext ? pricing.longContextCachedInput : pricing.cachedInput;
    const outputRate = isLongContext ? pricing.longContextOutput : pricing.output;
    const usd = (
      uncached * inputRate
      + cached * cachedInputRate
      + numberValue(tokens.outputTokens) * outputRate
    ) / 1000000;
    return {
      usd,
      known: true,
      label: pricing.label,
      estimated: Boolean(pricing.estimated),
      pricingTier: isLongContext ? "long" : "standard",
    };
  }

  return { usd: 0, known: false, label: "Unknown provider" };
}

function estimateCredits(provider, model, tokens) {
  if (provider !== "codex") {
    return { credits: 0, known: false, label: "Credits apply to Codex usage" };
  }

  const pricing = findOpenAiPricing(model);
  if (!pricing || pricing.creditInput == null || pricing.creditCachedInput == null || pricing.creditOutput == null) {
    return { credits: 0, known: false, label: "No published Codex credit rate" };
  }

  const input = numberValue(tokens.inputTokens);
  const cached = Math.min(numberValue(tokens.cachedInputTokens), input);
  const uncached = Math.max(0, input - cached);
  const credits = (
    uncached * pricing.creditInput
    + cached * pricing.creditCachedInput
    + numberValue(tokens.outputTokens) * pricing.creditOutput
  ) / TOKENS_PER_MILLION;

  return { credits, known: true, label: pricing.label };
}

function normalizeClaudeUsage(usage) {
  const tokens = emptyTokens();
  if (!usage || typeof usage !== "object") return tokens;

  tokens.inputTokens = numberValue(usage.input_tokens);
  tokens.outputTokens = numberValue(usage.output_tokens);
  tokens.cacheReadInputTokens = numberValue(usage.cache_read_input_tokens);

  // cache_creation_input_tokens is the total; usage.cache_creation splits that
  // same total into ephemeral 5m/1h buckets, so the breakdown replaces the
  // total instead of adding to it.
  const cacheCreationTotal = numberValue(usage.cache_creation_input_tokens);
  let fiveMinute = 0;
  let oneHour = 0;
  let hasBreakdown = false;
  if (usage.cache_creation && typeof usage.cache_creation === "object") {
    for (const [key, value] of Object.entries(usage.cache_creation)) {
      hasBreakdown = true;
      if (/1h|hour/i.test(key)) {
        oneHour += numberValue(value);
      } else {
        fiveMinute += numberValue(value);
      }
    }
  }
  if (!hasBreakdown) {
    fiveMinute = cacheCreationTotal;
  } else if (fiveMinute + oneHour < cacheCreationTotal) {
    fiveMinute += cacheCreationTotal - (fiveMinute + oneHour);
  }
  tokens.cacheCreationInputTokens = fiveMinute;
  tokens.cacheCreation1hInputTokens = oneHour;

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

function normalizeImportedUsage(record) {
  const source = record && typeof record === "object" ? record : {};
  const usage = source.usage && typeof source.usage === "object"
    ? source.usage
    : source.tokens && typeof source.tokens === "object"
      ? source.tokens
      : source;
  const read = (...keys) => {
    for (const key of keys) {
      if (usage[key] != null) {
        return usage[key];
      }
    }
    return 0;
  };
  const tokens = emptyTokens();
  tokens.inputTokens = numberValue(read("input_tokens", "inputTokens", "prompt_tokens", "promptTokens"));
  tokens.cachedInputTokens = numberValue(read("cached_input_tokens", "cachedInputTokens", "cache_read_input_tokens", "cacheReadInputTokens"));
  tokens.cacheCreationInputTokens = numberValue(read("cache_creation_input_tokens", "cacheCreationInputTokens"));
  tokens.cacheCreation1hInputTokens = numberValue(read("cache_creation_1h_input_tokens", "cacheCreation1hInputTokens"));
  tokens.cacheReadInputTokens = numberValue(read("cache_read_input_tokens", "cacheReadInputTokens"));
  tokens.outputTokens = numberValue(read("output_tokens", "outputTokens", "completion_tokens", "completionTokens"));
  tokens.reasoningOutputTokens = numberValue(read("reasoning_output_tokens", "reasoningOutputTokens"));
  tokens.totalTokens = numberValue(read("total_tokens", "totalTokens")) || tokenTotal(tokens);
  return tokens;
}

function epochMs(value) {
  const numeric = Number(value || 0);
  if (!Number.isFinite(numeric) || numeric <= 0) return 0;
  return numeric < 1e12 ? numeric * 1000 : numeric;
}

function normalizeRateLimitSnapshot(raw, timestampMs) {
  const source = raw && raw.rate_limits && typeof raw.rate_limits === "object" ? raw.rate_limits : raw;
  if (!source || typeof source !== "object") return [];
  const rows = [];
  const baseId = String(source.limit_id || source.limitId || "codex");
  for (const [kind, value] of [["primary", source.primary], ["secondary", source.secondary]]) {
    if (!value || typeof value !== "object") continue;
    const usedPercent = Number(value.used_percent ?? value.usedPercent);
    if (!Number.isFinite(usedPercent)) continue;
    const windowMinutes = numberValue(value.window_minutes ?? value.windowMinutes);
    const resetAt = epochMs(value.resets_at ?? value.resetsAt);
    rows.push({
      provider: "codex",
      limitId: `${baseId}:${kind}`,
      limitName: String(source.limit_name || source.limitName || kind),
      windowMinutes,
      resetAt,
      usedPercent: Math.max(0, Math.min(100, usedPercent)),
      timestampMs,
    });
  }
  return rows;
}

function buildObservedRateLimits(snapshots, nowMs = Date.now(), includeHistory = false) {
  const groups = new Map();
  for (const snapshot of snapshots || []) {
    const key = `${snapshot.limitId || "codex"}:${snapshot.windowMinutes || 0}:${snapshot.resetAt || 0}`;
    const list = groups.get(key) || [];
    list.push(snapshot);
    groups.set(key, list);
  }
  const rows = Array.from(groups.values()).map((list) => {
    list.sort((a, b) => a.timestampMs - b.timestampMs);
    const latest = list[list.length - 1];
    const previous = list.length > 1 ? list[list.length - 2] : null;
    const resetAt = latest.resetAt || 0;
    const windowMs = Math.max(0, numberValue(latest.windowMinutes) * MS_PER_MINUTE);
    const freshnessMs = Math.max(2 * MS_PER_HOUR, windowMs > 0 ? windowMs * 0.25 : 2 * MS_PER_HOUR);
    const fresh = latest.timestampMs >= nowMs - freshnessMs;
    const sameReset = previous && previous.resetAt === latest.resetAt;
    const elapsedHours = previous && latest.timestampMs > previous.timestampMs
      ? (latest.timestampMs - previous.timestampMs) / MS_PER_HOUR
      : 0;
    const slopePercentPerHour = sameReset && elapsedHours > 0
      ? (latest.usedPercent - previous.usedPercent) / elapsedHours
      : null;
    const resetHours = resetAt > nowMs ? (resetAt - nowMs) / MS_PER_HOUR : 0;
    const canProject = fresh && sameReset && elapsedHours > 0 && resetAt > nowMs && slopePercentPerHour >= 0;
    const projectedPercent = canProject
      ? Math.min(100, latest.usedPercent + slopePercentPerHour * resetHours)
      : null;
    return {
      provider: latest.provider || "codex",
      limitId: latest.limitId || "codex",
      limitName: latest.limitName || "Observed allowance",
      windowMinutes: latest.windowMinutes || 0,
      usedPercent: latest.usedPercent,
      resetAt: resetAt ? new Date(resetAt).toISOString() : "",
      latestAt: latest.timestampMs ? new Date(latest.timestampMs).toISOString() : "",
      sampleCount: list.length,
      fresh,
      measured: true,
      slopePercentPerHour,
      projectedPercent,
      status: !fresh ? "stale" : canProject ? "projected" : "observed",
      statusText: !fresh
        ? "No fresh rate-limit snapshot; showing the last observed value."
        : canProject
          ? `Observed ${latest.usedPercent.toFixed(1)}%; projected ${projectedPercent.toFixed(1)}% by reset at the measured slope.`
          : `Observed ${latest.usedPercent.toFixed(1)}%; no safe forecast without two fresh samples on the same reset window.`,
    };
  }).sort((a, b) => b.usedPercent - a.usedPercent);
  if (includeHistory) return rows;
  const latestByWindow = new Map();
  for (const row of rows) {
    const key = `${row.limitId}:${row.windowMinutes}`;
    const current = latestByWindow.get(key);
    const rowReset = row.resetAt ? Date.parse(row.resetAt) : 0;
    const currentReset = current && current.resetAt ? Date.parse(current.resetAt) : 0;
    if (!current || rowReset > currentReset || (rowReset === currentReset && row.latestAt > current.latestAt)) {
      latestByWindow.set(key, row);
    }
  }
  return Array.from(latestByWindow.values()).sort((a, b) => b.usedPercent - a.usedPercent);
}

function selectFreshLimitPressure(rows) {
  return (rows || [])
    .filter((row) => row && row.fresh && (
      numberValue(row.usedPercent) >= LIMIT_WARNING_USED_PERCENT
      || numberValue(row.projectedPercent) >= LIMIT_WARNING_PROJECTED_PERCENT
    ))
    .sort((a, b) => Math.max(numberValue(b.usedPercent), numberValue(b.projectedPercent))
      - Math.max(numberValue(a.usedPercent), numberValue(a.projectedPercent)))[0];
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

function resolveProjectFromRelPath(relPath, filePath) {
  const parts = String(relPath || "").split(/[\\/]+/).filter(Boolean);
  if (parts.length >= 2) {
    return parts[0];
  }
  return path.basename(path.dirname(filePath));
}

function detectClaudeSubagentPath(relPath, filePath) {
  const parts = String(relPath || "").split(/[\\/]+/).filter(Boolean);
  const baseName = path.basename(filePath, ".jsonl");
  const subagentsIdx = parts.findIndex((seg) => seg.toLowerCase() === "subagents");
  if (subagentsIdx >= 0) {
    const parentId = subagentsIdx >= 1 ? parts[subagentsIdx - 1] : "";
    const agentId = baseName.replace(/^agent-/i, "");
    return { isSubagent: true, parentSessionId: parentId, agentId };
  }
  if (/^agent-/i.test(baseName)) {
    return { isSubagent: true, parentSessionId: "", agentId: baseName.replace(/^agent-/i, "") };
  }
  return { isSubagent: false, parentSessionId: "", agentId: "" };
}

function createSession(provider, fileInfo, root) {
  const filePath = fileInfo.path || String(fileInfo);
  const relPath = root ? path.relative(root, filePath) : path.basename(filePath);
  const subagentInfo = provider === "claude"
    ? detectClaudeSubagentPath(relPath, filePath)
    : { isSubagent: false, parentSessionId: "", agentId: "" };
  const baseId = path.basename(filePath, ".jsonl");
  const sessionId = subagentInfo.isSubagent && subagentInfo.parentSessionId
    ? `${subagentInfo.parentSessionId}:subagent:${subagentInfo.agentId || baseId}`
    : baseId;

  return {
    provider,
    id: sessionId,
    parentSessionId: subagentInfo.parentSessionId || "",
    agentId: subagentInfo.agentId || "",
    isSubagent: subagentInfo.isSubagent,
    subagentKind: subagentInfo.isSubagent ? "sidechain" : "",
    liveStatus: "",
    livePid: 0,
    reasoningEffort: "",
    sourceType: "jsonl",
    file: filePath,
    relativeFile: relPath,
    project: provider === "claude" ? resolveProjectFromRelPath(relPath, filePath) : path.basename(path.dirname(filePath)),
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
    credits: 0,
    creditKnownTokens: 0,
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
  if (!session.reasoningEffort && event.reasoningEffort) {
    session.reasoningEffort = event.reasoningEffort;
  }
  addTokens(session.tokens, event.tokens);
  session.costUsd += event.costUsd;
  if (event.costKnown) {
    session.knownCostUsd += event.costUsd;
  } else {
    session.unknownCostTokens += tokenTotal(event.tokens);
  }
  session.credits += numberValue(event.credits);
  if (event.creditKnown) {
    session.creditKnownTokens += tokenTotal(event.tokens);
  }
  if (event.pricingLabel) {
    session.pricingLabels.add(event.pricingLabel);
  }
  session.events.push(event);
}

function readClaudeLiveSessions(root, options) {
  const opts = options || {};
  const sessionsDir = path.resolve(
    opts.sessionsMetaRoot
      || process.env.CLAUDE_SESSIONS_ROOT
      || path.join(root, "..", "sessions"),
  );
  const map = new Map();
  if (!fs.existsSync(sessionsDir)) {
    return map;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch (_) {
    return map;
  }
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith(".json")) {
      continue;
    }
    try {
      const raw = fs.readFileSync(path.join(sessionsDir, entry.name), "utf8");
      const parsed = safeJsonParse(raw);
      if (!parsed || typeof parsed !== "object" || !parsed.sessionId) {
        continue;
      }
      const id = sanitizeSessionTitle(parsed.sessionId, 160);
      const name = sanitizeSessionTitle(parsed.name || parsed.title || "");
      map.set(id, {
        sessionId: id,
        name,
        pid: numberValue(parsed.pid),
        status: sanitizeSessionTitle(parsed.status || "", 32),
        updatedAt: numberValue(parsed.updatedAt),
        cwd: String(parsed.cwd || ""),
      });
    } catch (_) {
      continue;
    }
  }
  return map;
}

function readCodexSessionIndex(root, options) {
  const opts = options || {};
  const indexPath = path.resolve(
    opts.sessionIndexPath
      || process.env.CODEX_SESSION_INDEX
      || path.join(root, "..", "session_index.jsonl"),
  );
  const names = new Map();
  if (!fs.existsSync(indexPath)) {
    return names;
  }
  let body = "";
  try {
    body = fs.readFileSync(indexPath, "utf8");
  } catch (_) {
    return names;
  }

  for (const line of body.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const record = safeJsonParse(trimmed);
    if (!record || typeof record !== "object") {
      continue;
    }
    const id = sanitizeSessionTitle(record.id, 160);
    const title = sanitizeSessionTitle(record.thread_name || record.title || record.name);
    if (id && title) {
      names.set(id, { title, source: "Codex thread name" });
    }
  }
  return names;
}

function findLatestCodexSqlite(codexHome) {
  if (!codexHome || !fs.existsSync(codexHome)) {
    return "";
  }
  let entries = [];
  try {
    entries = fs.readdirSync(codexHome);
  } catch (_) {
    return "";
  }
  const candidates = entries
    .filter((name) => /^state_\d+\.sqlite$/i.test(name))
    .sort((a, b) => {
      const verA = Number((a.match(/\d+/) || [0])[0]);
      const verB = Number((b.match(/\d+/) || [0])[0]);
      return verB - verA;
    });
  return candidates.length > 0 ? path.join(codexHome, candidates[0]) : "";
}

function readCodexSqliteThreads(sqlitePath) {
  if (!sqlitePath || !fs.existsSync(sqlitePath)) {
    return [];
  }
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(sqlitePath, { readOnly: true });
    const rows = db.prepare(`
      SELECT
        id,
        rollout_path,
        created_at,
        updated_at,
        cwd,
        tokens_used,
        agent_nickname,
        agent_role,
        model,
        reasoning_effort
      FROM threads
      WHERE tokens_used > 0
      ORDER BY updated_at DESC
    `).all();
    return Array.isArray(rows) ? rows : [];
  } catch (_) {
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch (_) {
        // Ignore close errors on read-only handle
      }
    }
  }
}

// Claude Code streams one JSONL record per content block; all records of a
// message share message.id, repeat the prompt-side usage, and later records can
// carry a larger (final) output count. Grow the existing event to the
// field-wise max instead of counting the message again.
function growEventTokens(session, event, tokens) {
  const delta = emptyTokens();
  let grew = false;
  for (const key of Object.keys(delta)) {
    if (key === "totalTokens") continue;
    const diff = numberValue(tokens[key]) - numberValue(event.tokens[key]);
    if (diff > 0) {
      delta[key] = diff;
      event.tokens[key] += diff;
      grew = true;
    }
  }
  if (!grew) return false;
  delta.totalTokens = tokenTotal(delta);
  event.tokens.totalTokens = 0;
  event.tokens.totalTokens = tokenTotal(event.tokens);
  event.totalTokens = event.tokens.totalTokens;
  addTokens(session.tokens, delta);
  const cost = estimateCost(event.provider, event.model, event.tokens);
  const costDelta = cost.usd - event.costUsd;
  event.costUsd = cost.usd;
  event.pricingTier = cost.pricingTier || event.pricingTier;
  session.costUsd += costDelta;
  if (event.costKnown) {
    session.knownCostUsd += costDelta;
  } else {
    session.unknownCostTokens += delta.totalTokens;
  }
  return true;
}

function emitSession(opts, collect, sessions, events, session) {
  const finalized = finalizeSession(session);
  if (typeof opts.onSession === "function") {
    opts.onSession(finalized, session.events);
  }
  if (collect) {
    sessions.push(finalized);
    for (const event of session.events) {
      events.push(event);
    }
  }
  return finalized;
}

function fileAllowed(opts, fileInfo) {
  return typeof opts.fileFilter !== "function" || Boolean(opts.fileFilter(fileInfo));
}

async function parseClaude(root, sinceMs, options) {
  const opts = options || {};
  const collect = opts.collect !== false;
  const files = listJsonlFiles(root);
  const liveSessions = readClaudeLiveSessions(root, opts);
  const sessions = [];
  const events = [];
  const errors = [];
  let scannedFiles = 0;
  let duplicateUsageRecords = 0;
  let mergedUsageRecords = 0;
  for (const fileInfo of files) {
    if (sinceMs && fileInfo.mtimeMs && fileInfo.mtimeMs < sinceMs - 7 * MS_PER_DAY) {
      continue;
    }
    if (!fileAllowed(opts, fileInfo)) {
      continue;
    }
    scannedFiles += 1;
    if (typeof opts.onFile === "function") {
      opts.onFile(fileInfo, scannedFiles, files.length);
    }
    const session = createSession("claude", fileInfo, root);
    const eventsByMessageId = new Map();
    let sessionSlug = "";
    let turnIndex = 0;
    try {
      await readJsonLines(fileInfo.path, (record) => {
        if (record.timestamp) {
          const ms = parseTimestampMs(record.timestamp, fileInfo.mtimeMs || Date.now());
          session.startMs = session.startMs ? Math.min(session.startMs, ms) : ms;
          session.endMs = Math.max(session.endMs || 0, ms);
        }
        if (record.isSidechain || record.agentId) {
          session.isSubagent = true;
          session.subagentKind = session.subagentKind || "sidechain";
          if (record.agentId) {
            session.agentId = String(record.agentId);
          }
        }
        if (record.sessionId) {
          const rawSessionId = String(record.sessionId);
          if (session.isSubagent) {
            session.parentSessionId = rawSessionId;
            session.id = `${rawSessionId}:subagent:${session.agentId || path.basename(fileInfo.path, ".jsonl")}`;
          } else {
            session.id = rawSessionId;
          }
        }
        if (record.cwd) {
          session.cwd = String(record.cwd);
        }
        if (record.slug && !sessionSlug) {
          sessionSlug = sanitizeSessionTitle(record.slug, 72);
        }
        if (record.messageCount) {
          session.messageCount = Math.max(session.messageCount, numberValue(record.messageCount));
        }
        if (record.type === "custom-title") {
          setSessionTitle(session, record.customTitle, "Claude custom title", 6);
        }
        if (record.type === "agent-name") {
          setSessionTitle(session, record.agentName, "Claude agent name", 4);
        }

        const message = record.message && typeof record.message === "object" ? record.message : null;
        const usage = message && message.usage ? message.usage : null;
        if (!usage) {
          return;
        }

        const tokens = normalizeClaudeUsage(usage);
        if (tokenTotal(tokens) <= 0) {
          return;
        }
        const usageId = String(message.id || record.requestId || "");
        const existingEvent = usageId ? eventsByMessageId.get(usageId) : null;
        if (existingEvent) {
          duplicateUsageRecords += 1;
          if (growEventTokens(session, existingEvent, tokens)) {
            mergedUsageRecords += 1;
          }
          return;
        }
        turnIndex += 1;
        const model = String(message.model || record.model || session.model || "unknown");
        if (model !== "unknown") {
          session.model = model;
        }
        const timestampMs = parseTimestampMs(record.timestamp, fileInfo.mtimeMs || Date.now());
        const cost = estimateCost("claude", model, tokens);
        const event = {
          provider: "claude",
          id: `${session.id}:${turnIndex}`,
          sessionId: session.id,
          parentSessionId: session.parentSessionId || "",
          isSubagent: Boolean(session.isSubagent),
          turnIndex,
          file: session.relativeFile,
          project: session.project,
          cwd: session.cwd,
          model,
          reasoningEffort: "",
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
          pricingTier: cost.pricingTier || "standard",
          credits: 0,
          creditKnown: false,
        };
        addEvent(session, event);
        if (usageId) {
          eventsByMessageId.set(usageId, event);
        }
      });
    } catch (err) {
      errors.push({ file: fileInfo.path, error: err && err.message ? err.message : String(err) });
    }
    if (session.eventCount > 0) {
      const lookupId = session.parentSessionId || session.id;
      const liveMeta = liveSessions.get(lookupId);
      if (liveMeta) {
        session.liveStatus = liveMeta.status || "";
        session.livePid = liveMeta.pid || 0;
        if (!session.cwd && liveMeta.cwd) {
          session.cwd = liveMeta.cwd;
        }
        if (session.isSubagent && liveMeta.name) {
          const shortAgent = session.agentId ? `#${session.agentId.slice(0, 6)}` : "";
          const subLabel = sessionSlug
            ? `${sessionSlug}${shortAgent ? ` ${shortAgent}` : ""}`
            : (shortAgent ? `subagent ${shortAgent}` : "subagent");
          setSessionTitle(session, `${liveMeta.name} / ${subLabel}`, "Claude live session + subagent", 5);
        } else if (!session.isSubagent && liveMeta.name) {
          setSessionTitle(session, liveMeta.name, "Claude live session", 5);
        }
      }
      if (session.isSubagent && !session.title) {
        const shortAgent = session.agentId ? `#${session.agentId.slice(0, 6)}` : "";
        if (sessionSlug) {
          setSessionTitle(session, `${sessionSlug}${shortAgent ? ` ${shortAgent}` : ""} (subagent)`, "Claude subagent slug", 3);
        } else if (session.agentId) {
          setSessionTitle(session, `${session.project || "claude"} / subagent ${shortAgent}`, "Claude subagent id", 2);
        }
      }
      applySessionIdentityToEvents(session);
      emitSession(opts, collect, sessions, events, session);
    }
  }
  return {
    provider: "claude",
    root,
    files: files.length,
    scannedFiles,
    duplicateUsageRecords,
    mergedUsageRecords,
    sessions,
    events,
    errors,
  };
}

// Codex rollout lines start with a fixed header; only session_meta, turn_context
// and token_count events carry usage, so other (often multi-megabyte) records
// are handled from the header alone.
const CODEX_LINE_HEAD = /^\{"timestamp":"([^"]{20,40})",(?:"[a-z_]+":(?:\d+|"[^"]*"|true|false|null),)*?"type":"([a-z_]+)"(?:,"payload":\{"type":"([a-z_]+)")?/;
const CODEX_LINE_HEAD_CHARS = 160;
const CODEX_TOTAL_USAGE_KEYS = ["input_tokens", "cached_input_tokens", "output_tokens", "reasoning_output_tokens", "total_tokens"];
// Real responses in one thread are seconds apart; a fork's replayed history is
// written back-to-back within milliseconds.
const CODEX_REPLAY_GAP_MS = 250;

function codexReasoningEffort(payload) {
  if (!payload || typeof payload !== "object") return "";
  const settings = payload.collaboration_mode && typeof payload.collaboration_mode === "object"
    && payload.collaboration_mode.settings && typeof payload.collaboration_mode.settings === "object"
    ? payload.collaboration_mode.settings
    : {};
  const effort = payload.reasoning_effort || payload.reasoningEffort || payload.effort || settings.reasoning_effort || "";
  return effort ? String(effort) : "";
}

function codexSubagentSource(payload) {
  const source = payload && typeof payload === "object" ? payload.source : null;
  if (!source || typeof source !== "object" || !source.subagent) return null;
  const subagent = source.subagent;
  const spawn = subagent && typeof subagent === "object" && subagent.thread_spawn && typeof subagent.thread_spawn === "object"
    ? subagent.thread_spawn
    : null;
  const kind = spawn
    ? "thread_spawn"
    : subagent && typeof subagent === "object" && typeof subagent.other === "string"
      ? subagent.other
      : "subagent";
  return {
    kind,
    parentThreadId: String((spawn && spawn.parent_thread_id) || payload.parent_thread_id || ""),
    nickname: String((spawn && spawn.agent_nickname) || ""),
  };
}

function sameCodexTotals(current, previous) {
  if (!current || !previous) return false;
  for (const key of CODEX_TOTAL_USAGE_KEYS) {
    if (numberValue(current[key]) !== numberValue(previous[key])) return false;
  }
  return true;
}

// Cumulative totals grow monotonically inside a thread, so (total, output,
// last) identifies one response; a fork replays the parent's exact stream.
function codexUsageSignature(info) {
  const total = info.total_token_usage;
  if (!total || typeof total !== "object") return "";
  const last = info.last_token_usage && typeof info.last_token_usage === "object" ? info.last_token_usage : {};
  return `${numberValue(total.total_tokens)}:${numberValue(total.output_tokens)}:${numberValue(last.total_tokens)}`;
}

async function parseCodex(root, sinceMs, options) {
  const opts = options || {};
  const collect = opts.collect !== false;
  // Chronological order lets a parent thread claim its usage before any fork
  // that replays it.
  const files = listJsonlFiles(root).sort((a, b) => a.path.localeCompare(b.path));
  const sessionNames = readCodexSessionIndex(root, opts);
  const sessions = [];
  const events = [];
  const errors = [];
  const rateLimitSnapshots = [];
  const seenSessionIds = new Set();
  const seenRolloutPaths = new Set();
  const seenUsageByRoot = new Map();
  let scannedFiles = 0;
  let repeatedTokenCounts = 0;
  let replayedTokenCounts = 0;
  let burstTokenCounts = 0;

  for (const fileInfo of files) {
    seenRolloutPaths.add(path.resolve(fileInfo.path).toLowerCase());
    if (sinceMs && fileInfo.mtimeMs && fileInfo.mtimeMs < sinceMs - 7 * MS_PER_DAY) {
      continue;
    }
    if (!fileAllowed(opts, fileInfo)) {
      continue;
    }
    scannedFiles += 1;
    if (typeof opts.onFile === "function") {
      opts.onFile(fileInfo, scannedFiles, files.length);
    }
    const session = createSession("codex", fileInfo, root);
    let previousTotalUsage = null;
    let previousTokenCountMs = 0;
    let turnIndex = 0;
    let sessionMetaSeen = false;
    let rootSessionId = "";
    let forked = false;
    const touchTimestamp = (timestampMs) => {
      session.startMs = session.startMs ? Math.min(session.startMs, timestampMs) : timestampMs;
      session.endMs = Math.max(session.endMs || 0, timestampMs);
    };
    const skipUnusedLine = (line) => {
      const head = CODEX_LINE_HEAD.exec(line.length > CODEX_LINE_HEAD_CHARS ? line.slice(0, CODEX_LINE_HEAD_CHARS) : line);
      if (!head) return false;
      const type = head[2];
      if (type === "session_meta" || type === "turn_context") return false;
      if (type === "event_msg" && (!head[3] || head[3] === "token_count")) return false;
      if (line.includes("rate_limit")) return false;
      touchTimestamp(parseTimestampMs(head[1], fileInfo.mtimeMs || Date.now()));
      return true;
    };
    try {
      await readJsonLines(fileInfo.path, (record) => {
        const timestampMs = parseTimestampMs(record.timestamp, fileInfo.mtimeMs || Date.now());
        touchTimestamp(timestampMs);

        const payload = record.payload && typeof record.payload === "object" ? record.payload : {};
        const rateLimits = payload.rate_limits || payload.rateLimits || payload.rate_limit_snapshot || payload.rateLimitSnapshot || record.rate_limits || record.rateLimits;
        if (rateLimits && collect) {
          rateLimitSnapshots.push(...normalizeRateLimitSnapshot(rateLimits, timestampMs));
        }
        if (record.type === "session_meta") {
          // A forked sub-thread replays its parent's session_meta right after
          // its own, so only the first record names this file's thread.
          const ownMeta = !sessionMetaSeen;
          sessionMetaSeen = true;
          if (!ownMeta || payload.forked_from_id) {
            forked = true;
          }
          if (ownMeta && payload.id) {
            session.id = String(payload.id);
            rootSessionId = String(payload.session_id || payload.id);
            const indexed = sessionNames.get(session.id);
            if (indexed) {
              setSessionTitle(session, indexed.title, indexed.source, 5);
            }
          }
          if (ownMeta && payload.agent_nickname) {
            setSessionTitle(session, payload.agent_nickname, "Codex agent name", 3);
          }
          const subagentSource = ownMeta ? codexSubagentSource(payload) : null;
          if (subagentSource) {
            session.isSubagent = true;
            session.subagentKind = sanitizeSessionTitle(subagentSource.kind, 32);
            session.parentSessionId = subagentSource.parentThreadId || session.parentSessionId;
            session.agentId = sanitizeSessionTitle(subagentSource.nickname || subagentSource.kind, 48);
          }
          if (ownMeta && !session.parentSessionId && payload.forked_from_id) {
            session.parentSessionId = String(payload.forked_from_id);
          }
          if (payload.cwd && (ownMeta || !session.cwd)) {
            session.cwd = String(payload.cwd);
            session.project = path.basename(session.cwd);
          }
          if (payload.model && (ownMeta || session.model === "unknown")) {
            session.model = String(payload.model);
          }
          const metaEffort = codexReasoningEffort(payload);
          if (metaEffort && (ownMeta || !session.reasoningEffort)) {
            session.reasoningEffort = metaEffort;
          }
          return;
        }

        if (record.type === "turn_context") {
          if (payload.cwd) {
            session.cwd = String(payload.cwd);
            session.project = path.basename(session.cwd);
          }
          if (payload.model) {
            session.model = String(payload.model);
          }
          const turnEffort = codexReasoningEffort(payload);
          if (turnEffort) {
            session.reasoningEffort = turnEffort;
          }
          return;
        }

        if (record.type !== "event_msg" || payload.type !== "token_count") {
          return;
        }
        const info = payload.info && typeof payload.info === "object" ? payload.info : {};
        // A snapshot whose cumulative totals did not move repeats the previous
        // last_token_usage and carries no new usage.
        if (info.total_token_usage && sameCodexTotals(info.total_token_usage, previousTotalUsage)) {
          repeatedTokenCounts += 1;
          return;
        }
        const signature = codexUsageSignature(info);
        if (signature) {
          const rootKey = rootSessionId || session.id;
          let seenSignatures = seenUsageByRoot.get(rootKey);
          if (!seenSignatures) {
            seenSignatures = new Set();
            seenUsageByRoot.set(rootKey, seenSignatures);
          }
          if (seenSignatures.has(signature)) {
            replayedTokenCounts += 1;
            previousTotalUsage = info.total_token_usage;
            return;
          }
          seenSignatures.add(signature);
        }
        if (forked && previousTokenCountMs && timestampMs - previousTokenCountMs < CODEX_REPLAY_GAP_MS) {
          burstTokenCounts += 1;
          previousTotalUsage = info.total_token_usage || previousTotalUsage;
          previousTokenCountMs = timestampMs;
          return;
        }
        previousTokenCountMs = timestampMs;
        let tokens = null;
        if (info.last_token_usage) {
          tokens = normalizeCodexUsage(info.last_token_usage);
        } else if (info.total_token_usage) {
          tokens = diffCodexTotals(info.total_token_usage, previousTotalUsage);
        }
        if (info.total_token_usage) {
          previousTotalUsage = info.total_token_usage;
        }
        if (!tokens || tokenTotal(tokens) <= 0) {
          return;
        }

        turnIndex += 1;
        const model = String(info.model || payload.model || session.model || "unknown");
        const cost = estimateCost("codex", model, tokens);
        const credit = estimateCredits("codex", model, tokens);
        const event = {
          provider: "codex",
          id: `${session.id}:${turnIndex}`,
          sessionId: session.id,
          parentSessionId: session.parentSessionId || "",
          isSubagent: Boolean(session.isSubagent),
          turnIndex,
          file: session.relativeFile,
          project: session.project,
          cwd: session.cwd,
          model,
          reasoningEffort: session.reasoningEffort || "",
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
          pricingTier: cost.pricingTier || "standard",
          credits: credit.credits,
          creditKnown: credit.known,
        };
        addEvent(session, event);
      }, skipUnusedLine);
    } catch (err) {
      errors.push({ file: fileInfo.path, error: err && err.message ? err.message : String(err) });
    }
    if (session.eventCount > 0) {
      seenSessionIds.add(session.id);
      for (const event of session.events) {
        if (!event.model || event.model === "unknown") {
          event.model = session.model || "unknown";
        }
      }
      applySessionIdentityToEvents(session);
      emitSession(opts, collect, sessions, events, session);
    }
  }

  const sqlitePath = opts.includeSqlite === false
    ? ""
    : opts.sqlitePath
      || process.env.CODEX_STATE_DB
      || findLatestCodexSqlite(path.resolve(root, ".."));
  const sqliteRows = readCodexSqliteThreads(sqlitePath);
  let sqliteRecoveredCount = 0;

  for (const row of sqliteRows) {
    const threadId = String(row.id || "").trim();
    const totalUsed = numberValue(row.tokens_used);
    if (!threadId || totalUsed <= 0 || seenSessionIds.has(threadId)) {
      continue;
    }
    const rolloutPath = String(row.rollout_path || "").trim();
    if (rolloutPath && seenRolloutPaths.has(path.resolve(rolloutPath).toLowerCase())) {
      continue;
    }
    const updatedMs = numberValue(row.updated_at) > 1e11 ? numberValue(row.updated_at) : numberValue(row.updated_at) * 1000;
    const createdMs = numberValue(row.created_at) > 1e11 ? numberValue(row.created_at) : numberValue(row.created_at) * 1000;
    const endMs = updatedMs || Date.now();
    const startMs = createdMs || endMs;
    if (sinceMs && endMs < sinceMs - 7 * MS_PER_DAY) {
      continue;
    }

    const cwd = String(row.cwd || "");
    const project = cwd ? path.basename(cwd) : "codex";
    const model = String(row.model || "gpt-6.1-sol");
    const reasoningEffort = sanitizeSessionTitle(row.reasoning_effort || "", 24);
    const isSubagent = Boolean(row.agent_nickname || row.agent_role);
    const session = {
      provider: "codex",
      id: threadId,
      parentSessionId: "",
      agentId: sanitizeSessionTitle(row.agent_nickname || "", 48),
      isSubagent,
      subagentKind: isSubagent ? "thread_spawn" : "",
      liveStatus: "",
      livePid: 0,
      reasoningEffort,
      sourceType: "sqlite",
      file: rolloutPath || sqlitePath,
      relativeFile: rolloutPath ? path.basename(rolloutPath) : `state_sqlite:${threadId.slice(0, 12)}`,
      project,
      cwd,
      model,
      title: "",
      displayName: "",
      nameSource: "",
      namePriority: 0,
      startMs,
      endMs,
      eventCount: 0,
      messageCount: 1,
      costUsd: 0,
      knownCostUsd: 0,
      unknownCostTokens: 0,
      credits: 0,
      creditKnownTokens: 0,
      pricingLabels: new Set(),
      tokens: emptyTokens(),
      events: [],
    };

    const indexed = sessionNames.get(threadId);
    if (indexed) {
      setSessionTitle(session, indexed.title, indexed.source, 5);
    } else if (row.agent_nickname) {
      const roleSuffix = row.agent_role ? ` (${sanitizeSessionTitle(row.agent_role, 32)})` : "";
      setSessionTitle(session, `${sanitizeSessionTitle(row.agent_nickname, 48)}${roleSuffix} - ${project}`, "Codex SQLite agent", 4);
    } else {
      setSessionTitle(session, `${project} #${threadId.slice(0, 8)}`, "Codex SQLite thread", 2);
    }

    const tokens = emptyTokens();
    tokens.totalTokens = totalUsed;
    const event = {
      provider: "codex",
      id: `${threadId}:1`,
      sessionId: threadId,
      parentSessionId: "",
      isSubagent,
      turnIndex: 1,
      file: session.relativeFile,
      project,
      cwd,
      model,
      reasoningEffort,
      timestampMs: endMs,
      timestamp: new Date(endMs).toISOString(),
      date: localDateKey(endMs),
      hour: localHourKey(endMs),
      tokens,
      totalTokens: totalUsed,
      costUsd: 0,
      costKnown: false,
      pricingLabel: "Token total; breakdown unavailable",
      pricingEstimated: false,
      pricingTier: "unknown",
      credits: 0,
      creditKnown: false,
      syntheticThreadTotal: true,
    };
    addEvent(session, event);
    session.startMs = Math.min(startMs, endMs);
    session.endMs = Math.max(startMs, endMs);
    applySessionIdentityToEvents(session);
    emitSession(opts, collect, sessions, events, session);
    seenSessionIds.add(threadId);
    sqliteRecoveredCount += 1;
  }

  return {
    provider: "codex",
    root,
    sqlitePath: sqliteRecoveredCount > 0 ? sqlitePath : "",
    sqliteThreads: sqliteRecoveredCount,
    files: files.length + sqliteRecoveredCount,
    scannedFiles,
    repeatedTokenCounts,
    replayedTokenCounts,
    burstTokenCounts,
    sessions,
    events,
    errors,
    rateLimitSnapshots,
  };
}

function listImportedFiles(root) {
  if (!root || !fs.existsSync(root)) {
    return [];
  }
  let stat = null;
  try {
    stat = fs.statSync(root);
  } catch (_) {
    return [];
  }
  if (stat.isFile()) {
    return /\.jsonl?$/i.test(root) ? [{ path: root, size: stat.size, mtimeMs: stat.mtimeMs }] : [];
  }
  return listJsonlFiles(root).concat(listJsonFiles(root));
}

function listJsonFiles(root) {
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
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith(".json")) {
        let stat = null;
        try {
          stat = fs.statSync(fullPath);
        } catch (_) {
          stat = null;
        }
        out.push({ path: fullPath, size: stat ? stat.size : 0, mtimeMs: stat ? stat.mtimeMs : 0 });
      }
    }
  }
  return out;
}

function importedProvider(value) {
  const name = String(value || "imported").trim().toLowerCase();
  if (/claude|anthropic/.test(name)) return "claude";
  if (/codex|openai|chatgpt/.test(name)) return "codex";
  return sanitizeSessionTitle(name.replace(/[^a-z0-9._-]+/g, "-"), 40) || "imported";
}

async function readImportedRecords(filePath, onRecord) {
  if (filePath.toLowerCase().endsWith(".jsonl")) {
    await readJsonLines(filePath, (record) => onRecord(record));
    return;
  }
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return;
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed && parsed.records)
      ? parsed.records
      : Array.isArray(parsed && parsed.events)
        ? parsed.events
        : [parsed];
  for (const row of rows) {
    if (row && typeof row === "object") onRecord(row);
  }
}

async function parseImportedUsage(root, sinceMs) {
  const files = listImportedFiles(root);
  const sessions = [];
  const events = [];
  const errors = [];
  const seen = new Set();
  const rootDir = root && fs.existsSync(root) && fs.statSync(root).isDirectory() ? root : path.dirname(String(root || ""));

  for (const fileInfo of files) {
    if (sinceMs && fileInfo.mtimeMs && fileInfo.mtimeMs < sinceMs - 7 * MS_PER_DAY) continue;
    const sessionMap = new Map();
    let rowIndex = 0;
    try {
      await readImportedRecords(fileInfo.path, (record) => {
        rowIndex += 1;
        const tokens = normalizeImportedUsage(record);
        if (tokenTotal(tokens) <= 0) return;
        const provider = importedProvider(record.provider || record.source || record.tool);
        const model = String(record.model || record.model_id || record.modelId || "unknown").trim() || "unknown";
        const sessionId = String(record.session_id || record.sessionId || record.thread_id || record.threadId || path.basename(fileInfo.path, path.extname(fileInfo.path))).trim();
        const suppliedId = String(record.id || record.event_id || record.eventId || "").trim();
        const dedupeKey = `${provider}:${suppliedId || `${sessionId}:${rowIndex}`}`;
        if (seen.has(dedupeKey)) return;
        seen.add(dedupeKey);
        const sessionKey = `${provider}:${sessionId}`;
        let session = sessionMap.get(sessionKey);
        if (!session) {
          session = createSession(provider, fileInfo, rootDir);
          session.sourceType = "import";
          session.id = sessionId;
          session.project = "imported usage";
          sessionMap.set(sessionKey, session);
        }
        session.model = session.model === "unknown" ? model : session.model;
        const timestampMs = parseTimestampMs(record.timestamp || record.time || record.created_at || record.createdAt, fileInfo.mtimeMs || Date.now());
        if (sinceMs && timestampMs < sinceMs) return;
        const costProvider = provider === "claude" || provider === "codex" ? provider : "unknown";
        const cost = estimateCost(costProvider, model, tokens);
        const credit = estimateCredits(costProvider, model, tokens);
        const turnIndex = session.eventCount + 1;
        const event = {
          provider,
          id: `${session.id}:${turnIndex}`,
          dedupeKey,
          sessionId: session.id,
          parentSessionId: String(record.parent_session_id || record.parentSessionId || ""),
          isSubagent: Boolean(record.is_subagent || record.isSubagent || record.role === "subagent"),
          turnIndex,
          file: session.relativeFile,
          project: session.project,
          cwd: "",
          model,
          reasoningEffort: String(record.reasoning_effort || record.reasoningEffort || ""),
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
          pricingTier: cost.pricingTier || "standard",
          credits: credit.credits,
          creditKnown: credit.known,
        };
        addEvent(session, event);
        events.push(event);
      });
    } catch (err) {
      errors.push({ file: fileInfo.path, error: err && err.message ? err.message : String(err) });
    }
    for (const session of sessionMap.values()) {
      if (session.eventCount > 0) {
        applySessionIdentityToEvents(session);
        sessions.push(finalizeSession(session));
      }
    }
  }
  return { provider: "imported", root, files: files.length, sessions, events, errors };
}

function finalizeSession(session) {
  const tokens = session.tokens;
  const durationMs = Math.max(0, (session.endMs || 0) - (session.startMs || 0));
  const identity = getSessionIdentity(session);
  return {
    provider: session.provider,
    id: session.id,
    parentSessionId: session.parentSessionId || "",
    agentId: session.agentId || "",
    isSubagent: Boolean(session.isSubagent),
    subagentKind: session.subagentKind || "",
    liveStatus: session.liveStatus || "",
    livePid: session.livePid || 0,
    reasoningEffort: session.reasoningEffort || "",
    sourceType: session.sourceType || "jsonl",
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
    durationMinutes: durationMs / MS_PER_MINUTE,
    eventCount: session.eventCount,
    messageCount: session.messageCount,
    tokens,
    totalTokens: tokenTotal(tokens),
    cacheHitRatio: cacheHitRatio(tokens),
    costUsd: session.costUsd,
    knownCostUsd: session.knownCostUsd,
    unknownCostTokens: session.unknownCostTokens,
    credits: session.credits,
    creditKnownTokens: session.creditKnownTokens,
    pricingLabels: Array.from(session.pricingLabels).sort(),
  };
}

function addGroup(map, key, base) {
  if (!map.has(key)) {
    map.set(key, Object.assign({
      costUsd: 0,
      knownCostUsd: 0,
      unknownCostTokens: 0,
      credits: 0,
      creditKnownTokens: 0,
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
    parentSessionId: event.parentSessionId || "",
    isSubagent: Boolean(event.isSubagent),
    turnIndex: event.turnIndex,
    file: event.file,
    project: event.project,
    cwd: event.cwd,
    title: event.title || "",
    displayName: event.displayName || "",
    nameSource: event.nameSource || "",
    model: event.model,
    reasoningEffort: event.reasoningEffort || "",
    timestamp: event.timestamp,
    timestampMs: event.timestampMs,
    totalTokens: event.totalTokens,
    tokens: event.tokens,
    costUsd: event.costUsd,
    costKnown: event.costKnown,
    pricingLabel: event.pricingLabel,
    pricingEstimated: event.pricingEstimated,
    pricingTier: event.pricingTier || "standard",
    credits: numberValue(event.credits),
    creditKnown: Boolean(event.creditKnown),
    recommendation: buildTurnRecommendation(event),
  };
}

function buildSubagentStats(sessions, events, totalTokens) {
  let subagentTokens = 0;
  let subagentCostUsd = 0;
  let subagentSessionCount = 0;
  let mainSessionCount = 0;
  const effortMap = new Map();

  for (const session of sessions) {
    if (session.isSubagent) {
      subagentTokens += numberValue(session.totalTokens);
      subagentCostUsd += numberValue(session.costUsd);
      subagentSessionCount += 1;
    } else {
      mainSessionCount += 1;
    }
  }

  for (const event of events) {
    const effort = sanitizeSessionTitle(event.reasoningEffort || "", 24).toLowerCase();
    if (!effort) {
      continue;
    }
    const row = addGroup(effortMap, effort, { effort });
    addWindowTotal(row, event);
  }

  const mainTokens = Math.max(0, numberValue(totalTokens) - subagentTokens);
  return {
    subagentTokens,
    mainTokens,
    subagentCostUsd,
    subagentSessionCount,
    mainSessionCount,
    subagentShare: totalTokens > 0 ? subagentTokens / totalTokens : 0,
    effortTotals: Array.from(effortMap.values()).sort((a, b) => b.totalTokens - a.totalTokens),
  };
}

function buildSummary(parsed, options) {
  const opts = options || {};
  const nowMs = Date.now();
  const days = Math.max(1, Number(opts.days || DEFAULT_DAYS));
  const sinceMs = nowMs - days * MS_PER_DAY;
  const providerFilter = String(opts.provider || "all").toLowerCase();
  const allEvents = [];
  const allSessions = [];
  const seenEventKeys = new Set();
  const sourceSessionLookup = new Map();
  for (const source of parsed) {
    for (const sess of source.sessions || []) {
      sourceSessionLookup.set(`${sess.provider}:${sess.id}:${sess.file}`, sess);
    }
  }
  const totals = {
    costUsd: 0,
    knownCostUsd: 0,
    unknownCostTokens: 0,
    breakdownUnknownTokens: 0,
    credits: 0,
    creditKnownTokens: 0,
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
      if (!includeProvider(providerFilter, event.provider)) {
        continue;
      }

      const eventKey = event.dedupeKey
        || `${event.provider}:${event.sessionId}:${event.turnIndex}:${event.timestampMs}:${event.totalTokens}`;
      if (seenEventKeys.has(eventKey)) {
        continue;
      }
      seenEventKeys.add(eventKey);

      const sessionKey = `${event.provider}:${event.sessionId}:${event.file}`;
      const sessionMeta = sourceSessionLookup.get(sessionKey);
      const inLastHour = event.timestampMs >= nowMs - MS_PER_HOUR;
      const inLast5h = event.timestampMs >= nowMs - 5 * MS_PER_HOUR;
      const inLast24h = event.timestampMs >= nowMs - MS_PER_DAY;
      const inLast7d = event.timestampMs >= nowMs - 7 * MS_PER_DAY;

      if (!event.syntheticThreadTotal && inLastHour) {
        addWindowTotal(windows.lastHour, event);
        addProviderPlanWindow(planWindowStats, event, "lastHour");
      }
      if (!event.syntheticThreadTotal && inLast5h) {
        addWindowTotal(windows.last5h, event);
        addProviderPlanWindow(planWindowStats, event, "last5h");
        addEventToRangeSession(addRangeSession(fiveHourSessionMap, sessionKey, event, sessionMeta), event);
      }
      if (!event.syntheticThreadTotal && inLast24h) {
        addWindowTotal(windows.last24h, event);
      }
      if (!event.syntheticThreadTotal && inLast7d) {
        addWindowTotal(windows.last7d, event);
        addProviderPlanWindow(planWindowStats, event, "last7d");
        addEventToRangeSession(addRangeSession(weeklySessionMap, sessionKey, event, sessionMeta), event);
      }
      if (!event.syntheticThreadTotal && localDateKey(event.timestampMs) === localDateKey(nowMs)) {
        addWindowTotal(windows.today, event);
      }

      if (event.timestampMs < sinceMs) {
        continue;
      }
      allEvents.push(event);
      addWindowTotal(totals, event);
      addWindowTotal(windows.selectedRange, event);

      const providerGroup = addGroup(providerMap, event.provider, { provider: event.provider });
      addWindowTotal(providerGroup, event);

      const modelKey = `${event.provider}:${event.model || "unknown"}`;
      const modelGroup = addGroup(modelMap, modelKey, { provider: event.provider, model: event.model || "unknown" });
      addWindowTotal(modelGroup, event);

       if (!event.syntheticThreadTotal) {
         const dayKey = `${event.date}:${event.provider}`;
         const dayGroup = addGroup(dayMap, dayKey, { date: event.date, provider: event.provider });
         addWindowTotal(dayGroup, event);

         const hourKey = `${event.hour}:${event.provider}`;
         const hourGroup = addGroup(hourMap, hourKey, { hour: event.hour, provider: event.provider });
         addWindowTotal(hourGroup, event);
       }

      const sessionGroup = addRangeSession(sessionMap, sessionKey, event, sessionMeta);
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
  const turnCandidates = allEvents.filter((event) => !event.syntheticThreadTotal);
  const topEventsSource = turnCandidates.length > 0 ? turnCandidates : allEvents;
  const topEvents = topEventsSource
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

  const subagentStats = buildSubagentStats(allSessions, allEvents, totals.totalTokens);
  const modelCatalog = buildModelCatalog(modelTotals);
  const rateLimitSnapshots = parsed.flatMap((source) => source.rateLimitSnapshots || []);
  const observedRateLimits = buildObservedRateLimits(rateLimitSnapshots, nowMs);
  const budgetPace = buildBudgetPace(windows);
  const weeklyPace = budgetPace.weekly;
  const planPace = buildPlanPace(planWindowStats, opts);
  const budgetSessions = buildBudgetSessions(fiveHourSessionMap, weeklySessionMap, budgetPace);
  const insightContext = {
    totals,
    windows,
    providerTotals,
    modelTotals,
    topSessions,
    topEvents,
    weeklyPace,
    budgetPace,
    budgetSessions,
    planPace,
    subagentStats,
    observedRateLimits,
    task: String(opts.task || "auto"),
  };

  return {
    generatedAt: new Date(nowMs).toISOString(),
    range: { days, since: new Date(sinceMs).toISOString(), provider: providerFilter },
    roots: {
      claude: parsed.find((source) => source.provider === "claude"),
      codex: parsed.find((source) => source.provider === "codex"),
      imported: parsed.find((source) => source.provider === "imported"),
    },
    totals,
    windows,
    providerTotals,
    modelTotals,
    subagentStats,
    modelCatalog,
    observedRateLimits,
    daily,
    hourly,
    topSessions,
    topEvents,
    budgetPace,
    planPace,
    weeklyPace,
    budgetSessions,
    promptGuidance: buildPromptGuidance(insightContext),
    workflowGuidance: buildWorkflowGuidance(insightContext, opts.task),
    insights: buildInsights(insightContext),
    recommendations: buildRecommendations(insightContext),
    pricingNotice: "API dollars and credits are estimates from timestamped usage with a known token breakdown, not provider invoices or subscription counters. SQLite recovery contributes token totals only; its cumulative totals are excluded from cache, cost, and pacing breakdowns. Plans publish message windows and fair-use limits, not fixed included token caps; set local budgets for a separate envelope.",
  };
}

function addRangeSession(map, key, event, sessionMeta) {
  if (!map.has(key)) {
    const meta = sessionMeta || {};
    map.set(key, {
      provider: event.provider,
      id: event.sessionId,
      parentSessionId: event.parentSessionId || meta.parentSessionId || "",
      agentId: meta.agentId || "",
      isSubagent: Boolean(event.isSubagent || meta.isSubagent),
      liveStatus: meta.liveStatus || "",
      livePid: meta.livePid || 0,
      reasoningEffort: event.reasoningEffort || meta.reasoningEffort || "",
      sourceType: meta.sourceType || "jsonl",
      file: event.file,
      project: event.project || meta.project || "",
      cwd: event.cwd || meta.cwd || "",
      title: event.title || meta.title || "",
      displayName: event.displayName || event.title || meta.displayName || "",
      nameSource: event.nameSource || meta.nameSource || "",
      model: event.model || meta.model || "unknown",
      startMs: meta.startMs || event.timestampMs,
      endMs: meta.endMs || event.timestampMs,
      start: meta.start || event.timestamp,
      end: meta.end || event.timestamp,
      durationMinutes: meta.durationMinutes || 0,
      eventCount: 0,
      messageCount: meta.messageCount || 0,
      tokens: emptyTokens(),
      totalTokens: 0,
      cacheHitRatio: 0,
      costUsd: 0,
      knownCostUsd: 0,
      unknownCostTokens: 0,
      credits: 0,
      creditKnownTokens: 0,
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
  session.durationMinutes = Math.max(session.durationMinutes || 0, Math.max(0, session.endMs - session.startMs) / MS_PER_MINUTE);
  session.eventCount += 1;
  if ((!session.model || session.model === "unknown") && event.model) {
    session.model = event.model;
  }
  if (!session.reasoningEffort && event.reasoningEffort) {
    session.reasoningEffort = event.reasoningEffort;
  }
  if ((!session.title || !session.displayName) && (event.title || event.displayName)) {
    session.title = event.title || session.title || "";
    session.displayName = event.displayName || event.title || session.displayName || "";
    session.nameSource = event.nameSource || session.nameSource || "metadata";
  }
  addTokens(session.tokens, event.tokens);
  session.totalTokens = tokenTotal(session.tokens);
  session.cacheHitRatio = cacheHitRatio(session.tokens);
  session.costUsd += event.costUsd;
  session.credits += numberValue(event.credits);
  if (event.creditKnown) {
    session.creditKnownTokens += event.totalTokens;
  }
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
    breakdownUnknownTokens: 0,
    credits: 0,
    creditKnownTokens: 0,
    eventCount: 0,
    sessionCount: 0,
    tokens: emptyTokens(),
    totalTokens: 0,
  };
}

function addWindowTotal(target, event) {
  target.costUsd += numberValue(event.costUsd);
  target.credits += numberValue(event.credits);
  if (event.creditKnown) {
    target.creditKnownTokens += event.totalTokens;
  }
  if (event.costKnown) {
    target.knownCostUsd += numberValue(event.costUsd);
  } else {
    target.unknownCostTokens += event.totalTokens;
  }
  target.eventCount += 1;
  if (event.syntheticThreadTotal) {
    target.breakdownUnknownTokens = numberValue(target.breakdownUnknownTokens) + event.totalTokens;
  }
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

function readResetAt(names) {
  for (const name of names) {
    const value = String(process.env[name] || "").trim();
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return "";
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
    measuredTokensPerHour: lastHourTokens,
    resetAt: readResetAt(["AI_SPEND_5H_RESET_AT", "AI_SPEND_FIVE_HOUR_RESET_AT"]),
    projectionNote: "Projection uses the observed last-hour token rate; it is not a provider quota counter.",
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
    measuredTokensPerHour: lastHourTokens,
    resetAt: readResetAt(["AI_SPEND_WEEKLY_RESET_AT"]),
    projectionNote: "Projection uses observed rolling-window and hourly rates; it is not a provider quota counter.",
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
  const status = preset.unlimitedFiveHour
    ? { status: "ok", statusText: preset.unlimitedText || "No five-hour limit is published for this plan." }
    : planLimitStatus(last5h.totalTokens, projected5hTokens, minBudgetTokens, maxBudgetTokens);

  return {
    provider,
    planId,
    label: preset.label,
    detail: preset.detail || "",
    source: preset.source || "",
    promoUntil: preset.promoUntil || "",
    unlimitedFiveHour: Boolean(preset.unlimitedFiveHour),
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
  if (/^gpt-6-astra/i.test(value)) {
    return "gpt6astra";
  }
  if (/^gpt-6\.1-sol/i.test(value)) {
    return "gpt61sol";
  }
  if (/^gpt-6\.1-terra/i.test(value)) {
    return "gpt61terra";
  }
  if (/^gpt-6-sol/i.test(value)) {
    return "gpt6sol";
  }
  if (/^gpt-6-luna/i.test(value)) {
    return "gpt6luna";
  }
  if (/^gpt-5\.6-sol/i.test(value)) {
    return "gpt6sol";
  }
  if (/^gpt-5\.6-terra/i.test(value)) {
    return "gpt61terra";
  }
  if (/^gpt-5\.6-luna/i.test(value)) {
    return "gpt6luna";
  }
  if (/^gpt-5\.4-mini/i.test(value)) {
    return "gpt54mini";
  }
  if (/^gpt-5\.4/i.test(value)) {
    return "gpt54";
  }
  if (/^gpt-5\.3-codex-spark/i.test(value)) {
    return "gpt53spark";
  }
  if (/^gpt-5\.3-codex/i.test(value)) {
    return "gpt53codex";
  }
  if (/^gpt-5\.5/i.test(value)) {
    return "gpt55";
  }
  if (/codex/i.test(value)) {
    return "gpt53codex";
  }
  return "gpt61sol";
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
  if (provider === "claude") {
    return "Claude Code";
  }
  if (provider === "codex") {
    return "Codex CLI";
  }
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
  const frontierTokens = sumModelTokens(summary.modelTotals, /^(gpt-6-astra|gpt-6\.1-sol|claude-(fable-5-1|opus-5))/i);
  const frontierShare = totalTokens > 0 ? frontierTokens / totalTokens : 0;
  const subagentStats = summary.subagentStats || {};
  const subagentShare = numberValue(subagentStats.subagentShare);
  const last24 = summary.windows.last24h;
  const lastHour = summary.windows.lastHour;
  const hourSpike = lastHour.totalTokens > 0 && last24.totalTokens > 0 && lastHour.totalTokens > (last24.totalTokens / 24) * 2.5;
  const pace = summary.weeklyPace || {};
  const fiveHour = summary.budgetPace && summary.budgetPace.fiveHour ? summary.budgetPace.fiveHour : {};
  const fiveHourPressure = fiveHour.status === "risk" || fiveHour.status === "over";

  return [
    {
      severity: frontierShare >= 0.45 ? "high" : "info",
      title: "Use GPT-6 frontier models for planning gates",
      target: frontierTokens > 0 ? `${formatCount(frontierTokens)} frontier tokens` : "Model routing",
      detail: "Spend GPT-6 Astra, GPT-6.1 Sol, Claude Fable 5.1, and Opus 5.5 on ambiguity, architecture, and review. Route bounded work to Terra, Luna, Sonnet 5.5, or Haiku 5.5.",
      doNow: [
        "Lock the plan, file write set, and acceptance criteria on Astra, Sol, Fable, or Opus first.",
        "Delegate bounded implementation to GPT-6.1 Terra, GPT-6 Luna, Claude Sonnet 5.5, or Haiku 5.5.",
      ],
    },
    {
      severity: subagentShare >= 0.4 || fiveHourPressure ? "high" : "info",
      title: "Cap subagent fan-out & /fast discovery",
      target: subagentStats.subagentTokens > 0
        ? `${formatCount(subagentStats.subagentTokens)} subagent tokens (${Math.round(subagentShare * 100)}%)`
        : fiveHour.budgetTokens > 0
          ? `${formatCount(fiveHour.remainingTokens)} 5h remaining`
          : hourSpike ? "Last-hour spike" : "Subagents & /fast",
      detail: "Parallel Claude subagents and /fast mode multiply context reads across every spawned worker. Keep exploration single-threaded until the write set is known.",
      doNow: [
        "Give each subagent an explicit file list and completion gate instead of open repo search.",
        "Reserve /fast and GPT-5.3 Codex Spark for tight edit-and-test loops.",
      ],
    },
    {
      severity: "info",
      title: "Match reasoning effort to risk",
      target: "low / medium vs xhigh / ultra",
      detail: "GPT-6 Astra, Sol, and Terra support effort controls through max. Higher effort multiplies reasoning output and latency without helping when the spec is already explicit.",
      doNow: [
        "Use low or medium effort on Terra or Luna for scoped implementation and test fixes.",
        "Escalate to xhigh or ultra on Sol only for multi-system architecture or subtle race/memory bugs.",
      ],
    },
    {
      severity: fiveHourPressure ? "high" : "info",
      title: "Protect the 5h window",
      target: fiveHour.budgetTokens > 0 ? `${formatCount(fiveHour.usedTokens)} of ${formatCount(fiveHour.budgetTokens)}` : "5h budget",
      detail: fiveHour.statusText || "Set a 5-hour envelope to catch short burst limits from Opus 5.5 or Sol subagent swarms before the weekly chart moves.",
      doNow: [
        "Treat the 5-hour remaining number as the subagent and fast-mode guardrail.",
        "When it is low, finish the current scoped edit or checkpoint and pause broad discovery.",
      ],
    },
    {
      severity: pace.status === "risk" || pace.status === "over" ? "high" : "info",
      title: "Pace the weekly envelope",
      target: pace.budgetTokens > 0 ? `${formatCount(pace.last7dTokens)} of ${formatCount(pace.budgetTokens)}` : "Weekly budget",
      detail: pace.statusText || "Track projected runout across rolling 7-day windows, not just single-turn cost.",
      doNow: [
        "Watch last-hour pace against the rolling 7-day envelope.",
        "If projected use crosses the envelope, summarize, narrow context, or step down model tier.",
      ],
    },
  ];
}

function buildWorkflowGuidance(summary, task) {
  const mode = ["auto", "explore", "implement", "review", "repeat"].includes(String(task || "auto"))
    ? String(task || "auto")
    : "auto";
  const totalTokens = numberValue(summary.totals && summary.totals.totalTokens);
  const cacheRatio = cacheHitRatio(summary.totals && summary.totals.tokens ? summary.totals.tokens : emptyTokens());
  const contextRatio = contextTokenRatio(summary.totals && summary.totals.tokens ? summary.totals.tokens : emptyTokens());
  const subagentShare = numberValue(summary.subagentStats && summary.subagentStats.subagentShare);
  const topModel = summary.modelTotals && summary.modelTotals[0] ? summary.modelTotals[0].model : "an observed model";
  const guidance = [];

  if (mode === "explore" || (mode === "auto" && subagentShare >= 0.3)) {
    guidance.push({
      severity: subagentShare >= 0.3 ? "high" : "info",
      title: "Explore with one bounded thread",
      target: "Workflow / exploration",
      detail: subagentShare >= 0.3
        ? "Subagents are a large share of the observed burn. Search locally first, then delegate only independent questions."
        : "Start with a local file search and a short evidence packet before opening parallel work.",
      doNow: [
        "Use the smallest available model tier for file discovery and inventory.",
        "Keep any existing search or code-navigation skill scoped to named paths; AI Spend does not install skills automatically.",
      ],
    });
  }

  if (mode === "implement" || (mode === "auto" && cacheRatio < 0.2 && totalTokens >= 10000)) {
    guidance.push({
      severity: cacheRatio < 0.2 ? "high" : "info",
      title: "Use an efficient implementation loop",
      target: `Model suggestion: efficient tier after a compact plan (${topModel} observed most often)`,
      detail: cacheRatio < 0.2
        ? "Low cache reuse means repeated broad context is expensive. Keep the write set and test command explicit."
        : "Bounded edits and focused tests rarely need the strongest reasoning tier.",
      doNow: [
        "Ask for the exact files and acceptance test, then edit only that set.",
        "Use low or medium effort where supported; reserve frontier reasoning for ambiguity or final review.",
      ],
    });
  }

  if (mode === "review" || (mode === "auto" && contextRatio >= 0.65)) {
    guidance.push({
      severity: contextRatio >= 0.85 ? "high" : "info",
      title: "Review from a compact handoff",
      target: "Workflow / review",
      detail: contextRatio >= 0.65
        ? "Most observed usage is input/context. Preserve decisions and test evidence, not the entire thread."
        : "A focused review packet makes a stronger model spend easier to justify.",
      doNow: [
        "Summarize changed files, risks, and the failing or passing command before review.",
        "Choose a stronger model only for the decision or review that needs it; do not assume the dashboard can switch models for you.",
      ],
    });
  }

  if (mode === "repeat" || (mode === "auto" && cacheRatio >= 0.2 && guidance.length === 0)) {
    guidance.push({
      severity: "info",
      title: "Preserve useful cache reuse",
      target: `${Math.round(cacheRatio * 100)}% observed cache reuse`,
      detail: "Keep stable instructions and file scope together when repeating a task; start a fresh thread when the goal changes.",
      doNow: [
        "Repeat the same narrow task shape before adding unrelated context.",
        "Use a compact skill/workflow checklist already available in your toolchain; no automatic skill installation is performed.",
      ],
    });
  }

  return guidance.slice(0, 3);
}

function quotePowerShellPath(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return `'${text.replace(/'/g, "''")}'`;
}

function launchCommandForSession(session) {
  const tool = session.provider === "claude" ? "claude" : session.provider === "codex" ? "codex" : "";
  if (!tool) {
    return "";
  }
  const cwd = quotePowerShellPath(session.cwd);
  return cwd ? `cd ${cwd}; ${tool}` : tool;
}

function targetCliWindow(session) {
  const cwd = sanitizeSessionTitle(session.cwd || session.project || "", 120);
  const suffix = cwd ? ` in ${cwd}` : "";
  const statusBadge = session.liveStatus ? ` [${session.liveStatus}${session.livePid ? ` PID ${session.livePid}` : ""}]` : "";
  return `${providerDisplay(session.provider)} window for "${sessionDisplayName(session)}"${statusBadge}${suffix}`;
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
    const longLivedNote = durationMinutes >= 240
      ? " Large history can inflate input on later turns; restart from a compact handoff when the task changes."
      : "";
    return {
      label: "Summarize and restart",
      severity: "high",
      detail: `"${name}" is ${Math.round(share * 100)}% of the selected range and has been active for ${formatDurationMinutes(durationMinutes)}.${longLivedNote}`,
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

  if (total >= TOKENS_PER_MILLION || contextRatio >= 0.9) {
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
  const frontierTokens = sumModelTokens(summary.modelTotals, /^(gpt-6-astra|gpt-6\.1-sol|claude-(fable-5-1|opus-5))/i);
  const frontierShare = summary.totals.totalTokens > 0 ? frontierTokens / summary.totals.totalTokens : 0;
  const subagentStats = summary.subagentStats || {};
  const recentCutoffMs = Date.now() - 2 * MS_PER_HOUR;

  function push(key, item) {
    if (!item || used.has(key)) {
      return;
    }
    used.add(key);
    recommendations.push(item);
  }

  const observedLimit = selectFreshLimitPressure(summary.observedRateLimits);
  if (observedLimit) {
    const observed = `${numberValue(observedLimit.usedPercent).toFixed(1)}% observed`;
    const projection = observedLimit.projectedPercent === null || observedLimit.projectedPercent === undefined
      ? "no safe forecast"
      : `${numberValue(observedLimit.projectedPercent).toFixed(1)}% projected by reset`;
    push("observed-limit", {
      severity: "high",
      title: "Protect the observed limit",
      target: `${providerDisplay(observedLimit.provider)} ${observedLimit.limitName || "allowance"}: ${observed}`,
      reason: `${observedLimit.statusText} This is provider-reported allowance telemetry; token totals and API estimates do not prove subscription quota.`,
      doNow: [
        "Pause unbounded discovery and extra agents until the current window resets or the next task is explicitly bounded.",
        "Save a compact handoff and stop the current session if it has changed purpose; do not keep paying to rebuild old context.",
        "Use another provider only when its own window is separately observed; AI Spend cannot infer shared subscription capacity.",
      ],
      ask: `Checkpoint the current work and identify one bounded next action. Treat this as ${projection}; do not estimate remaining quota from token counts.`,
      cli: [],
    });
  }

  if (fiveHourPace.status === "risk" || fiveHourPace.status === "over") {
    push("five-hour-pace", {
      severity: "high",
      title: "Stop the 5h drain",
      target: fiveHourPace.budgetTokens > 0 ? `${formatCount(fiveHourPace.remainingTokens)} tokens remaining` : "5h envelope",
      reason: fiveHourPace.statusText,
      doNow: [
        "Pause /fast, subagent fan-out, and broad discovery until the rolling 5-hour pressure drops.",
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
        "Stop open-ended fast-mode or xhigh/ultra work until the next task is bounded.",
        "Summarize active sessions and continue only with the file list, failing command, and acceptance criteria.",
        "Use GPT-6.1 Terra, GPT-6 Luna, Claude Sonnet 5.5, or Haiku 5.5 for scoped execution; reserve Astra, Sol, Fable, and Opus for ambiguity or review.",
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

  const recentMainSessions = summary.topSessions.filter((session) => session.endMs >= recentCutoffMs && !session.isSubagent);
  const recentSessions = recentMainSessions.length >= 2
    ? recentMainSessions
    : summary.topSessions.filter((session) => session.endMs >= recentCutoffMs);
  if (recentSessions.length >= 2) {
    const names = recentSessions.slice(0, 4).map((session) => `${providerDisplay(session.provider)}: ${sessionDisplayName(session)}`).join("; ");
    push("recent-sessions", {
      severity: "high",
      title: "Close duplicate active agents",
      target: `${recentSessions.length} sessions had log activity in the last 2 hours`,
      reason: "Parallel stale terminals and subagents can keep adding turns, miss cache, and make it unclear which agent is burning tokens.",
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
        "Stop broad follow-up prompts until you know which session or subagent swarm caused the spike.",
        "Open Largest Turns, find the matching session, and split the next ask by file group or failing command.",
        "Do not use /fast or xhigh/ultra effort again until the write set and acceptance test are explicit.",
      ],
      ask: "Before continuing, propose a smaller next step that uses the fewest files, names the acceptance test, and avoids re-reading old context.",
      cli: [
        'rg -n "<error-or-symbol>" .',
        "Paste only the relevant output into the next Claude/Codex turn.",
      ],
    });
  }

  if (numberValue(subagentStats.subagentShare) >= 0.35 && numberValue(subagentStats.subagentTokens) >= 50000) {
    push("subagent-fanout", {
      severity: "high",
      title: "Trim subagent fan-out",
      target: `${subagentStats.subagentSessionCount} subagent sessions (${Math.round(subagentStats.subagentShare * 100)}% of tokens)`,
      reason: `Subagents consumed ${formatCount(subagentStats.subagentTokens)} tokens in this range. Each spawned subagent builds its own context window.`,
      doNow: [
        "Keep routine multi-file changes with one implementation owner.",
        "Pass subagents exact file paths and line ranges instead of letting every worker search the repo.",
        "Use Claude Sonnet 5.5, Haiku 5.5, or GPT-6 Luna for bounded worker subagents.",
      ],
      ask: "Do not spawn subagents for this task unless independent workstreams require it. Handle the edit directly on the main thread.",
      cli: [],
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
        "Use Codex (GPT-6.1 Terra or GPT-6 Luna) for repo search, mechanical edits, and test-loop fixes.",
        "Bring GPT-6 Astra, GPT-6.1 Sol, Claude Fable 5.1, or Opus 5.5 the narrowed result for architecture, UX, or review decisions.",
      ],
      ask: "Codex: inspect the repo for this exact issue, return the relevant files and a minimal patch plan, and do not edit until I approve the write set.",
      cli: [
        "codex",
        "claude",
      ],
    });
  }

  if (frontierShare >= 0.35) {
    push("route-frontier", {
      severity: "info",
      title: "Step down from frontier models after planning",
      target: `${formatCount(frontierTokens)} frontier (Astra / Sol / Fable / Opus) tokens`,
      reason: "GPT-6 Astra, GPT-6.1 Sol, Claude Fable 5.1, and Opus 5.5 are best spent on ambiguity and review. Once scope is clear, execute on Terra, Luna, Sonnet 5.5, or Haiku 5.5.",
      doNow: [
        "Ask Sol or Opus 5.5 for the write set, risks, and acceptance criteria.",
        "Execute with GPT-6.1 Terra, GPT-6 Luna, Claude Sonnet 5.5, or Haiku 5.5 using low or medium effort.",
        "Bring the completed diff back for review only if decision quality matters.",
      ],
      ask: "Plan only: identify the exact files, success criteria, risks, and test command. Do not implement in this turn.",
      cli: [
        "codex",
        "Use a scoped prompt with exact files and tests.",
      ],
    });
  }

  if (topEvent) {
    push(`turn:${topEvent.provider}:${topEvent.sessionId}:${topEvent.turnIndex}`, {
      severity: topEvent.totalTokens >= TOKENS_PER_MILLION ? "high" : "info",
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
  const subagentStats = summary.subagentStats || {};
  const observedLimit = selectFreshLimitPressure(summary.observedRateLimits);

  if (observedLimit) {
    const projection = observedLimit.projectedPercent === null || observedLimit.projectedPercent === undefined
      ? "No safe forecast is available without two fresh samples on the same reset window."
      : `The current slope projects ${numberValue(observedLimit.projectedPercent).toFixed(1)}% by reset.`;
    insights.push({
      severity: "high",
      title: "Observed limit pressure",
      detail: `${providerDisplay(observedLimit.provider)} reports ${numberValue(observedLimit.usedPercent).toFixed(1)}% used on its ${observedLimit.limitName || "allowance"} window. ${projection} This is measured provider telemetry, not a quota derived from token totals.`,
    });
  }

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

  if (codex && summary.totals.totalTokens > 0) {
    const codexShare = codex.totalTokens / summary.totals.totalTokens;
    if (codexShare >= 0.65) {
      insights.push({
        severity: "high",
        title: "Codex dominates this range",
        detail: `Codex accounts for ${Math.round(codexShare * 100)}% of selected tokens across local JSONL and SQLite thread history.`,
      });
    }
  }

  if (numberValue(subagentStats.subagentTokens) > 0 && summary.totals.totalTokens > 0) {
    const subShare = Math.round(numberValue(subagentStats.subagentShare) * 100);
    insights.push({
      severity: subShare >= 40 ? "high" : "info",
      title: "Subagent token share",
      detail: `${subagentStats.subagentSessionCount} subagent sessions used ${formatCount(subagentStats.subagentTokens)} tokens (${subShare}% of range, ~${ `$${numberValue(subagentStats.subagentCostUsd).toFixed(2)}` }).`,
    });
  }

  if (last24.totalTokens > 0) {
    const hourlyPace = Math.round(last24.totalTokens / 24);
    insights.push({
      severity: last24.totalTokens >= TOKENS_PER_MILLION ? "high" : "info",
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

  const recentCutoffMs = Date.now() - 2 * MS_PER_HOUR;
  const recentMainSessions = summary.topSessions.filter((session) => session.endMs >= recentCutoffMs && !session.isSubagent);
  const recentSessions = recentMainSessions.length >= 2
    ? recentMainSessions
    : summary.topSessions.filter((session) => session.endMs >= recentCutoffMs);
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
  if (n >= 1000 * TOKENS_PER_MILLION) {
    return `${(n / (1000 * TOKENS_PER_MILLION)).toFixed(2)}B`;
  }
  if (n >= TOKENS_PER_MILLION) {
    return `${(n / TOKENS_PER_MILLION).toFixed(1)}M`;
  }
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1)}K`;
  }
  return String(n);
}

function formatDurationMinutes(value) {
  const minutes = Math.max(0, Math.round(numberValue(value)));
  if (minutes >= 1440) {
    return `${(minutes / 1440).toFixed(1)}d`;
  }
  if (minutes >= 60) {
    return `${(minutes / 60).toFixed(1)}h`;
  }
  return `${minutes}m`;
}

async function parseAllUsage(options) {
  const opts = options || {};
  const days = Math.max(1, Number(opts.days || DEFAULT_DAYS));
  const logDays = Math.max(days, 7);
  const sinceMs = Date.now() - logDays * MS_PER_DAY;
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
  const claudeRoot = path.resolve(opts.claudeRoot || process.env.CLAUDE_PROJECTS_ROOT || path.join(os.homedir(), ".claude", "projects"));
  const codexRoot = path.resolve(opts.codexRoot || process.env.CODEX_SESSIONS_ROOT || path.join(codexHome, "sessions"));
  const importRoot = opts.importRoot || process.env.AI_SPEND_IMPORT_ROOT || process.env.AI_SPEND_IMPORT || "";
  const [claude, codex, imported] = await Promise.all([
    parseClaude(claudeRoot, sinceMs, opts),
    parseCodex(codexRoot, sinceMs, opts),
    parseImportedUsage(importRoot, sinceMs),
  ]);
  return [claude, codex, imported];
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
      respond(res, HTTP_NOT_FOUND, "Not found");
      return;
    }
    respond(res, HTTP_OK, body, contentType || "text/html; charset=utf-8");
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
      respondJson(res, HTTP_METHOD_NOT_ALLOWED, { ok: false, error: "Method not allowed" });
      return;
    }

    if (parsed.path === "/" || parsed.path === "/dashboard") {
      serveFile(res, dashboardPath, "text/html; charset=utf-8");
      return;
    }

    if (parsed.path === "/favicon.ico") {
      res.statusCode = HTTP_NO_CONTENT;
      res.end();
      return;
    }

    if (parsed.path === "/health") {
      respondJson(res, HTTP_OK, { ok: true, name: "ai-spend-dashboard" });
      return;
    }

    if (parsed.path === "/api/summary") {
      try {
        const days = Math.max(1, Number(parsed.query.get("days") || DEFAULT_DAYS));
        const provider = String(parsed.query.get("provider") || "all").toLowerCase();
        const task = String(parsed.query.get("task") || "auto").toLowerCase();
        const claudePlan = String(parsed.query.get("claudePlan") || "").toLowerCase();
        const codexPlan = String(parsed.query.get("codexPlan") || "").toLowerCase();
        const sources = await parseAllUsage({ days });
        const summary = buildSummary(sources, { days, provider, task, claudePlan, codexPlan });
        respondJson(res, HTTP_OK, summary);
      } catch (err) {
        respondJson(res, HTTP_SERVER_ERROR, {
          ok: false,
          error: err && err.message ? err.message : String(err),
        });
      }
      return;
    }

    respond(res, HTTP_NOT_FOUND, "Not found");
  });
}

function parseArgs(argv) {
  const out = { port: DEFAULT_PORT, days: DEFAULT_DAYS, provider: "all", task: "auto", claudePlan: "", codexPlan: "", summary: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--summary") {
      out.summary = true;
    } else if (arg === "--days") {
      out.days = Number(argv[++i] || DEFAULT_DAYS);
    } else if (arg === "--provider") {
      out.provider = String(argv[++i] || "all").toLowerCase();
    } else if (arg === "--task") {
      out.task = String(argv[++i] || "auto").toLowerCase();
    } else if (arg === "--claude-plan") {
      out.claudePlan = String(argv[++i] || "").toLowerCase();
    } else if (arg === "--codex-plan") {
      out.codexPlan = String(argv[++i] || "").toLowerCase();
    } else if (arg === "--port") {
      out.port = Number(argv[++i] || DEFAULT_PORT);
    } else if (/^\d+$/.test(arg)) {
      out.port = Number(arg);
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.summary) {
    const sources = await parseAllUsage({ days: args.days });
    const summary = buildSummary(sources, { days: args.days, provider: args.provider, task: args.task, claudePlan: args.claudePlan, codexPlan: args.codexPlan });
    console.log(JSON.stringify({
      generatedAt: summary.generatedAt,
      range: summary.range,
      totals: summary.totals,
      providerTotals: summary.providerTotals,
      modelTotals: summary.modelTotals,
      observedRateLimits: summary.observedRateLimits,
      subagentStats: summary.subagentStats,
      budgetPace: summary.budgetPace,
      planPace: summary.planPace,
      weeklyPace: summary.weeklyPace,
      budgetSessions: summary.budgetSessions,
      promptGuidance: summary.promptGuidance,
      insights: summary.insights,
      recommendations: summary.recommendations,
      workflowGuidance: summary.workflowGuidance,
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
  addTokens,
  buildModelCatalog,
  buildObservedRateLimits,
  buildSummary,
  createServer,
  emptyTokens,
  estimateCost,
  estimateCredits,
  buildWorkflowGuidance,
  findClaudePricing,
  findOpenAiPricing,
  listJsonlFiles,
  localDateKey,
  normalizeClaudeUsage,
  normalizeCodexUsage,
  normalizeImportedUsage,
  numberValue,
  parseAllUsage,
  parseClaude,
  parseCodex,
  parseImportedUsage,
  tokenTotal,
};
