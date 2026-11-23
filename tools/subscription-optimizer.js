// Deterministic Multi-Subscription Value Optimizer (Claude + Codex + Antigravity/AGY).
// Zero Node-only imports so export-guard-demo.js can bundle this directly into public/guard.html.

const PROVIDER_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'Antigravity (AGY)',
};

const SHORT_LABELS = {
  claude: 'Claude',
  codex: 'Codex',
  agy: 'AGY',
};

const SUBSCRIPTION_IDS = ['claude', 'codex', 'agy'];

function round1(value) {
  return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
}

function clampPct(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function formatSpan(hours) {
  if (!Number.isFinite(hours) || hours < 0) return '?';
  if (hours === 0) return '0m';
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  const totalHours = Math.round(hours);
  if (totalHours < 48) return `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function windowLabel(provider, win) {
  const id = String(win.windowId || '').toLowerCase();
  const family = String(win.modelFamily || '').toLowerCase();
  const isWeekly = win.windowMinutes >= 1440 || id.includes('week') || id === 'codex:primary';
  const spanLabel = isWeekly ? 'weekly' : '5h session';

  if (provider === 'agy') {
    if (family === 'gemini-argon' || id.startsWith('gemini-argon')) return `Gemini Argon ${spanLabel}`;
    if (family === 'claude-gpt' || id.startsWith('claude-gpt')) return `Claude/GPT ${spanLabel}`;
    if (family === 'gemini' || id.startsWith('gemini')) return `Gemini ${spanLabel}`;
    return `AGY ${spanLabel}`;
  }
  if (provider === 'claude') {
    if (family) return `${family[0].toUpperCase()}${family.slice(1)} ${spanLabel}`;
    return isWeekly ? 'All models weekly' : '5h session';
  }
  if (provider === 'codex') {
    if (id.includes('secondary') || (!isWeekly && win.windowMinutes <= 600)) return '5h session';
    return isWeekly ? 'Weekly limit' : 'Session limit';
  }
  return id || spanLabel;
}

function isFreshWindow(win) {
  return Boolean(win) && !['stale', 'verify-reset'].includes(win.status);
}

function normalizeWindows(provider, rawWindows) {
  return (Array.isArray(rawWindows) ? rawWindows : []).map((w) => {
    const remainingPercent = round1(clampPct(w.remainingPercent ?? (100 - (w.usedPercent ?? 100))));
    const usedPercent = round1(clampPct(w.usedPercent ?? (100 - remainingPercent)));
    const hoursLeft = Number.isFinite(w.hoursLeft) ? Math.max(0, round1(w.hoursLeft)) : null;
    return {
      windowId: String(w.windowId || 'unknown'),
      modelFamily: w.modelFamily || null,
      label: windowLabel(provider, w),
      remainingPercent,
      usedPercent,
      hoursLeft,
      resetAt: w.resetAt || null,
      status: w.status || 'unknown',
      applies: Boolean(w.applies),
      windowMinutes: Number.isFinite(w.windowMinutes) ? w.windowMinutes : (String(w.windowId || '').includes('week') ? 10080 : 300),
      slopePercentPerHour: Number.isFinite(w.slopePercentPerHour) ? w.slopePercentPerHour : null,
      depletionHours: Number.isFinite(w.depletionHours) ? w.depletionHours : null,
      usablePercent: Number.isFinite(w.usablePercent) ? w.usablePercent : null,
    };
  });
}

function pickBottleneck(windows) {
  if (!windows.length) return null;
  return [...windows].sort((a, b) => {
    if (a.remainingPercent !== b.remainingPercent) return a.remainingPercent - b.remainingPercent;
    return (b.windowMinutes || 0) - (a.windowMinutes || 0);
  })[0];
}

function pickWeekly(windows) {
  const weekly = windows.filter((w) => (w.windowMinutes || 0) >= 1440 || w.windowId.toLowerCase().includes('week'));
  return pickBottleneck(weekly.length ? weekly : windows);
}

function calcTargetPerDay(win, reservePercent) {
  if (!win || !isFreshWindow(win) || !Number.isFinite(win.hoursLeft) || win.hoursLeft <= 0) return null;
  const usable = Math.max(0, win.remainingPercent - reservePercent);
  if (usable <= 0) return 0;
  if (win.hoursLeft <= 24) return round1(usable);
  return round1(usable / (win.hoursLeft / 24));
}

function calcProjectedUnused(win) {
  if (!win || !isFreshWindow(win)) return null;
  if (win.remainingPercent <= 0) return 0;
  if (!Number.isFinite(win.hoursLeft) || win.hoursLeft <= 0) return round1(win.remainingPercent);

  if (win.slopePercentPerHour !== null && Number.isFinite(win.slopePercentPerHour)) {
    const projectedBurn = Math.max(0, win.slopePercentPerHour) * win.hoursLeft;
    return round1(Math.max(0, win.remainingPercent - projectedBurn));
  }

  const totalWindowHours = (win.windowMinutes || 10080) / 60;
  const elapsedHours = Math.max(0, totalWindowHours - win.hoursLeft);
  if (elapsedHours >= 2) {
    const avgSlope = win.usedPercent / elapsedHours;
    return round1(Math.max(0, win.remainingPercent - avgSlope * win.hoursLeft));
  }
  return null;
}

function classifyUtilization({ status, remainingPercent, usablePercent, hoursLeft, projectedUnusedAtReset, primaryWin, reservePercent }) {
  if (status === 'blocked') return 'blocked';
  if (!primaryWin || ['unknown', 'stale', 'verify-reset'].includes(status)) return 'unknown';
  if (remainingPercent <= 0 || status === 'depleted') return 'exhausted';
  if (
    remainingPercent < 20 ||
    usablePercent <= 0 ||
    status === 'reserve' ||
    (status === 'pace' && remainingPercent < 30) ||
    (primaryWin.depletionHours !== null && Number.isFinite(hoursLeft) && primaryWin.depletionHours < hoursLeft * 0.55 && remainingPercent < 35)
  ) {
    return 'hot';
  }
  if (status !== 'pace') {
    if (remainingPercent >= 50) return 'surplus';
    if (remainingPercent >= 30 && Number.isFinite(hoursLeft) && hoursLeft <= 48) return 'surplus';
    if (projectedUnusedAtReset !== null && projectedUnusedAtReset >= 25 && remainingPercent >= 25) return 'surplus';
  }
  // If reservePercent is unusually high (e.g. 40%), ensure healthy headroom above reserve isn't missed.
  if (status === 'ready' && remainingPercent - reservePercent >= 45) return 'surplus';
  return 'on-pace';
}

function getInsightMetric(insights, provider, metricId) {
  const row = (insights?.providers || []).find((p) => p.provider === provider);
  if (!row) return null;
  const metric = (row.metrics || []).find((m) => m.id === metricId);
  return metric && Number.isFinite(metric.percent) ? metric.percent : null;
}

function getProviderInsights(insights, provider) {
  return {
    subagents: getInsightMetric(insights, provider, 'subagents'),
    context: getInsightMetric(insights, provider, 'context'),
    effort: getInsightMetric(insights, provider, 'effort'),
    long: getInsightMetric(insights, provider, 'long'),
    cache: getInsightMetric(insights, provider, 'cache'),
    fast: getInsightMetric(insights, provider, 'fast'),
    swarm: getInsightMetric(insights, provider, 'swarm'),
  };
}

function makeKnob(id, label, state, value, reason, command = null) {
  const knob = { id, label, state, value, reason };
  if (command) knob.command = command;
  return knob;
}

function extractBankedResets(plan, provider) {
  const row = (plan?.resetCredits || []).find((c) => c.provider === provider);
  if (!row) {
    return { availableCount: null, usableCount: null, status: 'unknown', action: null, nextExpiryAt: null, message: null };
  }
  return {
    availableCount: Number.isInteger(row.availableCount) ? row.availableCount : null,
    usableCount: Number.isInteger(row.usableCount) ? row.usableCount : null,
    status: row.status || 'unknown',
    action: row.action || null,
    nextExpiryAt: row.planningExpiryAt || row.nextExpiryAt || null,
    message: row.message || null,
  };
}

function analyzeAgyLanes(windows) {
  const isArgon = (w) => w.modelFamily === 'gemini-argon' || w.windowId.toLowerCase().startsWith('gemini-argon');
  const isClaudeGpt = (w) => w.modelFamily === 'claude-gpt' || w.windowId.toLowerCase().startsWith('claude-gpt');
  const isGemini = (w) => !isArgon(w) && !isClaudeGpt(w);

  const geminiAll = windows.filter(isGemini);
  const claudeGptAll = windows.filter(isClaudeGpt);
  const argonAll = windows.filter(isArgon);

  const geminiFresh = geminiAll.filter(isFreshWindow);
  const claudeGptFresh = claudeGptAll.filter(isFreshWindow);
  const argonFresh = argonAll.filter(isFreshWindow);

  const geminiPrimary = pickBottleneck(geminiFresh.length ? geminiFresh : geminiAll);
  const geminiWeekly = pickWeekly(geminiFresh.length ? geminiFresh : geminiAll);
  const geminiSession = geminiFresh.find((w) => w.windowMinutes < 1440) || geminiAll.find((w) => w.windowMinutes < 1440) || null;

  const cgPrimary = pickBottleneck(claudeGptFresh.length ? claudeGptFresh : claudeGptAll);
  const cgWeekly = pickWeekly(claudeGptFresh.length ? claudeGptFresh : claudeGptAll);
  const cgSession = claudeGptFresh.find((w) => w.windowMinutes < 1440) || claudeGptAll.find((w) => w.windowMinutes < 1440) || null;

  const argonPrimary = pickBottleneck(argonFresh.length ? argonFresh : argonAll);
  const argonDepleted = Boolean(argonPrimary && isFreshWindow(argonPrimary) && argonPrimary.remainingPercent <= 0);

  return {
    geminiPrimary,
    geminiWeekly,
    geminiSession,
    geminiFresh: geminiFresh.length > 0,
    cgPrimary,
    cgWeekly,
    cgSession,
    cgFresh: claudeGptFresh.length > 0,
    argonPrimary,
    argonDepleted,
  };
}

function summarizeProvider(plan, providerId, reservePercent) {
  const raw = (plan?.providers || []).find((p) => p.provider === providerId) || {
    provider: providerId,
    status: 'unknown',
    windows: [],
    binding: null,
  };
  const allWindows = normalizeWindows(providerId, raw.windows);
  const bankedResets = extractBankedResets(plan, providerId);
  const isBlocked = raw.status === 'blocked';

  let primaryWin = null;
  let weeklyWin = null;
  let effectiveStatus = raw.status || 'unknown';
  let agyLanes = null;

  if (providerId === 'agy') {
    agyLanes = analyzeAgyLanes(allWindows);
    const model = String(raw.binding?.model || '').toLowerCase();
    const prefersCg = Boolean(model) && !/(?:gemini|argon|neon|carbon|hydrogen|flash)/.test(model);

    if (prefersCg && agyLanes.cgFresh && agyLanes.cgPrimary.remainingPercent > 0) {
      primaryWin = agyLanes.cgPrimary;
      weeklyWin = agyLanes.cgWeekly;
    } else if (agyLanes.geminiFresh && (agyLanes.geminiPrimary.remainingPercent > 0 || !agyLanes.cgFresh || agyLanes.cgPrimary.remainingPercent <= 0)) {
      primaryWin = agyLanes.geminiPrimary;
      weeklyWin = agyLanes.geminiWeekly;
    } else if (agyLanes.cgFresh) {
      primaryWin = agyLanes.cgPrimary;
      weeklyWin = agyLanes.cgWeekly;
    } else {
      primaryWin = agyLanes.geminiPrimary || agyLanes.cgPrimary || agyLanes.argonPrimary || pickBottleneck(allWindows);
      weeklyWin = agyLanes.geminiWeekly || agyLanes.cgWeekly || pickWeekly(allWindows);
    }

    if (!isBlocked) {
      // Do not let a retired/stale legacy Argon window mark healthy Gemini/Claude-GPT lanes stale or depleted.
      if (primaryWin && isFreshWindow(primaryWin)) {
        effectiveStatus = primaryWin.status;
      } else if (primaryWin) {
        effectiveStatus = primaryWin.status;
      } else {
        effectiveStatus = 'unknown';
      }
    }
  } else {
    const applicable = allWindows.filter((w) => w.applies);
    const pool = applicable.length ? applicable : allWindows;
    const freshPool = pool.filter(isFreshWindow);
    const globalDepleted = freshPool.find((w) => !w.modelFamily && w.remainingPercent <= 0);
    if (globalDepleted) {
      primaryWin = globalDepleted;
      weeklyWin = pickWeekly(freshPool);
      if (!isBlocked) effectiveStatus = 'depleted';
    } else if (freshPool.length) {
      primaryWin = pickBottleneck(freshPool);
      weeklyWin = pickWeekly(freshPool);
      if (!isBlocked) effectiveStatus = primaryWin.status;
    } else {
      primaryWin = pickBottleneck(pool);
      weeklyWin = pickWeekly(pool);
      if (!isBlocked) effectiveStatus = primaryWin ? primaryWin.status : 'unknown';
    }
  }

  const hasFresh = Boolean(primaryWin && isFreshWindow(primaryWin));
  const planningWin = hasFresh && weeklyWin && isFreshWindow(weeklyWin) && primaryWin.remainingPercent >= 25
    ? weeklyWin
    : primaryWin;
  const remainingPercent = hasFresh ? primaryWin.remainingPercent : null;
  const usablePercent = hasFresh ? round1(Math.max(0, primaryWin.remainingPercent - reservePercent)) : null;
  const resetAt = planningWin ? planningWin.resetAt : null;
  const hoursLeft = planningWin && Number.isFinite(planningWin.hoursLeft) ? planningWin.hoursLeft : null;
  const burnPercentPerHour = hasFresh && primaryWin.slopePercentPerHour !== null ? round1(primaryWin.slopePercentPerHour) : null;
  const targetPercentPerDay = hasFresh ? calcTargetPerDay(weeklyWin || primaryWin, reservePercent) : null;
  const projectedUnusedAtReset = hasFresh ? calcProjectedUnused(weeklyWin || primaryWin) : null;

  let utilizationState = classifyUtilization({
    status: effectiveStatus,
    remainingPercent: remainingPercent ?? 0,
    usablePercent: usablePercent ?? 0,
    hoursLeft,
    projectedUnusedAtReset,
    primaryWin: hasFresh ? primaryWin : null,
    reservePercent,
  });

  // For AGY: if Gemini is healthy/surplus OR Claude/GPT has big surplus while Gemini isn't dead, reflect surplus accurately.
  if (providerId === 'agy' && agyLanes && !isBlocked) {
    const gRem = agyLanes.geminiFresh ? agyLanes.geminiPrimary.remainingPercent : null;
    const gHours = agyLanes.geminiFresh ? agyLanes.geminiWeekly?.hoursLeft ?? agyLanes.geminiPrimary.hoursLeft : null;
    const cgRem = agyLanes.cgFresh ? agyLanes.cgPrimary.remainingPercent : null;
    if (utilizationState === 'on-pace' && ((gRem !== null && gRem >= 30 && gHours !== null && gHours <= 48) || (cgRem !== null && cgRem >= 65))) {
      utilizationState = 'surplus';
    }
  }

  const publicWindows = allWindows.map(({ windowId, modelFamily, label, remainingPercent: rem, usedPercent, hoursLeft: hrs, resetAt: rst, status, applies }) => ({
    windowId,
    modelFamily,
    label,
    remainingPercent: rem,
    usedPercent,
    hoursLeft: hrs,
    resetAt: rst,
    status,
    applies,
  }));

  return {
    provider: providerId,
    label: PROVIDER_LABELS[providerId] || providerId,
    status: effectiveStatus,
    utilizationState,
    remainingPercent,
    usablePercent,
    resetAt,
    hoursLeft,
    burnPercentPerHour,
    targetPercentPerDay,
    projectedUnusedAtReset,
    windows: publicWindows,
    bankedResets,
    _meta: { primaryWin, weeklyWin, agyLanes, allWindows },
  };
}

function buildAgyKnobs(summary, others, insights) {
  const { utilizationState, hoursLeft, projectedUnusedAtReset } = summary;
  const lanes = summary._meta.agyLanes || {};
  const gRem = lanes.geminiFresh ? lanes.geminiPrimary.remainingPercent : null;
  const gWeeklyRem = lanes.geminiWeekly && isFreshWindow(lanes.geminiWeekly) && lanes.geminiWeekly.windowMinutes >= 1440
    ? lanes.geminiWeekly.remainingPercent
    : null;
  const gHours = lanes.geminiFresh ? (lanes.geminiWeekly?.hoursLeft ?? lanes.geminiPrimary.hoursLeft) : null;
  const gSess = lanes.geminiSession && isFreshWindow(lanes.geminiSession) ? lanes.geminiSession.remainingPercent : null;
  const gSessHours = lanes.geminiSession && isFreshWindow(lanes.geminiSession) ? lanes.geminiSession.hoursLeft : null;
  const cgRem = lanes.cgFresh ? lanes.cgPrimary.remainingPercent : null;
  const cgSess = lanes.cgSession && isFreshWindow(lanes.cgSession) ? lanes.cgSession.remainingPercent : null;
  const cgSessHours = lanes.cgSession && isFreshWindow(lanes.cgSession) ? lanes.cgSession.hoursLeft : null;

  const claudeTight = ['exhausted', 'hot', 'blocked'].includes(others.claude?.utilizationState);
  const claudeExhausted = others.claude?.utilizationState === 'exhausted';
  const codexTight = ['exhausted', 'hot', 'blocked'].includes(others.codex?.utilizationState);

  const ins = getProviderInsights(insights, 'agy');
  const highContext = ins.context !== null && ins.context >= 40;
  const highEffort = ins.effort !== null && ins.effort >= 45;
  const lowSwarm = ins.swarm !== null && ins.swarm < 15;

  const geminiPivotToCg = gRem !== null && gRem < 25 && cgRem !== null && cgRem >= 30;
  const geminiSurplus = gRem !== null && (gRem >= 50 || (gRem >= 30 && gHours !== null && gHours <= 48));
  const geminiSessionTight = gSess !== null && gSess < 25;
  const geminiSessionWarn = gSess !== null && gSess < 45;
  const cgSessionTight = cgSess !== null && cgSess < 25;
  const geminiHot = (gRem !== null && gRem < 25) || geminiSessionTight;
  const expiringSoon = Number.isFinite(hoursLeft) && hoursLeft <= 48;

  const earliest = [lanes.geminiPrimary, lanes.cgPrimary]
    .filter(Boolean)
    .sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity))[0];
  const span = formatSpan(earliest?.hoursLeft ?? hoursLeft);

  if (utilizationState === 'blocked') {
    return [
      makeKnob('swarm-size', '/swarm workers', 'off', 'OFF (blocked)', 'AGY is manually blocked — unblock before launching /swarm workers.', '/guard-block none'),
      makeKnob('dual-pool', 'Dual-pool routing', 'off', 'Blocked', 'Both Gemini and Claude/GPT quota pools are paused while AGY is blocked.', '/guard-block none'),
      makeKnob('worker-tier', 'Worker model tiering', 'off', 'Paused', 'Unblock AGY to assign Neon coordinator and Hydrogen/Flash worker models.'),
      makeKnob('effort-suffix', 'Model effort suffix', 'off', 'OFF (blocked)', 'Effort suffix tuning resumes once AGY is unblocked.'),
      makeKnob('session-5h', '5h burst guard', 'off', 'Blocked', '5h burst monitoring is idle while AGY is blocked.'),
      makeKnob('context-compact', 'Context & /goal timing', 'off', 'Paused', 'Unblock AGY before scheduling /goal runs or context compaction.'),
    ];
  }

  if (utilizationState === 'unknown') {
    return [
      makeKnob('swarm-size', '/swarm workers', 'steady', 'Refresh /usage first', 'Run agy --print /usage to size /swarm safely against 5h and weekly limits.', 'agy --print /usage'),
      makeKnob('dual-pool', 'Dual-pool routing', 'steady', 'Check both pools', 'AGY tracks separate Gemini and Claude/GPT pools — refresh /usage to inspect both.', 'agy --print /usage'),
      makeKnob('worker-tier', 'Worker model tiering', 'steady', 'Neon coord + Hydrogen/Flash', 'Default tiered setup keeps coordinator quality sharp while conserving worker burn.', '/model gemini-4-neon-high'),
      makeKnob('effort-suffix', 'Model effort suffix', 'steady', '-high (default)', 'Use -high until live AGY allowance readings confirm surplus or 5h pressure.', '/model gemini-4-neon-high'),
      makeKnob('session-5h', '5h burst guard', 'steady', 'Unobserved', 'Refresh /usage to watch 5h session burst caps alongside weekly windows.', 'agy --print /usage'),
      makeKnob('context-compact', 'Context & /goal timing', 'steady', '/compact at milestones', 'Keep threads compact and confirm headroom before queuing long /goal loops.', '/compact'),
    ];
  }

  if (utilizationState === 'exhausted') {
    return [
      makeKnob('swarm-size', '/swarm workers', 'off', 'OFF (exhausted)', `Both Gemini and Claude/GPT pools are empty — pause /swarm until reset in ${span}.`, 'agy --print /usage'),
      makeKnob('dual-pool', 'Dual-pool routing', 'off', 'Both pools 0%', `Gemini and Claude/GPT buckets are both depleted — next refill in ${span}.`, 'agy --print /usage'),
      makeKnob('worker-tier', 'Worker model tiering', 'off', 'OFF (exhausted)', `All AGY model tiers are paused until the ${span} reset.`),
      makeKnob('effort-suffix', 'Model effort suffix', 'off', 'OFF (exhausted)', `Hold AGY runs until the window refills in ${span}.`),
      makeKnob('session-5h', '5h burst guard', 'off', 'Depleted', `5h and weekly windows are exhausted — next unlock in ${span}.`),
      makeKnob('context-compact', 'Context & /goal timing', 'off', 'Queue /goal for reset', `Hold heavy /goal runs until ${span}; /compact existing threads before resuming.`, '/compact'),
    ];
  }

  // 1. swarm-size
  let swarmKnob;
  if (geminiSessionTight) {
    swarmKnob = makeKnob(
      'swarm-size',
      '/swarm workers',
      'tighten',
      '1–2 workers / single-thread',
      `Gemini 5h burst window is down to ${Math.round(gSess)}%${gWeeklyRem !== null && gWeeklyRem >= 40 ? ` (weekly still ${Math.round(gWeeklyRem)}%)` : ''}${gSessHours !== null ? ` — refills in ${formatSpan(gSessHours)}` : ''}; throttle /swarm${cgRem !== null && cgRem >= 30 ? ' or pivot to Claude/GPT' : ''}.`,
      cgRem !== null && cgRem >= 30 ? '/model claude-opus-5-5-high' : '/model gemini-3.8-flash-medium'
    );
  } else if (geminiPivotToCg) {
    swarmKnob = makeKnob(
      'swarm-size',
      '/swarm workers',
      'tighten',
      '1–2 workers / single-thread',
      `Gemini is low (${Math.round(gRem)}%) — throttle Gemini /swarm and run focused work on AGY Claude/GPT (${Math.round(cgRem)}% left).`,
      '/model claude-opus-5-5-high'
    );
  } else if (geminiSurplus && !geminiHot) {
    if (geminiSessionWarn) {
      swarmKnob = makeKnob(
        'swarm-size',
        '/swarm workers',
        'steady',
        '2–3 workers + verifier',
        `Weekly Gemini is high (${Math.round(gWeeklyRem ?? gRem)}%), but 5h session is at ${Math.round(gSess)}% — cap at 2–3 workers until 5h refills.`,
        '/swarm'
      );
    } else {
      swarmKnob = makeKnob(
        'swarm-size',
        '/swarm workers',
        'boost',
        '3–4 workers + verifier',
        lowSwarm
          ? `Gemini has ${Math.round(gRem)}% left and 24h /swarm share is only ${Math.round(ins.swarm)}% — parallelize big tasks with 3–4 workers + verifier.`
          : `Gemini has ${Math.round(gRem)}% left${gSess !== null ? ` (${Math.round(gSess)}% 5h)` : ''} — safe for 3–4 parallel workers plus a verifier.`,
        '/swarm'
      );
    }
  } else if (geminiHot || utilizationState === 'hot') {
    swarmKnob = makeKnob(
      'swarm-size',
      '/swarm workers',
      'tighten',
      '1–2 workers / single-thread',
      `AGY headroom is tight (${Math.round(gRem ?? summary.remainingPercent ?? 0)}% left) — shrink /swarm to 1–2 workers or single-thread until refill.`,
      '/model gemini-3.8-flash-medium'
    );
  } else {
    swarmKnob = makeKnob(
      'swarm-size',
      '/swarm workers',
      'steady',
      '2–3 workers',
      `Gemini is on pace (${Math.round(gRem ?? summary.remainingPercent ?? 0)}% left) — keep /swarm to 2–3 focused workers with clear file ownership.`,
      '/swarm'
    );
  }

  // 2. dual-pool
  let dualPoolKnob;
  if (cgRem !== null && cgRem >= 30 && (claudeTight || codexTight || geminiPivotToCg)) {
    const val = geminiPivotToCg
      ? `Pivot to Claude/GPT (${Math.round(cgRem)}%)`
      : `Tap Claude/GPT lane (${Math.round(cgRem)}%)`;
    const why = claudeExhausted
      ? `Native Claude is exhausted while AGY's separate Claude/GPT pool has ${Math.round(cgRem)}% left${cgSess !== null ? ` (${Math.round(cgSess)}% 5h)` : ''} — route Opus/coding overflow here.`
      : geminiPivotToCg
        ? `Gemini lane is down to ${Math.round(gRem)}%, while AGY's separate Claude/GPT pool still has ${Math.round(cgRem)}% left.`
        : `Native ${claudeTight && codexTight ? 'Claude & Codex are tight' : claudeTight ? 'Claude is tight' : 'Codex is tight'} — arbitrate overflow onto AGY Claude/GPT (${Math.round(cgRem)}% free).`;
    dualPoolKnob = makeKnob('dual-pool', 'Dual-pool routing', 'boost', val, why, '/model claude-opus-5-5-high');
  } else if (cgRem !== null && cgRem >= 50) {
    dualPoolKnob = makeKnob(
      'dual-pool',
      'Dual-pool routing',
      'boost',
      `Gemini + Claude/GPT (${Math.round(cgRem)}%)`,
      `Both pools are open — run /swarm on Gemini (${gRem !== null ? Math.round(gRem) + '%' : 'active'}) and tap AGY Claude/GPT (${Math.round(cgRem)}%) for extra Opus/GPT headroom.`,
      '/model claude-opus-5-5-high'
    );
  } else if (cgRem !== null && cgRem < 20 && gRem !== null && gRem >= 30) {
    dualPoolKnob = makeKnob(
      'dual-pool',
      'Dual-pool routing',
      'tighten',
      `Gemini lane only (${Math.round(gRem)}%)`,
      `AGY Claude/GPT pool is low (${Math.round(cgRem)}%) — keep workloads on the Gemini lane (${Math.round(gRem)}% left).`,
      '/model gemini-4-neon-high'
    );
  } else {
    dualPoolKnob = makeKnob(
      'dual-pool',
      'Dual-pool routing',
      utilizationState === 'hot' ? 'tighten' : 'steady',
      gRem !== null ? `Gemini lane (${Math.round(gRem)}%)` : 'Gemini lane',
      cgRem !== null
        ? `Gemini (${gRem !== null ? Math.round(gRem) + '%' : '?'}) and Claude/GPT (${Math.round(cgRem)}%) are balanced — match model pool to task.`
        : 'Only Gemini pool windows are active — keep routine runs on Gemini.',
      '/model gemini-4-neon-high'
    );
  }

  // 3. worker-tier
  const argonNote = lanes.argonDepleted ? 'Gemini Argon cap is depleted; ' : '';
  let workerTierKnob;
  if (geminiPivotToCg) {
    workerTierKnob = makeKnob(
      'worker-tier',
      'Worker model tiering',
      'steady',
      'Claude/GPT lane · pause Gemini',
      `Keep Gemini workers parked (${Math.round(gRem)}% left) and run focused Opus/Sonnet sessions on AGY Claude/GPT (${Math.round(cgRem)}% left).`,
      '/model claude-opus-5-5-high'
    );
  } else if (geminiHot || utilizationState === 'hot') {
    workerTierKnob = makeKnob(
      'worker-tier',
      'Worker model tiering',
      'tighten',
      'Hydrogen / Flash only',
      `${argonNote}Protect ${geminiSessionTight ? `the 5h burst window (${Math.round(gSess)}% left)` : 'remaining Gemini budget'} by stepping workers and routine edits down to Hydrogen or Flash.`,
      '/model gemini-3.8-flash-medium'
    );
  } else if (geminiSessionWarn) {
    workerTierKnob = makeKnob(
      'worker-tier',
      'Worker model tiering',
      'tighten',
      'Neon coord + Hydrogen/Flash',
      `${argonNote}5h session is at ${Math.round(gSess)}% — keep coordinator on Neon and pin workers/verifiers to Hydrogen or Flash.`,
      '/model gemini-4-hydrogen-high'
    );
  } else if (geminiSurplus) {
    workerTierKnob = makeKnob(
      'worker-tier',
      'Worker model tiering',
      'boost',
      'Neon coord + Hydrogen/Flash',
      `${argonNote}Keep coordinator sharp on Neon while Hydrogen/Flash workers absorb parallel edits so the 5h burst cap stays comfortable.`,
      '/model gemini-4-neon-high'
    );
  } else {
    workerTierKnob = makeKnob(
      'worker-tier',
      'Worker model tiering',
      'steady',
      'Neon coord + Hydrogen/Flash',
      `${argonNote}Run Neon for coordination and delegate bounded search/edits to Hydrogen or Flash.`,
      '/model gemini-4-hydrogen-high'
    );
  }

  // 4. effort-suffix
  let effortKnob;
  if (geminiPivotToCg && !cgSessionTight) {
    effortKnob = makeKnob(
      'effort-suffix',
      'Model effort suffix',
      'steady',
      '-high (Claude/GPT) · -medium (Gem)',
      `Use -high on AGY's open Claude/GPT lane (${Math.round(cgRem)}%) and hold any Gemini turns at -medium.`,
      '/model claude-opus-5-5-high'
    );
  } else if (geminiHot || utilizationState === 'hot' || geminiSessionTight || cgSessionTight) {
    effortKnob = makeKnob(
      'effort-suffix',
      'Model effort suffix',
      'tighten',
      '-medium',
      `Step effort suffix down to -medium (${geminiSessionTight ? `Gemini 5h at ${Math.round(gSess)}%` : 'headroom tight'}) to stretch burst and weekly quota.`,
      '/model gemini-3.8-flash-medium'
    );
  } else if (highEffort && (utilizationState !== 'surplus' || !expiringSoon)) {
    effortKnob = makeKnob(
      'effort-suffix',
      'Model effort suffix',
      'tighten',
      '-medium / -high (trim -xhigh)',
      `${Math.round(ins.effort)}% of 24h AGY tokens ran at xhigh/max effort — use -medium on routine workers and save -high for complex steps.`,
      '/model gemini-4-hydrogen-high'
    );
  } else if (utilizationState === 'surplus' && !geminiSessionWarn) {
    effortKnob = makeKnob(
      'effort-suffix',
      'Model effort suffix',
      'boost',
      '-xhigh / -high',
      `Surplus weekly (${Math.round(gWeeklyRem ?? gRem ?? summary.remainingPercent ?? 0)}%) and healthy 5h headroom support -xhigh on hard problems and -high on workers.`,
      '/model gemini-4-neon-xhigh'
    );
  } else {
    effortKnob = makeKnob(
      'effort-suffix',
      'Model effort suffix',
      'steady',
      '-high',
      geminiSessionWarn
        ? `Weekly headroom is solid, but 5h session is at ${Math.round(gSess)}% — stay at -high instead of -xhigh.`
        : 'On-pace allowance — default to -high for primary threads and -medium for routine workers.',
      '/model gemini-4-neon-high'
    );
  }

  // 5. session-5h
  let sessionKnob;
  if (geminiSessionTight || cgSessionTight) {
    const parts = [];
    if (gSess !== null) parts.push(`Gem 5h ${Math.round(gSess)}%`);
    if (cgSess !== null) parts.push(`CG 5h ${Math.round(cgSess)}%`);
    const wallNote = geminiSessionTight && gWeeklyRem !== null && gWeeklyRem >= 50
      ? `5h Gemini session is at ${Math.round(gSess)}%${gSessHours !== null ? ` (refills in ${formatSpan(gSessHours)})` : ''} even though weekly is ${Math.round(gWeeklyRem)}% — pause heavy /swarm bursts so you do not trip the 5h wall.`
      : `5h burst window is low (${parts.join(', ')}${gSessHours !== null && geminiSessionTight ? `, refills in ${formatSpan(gSessHours)}` : cgSessHours !== null && cgSessionTight ? `, refills in ${formatSpan(cgSessHours)}` : ''}) — pace turns until the 5h window recovers.`;
    sessionKnob = makeKnob('session-5h', '5h burst guard', 'tighten', parts.join(' · '), wallNote);
  } else if ((gSess !== null && gSess < 50) || (cgSess !== null && cgSess < 50)) {
    const parts = [];
    if (gSess !== null) parts.push(`Gem 5h ${Math.round(gSess)}%`);
    if (cgSess !== null) parts.push(`CG 5h ${Math.round(cgSess)}%`);
    sessionKnob = makeKnob(
      'session-5h',
      '5h burst guard',
      'steady',
      parts.join(' · '),
      `Monitor 5h burst burn (${parts.join(', ')}) — stagger /swarm waves instead of spawning all workers simultaneously.`
    );
  } else if (gSess !== null || cgSess !== null) {
    const parts = [];
    if (gSess !== null) parts.push(`Gem 5h ${Math.round(gSess)}%`);
    if (cgSess !== null) parts.push(`CG 5h ${Math.round(cgSess)}%`);
    sessionKnob = makeKnob(
      'session-5h',
      '5h burst guard',
      utilizationState === 'hot' ? 'tighten' : 'boost',
      parts.join(' · '),
      utilizationState === 'hot'
        ? `5h windows look open (${parts.join(', ')}), but weekly headroom (${Math.round(summary.remainingPercent ?? 0)}%) is the real cap.`
        : `5h burst windows are wide open (${parts.join(', ')}) — safe for multi-worker /swarm bursts without tripping the 5h wall.`
    );
  } else {
    sessionKnob = makeKnob(
      'session-5h',
      '5h burst guard',
      utilizationState === 'hot' ? 'tighten' : 'steady',
      'Weekly only (pace bursts)',
      'No 5h session window reported yet — stagger large /swarm waves so a burst does not trip an unseen 5h cap.',
      'agy --print /usage'
    );
  }

  // 6. context-compact
  let contextKnob;
  if (highContext) {
    contextKnob = makeKnob(
      'context-compact',
      'Context & /goal timing',
      'tighten',
      `/compact now (${Math.round(ins.context)}% >150k)`,
      `${Math.round(ins.context)}% of 24h AGY tokens ran above 150k context — run /compact or open a fresh thread at milestones${utilizationState === 'surplus' && expiringSoon ? ` before launching expiring-surplus /goal runs (${formatSpan(hoursLeft)} left)` : ''}.`,
      '/compact'
    );
  } else if (utilizationState === 'surplus' && (expiringSoon || (projectedUnusedAtReset !== null && projectedUnusedAtReset >= 25))) {
    contextKnob = makeKnob(
      'context-compact',
      'Context & /goal timing',
      'boost',
      'Schedule /goal before reset',
      `${Math.round(summary.remainingPercent ?? 0)}% AGY headroom${expiringSoon ? ` expires in ${formatSpan(hoursLeft)}` : ` (~${Math.round(projectedUnusedAtReset)}% projected unused)`} — run heavy /goal or refactor passes before weekly reset and /compact between phases.`,
      '/goal'
    );
  } else if (utilizationState === 'hot' || geminiSessionTight) {
    contextKnob = makeKnob(
      'context-compact',
      'Context & /goal timing',
      'tighten',
      '/compact + fresh threads',
      `AGY headroom is tight — run /compact early and hold long /goal runs until refill (${formatSpan(hoursLeft)}).`,
      '/compact'
    );
  } else if (utilizationState === 'surplus') {
    contextKnob = makeKnob(
      'context-compact',
      'Context & /goal timing',
      'boost',
      '/goal open · /compact at milestones',
      'Plenty of weekly runway for /goal tasks — /compact when switching subsystems to protect the 5h burst window.',
      '/goal'
    );
  } else {
    contextKnob = makeKnob(
      'context-compact',
      'Context & /goal timing',
      'steady',
      '/compact at milestones',
      'Run /compact or start a fresh thread at milestones to stay below 150k context.',
      '/compact'
    );
  }

  return [swarmKnob, dualPoolKnob, workerTierKnob, effortKnob, sessionKnob, contextKnob];
}

