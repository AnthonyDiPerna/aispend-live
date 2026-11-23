#!/usr/bin/env node
// Export a sanitized snapshot of the local Guard controller for the public site.
// Output holds percentages, hashed task IDs, counters, model IDs, optimizer guidance, and policy values only:
// no prompts, paths, account identity, or file names. Usage:
//   node tools/export-guard-snapshot.js [--url http://127.0.0.1:9021] [--state-dir <dir>] [--out public/guard-snapshot.json]
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { buildPlan } = require('./usage-guard');

function loadOptimizer() {
  try {
    return require('./subscription-optimizer');
  } catch {
    return null;
  }
}

function flag(name, fallback) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

const span = (h) => !Number.isFinite(h) || h < 0 ? null : h < 1 ? Math.max(1, Math.round(h * 60)) + 'm' : h < 48 ? Math.round(h) + 'h' : Math.round(h / 24) + 'd';
const PATH_TEXT_RE = /[A-Za-z]:\\[^\s"'`,)]+|\/(?:Users|home|var|tmp|etc|opt|mnt|Volumes)\/[^\s"'`,)]+|~\/[^\s"'`,)]+/g;
const stripPath = (value, maxLen = 220) => String(value == null ? '' : value).replace(PATH_TEXT_RE, '<path>').slice(0, maxLen);
const numOrNull = (value) => (value != null && Number.isFinite(Number(value)) ? Math.round(Number(value) * 10) / 10 : null);
const ALLOWED_PROVIDERS = new Set(['claude', 'codex', 'agy']);

async function loadState(url, stateDir) {
  if (url) {
    try {
      const r = await fetch(new URL('/api/state', url), { signal: AbortSignal.timeout(5000) });
      if (r.ok) return { public: await r.json(), source: 'controller' };
    } catch {}
  }
  const file = path.join(stateDir, 'state.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  const now = Date.now();
  const plan = buildPlan(raw, now);
  const optMod = loadOptimizer();
  const optimizer = optMod && typeof optMod.buildOptimizationPlan === 'function'
    ? optMod.buildOptimizationPlan(plan, raw.insights || null, now)
    : null;
  return {
    public: {
      ...plan,
      optimizer,
      tasks: Object.values(raw.tasks || {}),
      events: raw.events || [],
      impact: raw.impact || {},
      insights: raw.insights || null,
      accounting: raw.accounting || {},
    },
    source: 'state-file',
  };
}

// Footer text exactly as the Pi extension renders it, for the site example.
function footer(state, currentGroup) {
  const labels = { claude: 'Claude', codex: 'Codex', agy: 'AGY' };
  const order = state.policy?.providerOrder || ['claude', 'codex', 'agy'];
  const lowest = (p) => p.windows.filter((w) => w.applies).sort((a, b) => a.remainingPercent - b.remainingPercent)[0];
  const rows = order.map((id) => state.providers.find((p) => p.provider === id)).filter(Boolean).map((p) => ({ p, w: lowest(p) }));
  const cells = rows.map(({ p, w }) => {
    const active = p.provider === currentGroup;
    let cell = (active ? '▸' : '') + labels[p.provider] + ' ' + (w ? Math.max(0, w.remainingPercent).toFixed(0) + '%' : '?');
    if (p.status === 'depleted') cell += '∅';
    if (p.status === 'blocked') cell += '⛔';
    if (active && w && Number.isFinite(w.slopePercentPerHour) && w.slopePercentPerHour >= 0.1) cell += ' −' + (w.slopePercentPerHour < 1 ? w.slopePercentPerHour.toFixed(1) : Math.round(w.slopePercentPerHour)) + '%/h';
    return cell;
  });
  const current = rows.find((r) => r.p.provider === currentGroup);
  const fallback = rows.find((r) => r.p.provider !== currentGroup && r.p.status === 'ready' && r.w && r.w.remainingPercent > (state.policy?.reservePercent ?? 10));
  const bridge = rows.find((r) => r.p.provider === state.policy?.bridgeProvider && r.p.provider !== currentGroup);
  let next = '';
  if (current && ['depleted', 'stale', 'verify-reset', 'blocked'].includes(current.p.status)) next = fallback ? 'switch to ' + labels[fallback.p.provider] : 'wait for a fresh reading';
  else if (current?.w && Number.isFinite(current.w.depletionHours) && current.w.depletionHours < current.w.hoursLeft) next = labels[current.p.provider] + ' runs out in ' + span(current.w.depletionHours) + (fallback ? ', then ' + labels[fallback.p.provider] : '');
  else if (bridge?.w) next = labels[bridge.p.provider] + ' resets in ' + span(bridge.w.hoursLeft);
  else if (current?.w) next = labels[current.p.provider] + ' resets in ' + span(current.w.hoursLeft);
  return 'Guard · ' + cells.join(' · ') + (next ? ' · next: ' + next : '');
}

function sanitizeOptimizer(opt) {
  if (!opt || typeof opt !== 'object') return null;
  const providers = Array.isArray(opt.providers)
    ? opt.providers
      .filter((p) => p && ALLOWED_PROVIDERS.has(p.provider))
      .map((p) => ({
        provider: p.provider,
        label: stripPath(p.label || p.provider, 40),
        status: stripPath(p.status || 'unknown', 32),
        utilizationState: stripPath(p.utilizationState || 'unknown', 32),
        remainingPercent: p.remainingPercent != null && Number.isFinite(Number(p.remainingPercent)) ? Math.round(Math.max(0, Number(p.remainingPercent))) : null,
        usablePercent: p.usablePercent != null && Number.isFinite(Number(p.usablePercent)) ? Math.round(Math.max(0, Number(p.usablePercent))) : null,
        resetIn: p.resetIn ? stripPath(p.resetIn, 24) : (Number.isFinite(Number(p.hoursLeft)) ? span(Number(p.hoursLeft)) : null),
        resetAt: p.resetAt || null,
        hoursLeft: numOrNull(p.hoursLeft),
        targetPercentPerDay: numOrNull(p.targetPercentPerDay),
        projectedUnusedAtReset: numOrNull(p.projectedUnusedAtReset),
        bankedResets: p.bankedResets != null && Number.isFinite(Number(p.bankedResets))
          ? Number(p.bankedResets)
          : (p.bankedResets && Number.isFinite(Number(p.bankedResets.availableCount)) ? Number(p.bankedResets.availableCount) : 0),
        windows: Array.isArray(p.windows) ? p.windows.map((w) => ({
          windowId: stripPath(w.windowId || w.id || '', 48),
          modelFamily: w.modelFamily ? stripPath(w.modelFamily, 32) : null,
          label: stripPath(w.label || w.windowId || w.id || '', 64),
          remainingPercent: w.remainingPercent != null && Number.isFinite(Number(w.remainingPercent)) ? Math.round(Math.max(0, Number(w.remainingPercent))) : null,
          resetIn: w.resetIn ? stripPath(w.resetIn, 24) : (Number.isFinite(Number(w.hoursLeft)) ? span(Number(w.hoursLeft)) : null),
          status: stripPath(w.status || 'unknown', 32),
          applies: Boolean(w.applies),
        })) : [],
        playbook: p.playbook && typeof p.playbook === 'object' ? {
          mode: stripPath(p.playbook.mode || 'steady', 24),
          headline: stripPath(p.playbook.headline || '', 160),
          badges: Array.isArray(p.playbook.badges) ? p.playbook.badges.slice(0, 8).map((b) => stripPath(b, 48)) : [],
          knobs: Array.isArray(p.playbook.knobs) ? p.playbook.knobs.slice(0, 8).map((k) => {
            const st = String(k && k.state || 'steady').toLowerCase();
            return {
              id: stripPath(k && k.id || '', 40),
              label: stripPath(k && k.label || '', 64),
              state: ['boost', 'steady', 'tighten', 'off'].includes(st) ? st : 'steady',
              value: stripPath(k && k.value || '', 80),
              reason: stripPath(k && k.reason || '', 180),
              ...(k && k.command ? { command: stripPath(k.command, 80) } : {}),
            };
          }) : [],
          guidance: Array.isArray(p.playbook.guidance) ? p.playbook.guidance.slice(0, 6).map((g) => stripPath(g, 200)) : [],
          commands: Array.isArray(p.playbook.commands) ? p.playbook.commands.slice(0, 6).map((c) => stripPath(c, 80)) : [],
        } : null,
      }))
    : [];
  const alerts = Array.isArray(opt.alerts)
    ? opt.alerts.slice(0, 10).map((a) => ({
      kind: stripPath(a.kind || 'info', 32),
      severity: stripPath(a.severity || 'info', 16),
      provider: a.provider && ALLOWED_PROVIDERS.has(a.provider) ? a.provider : null,
      title: stripPath(a.title || '', 120),
      detail: stripPath(a.detail || '', 220),
      command: a.command ? stripPath(a.command, 80) : null,
    }))
    : [];
  const nextUnlock = opt.nextUnlock && typeof opt.nextUnlock === 'object'
    ? {
      provider: ALLOWED_PROVIDERS.has(opt.nextUnlock.provider) ? opt.nextUnlock.provider : null,
      windowId: opt.nextUnlock.windowId ? stripPath(opt.nextUnlock.windowId, 48) : null,
      resetAt: opt.nextUnlock.resetAt || null,
      hoursLeft: numOrNull(opt.nextUnlock.hoursLeft),
      resetIn: Number.isFinite(Number(opt.nextUnlock.hoursLeft)) ? span(Number(opt.nextUnlock.hoursLeft)) : null,
      label: stripPath(opt.nextUnlock.label || '', 80),
    }
    : null;
  const quickCommands = Array.isArray(opt.quickCommands)
    ? opt.quickCommands.slice(0, 8).map((q) => ({
      tool: stripPath(q.tool || '', 24),
      label: stripPath(q.label || '', 60),
      command: stripPath(q.command || '', 80),
      why: stripPath(q.why || '', 140),
    }))
    : [];
  return {
    headline: stripPath(opt.headline || '', 180),
    strategy: stripPath(opt.strategy || 'balanced', 24),
    primaryProvider: ALLOWED_PROVIDERS.has(opt.primaryProvider) ? opt.primaryProvider : null,
    secondaryProvider: ALLOWED_PROVIDERS.has(opt.secondaryProvider) ? opt.secondaryProvider : null,
    nextUnlock,
    recommendedOrder: Array.isArray(opt.recommendedOrder) ? opt.recommendedOrder.filter((id) => ALLOWED_PROVIDERS.has(id)) : [],
    providers,
    alerts,
    quickCommands,
  };
}

function sanitize(state, source) {
  const now = Date.now();
  const providers = (state.providers || []).filter((p) => p.provider !== 'api').map((p) => {
    const rows = (p.windows || []).filter((w) => w.applies).sort((a, b) => a.remainingPercent - b.remainingPercent);
    const w = rows[0];
    return {
      provider: p.provider,
      status: p.status,
      blocked: p.status === 'blocked',
      configured: Boolean(p.configured),
      model: p.binding?.model || null,
      remainingPercent: w ? Math.round(Math.max(0, w.remainingPercent)) : null,
      resetIn: w ? span(w.hoursLeft) : null,
      resetAt: w?.resetAt || null,
      burnPercentPerHour: w && Number.isFinite(w.slopePercentPerHour) ? Math.round(w.slopePercentPerHour * 10) / 10 : null,
      runOutIn: w && Number.isFinite(w.depletionHours) && w.depletionHours < w.hoursLeft ? span(w.depletionHours) : null,
      windows: (p.windows || []).map((x) => ({
        id: x.windowId,
        modelFamily: x.modelFamily || null,
        remainingPercent: Math.round(Math.max(0, x.remainingPercent)),
        resetIn: span(x.hoursLeft),
        applies: Boolean(x.applies),
      })),
    };
  });
  const policy = state.policy || {};
  // Collapse bursts: the same intervention kind on the same task within two seconds counts once.
  const seen = new Map();
  const interventions = {};
  const impactEvents = Array.isArray(state.impact?.events) ? state.impact.events : [];
  if (!impactEvents.length && state.impact) {
    for (const k of ['loopBlocks', 'subagentBlocks', 'repairs', 'switches']) {
      if (state.impact[k]) interventions[k] = state.impact[k];
    }
  }
  for (const e of impactEvents) {
    const key = e.taskId + '|' + e.kind;
    const t = Date.parse(e.at);
    if (seen.has(key) && Math.abs(seen.get(key) - t) < 2000) {
      seen.set(key, t);
      continue;
    }
    seen.set(key, t);
    interventions[e.kind] = (interventions[e.kind] || 0) + 1;
  }
  const tasks = (state.tasks || []).map((t) => ({
    id: String(t.id).slice(0, 8),
    requests: t.requests || 0,
    tokens: t.totalTokens || 0,
    status: t.status,
    provider: t.provider || null,
    startedAt: t.startedAt || null,
    minutes: t.startedAt && t.updatedAt ? Math.round((Date.parse(t.updatedAt) - Date.parse(t.startedAt)) / 60000) : null,
    contextTokens: t.contextTokens || null,
    trimmedChars: t.removedChars || 0,
  }));
  const events = (state.events || []).slice(-40).map((e) => ({
    at: e.at,
    kind: e.kind,
    detail: String(e.detail).replace(/[A-Za-z]:\\[^\s]+|\/[^\s]*\//g, '<path>').slice(0, 220),
  }));
  const insights = state.insights ? {
    since: state.insights.since,
    providers: (state.insights.providers || []).map((p) => ({
      provider: p.provider,
      requests: p.requests,
      totalTokens: p.totalTokens,
      cachePercent: p.inputTokens ? Math.round(100 * p.cachedInputTokens / p.inputTokens) : null,
      metrics: (p.metrics || []).map((m) => ({ id: m.id, label: m.label, percent: m.percent })),
    })),
  } : null;

  let rawOptimizer = state.optimizer || null;
  if (!rawOptimizer && Array.isArray(state.providers)) {
    const optMod = loadOptimizer();
    if (optMod && typeof optMod.buildOptimizationPlan === 'function') {
      try {
        rawOptimizer = optMod.buildOptimizationPlan(state, state.insights || null, now);
      } catch {}
    }
  }
  const optimizer = sanitizeOptimizer(rawOptimizer);

  return {
    generatedAt: new Date(now).toISOString(),
    source,
    version: require('../package.json').version,
    policy: {
      usageMode: policy.usageMode,
      providerOrder: policy.providerOrder,
      blockedProviders: policy.blockedProviders || [],
      reservePercent: policy.reservePercent,
      maxRequestsPerTask: policy.maxRequestsPerTask,
      maxTaskMinutes: policy.maxTaskMinutes,
      maxContextTokens: policy.maxContextTokens,
      maxThinkingLevel: policy.maxThinkingLevel,
      maxSubagentCalls: policy.maxSubagentCalls,
      allowApiSpend: policy.allowApiSpend,
    },
    recommendedProvider: state.recommendedProvider || null,
    footer: footer(state, state.recommendedProvider || undefined),
    providers,
    ...(optimizer ? { optimizer } : {}),
    tasks,
    interventions,
    impact: {
      removedChars: state.impact?.removedChars || 0,
      estimatedInputTokensAvoided: state.impact?.estimatedInputTokensAvoided || 0,
      loopBlocks: state.impact?.loopBlocks || 0,
    },
    insights,
    events,
    note: 'Sanitized local snapshot: percentages, hashed task prefixes, optimizer guidance, counters and model IDs. No prompts, files or account identity.',
  };
}

async function main() {
  const url = flag('--url', process.env.AI_SPEND_GUARD_URL || 'http://127.0.0.1:9021');
  const stateDir = flag('--state-dir', process.env.AI_SPEND_GUARD_DIR || path.join(os.homedir(), '.aispend-live', 'guard'));
  const out = flag('--out', path.resolve(__dirname, '../public/guard-snapshot.json'));
  const { public: state, source } = await loadState(url, stateDir);
  const snapshot = sanitize(state, source);
  const text = JSON.stringify(snapshot, null, 1);
  if (/[A-Za-z]:\\|\/Users\/|\/home\//.test(text)) throw Error('Snapshot still contains a filesystem path');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, text);
  console.log(`Wrote ${out} (${source}): ${snapshot.footer}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}

module.exports = { sanitize, sanitizeOptimizer, footer };
