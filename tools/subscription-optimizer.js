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
    _meta: { primaryWin, weeklyWin, agyLanes },
  };
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

  if (utilizationState === 'blocked') {
    return {
      mode: 'pause',
      headline: 'Antigravity (AGY) is manually blocked',
      badges: ['Blocked'],
      guidance: ['Unblock AGY when you want to route work or run /swarm there.'],
      commands: ['/guard-block none'],
    };
  }
  if (utilizationState === 'unknown') {
    return {
      mode: 'pause',
      headline: 'Refresh AGY /usage to unlock /swarm and lane sizing',
      badges: ['Awaiting reading'],
      guidance: ['Run agy --print /usage (or npm run check -- --live) to read both Gemini and Claude/GPT buckets.'],
      commands: ['agy --print /usage'],
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

    return { mode: 'accelerate', headline, badges, guidance, commands };
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
    };
  }

  // Steady / on-pace (25–49%)
  const badges = ['/swarm 1-2 workers', 'Neon / Hydrogen'];
  if (cgRem !== null && cgRem >= 40) badges.push(`Claude/GPT lane ${Math.round(cgRem)}%`);
  const guidance = [
    `AGY Gemini is on pace (${gRem !== null ? Math.round(gRem) : Math.round(summary.remainingPercent ?? 0)}% left) — keep /swarm to 1–2 focused workers on Hydrogen/Neon.`,
  ];
  if (cgRem !== null && cgRem >= 40) {
    guidance.push(`Separate AGY Claude/GPT lane has ${Math.round(cgRem)}% left (${formatSpan(cgHours)} to reset) for extra Claude/GPT capacity.`);
  }
  return {
    mode: 'steady',
    headline: `Steady AGY pace (${Math.round(summary.remainingPercent ?? 0)}% left) — 1–2 worker /swarm on Neon/Hydrogen`,
    badges,
    guidance,
    commands: ['/swarm', '/model gemini-4-hydrogen-high'],
  };
}

function buildCodexPlaybook(summary, insights) {
  const { utilizationState, remainingPercent, hoursLeft, projectedUnusedAtReset, bankedResets } = summary;
  const usableCredits = bankedResets.usableCount || 0;
  const fastInsight = getInsightMetric(insights, 'codex', 'fast');
  const effortInsight = getInsightMetric(insights, 'codex', 'effort');
  const span = formatSpan(hoursLeft);

  if (utilizationState === 'blocked') {
    return {
      mode: 'pause',
      headline: 'Codex is manually blocked',
      badges: ['Blocked'],
      guidance: ['Unblock Codex when you want to route work there again.'],
      commands: ['/guard-block none'],
    };
  }
  if (utilizationState === 'unknown') {
    return {
      mode: 'pause',
      headline: 'Refresh Codex /usage to check /fast and effort headroom',
      badges: ['Awaiting reading'],
      guidance: ['Run codex /usage or npm run check -- --live to read your weekly limit and banked resets.'],
      commands: ['/usage'],
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
    };
  }

  // On-pace
  const badges = ['Standard speed (/fast off)', 'Effort: medium / high'];
  if (usableCredits > 0) badges.push(`${usableCredits} banked reset`);
  const guidance = [
    `Codex is on pace (${Math.round(remainingPercent)}% left, resets in ${span}) — run standard speed with medium/high effort on Sol/Astra.`,
    'Reserve /fast for short latency-critical sprints so the 2x+ multiplier does not eat the week early.',
  ];
  if (effortInsight !== null && effortInsight >= 50) {
    guidance.push(`${Math.round(effortInsight)}% of recent Codex tokens ran at xhigh/max effort — drop routine edits to medium.`);
  }
  return {
    mode: 'steady',
    headline: `Codex on pace (${Math.round(remainingPercent)}% left) — standard speed, medium/high effort`,
    badges,
    guidance,
    commands: ['/fast off', '/effort medium'],
  };
}

function buildClaudePlaybook(summary, others, insights) {
  const { utilizationState, remainingPercent, hoursLeft, projectedUnusedAtReset, bankedResets } = summary;
  const agyCg = others.agy?._meta?.agyLanes?.cgFresh ? others.agy._meta.agyLanes.cgPrimary : null;
  const agyCgRem = agyCg && agyCg.remainingPercent > 0 ? agyCg.remainingPercent : null;
  const codexRem = others.codex?.utilizationState !== 'exhausted' && others.codex?.remainingPercent !== null ? others.codex.remainingPercent : null;
  const subagentInsight = getInsightMetric(insights, 'claude', 'subagents');
  const contextInsight = getInsightMetric(insights, 'claude', 'context');
  const span = formatSpan(hoursLeft);

  if (utilizationState === 'blocked') {
    return {
      mode: 'pause',
      headline: 'Claude is manually blocked',
      badges: ['Blocked'],
      guidance: ['Unblock Claude when you want to route tasks back to it.'],
      commands: ['/guard-block none'],
    };
  }
  if (utilizationState === 'unknown') {
    return {
      mode: 'pause',
      headline: 'Refresh Claude /usage to check Opus/Fable vs Sonnet headroom',
      badges: ['Awaiting reading'],
      guidance: ['Sign in to Claude Code or run npm run check -- --live to fetch live weekly/session limits.'],
      commands: ['/usage'],
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
  } else if (contextInsight !== null && contextInsight >= 45) {
    guidance.push(`${Math.round(contextInsight)}% of recent Claude tokens ran above 150k context — compact or /clear earlier.`);
  }
  return {
    mode: 'steady',
    headline: `Claude on pace (${Math.round(remainingPercent)}% left) — Opus/Fable for plans, Sonnet for execution`,
    badges,
    guidance,
    commands: ['/model sonnet', '/clear'],
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
  byId.codex.playbook = buildCodexPlaybook(byId.codex, insights);
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