function buildAgyPlaybook(summary, others, insights) {
  const { utilizationState, hoursLeft, projectedUnusedAtReset } = summary;
  const lanes = summary._meta.agyLanes || {};
  const gRem = lanes.geminiFresh ? lanes.geminiPrimary.remainingPercent : null;
  const gHours = lanes.geminiFresh ? (lanes.geminiWeekly?.hoursLeft ?? lanes.geminiPrimary.hoursLeft) : null;
  const gSess = lanes.geminiSession && isFreshWindow(lanes.geminiSession) ? lanes.geminiSession.remainingPercent : null;
  const cgRem = lanes.cgFresh ? lanes.cgPrimary.remainingPercent : null;
  const cgHours = lanes.cgFresh ? (lanes.cgWeekly?.hoursLeft ?? lanes.cgPrimary.hoursLeft) : null;
  const cgSess = lanes.cgSession && isFreshWindow(lanes.cgSession) ? lanes.cgSession.remainingPercent : null;

  const claudeTight = ['exhausted', 'hot', 'blocked'].includes(others.claude?.utilizationState);
  const codexTight = ['exhausted', 'hot', 'blocked'].includes(others.codex?.utilizationState);
  const swarmInsight = getInsightMetric(insights, 'agy', 'swarm');
  const knobs = buildAgyKnobs(summary, others, insights);

  if (utilizationState === 'blocked') {
    return {
      mode: 'pause',
      headline: 'Antigravity (AGY) is manually blocked',
      badges: ['Blocked'],
      guidance: ['Unblock AGY when you want to route work or run /swarm there.'],
      commands: ['/guard-block none'],
      knobs,
    };
  }
  if (utilizationState === 'unknown') {
    return {
      mode: 'pause',
      headline: 'Refresh AGY /usage to unlock /swarm and lane sizing',
      badges: ['Awaiting reading'],
      guidance: ['Run agy --print /usage (or npm run check -- --live) to read both Gemini and Claude/GPT buckets.'],
      commands: ['agy --print /usage'],
      knobs,
    };
  }
  if (utilizationState === 'exhausted') {
    const earliest = [lanes.geminiPrimary, lanes.cgPrimary].filter(Boolean).sort((a, b) => (a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity))[0];
    const span = formatSpan(earliest?.hoursLeft ?? hoursLeft);
    return {
      mode: 'pause',
      headline: `AGY Gemini and Claude/GPT lanes are exhausted — resets in ${span}`,
      badges: ['Exhausted', `Resets in ${span}`],
      guidance: [`Pause /swarm and single-agent AGY runs until the next window refills in ${span}.`],
      commands: ['agy --print /usage'],
      knobs,
    };
  }

  // Case: Gemini lane is tight/exhausted (<25%), but separate Claude/GPT lane is wide open (>=30%)
  if (gRem !== null && gRem < 25 && cgRem !== null && cgRem >= 30) {
    const mode = cgRem >= 50 ? 'accelerate' : 'steady';
    return {
      mode,
      headline: `Gemini lane is low (${Math.round(gRem)}%) — pivot to AGY Claude/GPT lane (${Math.round(cgRem)}% left)`,
      badges: ['Gemini low: pause /swarm', `Claude/GPT lane ${Math.round(cgRem)}%`],
      guidance: [
        `Scale Gemini /swarm down to 1 worker or pause Gemini until reset (${formatSpan(gHours)}).`,
        `Use AGY's separate Claude/GPT bucket (${Math.round(cgRem)}% weekly${cgSess !== null ? `, ${Math.round(cgSess)}% 5h` : ''}) for Opus/coding tasks.`,
      ],
      commands: ['/model claude-opus-5-5-high'],
      knobs,
    };
  }

  const geminiSurplus = gRem !== null && (gRem >= 50 || (gRem >= 30 && gHours !== null && gHours <= 48));
  const geminiHot = (gRem !== null && gRem < 25) || (gSess !== null && gSess < 25);

  if (geminiSurplus && !geminiHot) {
    const badges = ['/swarm 3-4 workers + verifier', 'Gemini Neon / Hydrogen'];
    if (cgRem !== null && cgRem >= 40) badges.push(`Claude/GPT lane ${Math.round(cgRem)}%`);
    if (projectedUnusedAtReset !== null && projectedUnusedAtReset >= 25) badges.push(`~${Math.round(projectedUnusedAtReset)}% unused risk`);

    const guidance = [
      `Gemini has ${Math.round(gRem)}% left${gSess !== null ? ` (${Math.round(gSess)}% 5h)` : ''} — fire up /swarm with 3–4 parallel workers + a verifier on Gemini Neon or Hydrogen.`,
    ];
    if (cgRem !== null && cgRem >= 40) {
      const overflowNote = claudeTight || codexTight
        ? ` while native ${claudeTight && codexTight ? 'Claude & Codex are tight' : claudeTight ? 'Claude is exhausted/tight' : 'Codex is tight'}`
        : '';
      guidance.push(`AGY's separate Claude/GPT lane has ${Math.round(cgRem)}% left${cgSess !== null ? ` (${Math.round(cgSess)}% 5h)` : ''}${overflowNote} — route Opus-tier planning or overflow coding there.`);
    }
    if (lanes.argonDepleted) {
      guidance.push('Gemini Argon family cap is depleted — target Neon, Hydrogen, or Flash instead.');
    }
    if (swarmInsight !== null && swarmInsight < 15) {
      guidance.push(`Recent AGY swarm usage is only ${Math.round(swarmInsight)}% of tokens — parallelizing big tasks gets far more value before reset.`);
    }

    const commands = ['/swarm', '/model gemini-4-neon-high'];
    if (cgRem !== null && cgRem >= 40 && (claudeTight || codexTight)) {
      commands.push('/model claude-opus-5-5-high');
    }

    const headline = cgRem !== null && cgRem >= 50 && (claudeTight || codexTight)
      ? `Run /swarm (3–4 workers + verifier) on Gemini (${Math.round(gRem)}%) + tap AGY Claude/GPT lane (${Math.round(cgRem)}%)`
      : `Green light for /swarm (3–4 workers + verifier) on Gemini Neon/Hydrogen (${Math.round(gRem)}% left)`;

    return { mode: 'accelerate', headline, badges, guidance, commands, knobs };
  }

  if (geminiHot || utilizationState === 'hot') {
    const badges = ['Scale /swarm to 1-2', 'Hydrogen / Flash'];
    if (cgRem !== null && cgRem >= 30) badges.push(`Claude/GPT lane ${Math.round(cgRem)}%`);
    const guidance = [
      `AGY Gemini is below 25% (${gRem !== null ? Math.round(gRem) + '% weekly' : ''}${gSess !== null ? `, ${Math.round(gSess)}% 5h` : ''}) — scale /swarm down to 1–2 workers or drop to Hydrogen/Flash.`,
    ];
    if (cgRem !== null && cgRem >= 30) {
      guidance.push(`AGY's Claude/GPT bucket still has ${Math.round(cgRem)}% left — offload critical coding there while Gemini cools down.`);
    } else {
      guidance.push(`Wait ${formatSpan(hoursLeft)} for the next AGY refill before launching large swarms.`);
    }
    return {
      mode: 'conserve',
      headline: `AGY tight (${Math.round(summary.remainingPercent ?? 0)}% left) — scale /swarm down to 1–2 workers or use Hydrogen/Flash`,
      badges,
      guidance,
      commands: ['/model gemini-4-hydrogen-high', '/model gemini-3.8-flash-medium'],
      knobs,
    };
  }

  // Steady / on-pace (25–49%)
  const badges = ['/swarm 2-3 workers', 'Neon / Hydrogen'];
  if (cgRem !== null && cgRem >= 40) badges.push(`Claude/GPT lane ${Math.round(cgRem)}%`);
  const guidance = [
    `AGY Gemini is on pace (${gRem !== null ? Math.round(gRem) : Math.round(summary.remainingPercent ?? 0)}% left) — keep /swarm to 2–3 focused workers on Neon/Hydrogen.`,
  ];
  if (cgRem !== null && cgRem >= 40) {
    guidance.push(`Separate AGY Claude/GPT lane has ${Math.round(cgRem)}% left (${formatSpan(cgHours)} to reset) for extra Claude/GPT capacity.`);
  }
  return {
    mode: 'steady',
    headline: `Steady AGY pace (${Math.round(summary.remainingPercent ?? 0)}% left) — 2–3 worker /swarm on Neon/Hydrogen`,
    badges,
    guidance,
    commands: ['/swarm', '/model gemini-4-hydrogen-high'],
    knobs,
  };
}

function buildCodexKnobs(summary, insights, now) {
  const { utilizationState, remainingPercent, hoursLeft, bankedResets } = summary;
  const usableCredits = bankedResets.usableCount || 0;
  const parsedExpiry = bankedResets.nextExpiryAt ? Date.parse(bankedResets.nextExpiryAt) : NaN;
  const expiryHours = Number.isFinite(parsedExpiry) ? round1((parsedExpiry - now) / 3600000) : null;
  const creditExpiringSoon = usableCredits > 0 && expiryHours !== null && expiryHours > 0 && expiryHours <= 24;
  const expiringSoon = Number.isFinite(hoursLeft) && hoursLeft <= 48;
  const span = formatSpan(hoursLeft);

  const ins = getProviderInsights(insights, 'codex');
  const highFast = ins.fast !== null && ins.fast >= 20;
  const highEffort = ins.effort !== null && ins.effort >= 40;
  const highContext = ins.context !== null && ins.context >= 35;
  const highSubagents = ins.subagents !== null && ins.subagents >= 30;
  const lowCache = ins.cache !== null && ins.cache < 75;
  const cacheNote = ins.cache !== null
    ? `24h prefix cache reuse is ${Math.round(ins.cache)}%${lowCache ? ' (low — keep prompt prefix stable)' : ''}.`
    : 'Keep system/tool prefix stable for prompt cache hits.';

  if (utilizationState === 'blocked') {
    return [
      makeKnob('speed-tier', '/fast speed tier', 'off', 'OFF (blocked)', 'Codex is manually blocked — unblock before changing speed tier.', '/guard-block none'),
      makeKnob('reasoning-effort', 'Reasoning effort', 'off', 'OFF (blocked)', 'Unblock Codex before adjusting reasoning effort.'),
      makeKnob('model-tier', 'Model stepping', 'off', 'OFF (blocked)', 'Unblock Codex to pick a model tier.'),
      makeKnob('context-cliff', '272k context cliff', 'off', 'Paused', 'Keep threads under 250k tokens to avoid the 272k 2x input cliff when resuming.'),
      makeKnob('subagents-review', 'Subagents & auto-review', 'off', 'OFF (blocked)', 'Subagent delegation is paused while Codex is blocked.'),
      makeKnob('banked-resets', 'Banked resets & cache', 'off', usableCredits > 0 ? `${usableCredits} banked (hold)` : '0 banked', `Unblock Codex first. ${cacheNote}`),
    ];
  }

  if (utilizationState === 'unknown') {
    return [
      makeKnob('speed-tier', '/fast speed tier', 'steady', 'Standard (check /usage)', 'Keep /fast off until Codex /usage confirms live weekly headroom.', '/usage'),
      makeKnob('reasoning-effort', 'Reasoning effort', 'steady', 'medium / high', 'Hold at medium effort until /usage reports live weekly allowance.', '/effort medium'),
      makeKnob('model-tier', 'Model stepping', 'steady', 'Sol plans · Terra edits', 'Default to Sol for planning and Terra for edits until surplus is confirmed.', '/model gpt-6.1-terra'),
      makeKnob('context-cliff', '272k context cliff', 'steady', 'Checkpoint <250k', 'OpenAI models jump to 2x input weight above 272k tokens — start a fresh thread before 250k.', '/new'),
      makeKnob('subagents-review', 'Subagents & auto-review', 'steady', 'Workers on luna', 'Route subagent workers and verifiers to gpt-6-luna with explicit file lists.', '/model gpt-6-luna'),
      makeKnob('banked-resets', 'Banked resets & cache', 'steady', usableCredits > 0 ? `${usableCredits} banked` : 'Check /usage', `Run /usage to verify banked reset count and expiry. ${cacheNote}`, '/usage'),
    ];
  }

  if (utilizationState === 'exhausted') {
    const bankedKnob = creditExpiringSoon
      ? makeKnob('banked-resets', 'Banked resets & cache', 'boost', `Redeem now (expires ${formatSpan(expiryHours)})`, `${usableCredits} banked reset credit expires in ${formatSpan(expiryHours)} — redeem in /usage before it vanishes. ${cacheNote}`, '/usage')
      : usableCredits > 0
        ? makeKnob('banked-resets', 'Banked resets & cache', 'boost', `Redeem 1 of ${usableCredits} (or wait ${span})`, `Codex is at 0% with ${usableCredits} banked reset credit ready${expiryHours !== null && expiryHours > 0 ? ` (expires in ${formatSpan(expiryHours)})` : ''} — redeem in /usage if urgent, else wait ${span}. ${cacheNote}`, '/usage')
        : makeKnob('banked-resets', 'Banked resets & cache', 'off', '0 banked', `No banked resets on hand — wait ${span} for the weekly refill. ${cacheNote}`, '/usage');

    return [
      makeKnob('speed-tier', '/fast speed tier', 'off', 'OFF (/fast off)', 'Codex is at 0% — keep /fast OFF so you do not trigger 2x–8x burn right after reset or credit redeem.', '/fast off'),
      makeKnob('reasoning-effort', 'Reasoning effort', 'off', `OFF (wait ${span})`, `Codex is exhausted — resume at low/medium effort once the window resets in ${span}.`, '/effort medium'),
      makeKnob('model-tier', 'Model stepping', 'off', 'OFF (shift to AGY/Claude)', `Codex is exhausted for ${span} — route active coding to AGY or Claude.`),
      makeKnob('context-cliff', '272k context cliff', 'off', 'Fresh thread on reset', `Start a clean thread after reset (${span}) and stay below 250k to avoid the 272k 2x input cliff.`, '/new'),
      makeKnob('subagents-review', 'Subagents & auto-review', 'off', 'OFF (exhausted)', `Pause Codex subagents and auto-review until the ${span} reset.`),
      bankedKnob,
    ];
  }

  // 1. speed-tier
  let speedKnob;
  if (utilizationState === 'surplus') {
    speedKnob = makeKnob(
      'speed-tier',
      '/fast speed tier',
      'boost',
      'ON (/fast safe)',
      `${Math.round(remainingPercent)}% left (resets in ${span}) — priority /fast (2x) is safe; save ultrafast (8x) for short urgent bursts.`,
      '/fast'
    );
  } else if (utilizationState === 'hot') {
    speedKnob = makeKnob(
      'speed-tier',
      '/fast speed tier',
      'off',
      'OFF (/fast off)',
      highFast
        ? `${Math.round(ins.fast)}% of 24h Codex tokens used /fast (2x–8x burn) with only ${Math.round(remainingPercent)}% left — turn /fast OFF now.`
        : `Only ${Math.round(remainingPercent)}% left (${span} to reset) — turn /fast OFF to block 2x priority and 8x ultrafast burn.`,
      '/fast off'
    );
  } else if (highFast) {
    speedKnob = makeKnob(
      'speed-tier',
      '/fast speed tier',
      'tighten',
      'Standard (cut /fast)',
      `${Math.round(ins.fast)}% of 24h Codex tokens ran in /fast (2x–8x weight) — drop back to standard speed for routine edits.`,
      '/fast off'
    );
  } else {
    speedKnob = makeKnob(
      'speed-tier',
      '/fast speed tier',
      'steady',
      'Standard (targeted /fast)',
      `On pace (${Math.round(remainingPercent)}% left, resets in ${span}) — default to standard speed and reserve /fast for short sprints.`,
      '/fast off'
    );
  }

  // 2. reasoning-effort
  let effortKnob;
  if (utilizationState === 'hot') {
    effortKnob = makeKnob(
      'reasoning-effort',
      'Reasoning effort',
      'tighten',
      'low / medium',
      highEffort
        ? `${Math.round(ins.effort)}% of 24h Codex tokens ran at xhigh/max while only ${Math.round(remainingPercent)}% remains — drop immediately to low/medium.`
        : `Only ${Math.round(remainingPercent)}% left (${span} to reset) — step reasoning effort down to low/medium.`,
      '/effort low'
    );
  } else if (utilizationState === 'surplus') {
    if (highEffort && !expiringSoon) {
      effortKnob = makeKnob(
        'reasoning-effort',
        'Reasoning effort',
        'tighten',
        'medium / high (trim xhigh)',
        `${Math.round(ins.effort)}% of 24h Codex tokens ran at xhigh/max with ${span} left in the week — keep routine edits at medium and save xhigh for hard steps.`,
        '/effort medium'
      );
    } else {
      effortKnob = makeKnob(
        'reasoning-effort',
        'Reasoning effort',
        'boost',
        'high / xhigh',
        highEffort
          ? `24h xhigh/max share is ${Math.round(ins.effort)}%, which is ideal here since ${Math.round(remainingPercent)}% surplus expires in ${span}.`
          : `${Math.round(remainingPercent)}% headroom (${span} to reset) — high and xhigh reasoning are safe on complex builds and reviews.`,
        '/effort xhigh'
      );
    }
  } else if (highEffort) {
    effortKnob = makeKnob(
      'reasoning-effort',
      'Reasoning effort',
      'tighten',
      'low / medium (cut xhigh)',
      `${Math.round(ins.effort)}% of 24h Codex tokens ran at xhigh/max effort — drop routine edits to medium/low to protect the rest of the week.`,
      '/effort medium'
    );
  } else {
    effortKnob = makeKnob(
      'reasoning-effort',
      'Reasoning effort',
      'steady',
      'medium / high',
      `On pace (${Math.round(remainingPercent)}% left) — default to medium effort and raise to high only for tricky design or debugging.`,
      '/effort medium'
    );
  }

  // 3. model-tier
  let modelKnob;
  if (utilizationState === 'surplus') {
    modelKnob = makeKnob(
      'model-tier',
      'Model stepping',
      'boost',
      'gpt-6.2-sol / astra',
      `${Math.round(remainingPercent)}% headroom — keep primary coding and deep reviews on top-tier gpt-6.2-sol or astra.`,
      '/model gpt-6.2-sol'
    );
  } else if (utilizationState === 'hot') {
    modelKnob = makeKnob(
      'model-tier',
      'Model stepping',
      'tighten',
      'gpt-6.1-terra / gpt-6-luna',
      `Only ${Math.round(remainingPercent)}% left before the ${span} reset — step down to gpt-6.1-terra or gpt-6-luna for essential edits.`,
      '/model gpt-6.1-terra'
    );
  } else {
    modelKnob = makeKnob(
      'model-tier',
      'Model stepping',
      'steady',
      'Sol plans · Terra edits',
      `On pace (${Math.round(remainingPercent)}% left) — plan and review on gpt-6.2-sol, execute bounded edits on gpt-6.1-terra.`,
      '/model gpt-6.1-terra'
    );
  }

  // 4. context-cliff
  let cliffKnob;
  if (highContext) {
    cliffKnob = makeKnob(
      'context-cliff',
      '272k context cliff',
      'tighten',
      `Checkpoint <250k (${Math.round(ins.context)}% >150k)`,
      `${Math.round(ins.context)}% of 24h Codex tokens exceeded 150k context — checkpoint into a fresh thread before 250k so you never hit the 272k 2x input cliff.`,
      '/new'
    );
  } else if (utilizationState === 'hot') {
    cliffKnob = makeKnob(
      'context-cliff',
      '272k context cliff',
      'tighten',
      'Hard cap <150k–250k',
      `Only ${Math.round(remainingPercent)}% left — checkpoint early well below the 272k 2x input-weight cliff.`,
      '/new'
    );
  } else {
    cliffKnob = makeKnob(
      'context-cliff',
      '272k context cliff',
      'steady',
      'Checkpoint <250k',
      'OpenAI models jump to 2x input weight above 272k tokens — checkpoint into a fresh thread before 250k.',
      '/new'
    );
  }

  // 5. subagents-review
  let subagentKnob;
  if (highSubagents) {
    subagentKnob = makeKnob(
      'subagents-review',
      'Subagents & auto-review',
      'tighten',
      `Luna workers · explicit files (${Math.round(ins.subagents)}%)`,
      `Subagents drove ${Math.round(ins.subagents)}% of 24h Codex tokens — pass explicit file lists, route workers/verifiers to gpt-6-luna, and cut auto-review overhead.`,
      '/model gpt-6-luna'
    );
  } else if (utilizationState === 'hot') {
    subagentKnob = makeKnob(
      'subagents-review',
      'Subagents & auto-review',
      'tighten',
      'Single-thread · auto-review OFF',
      `Codex is tight (${Math.round(remainingPercent)}% left) — pause subagent fan-out and disable automatic review passes until reset.`,
      '/model gpt-6-luna'
    );
  } else if (utilizationState === 'surplus') {
    subagentKnob = makeKnob(
      'subagents-review',
      'Subagents & auto-review',
      'boost',
      'Parallel workers + verifier OK',
      `${Math.round(remainingPercent)}% headroom supports parallel workers and verifiers — still pin routine roles to gpt-6-luna with explicit file lists.`
    );
  } else {
    subagentKnob = makeKnob(
      'subagents-review',
      'Subagents & auto-review',
      'steady',
      'Luna workers · explicit files',
      'Give subagents explicit file lists and route verifier/auto-review roles to gpt-6-luna to avoid redundant context burn.'
    );
  }

  // 6. banked-resets
  let bankedKnob;
  if (creditExpiringSoon) {
    bankedKnob = makeKnob(
      'banked-resets',
      'Banked resets & cache',
      'boost',
      `Redeem soon (expires ${formatSpan(expiryHours)})`,
      `${usableCredits} banked reset credit expires in ${formatSpan(expiryHours)} — plan to redeem in /usage before it expires. ${cacheNote}`,
      '/usage'
    );
  } else if (usableCredits > 0) {
    bankedKnob = makeKnob(
      'banked-resets',
      'Banked resets & cache',
      lowCache ? 'tighten' : 'steady',
      `Hold ${usableCredits} banked${ins.cache !== null ? ` · ${Math.round(ins.cache)}% cache` : ''}`,
      `Hold ${usableCredits} banked reset credit as a safety buffer${expiryHours !== null && expiryHours > 0 ? ` (expires in ${formatSpan(expiryHours)})` : ''}. ${cacheNote}`,
      '/usage'
    );
  } else {
    bankedKnob = makeKnob(
      'banked-resets',
      'Banked resets & cache',
      lowCache ? 'tighten' : (ins.cache !== null && ins.cache >= 85 ? 'boost' : 'steady'),
      `0 banked${ins.cache !== null ? ` · ${Math.round(ins.cache)}% cache` : ' · stable prefix'}`,
      `No banked reset credits on hand. ${cacheNote}`
    );
  }

  return [speedKnob, effortKnob, modelKnob, cliffKnob, subagentKnob, bankedKnob];
}

function buildCodexPlaybook(summary, insights, now = Date.now()) {
  const { utilizationState, remainingPercent, hoursLeft, projectedUnusedAtReset, bankedResets } = summary;
  const usableCredits = bankedResets.usableCount || 0;
  const fastInsight = getInsightMetric(insights, 'codex', 'fast');
  const effortInsight = getInsightMetric(insights, 'codex', 'effort');
  const span = formatSpan(hoursLeft);
  const knobs = buildCodexKnobs(summary, insights, now);

  if (utilizationState === 'blocked') {
    return {
      mode: 'pause',
      headline: 'Codex is manually blocked',
      badges: ['Blocked'],
      guidance: ['Unblock Codex when you want to route work there again.'],
      commands: ['/guard-block none'],
      knobs,
    };
  }
  if (utilizationState === 'unknown') {
    return {
      mode: 'pause',
      headline: 'Refresh Codex /usage to check /fast and effort headroom',
      badges: ['Awaiting reading'],
      guidance: ['Run codex /usage or npm run check -- --live to read your weekly limit and banked resets.'],
      commands: ['/usage'],
      knobs,
    };
  }
  if (utilizationState === 'exhausted') {
    if (usableCredits > 0) {
      return {
        mode: 'pause',
        headline: `Codex exhausted — ${usableCredits} banked reset credit ready (or wait ${span})`,
        badges: ['Exhausted', `${usableCredits} banked reset`, '/fast OFF'],
        guidance: [
          `Redeem 1 banked reset in Codex /usage if you need Codex immediately; otherwise wait ${span} and keep the credit banked.`,
          'Turn /fast OFF before resuming if you need the refilled window to last all week.',
        ],
        commands: ['/usage', '/fast off'],
        knobs,
      };
    }
    return {
      mode: 'pause',
      headline: `Codex exhausted — wait ${span} for reset`,
      badges: ['Exhausted', `Resets in ${span}`],
      guidance: [
        `Hold Codex for ${span} until the weekly allowance refills.`,
        'Shift coding work to AGY or Claude in the meantime.',
      ],
      commands: ['/usage'],
      knobs,
    };
  }
  if (utilizationState === 'surplus') {
    const expiringSoon = Number.isFinite(hoursLeft) && hoursLeft <= 48;
    const badges = ['/fast ON (priority)', 'Effort: high / xhigh', 'Sol / Astra'];
    if (expiringSoon) badges.push(`Resets in ${span}`);
    if (usableCredits > 0) badges.push(`${usableCredits} banked reset`);
    const guidance = [
      `Safe to enable /fast (priority speed) and high/xhigh reasoning effort on Sol or Astra (${Math.round(remainingPercent)}% left, resets in ${span}).`,
    ];
    if (projectedUnusedAtReset !== null && projectedUnusedAtReset >= 20) {
      guidance.push(`At current pace, ~${Math.round(projectedUnusedAtReset)}% will expire unused — put Codex first for heavy builds and reviews.`);
    }
    if (usableCredits > 0) {
      guidance.push(`${usableCredits} banked reset credit also available as a safety net${bankedResets.nextExpiryAt ? ` (check expiry in /usage)` : ''}.`);
    }
    return {
      mode: 'accelerate',
      headline: expiringSoon
        ? `Codex surplus expiring in ${span} (${Math.round(remainingPercent)}% left) — run /fast ON + high/xhigh on Sol/Astra`
        : `High Codex headroom (${Math.round(remainingPercent)}% left) — /fast ON and high/xhigh safe on Sol/Astra`,
      badges,
      guidance,
      commands: ['/fast', '/effort xhigh', '/model gpt-6.2-sol'],
      knobs,
    };
  }
  if (utilizationState === 'hot') {
    const badges = ['/fast OFF (2x-8x burn)', 'Terra / Luna or wait', `Resets in ${span}`];
    if (usableCredits > 0) badges.push(`${usableCredits} banked reset`);
    const guidance = [
      `Turn /fast OFF immediately — priority speed multiplies burn 2x–8x and only ${Math.round(remainingPercent)}% remains before the ${span} reset.`,
      `Step down to Terra or Luna with low/medium effort, or hold Codex for ${span} and use AGY.`,
    ];
    if (usableCredits > 0) {
      guidance.push(`${usableCredits} banked reset credit available in /usage if an urgent deadline cannot wait ${span}.`);
    }
    if (fastInsight !== null && fastInsight >= 20) {
      guidance.push(`Local logs show ${Math.round(fastInsight)}% of recent Codex tokens used /fast — turning it off stops the rapid drain.`);
    }
    return {
      mode: 'conserve',
      headline: `Codex low (${Math.round(remainingPercent)}% left, resets in ${span}) — turn /fast OFF, use Terra/Luna or wait`,
      badges,
      guidance,
      commands: ['/fast off', '/effort low', '/model gpt-6.1-terra'],
      knobs,
    };
  }

  // On-pace
  const badges = ['Standard speed (/fast off)', 'Effort: medium / high'];
  if (usableCredits > 0) badges.push(`${usableCredits} banked reset`);
  const guidance = [
    `Codex is on pace (${Math.round(remainingPercent)}% left, resets in ${span}) — run standard speed with medium/high effort on Sol/Astra.`,
    'Reserve /fast for short latency-critical sprints so the 2x+ multiplier does not eat the week early.',
  ];
  if (effortInsight !== null && effortInsight >= 40) {
    guidance.push(`${Math.round(effortInsight)}% of recent Codex tokens ran at xhigh/max effort — drop routine edits to medium.`);
  }
  return {
    mode: 'steady',
    headline: `Codex on pace (${Math.round(remainingPercent)}% left) — standard speed, medium/high effort`,
    badges,
    guidance,
    commands: ['/fast off', '/effort medium'],
    knobs,
  };
}

function buildClaudeKnobs(summary, others, insights) {
  const { utilizationState, remainingPercent, hoursLeft } = summary;
  const agyCg = others.agy?.utilizationState !== 'blocked' && others.agy?._meta?.agyLanes?.cgFresh
    ? others.agy._meta.agyLanes.cgPrimary
    : null;
  const agyCgRem = agyCg && agyCg.remainingPercent > 0 ? agyCg.remainingPercent : null;
  const codexRem = !['exhausted', 'blocked'].includes(others.codex?.utilizationState) && others.codex?.remainingPercent !== null
    ? others.codex.remainingPercent
    : null;
  const span = formatSpan(hoursLeft);
  const expiringSoon = Number.isFinite(hoursLeft) && hoursLeft <= 48;

  const freshWindows = (summary._meta.allWindows || []).filter(isFreshWindow);
  const accountWeekly = freshWindows.find((w) => !w.modelFamily && (w.windowMinutes >= 1440 || w.windowId.toLowerCase().includes('week'))) || null;
  const scopedWindows = freshWindows.filter((w) => Boolean(w.modelFamily));
  const scopedOpen = scopedWindows.find((w) => w.remainingPercent > 0) || null;
  const scopedTight = scopedWindows.find((w) => w.remainingPercent < 25) || null;

  const ins = getProviderInsights(insights, 'claude');
  const highSubagents = ins.subagents !== null && ins.subagents >= 35;
  const highContext = ins.context !== null && ins.context >= 40;
  const highEffort = ins.effort !== null && ins.effort >= 45;
  const highFast = ins.fast !== null && ins.fast >= 15;
  const lowCache = ins.cache !== null && ins.cache < 80;
  const highCache = ins.cache !== null && ins.cache >= 90;

  if (utilizationState === 'blocked') {
    return [
      makeKnob('model-tier', 'Model tier split', 'off', 'OFF (blocked)', 'Claude is manually blocked — unblock before routing models here.', '/guard-block none'),
      makeKnob('effort-level', 'Per-turn effort', 'off', 'OFF (blocked)', 'Effort tuning resumes once Claude is unblocked.'),
      makeKnob('subagent-fanout', 'Subagent fan-out cap', 'off', 'OFF (blocked)', 'Subagents are paused while Claude is blocked.'),
      makeKnob('context-gravity', 'Context gravity & /clear', 'off', 'Paused', 'Run a 6-bullet handoff + /clear before resuming Claude.', '/clear'),
      makeKnob('cache-ttl', 'Cache TTL batching', 'off', 'Paused', 'Batch related turns inside the 5m/1h cache window once Claude is unblocked.'),
      makeKnob('scoped-windows', 'Scoped weekly & /fast', 'off', 'Blocked · /fast OFF', 'Unblock Claude to monitor account-wide vs scoped weekly buckets.'),
    ];
  }

  if (utilizationState === 'unknown') {
    return [
      makeKnob('model-tier', 'Model tier split', 'steady', 'Opus plans · Sonnet edits', 'Refresh Claude /usage to check Opus/Fable vs Sonnet headroom.', '/usage'),
      makeKnob('effort-level', 'Per-turn effort', 'steady', 'medium / high', 'Default to medium/high until live allowance windows confirm surplus.', '/effort medium'),
      makeKnob('subagent-fanout', 'Subagent fan-out cap', 'steady', 'Targeted (explicit files)', 'Each Claude sidechain builds a fresh context window — keep fan-out tight until /usage updates.'),
      makeKnob('context-gravity', 'Context gravity & /clear', 'steady', '6-bullet handoff + /clear', 'Use a 6-bullet handoff + /clear at milestones to stay below 150k context.', '/clear'),
      makeKnob('cache-ttl', 'Cache TTL batching', 'steady', 'Batch inside 5m/1h TTL', 'Group related edits inside the 5m/1h prompt cache window to sustain 90%+ cache-read reuse.'),
      makeKnob('scoped-windows', 'Scoped weekly & /fast', 'steady', 'Check /usage · /fast OFF', 'Refresh /usage to compare account-wide weekly limits against scoped Opus/Fable buckets.', '/usage'),
    ];
  }

  if (utilizationState === 'exhausted') {
    const modelKnob = agyCgRem !== null && agyCgRem >= 30
      ? makeKnob('model-tier', 'Model tier split', 'off', 'Shift to AGY Claude/GPT', `Native Claude is exhausted (${span} to reset) — shift Opus/coding work to AGY's Claude/GPT lane (${Math.round(agyCgRem)}% left).`, '/model claude-opus-5-5-high')
      : codexRem !== null && codexRem >= 20
        ? makeKnob('model-tier', 'Model tier split', 'off', `OFF · shift to Codex (${Math.round(codexRem)}%)`, `Native Claude is exhausted (${span} to reset) — overflow active coding to Codex (${Math.round(codexRem)}% left).`)
        : makeKnob('model-tier', 'Model tier split', 'off', `OFF (wait ${span})`, `Native Claude is exhausted — hold until reset in ${span}.`, '/usage');

    const scopedKnob = scopedOpen
      ? makeKnob('scoped-windows', 'Scoped weekly & /fast', 'off', `${scopedOpen.label} ${Math.round(scopedOpen.remainingPercent)}% (overall 0%)`, `${scopedOpen.label} still has ${Math.round(scopedOpen.remainingPercent)}% left, but account-wide weekly is capped at 0% (resets in ${span}) — keep /fast OFF when resuming.`, '/usage')
      : makeKnob('scoped-windows', 'Scoped weekly & /fast', 'off', 'Weekly 0% · /fast OFF', `Account-wide weekly allowance is exhausted for ${span} — keep /fast OFF once it refills.`, '/usage');

    return [
      modelKnob,
      makeKnob('effort-level', 'Per-turn effort', 'off', 'OFF (exhausted)', `Native Claude is paused until the ${span} reset.`),
      makeKnob('subagent-fanout', 'Subagent fan-out cap', 'off', 'OFF (exhausted)', `Pause sidechain fan-out until native Claude resets in ${span}.`),
      makeKnob('context-gravity', 'Context gravity & /clear', 'off', '/clear before resume', `Prepare a 6-bullet handoff and /clear stale context before Claude unlocks in ${span}.`, '/clear'),
      makeKnob('cache-ttl', 'Cache TTL batching', 'off', 'Queue batch for reset', `Cluster queued edits inside the 5m/1h cache window once Claude resets in ${span}.`),
      scopedKnob,
    ];
  }

  // 1. model-tier
  let modelKnob;
  if (utilizationState === 'surplus') {
    modelKnob = makeKnob(
      'model-tier',
      'Model tier split',
      'boost',
      'Opus / Fable',
      `${Math.round(remainingPercent)}% left (resets in ${span}) — use Opus/Fable for planning, deep review, and hard debugging.`,
      '/model opus'
    );
  } else if (utilizationState === 'hot') {
    modelKnob = makeKnob(
      'model-tier',
      'Model tier split',
      'tighten',
      'Sonnet / Haiku only',
      agyCgRem !== null && agyCgRem >= 30
        ? `Only ${Math.round(remainingPercent)}% left — keep native Claude on Sonnet/Haiku and offload Opus work to AGY Claude/GPT (${Math.round(agyCgRem)}% left).`
        : `Only ${Math.round(remainingPercent)}% left (${span} to reset) — pause Opus/Fable and stick to Sonnet/Haiku for small checks.`,
      '/model haiku'
    );
  } else {
    modelKnob = makeKnob(
      'model-tier',
      'Model tier split',
      'steady',
      'Opus plans · Sonnet edits',
      `On pace (${Math.round(remainingPercent)}% left, resets in ${span}) — use Opus/Fable for plans & review, Sonnet for bounded execution.`,
      '/model sonnet'
    );
  }

  // 2. effort-level
  let effortKnob;
  if (utilizationState === 'hot') {
    effortKnob = makeKnob(
      'effort-level',
      'Per-turn effort',
      'tighten',
      'medium',
      `Only ${Math.round(remainingPercent)}% left — hold per-turn effort at medium and avoid max thinking bursts.`,
      '/effort medium'
    );
  } else if (utilizationState === 'surplus') {
    if (highEffort && !expiringSoon) {
      effortKnob = makeKnob(
        'effort-level',
        'Per-turn effort',
        'tighten',
        'medium / high (trim max)',
        `${Math.round(ins.effort)}% of 24h Claude tokens ran at max effort with ${span} left — keep routine turns at medium/high.`,
        '/effort high'
      );
    } else {
      effortKnob = makeKnob(
        'effort-level',
        'Per-turn effort',
        'boost',
        'high / max',
        `${Math.round(remainingPercent)}% headroom (${span} to reset) — high and max effort are open for architecture and root-cause work.`,
        '/effort high'
      );
    }
  } else if (highEffort) {
    effortKnob = makeKnob(
      'effort-level',
      'Per-turn effort',
      'tighten',
      'medium (cut max)',
      `${Math.round(ins.effort)}% of 24h Claude tokens ran at max effort — step routine edits back to medium.`,
      '/effort medium'
    );
  } else {
    effortKnob = makeKnob(
      'effort-level',
      'Per-turn effort',
      'steady',
      'medium / high',
      `On pace (${Math.round(remainingPercent)}% left) — run medium for execution and raise to high for design or reviews.`,
      '/effort medium'
    );
  }

  // 3. subagent-fanout
  let subagentKnob;
  if (utilizationState === 'hot') {
    subagentKnob = makeKnob(
      'subagent-fanout',
      'Subagent fan-out cap',
      'off',
      'OFF (single-owner only)',
      highSubagents
        ? `Subagents drove ${Math.round(ins.subagents)}% of 24h Claude tokens while only ${Math.round(remainingPercent)}% remains — turn fan-out OFF and stay single-owner.`
        : `Only ${Math.round(remainingPercent)}% left — turn subagent fan-out OFF because each sidechain builds a fresh context window.`
    );
  } else if (highSubagents) {
    subagentKnob = makeKnob(
      'subagent-fanout',
      'Subagent fan-out cap',
      'tighten',
      `Single-owner · Sonnet/Haiku (${Math.round(ins.subagents)}%)`,
      `Subagents drove ${Math.round(ins.subagents)}% of 24h Claude tokens — each sidechain builds a fresh context window; prefer single-owner execution with explicit file lists and Sonnet/Haiku workers.`,
      '/model sonnet'
    );
  } else if (utilizationState === 'surplus') {
    subagentKnob = makeKnob(
      'subagent-fanout',
      'Subagent fan-out cap',
      'boost',
      'Parallel subagents OK',
      `${Math.round(remainingPercent)}% headroom supports parallel exploration and review subagents — still pass explicit file lists to keep sidechains lean.`
    );
  } else {
    subagentKnob = makeKnob(
      'subagent-fanout',
      'Subagent fan-out cap',
      'steady',
      '1–2 focused (Sonnet/Haiku)',
      'Keep routine edits single-owner; when fanning out, pass explicit file lists and pin workers to Sonnet or Haiku.'
    );
  }

  // 4. context-gravity
  let contextKnob;
  if (highContext) {
    contextKnob = makeKnob(
      'context-gravity',
      'Context gravity & /clear',
      'tighten',
      `6-bullet handoff + /clear (${Math.round(ins.context)}% >150k)`,
      `${Math.round(ins.context)}% of 24h Claude tokens ran above 150k context — write a 6-bullet handoff and run /clear at milestones to stop prompt drag.`,
      '/clear'
    );
  } else if (utilizationState === 'hot') {
    contextKnob = makeKnob(
      'context-gravity',
      'Context gravity & /clear',
      'tighten',
      'Aggressive /clear (<100k)',
      `Only ${Math.round(remainingPercent)}% left — run a 6-bullet handoff + /clear on every milestone so long threads do not drain your final quota.`,
      '/clear'
    );
  } else if (utilizationState === 'surplus') {
    contextKnob = makeKnob(
      'context-gravity',
      'Context gravity & /clear',
      'steady',
      '/clear on topic switch',
      'Write a short 6-bullet handoff + /clear when switching unrelated topics to keep cache focused and avoid >150k drag.',
      '/clear'
    );
  } else {
    contextKnob = makeKnob(
      'context-gravity',
      'Context gravity & /clear',
      'steady',
      '6-bullet handoff + /clear',
      'Run /clear at task milestones with a 6-bullet handoff to keep prompt context under 150k tokens.',
      '/clear'
    );
  }

  // 5. cache-ttl
  let cacheKnob;
  if (lowCache) {
    cacheKnob = makeKnob(
      'cache-ttl',
      'Cache TTL batching',
      'tighten',
      `Batch 5m/1h TTL (${Math.round(ins.cache)}% reuse)`,
      `24h cache-read reuse is ${Math.round(ins.cache)}% (below 90% target) — batch related edits inside the 5m/1h cache window instead of repeatedly paying cache writes.`
    );
  } else if (highCache) {
    cacheKnob = makeKnob(
      'cache-ttl',
      'Cache TTL batching',
      'boost',
      `${Math.round(ins.cache)}% reuse (5m/1h TTL)`,
      `Strong ${Math.round(ins.cache)}% cache-read reuse — keep batching follow-up turns within the 5m/1h cache window to avoid cold writes.`
    );
  } else if (utilizationState === 'hot') {
    cacheKnob = makeKnob(
      'cache-ttl',
      'Cache TTL batching',
      'tighten',
      'Tight 5m/1h batches',
      `Headroom is tight (${Math.round(remainingPercent)}% left) — cluster related prompts inside the 5m/1h cache window to hold 90%+ cache-read reuse.`
    );
  } else {
    cacheKnob = makeKnob(
      'cache-ttl',
      'Cache TTL batching',
      'steady',
      ins.cache !== null ? `${Math.round(ins.cache)}% reuse · target 90%+` : 'Batch inside 5m/1h TTL',
      'Batch related edits inside the 5m/1h cache window to sustain 90%+ cache-read reuse instead of repeatedly paying cache writes.'
    );
  }

  // 6. scoped-windows
  let scopedKnob;
  const acctPct = accountWeekly ? Math.round(accountWeekly.remainingPercent) : Math.round(remainingPercent);
  if (scopedTight && accountWeekly && accountWeekly.remainingPercent >= 35) {
    scopedKnob = makeKnob(
      'scoped-windows',
      'Scoped weekly & /fast',
      'tighten',
      `${scopedTight.label} ${Math.round(scopedTight.remainingPercent)}% · Weekly ${acctPct}% · /fast OFF`,
      `${scopedTight.label} is down to ${Math.round(scopedTight.remainingPercent)}% even though account-wide weekly has ${acctPct}% left — shift routine turns to Sonnet and keep /fast OFF.`,
      '/model sonnet'
    );
  } else if (utilizationState === 'hot' || highFast) {
    scopedKnob = makeKnob(
      'scoped-windows',
      'Scoped weekly & /fast',
      'tighten',
      scopedOpen ? `Weekly ${acctPct}% · ${scopedOpen.label} ${Math.round(scopedOpen.remainingPercent)}% · /fast OFF` : `Weekly ${acctPct}% · /fast OFF`,
      highFast
        ? `${Math.round(ins.fast)}% of 24h Claude tokens used /fast — turn /fast OFF to stop burning weekly allowance prematurely.`
        : `Account-wide weekly is at ${acctPct}%${scopedOpen ? ` (${scopedOpen.label}: ${Math.round(scopedOpen.remainingPercent)}%)` : ''} — keep /fast OFF under pressure.`,
      '/fast off'
    );
  } else if (utilizationState === 'surplus') {
    scopedKnob = makeKnob(
      'scoped-windows',
      'Scoped weekly & /fast',
      'boost',
      scopedOpen ? `Weekly ${acctPct}% · ${scopedOpen.label} ${Math.round(scopedOpen.remainingPercent)}%` : `Weekly ${acctPct}% · /fast targeted`,
      scopedOpen
        ? `Both account-wide weekly (${acctPct}%) and ${scopedOpen.label} (${Math.round(scopedOpen.remainingPercent)}%) have strong headroom — use Opus/Fable freely and keep /fast targeted.`
        : `${acctPct}% weekly headroom (${span} to reset) — Opus/Fable open, keep /fast targeted to avoid wasted multiplier burn.`
    );
  } else {
    scopedKnob = makeKnob(
      'scoped-windows',
      'Scoped weekly & /fast',
      'steady',
      scopedOpen ? `Weekly ${acctPct}% · ${scopedOpen.label} ${Math.round(scopedOpen.remainingPercent)}% · /fast OFF` : `Weekly ${acctPct}% · /fast OFF`,
      scopedOpen
        ? `Account-wide weekly (${acctPct}%) and ${scopedOpen.label} (${Math.round(scopedOpen.remainingPercent)}%) are on pace — keep /fast OFF.`
        : `Account-wide weekly is on pace (${acctPct}% left, resets in ${span}) — keep /fast OFF for steady pacing.`
    );
  }

  return [modelKnob, effortKnob, subagentKnob, contextKnob, cacheKnob, scopedKnob];
}

function buildClaudePlaybook(summary, others, insights) {
  const { utilizationState, remainingPercent, hoursLeft, projectedUnusedAtReset, bankedResets } = summary;
  const agyCg = others.agy?.utilizationState !== 'blocked' && others.agy?._meta?.agyLanes?.cgFresh ? others.agy._meta.agyLanes.cgPrimary : null;
  const agyCgRem = agyCg && agyCg.remainingPercent > 0 ? agyCg.remainingPercent : null;
  const codexRem = !['exhausted', 'blocked'].includes(others.codex?.utilizationState) && others.codex?.remainingPercent !== null ? others.codex.remainingPercent : null;
  const subagentInsight = getInsightMetric(insights, 'claude', 'subagents');
  const contextInsight = getInsightMetric(insights, 'claude', 'context');
  const span = formatSpan(hoursLeft);
  const knobs = buildClaudeKnobs(summary, others, insights);

  if (utilizationState === 'blocked') {
    return {
      mode: 'pause',
      headline: 'Claude is manually blocked',
      badges: ['Blocked'],
      guidance: ['Unblock Claude when you want to route tasks back to it.'],
      commands: ['/guard-block none'],
      knobs,
    };
  }
  if (utilizationState === 'unknown') {
    return {
      mode: 'pause',
      headline: 'Refresh Claude /usage to check Opus/Fable vs Sonnet headroom',
      badges: ['Awaiting reading'],
      guidance: ['Sign in to Claude Code or run npm run check -- --live to fetch live weekly/session limits.'],
      commands: ['/usage'],
      knobs,
    };
  }
  if (utilizationState === 'exhausted') {
    const badges = ['Exhausted', `Resets in ${span}`];
    const guidance = [`Hold native Claude until its allowance resets in ${span}.`];
    const commands = [];
    if (agyCgRem !== null && agyCgRem >= 30) {
      badges.push(`Shift to AGY Claude/GPT (${Math.round(agyCgRem)}%)`);
      guidance.push(`Shift Opus/coding work to AGY's Claude/GPT lane (${Math.round(agyCgRem)}% left) right now.`);
      commands.push('/model claude-opus-5-5-high');
    } else if (codexRem !== null && codexRem >= 20) {
      badges.push(`Shift to Codex (${Math.round(codexRem)}%)`);
      guidance.push(`Shift coding tasks to Codex (${Math.round(codexRem)}% left) while Claude resets.`);
    }
    const scopedOpen = summary.windows.find((w) => w.modelFamily && w.remainingPercent > 0);
    if (scopedOpen) {
      guidance.push(`Note: ${scopedOpen.label} still shows ${Math.round(scopedOpen.remainingPercent)}%, but the overall weekly cap at 0% blocks Claude until ${span}.`);
    }
    if ((bankedResets.usableCount || 0) > 0) {
      guidance.push(`${bankedResets.usableCount} banked reset credit reported on Claude.`);
    }
    if (!commands.length) commands.push('/usage');
    return {
      mode: 'pause',
      headline: agyCgRem !== null && agyCgRem >= 30
        ? `Claude exhausted (${span} to reset) — shift Opus/coding to AGY Claude/GPT lane (${Math.round(agyCgRem)}% left)`
        : `Claude exhausted — hold until reset in ${span}`,
      badges,
      guidance,
      commands,
      knobs,
    };
  }
  if (utilizationState === 'surplus') {
    const badges = ['Opus / Fable', 'Parallel subagents OK', '/clear between tasks'];
    const guidance = [
      `Claude has ${Math.round(remainingPercent)}% left (resets in ${span}) — use Opus/Fable for planning, deep review, and parallel subagents.`,
      'Run /clear when switching unrelated topics so cache stays focused instead of carrying stale context.',
    ];
    if (projectedUnusedAtReset !== null && projectedUnusedAtReset >= 25) {
      guidance.push(`At current pace, ~${Math.round(projectedUnusedAtReset)}% could expire unused — prioritize Claude for high-leverage design and review.`);
    }
    return {
      mode: 'accelerate',
      headline: `Claude surplus (${Math.round(remainingPercent)}% left) — Opus/Fable planning + parallel subagents open`,
      badges,
      guidance,
      commands: ['/model opus', '/clear'],
      knobs,
    };
  }
  if (utilizationState === 'hot') {
    const badges = ['Conserve / /clear', 'Sonnet / Haiku only', 'Subagents OFF'];
    const guidance = [
      `Claude is tight (${Math.round(remainingPercent)}% left, resets in ${span}) — turn off subagent fan-out, run /clear aggressively, and stick to Sonnet/Haiku for small checks.`,
    ];
    if (agyCgRem !== null && agyCgRem >= 30) {
      guidance.push(`Shift heavy Opus/coding work to AGY's Claude/GPT lane (${Math.round(agyCgRem)}% left) instead of burning Claude's last ${Math.round(remainingPercent)}%.`);
    } else if (codexRem !== null && codexRem >= 25) {
      guidance.push(`Shift heavy coding work to Codex (${Math.round(codexRem)}% left) until Claude resets.`);
    }
    return {
      mode: 'conserve',
      headline: `Claude tight (${Math.round(remainingPercent)}% left, resets in ${span}) — hold heavy Opus work, use /clear or overflow`,
      badges,
      guidance,
      commands: ['/clear', '/model haiku'],
      knobs,
    };
  }

  // On-pace
  const badges = ['Opus plan / Sonnet exec', '/clear on switch'];
  const guidance = [
    `Claude is on pace (${Math.round(remainingPercent)}% left, resets in ${span}) — use Opus/Fable for plans & review, Sonnet for bounded execution.`,
    'Run /clear between milestones to keep prompt context under 150k tokens.',
  ];
  if (subagentInsight !== null && subagentInsight >= 35) {
    guidance.push(`Subagents drove ${Math.round(subagentInsight)}% of recent Claude tokens — keep routine edits in a single thread.`);
  } else if (contextInsight !== null && contextInsight >= 40) {
    guidance.push(`${Math.round(contextInsight)}% of recent Claude tokens ran above 150k context — compact or /clear earlier.`);
  }
  return {
    mode: 'steady',
    headline: `Claude on pace (${Math.round(remainingPercent)}% left) — Opus/Fable for plans, Sonnet for execution`,
    badges,
    guidance,
    commands: ['/model sonnet', '/clear'],
    knobs,
  };
}

function rankProviders(summaries) {
  function tier(s) {
    if (s.utilizationState === 'surplus') {
      const expiring = Number.isFinite(s.hoursLeft) && s.hoursLeft <= 48;
      return expiring ? 0 : 1;
    }
    if (s.utilizationState === 'on-pace') return 2;
    if (s.utilizationState === 'hot') return 3;
    if (s.utilizationState === 'exhausted') return (s.bankedResets.usableCount || 0) > 0 ? 4 : 5;
    if (s.utilizationState === 'unknown') return 6;
    return 7; // blocked
  }

  return [...summaries].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;

    const ha = Number.isFinite(a.hoursLeft) ? a.hoursLeft : Infinity;
    const hb = Number.isFinite(b.hoursLeft) ? b.hoursLeft : Infinity;
    const ra = a.remainingPercent ?? -1;
    const rb = b.remainingPercent ?? -1;

    if (ta === 0) {
      // Expiring surplus: soonest reset first, then highest projected unused value.
      if (ha !== hb) return ha - hb;
      return (b.projectedUnusedAtReset ?? rb) - (a.projectedUnusedAtReset ?? ra);
    }
    if (ta === 1) {
      // Surplus (>48h): highest expiring unused value or soonest reset with real headroom.
      const ua = a.projectedUnusedAtReset ?? 0;
      const ub = b.projectedUnusedAtReset ?? 0;
      if (Math.abs(ub - ua) >= 15) return ub - ua;
      if (ha !== hb) return ha - hb;
      return rb - ra;
    }
    if (ta === 2) {
      // On-pace: use-it-or-lose-it (soonest reset first), tie-break by remaining %.
      if (ha !== hb) return ha - hb;
      return rb - ra;
    }
    if (ta === 3) {
      // Hot: higher remaining % first, then soonest reset.
      if (rb !== ra) return rb - ra;
      return ha - hb;
    }
    // Exhausted / unknown / blocked: earliest unlock first.
    if (ha !== hb) return ha - hb;
    return SUBSCRIPTION_IDS.indexOf(a.provider) - SUBSCRIPTION_IDS.indexOf(b.provider);
  });
}

function findNextUnlock(summaries) {
  const candidates = [];
  for (const s of summaries) {
    if (s.utilizationState === 'blocked') continue;
    const constrained = ['exhausted', 'hot'].includes(s.utilizationState);
    for (const w of s.windows) {
      if (!w.resetAt || !Number.isFinite(w.hoursLeft) || w.hoursLeft <= 0) continue;
      if (['stale', 'verify-reset'].includes(w.status)) continue;
      const isDepletedOrLow = w.remainingPercent <= 20;
      candidates.push({
        provider: s.provider,
        windowId: w.windowId,
        resetAt: w.resetAt,
        hoursLeft: w.hoursLeft,
        label: `${SHORT_LABELS[s.provider]} ${w.label} resets in ${formatSpan(w.hoursLeft)}`,
        priority: constrained && isDepletedOrLow ? 0 : constrained ? 1 : 2,
      });
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => a.priority - b.priority || a.hoursLeft - b.hoursLeft);
  const best = candidates[0];
  return {
    provider: best.provider,
    windowId: best.windowId,
    resetAt: best.resetAt,
    hoursLeft: best.hoursLeft,
    label: best.label,
  };
}

function buildAlerts(summaries, byId, strategy) {
  const alerts = [];
  const agy = byId.agy;
  const codex = byId.codex;
  const claude = byId.claude;

  // 1. Expiring surplus alerts (use-it-or-lose-it)
  for (const s of summaries) {
    if (s.utilizationState === 'surplus') {
      const expiringSoon = Number.isFinite(s.hoursLeft) && s.hoursLeft <= 48;
      const unused = s.projectedUnusedAtReset;
      if (expiringSoon || (unused !== null && unused >= 25)) {
        const cmd = s.provider === 'agy' ? '/swarm' : s.provider === 'codex' ? '/fast' : '/model opus';
        alerts.push({
          kind: 'surplus',
          severity: 'opportunity',
          provider: s.provider,
          title: expiringSoon
            ? `${SHORT_LABELS[s.provider]} surplus expiring in ${formatSpan(s.hoursLeft)}`
            : `${SHORT_LABELS[s.provider]} has high unused headroom (~${Math.round(unused)}% projected unused)`,
          detail: s.provider === 'codex'
            ? `${Math.round(s.remainingPercent)}% remaining with ${formatSpan(s.hoursLeft)} left — turn /fast ON and run high/xhigh effort on Sol/Astra to capture full value.`
            : s.provider === 'agy'
              ? `${Math.round(s.remainingPercent)}% remaining on AGY — launch /swarm (3–4 workers + verifier) on Gemini Neon/Hydrogen.`
              : `${Math.round(s.remainingPercent)}% remaining on Claude — use Opus/Fable and parallel subagents before reset.`,
          command: cmd,
        });
      }
    }
  }

  // 2. AGY Claude/GPT lane hidden-value opportunity
  const agyLanes = agy?._meta?.agyLanes;
  if (agy && agy.utilizationState !== 'blocked' && agyLanes?.cgFresh && agyLanes.cgPrimary.remainingPercent >= 50) {
    const cgRem = Math.round(agyLanes.cgPrimary.remainingPercent);
    const nativeTight = ['exhausted', 'hot'].includes(claude?.utilizationState) || ['exhausted', 'hot'].includes(codex?.utilizationState);
    if (nativeTight || cgRem >= 80) {
      alerts.push({
        kind: 'lane-opportunity',
        severity: 'opportunity',
        provider: 'agy',
        title: `AGY Claude/GPT lane is ${cgRem}% free`,
        detail: nativeTight
          ? `Native ${claude?.utilizationState === 'exhausted' ? 'Claude is exhausted' : 'Claude/Codex are tight'}, while AGY's separate Claude/GPT bucket still has ${cgRem}% remaining.`
          : `AGY's separate Claude/GPT bucket is almost untouched (${cgRem}% left) alongside your Gemini quota.`,
        command: '/model claude-opus-5-5-high',
      });
    }
  }

  // 3. AGY /swarm ready (when not already covered by expiring surplus)
  if (agy && agy.utilizationState === 'surplus' && !alerts.some((a) => a.provider === 'agy' && a.kind === 'surplus') && agyLanes?.geminiFresh && agyLanes.geminiPrimary.remainingPercent >= 50) {
    alerts.push({
      kind: 'swarm-ready',
      severity: 'opportunity',
      provider: 'agy',
      title: `AGY Gemini ready for /swarm (${Math.round(agyLanes.geminiPrimary.remainingPercent)}% left)`,
      detail: 'Plenty of Gemini weekly & session headroom — run 3–4 parallel /swarm workers + verifier on Neon or Hydrogen.',
      command: '/swarm',
    });
  }

  // 4. Codex /fast danger when hot
  if (codex && codex.utilizationState === 'hot') {
    alerts.push({
      kind: 'fast-burn',
      severity: 'warn',
      provider: 'codex',
      title: `Turn Codex /fast OFF (${Math.round(codex.remainingPercent)}% left)`,
      detail: `/fast multiplies Codex quota burn 2x–8x. With ${formatSpan(codex.hoursLeft)} until reset, switch to standard speed on Terra/Luna or wait.`,
      command: '/fast off',
    });
  }

  // 5. Banked reset credit alerts
  for (const s of summaries) {
    const usable = s.bankedResets.usableCount || 0;
    if (usable > 0 && (['exhausted', 'hot'].includes(s.utilizationState) || s.bankedResets.action === 'consider-reset')) {
      alerts.push({
        kind: 'banked-reset',
        severity: s.utilizationState === 'exhausted' ? 'opportunity' : 'info',
        provider: s.provider,
        title: `${SHORT_LABELS[s.provider]} has ${usable} banked reset credit${usable === 1 ? '' : 's'}`,
        detail: s.utilizationState === 'exhausted'
          ? `Redeem in ${SHORT_LABELS[s.provider]} /usage to unlock immediately, or wait ${formatSpan(s.hoursLeft)} to save the credit.`
          : `Banked reset available if current ${Math.round(s.remainingPercent ?? 0)}% runs dry before reset.`,
        command: '/usage',
      });
    }
  }

  // 6. Exhausted alerts
  for (const s of summaries) {
    if (s.utilizationState === 'exhausted') {
      alerts.push({
        kind: 'exhausted',
        severity: strategy === 'wait' ? 'critical' : 'warn',
        provider: s.provider,
        title: `${SHORT_LABELS[s.provider]} exhausted (resets in ${formatSpan(s.hoursLeft)})`,
        detail: (s.playbook.guidance || []).slice(0, 2).join(' ') || s.playbook.headline,
        command: s.playbook.commands[0] || null,
      });
    }
  }

  // 7. Stale / unknown alerts
  for (const s of summaries) {
    if (s.utilizationState === 'unknown') {
      alerts.push({
        kind: 'stale',
        severity: 'info',
        provider: s.provider,
        title: `${SHORT_LABELS[s.provider]} allowance needs a fresh reading`,
        detail: `No fresh ${SHORT_LABELS[s.provider]} reading is available; refresh collectors before routing automatically.`,
        command: 'npm run check -- --live',
      });
    }
  }

  return alerts;
}

function buildQuickCommands(ranked, byId) {
  const cmds = [];
  const push = (item) => {
    if (cmds.length >= 5) return;
    if (cmds.some((c) => c.tool === item.tool && c.command === item.command)) return;
    cmds.push(item);
  };

  const agy = byId.agy;
  const codex = byId.codex;
  const claude = byId.claude;
  const agyLanes = agy?._meta?.agyLanes;

  for (const s of ranked) {
    if (s.provider === 'agy' && s.utilizationState === 'surplus') {
      if (agyLanes?.geminiFresh && agyLanes.geminiPrimary.remainingPercent >= 50) {
        push({
          tool: 'agy',
          label: 'Launch AGY /swarm',
          command: '/swarm',
          why: `Gemini has ${Math.round(agyLanes.geminiPrimary.remainingPercent)}% left — run 3–4 workers + verifier`,
        });
      }
      if (agyLanes?.cgFresh && agyLanes.cgPrimary.remainingPercent >= 40 && (['exhausted', 'hot'].includes(claude?.utilizationState) || ['exhausted', 'hot'].includes(codex?.utilizationState))) {
        push({
          tool: 'agy',
          label: 'Tap AGY Claude/GPT lane',
          command: '/model claude-opus-5-5-high',
          why: `AGY Claude/GPT bucket is ${Math.round(agyLanes.cgPrimary.remainingPercent)}% free`,
        });
      }
    } else if (s.provider === 'codex' && s.utilizationState === 'surplus') {
      push({
        tool: 'codex',
        label: 'Enable Codex /fast',
        command: '/fast',
        why: `${Math.round(s.remainingPercent)}% left (resets in ${formatSpan(s.hoursLeft)}) — high/xhigh safe`,
      });
      push({
        tool: 'codex',
        label: 'Raise Codex effort',
        command: '/effort xhigh',
        why: 'Maximize surplus quality on Sol/Astra before reset',
      });
    } else if (s.provider === 'claude' && s.utilizationState === 'surplus') {
      push({
        tool: 'claude',
        label: 'Use Claude Opus',
        command: '/model opus',
        why: `${Math.round(s.remainingPercent)}% left — Opus/Fable + parallel subagents open`,
      });
    }
  }

  if (codex?.utilizationState === 'hot') {
    push({
      tool: 'codex',
      label: 'Turn Codex /fast OFF',
      command: '/fast off',
      why: `Only ${Math.round(codex.remainingPercent)}% left (${formatSpan(codex.hoursLeft)} to reset) — prevent 2x–8x burn`,
    });
  } else if (codex?.utilizationState === 'exhausted' && (codex.bankedResets.usableCount || 0) > 0) {
    push({
      tool: 'codex',
      label: 'Check Codex banked reset',
      command: '/usage',
      why: `${codex.bankedResets.usableCount} banked reset credit available to redeem`,
    });
  }

  if (claude?.utilizationState === 'hot') {
    push({
      tool: 'claude',
      label: 'Reset Claude context',
      command: '/clear',
      why: `Only ${Math.round(claude.remainingPercent)}% left — stop >150k context burn`,
    });
  }

  if (agy?.utilizationState === 'hot') {
    push({
      tool: 'agy',
      label: 'Step down AGY model',
      command: '/model gemini-3.8-flash-medium',
      why: 'Gemini below 25% — conserve until session/weekly refill',
    });
  }

  push({
    tool: 'pi',
    label: 'Auto-order Pi Guard',
    command: '/guard-order auto',
    why: `Applies ${ranked.map((r) => SHORT_LABELS[r.provider]).join(' > ')} priority`,
  });
  push({
    tool: 'cli',
    label: 'Live check-in',
    command: 'npm run check',
    why: 'Instant terminal cockpit across AGY, Codex, and Claude',
  });

  return cmds;
}

function buildHeadline(strategy, primary, secondary, byId, nextUnlock) {
  const agy = byId.agy;
  const codex = byId.codex;
  const claude = byId.claude;

  if (strategy === 'wait' || !primary) {
    const withCredit = Object.values(byId).find((s) => s.utilizationState === 'exhausted' && (s.bankedResets.usableCount || 0) > 0);
    if (withCredit) {
      return `All subscriptions exhausted — redeem ${SHORT_LABELS[withCredit.provider]} banked reset in /usage${nextUnlock ? ` or wait ${formatSpan(nextUnlock.hoursLeft)}` : ''}`;
    }
    if (nextUnlock) {
      return `All subscriptions unavailable — wait ${formatSpan(nextUnlock.hoursLeft)} for ${SHORT_LABELS[nextUnlock.provider]} reset`;
    }
    return 'No fresh subscription allowances available — refresh readings with npm run check -- --live';
  }

  const parts = [];
  if (primary.provider === 'agy') {
    const lanes = agy._meta.agyLanes || {};
    const gRem = lanes.geminiFresh ? Math.round(lanes.geminiPrimary.remainingPercent) : null;
    const cgRem = lanes.cgFresh ? Math.round(lanes.cgPrimary.remainingPercent) : null;
    if (primary.utilizationState === 'surplus' && gRem !== null && gRem >= 50) {
      parts.push(`Run AGY /swarm (${gRem}% Gemini${cgRem !== null && cgRem >= 40 ? ` · ${cgRem}% Claude/GPT open` : ''})`);
    } else if (cgRem !== null && cgRem >= 30 && (gRem === null || gRem < 25)) {
      parts.push(`Use AGY Claude/GPT lane (${cgRem}% left)`);
    } else {
      parts.push(`Lead with AGY (${Math.round(primary.remainingPercent ?? 0)}% left)`);
    }
  } else if (primary.provider === 'codex') {
    if (primary.utilizationState === 'surplus') {
      const expiring = Number.isFinite(primary.hoursLeft) && primary.hoursLeft <= 48;
      parts.push(`Burn Codex ${expiring ? `surplus first (${Math.round(primary.remainingPercent)}% left, resets in ${formatSpan(primary.hoursLeft)})` : `headroom (${Math.round(primary.remainingPercent)}% left)`} — /fast ON + high/xhigh`);
    } else if (primary.utilizationState === 'hot') {
      parts.push(`Codex tight (${Math.round(primary.remainingPercent)}% left) — /fast OFF`);
    } else {
      parts.push(`Lead with Codex (${Math.round(primary.remainingPercent)}% left) — standard speed`);
    }
  } else if (primary.provider === 'claude') {
    if (primary.utilizationState === 'surplus') {
      parts.push(`Lead with Claude Opus/Fable (${Math.round(primary.remainingPercent)}% left) + subagents`);
    } else if (primary.utilizationState === 'hot') {
      parts.push(`Claude tight (${Math.round(primary.remainingPercent)}% left) — Sonnet/Haiku + /clear`);
    } else {
      parts.push(`Lead with Claude (${Math.round(primary.remainingPercent)}% left) — Opus plan / Sonnet exec`);
    }
  }

  if (codex && primary.provider !== 'codex' && codex.utilizationState === 'hot') {
    parts.push(`keep Codex /fast OFF (${Math.round(codex.remainingPercent)}% left, resets in ${formatSpan(codex.hoursLeft)})`);
  }
  if (claude && primary.provider !== 'claude' && claude.utilizationState === 'exhausted') {
    parts.push(`hold Claude (${formatSpan(claude.hoursLeft)} to reset)`);
  } else if (secondary && secondary.utilizationState === 'surplus' && secondary.provider !== 'codex') {
    parts.push(`${SHORT_LABELS[secondary.provider]} ready (${Math.round(secondary.remainingPercent ?? 0)}%)`);
  }

  return parts.join(' · ');
}

function buildOptimizationPlan(plan, insights = null, now = Date.now()) {
  const reservePercent = Number.isFinite(plan?.policy?.reservePercent) ? plan.policy.reservePercent : 10;
  const rawSummaries = SUBSCRIPTION_IDS.map((id) => summarizeProvider(plan, id, reservePercent));
  const byId = Object.fromEntries(rawSummaries.map((s) => [s.provider, s]));

  // Attach context-aware playbooks (each provider sees the health of the others).
  byId.agy.playbook = buildAgyPlaybook(byId.agy, byId, insights);
  byId.codex.playbook = buildCodexPlaybook(byId.codex, insights, now);
  byId.claude.playbook = buildClaudePlaybook(byId.claude, byId, insights);

  const ranked = rankProviders(rawSummaries);
  const recommendedOrder = ranked.map((s) => s.provider);
  const usable = ranked.filter((s) => ['surplus', 'on-pace', 'hot'].includes(s.utilizationState));
  const primary = usable[0] || null;
  const secondary = usable[1] || null;

  let strategy = 'wait';
  if (primary) {
    if (primary.utilizationState === 'surplus') strategy = 'accelerate';
    else if (primary.utilizationState === 'on-pace') strategy = 'balanced';
    else strategy = 'conserve';
  }

  const nextUnlock = findNextUnlock(rawSummaries);
  const alerts = buildAlerts(ranked, byId, strategy);
  const quickCommands = buildQuickCommands(ranked, byId);
  const headline = buildHeadline(strategy, primary, secondary, byId, nextUnlock);

  const providers = ranked.map(({ _meta, ...clean }) => clean);

  return {
    generatedAt: new Date(now).toISOString(),
    headline,
    strategy,
    primaryProvider: primary ? primary.provider : null,
    secondaryProvider: secondary ? secondary.provider : null,
    nextUnlock,
    alerts,
    providers,
    recommendedOrder,
    quickCommands,
    note: 'Deterministic multi-subscription pacing from live provider allowance windows. Allowances never pool across subscriptions; confirm resets with a fresh reading.',
  };
}

module.exports = { buildOptimizationPlan, formatSpan };
