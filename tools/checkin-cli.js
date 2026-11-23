#!/usr/bin/env node
'use strict';
// Fast multi-subscription check-in CLI for Claude, Codex, and Antigravity (AGY).
// Tries the local Guard controller first (<100ms); falls back automatically to direct
// read-only live collectors so `node tools/checkin-cli.js` always works standalone.

const { initialState, mergeObservations, buildPlan } = require('./usage-guard');
const { fetchClaudeUsage, fetchCodexUsage, fetchAgyUsage } = require('./usage-collectors');
const { buildOptimizationPlan, formatSpan } = require('./subscription-optimizer');

const DEFAULT_URL = 'http://127.0.0.1:9021';

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    url: process.env.AI_SPEND_GUARD_URL || DEFAULT_URL,
    live: false,
    json: false,
    watchSeconds: null,
    color: !process.env.NO_COLOR && Boolean(process.stdout.isTTY),
    knobs: 'default',
    compact: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') opts.help = true;
    else if (arg === '--live') opts.live = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--no-color') opts.color = false;
    else if (arg === '--color') opts.color = true;
    else if (arg === '--knobs') {
      opts.knobs = 'full';
      opts.compact = false;
    } else if (arg === '--no-knobs') {
      opts.knobs = 'off';
    } else if (arg === '--compact') {
      opts.compact = true;
      if (opts.knobs === 'full') opts.knobs = 'default';
    } else if (arg === '--url') {
      if (!argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('--url requires a local Guard controller URL');
      opts.url = argv[++i];
    } else if (arg.startsWith('--url=')) {
      opts.url = arg.slice('--url='.length);
    } else if (arg === '--watch') {
      const next = argv[i + 1];
      if (next && /^\d+(?:\.\d+)?$/.test(next)) {
        opts.watchSeconds = Math.max(5, Math.round(Number(argv[++i])));
      } else {
        opts.watchSeconds = 60;
      }
    } else if (arg.startsWith('--watch=')) {
      const secs = Number(arg.slice('--watch='.length));
      if (!Number.isFinite(secs) || secs <= 0) throw new Error('--watch requires a positive number of seconds');
      opts.watchSeconds = Math.max(5, Math.round(secs));
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return opts;
}

function usageText() {
  return [
    'AI Spend Live — Multi-Subscription Check-In CLI',
    '',
    'Usage: node tools/checkin-cli.js [options]',
    '',
    'Options:',
    '  --url <guardUrl>    Guard controller URL (default: http://127.0.0.1:9021)',
    '  --live              Poll Claude, Codex, and AGY collectors directly (read-only)',
    '  --json              Emit machine-readable JSON (no ANSI colors)',
    '  --watch [seconds]   Refresh continuously (default: 60s, min: 5s)',
    '  --knobs             Show all tuning knobs with detailed rationale',
    '  --compact           Compact layout (condense tuning knobs and extra guidance)',
    '  --no-knobs          Hide per-harness tuning knobs',
    '  --no-color          Disable ANSI terminal colors',
    '  -h, --help          Show this help message',
  ].join('\n');
}

function validateGuardUrl(rawUrl) {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
    throw new Error('Guard URL must be a local loopback http://127.0.0.1 or http://localhost endpoint');
  }
  return parsed;
}

async function fetchFromController(guardUrl, { fetchImpl = fetch, timeoutMs = 1500, now = Date.now() } = {}) {
  const base = validateGuardUrl(guardUrl);
  const tryEndpoint = async (pathname) => {
    const res = await fetchImpl(new URL(pathname, base), {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const err = new Error(`Controller returned HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  };

  let data;
  try {
    data = await tryEndpoint('/api/checkin');
  } catch (err) {
    if (err && err.status === 404) {
      const state = await tryEndpoint('/api/state');
      data = {
        generatedAt: state.generatedAt || new Date(now).toISOString(),
        recommendedProvider: state.recommendedProvider || null,
        optimizer: state.optimizer || buildOptimizationPlan(state, state.insights || null, now),
        windows: state.windows || null,
        collectors: state.collectors || {},
      };
    } else {
      throw err;
    }
  }

  return {
    source: 'controller',
    generatedAt: data.generatedAt || new Date(now).toISOString(),
    recommendedProvider: data.recommendedProvider ?? data.optimizer?.primaryProvider ?? null,
    optimizer: data.optimizer,
    windows: data.windows || null,
    collectors: data.collectors || {},
  };
}

async function collectLive({
  now = Date.now(),
  fetchClaude = () => fetchClaudeUsage({ now }),
  fetchCodex = () => fetchCodexUsage({ now }),
  fetchAgy = () => fetchAgyUsage({ now }),
} = {}) {
  const state = initialState();
  const collectors = {};
  const entries = [
    ['claude', fetchClaude],
    ['codex', fetchCodex],
    ['agy', fetchAgy],
  ];

  const settled = await Promise.allSettled(entries.map(([, fn]) => Promise.resolve().then(fn)));
  for (let i = 0; i < entries.length; i++) {
    const provider = entries[i][0];
    const outcome = settled[i];
    if (outcome.status === 'fulfilled' && outcome.value) {
      const result = outcome.value;
      if (Array.isArray(result.observations) && result.observations.length) {
        state.observations = mergeObservations(state.observations, result.observations, now);
      }
      if (result.resetCredits) {
        state.resetCredits = state.resetCredits || {};
        state.resetCredits[provider] = result.resetCredits;
      }
      collectors[provider] = {
        provider,
        status: 'connected',
        lastSuccessAt: new Date(now).toISOString(),
        error: null,
      };
    } else {
      const rawErr = outcome.status === 'rejected' ? outcome.reason?.message || 'Unavailable' : 'No data returned';
      // Strip any accidental local filesystem paths from collector errors.
      const safeErr = String(rawErr).replace(/[A-Za-z]:\\[^\s]+|\/(?:Users|home)\/[^\s]+/g, '<path>');
      collectors[provider] = {
        provider,
        status: 'unavailable',
        lastSuccessAt: null,
        error: safeErr,
      };
    }
  }

  const plan = buildPlan(state, now);
  const optimizer = buildOptimizationPlan(plan, null, now);
  return {
    source: 'live',
    generatedAt: plan.generatedAt,
    recommendedProvider: optimizer.primaryProvider,
    optimizer,
    windows: null,
    collectors,
  };
}

async function fetchCheckin(options = {}) {
  const now = options.now ?? Date.now();
  if (!options.live) {
    try {
      return await fetchFromController(options.url || DEFAULT_URL, {
        fetchImpl: options.fetchImpl || fetch,
        timeoutMs: options.timeoutMs ?? 1500,
        now,
      });
    } catch {
      // Automatically fall back to direct read-only live collectors when Guard isn't running.
    }
  }
  return collectLive({
    now,
    fetchClaude: options.fetchClaude,
    fetchCodex: options.fetchCodex,
    fetchAgy: options.fetchAgy,
  });
}

function makePalette(enabled) {
  const wrap = (code) => (text) => (enabled ? `\x1b[${code}m${text}\x1b[0m` : String(text));
  return {
    bold: wrap('1'),
    dim: wrap('2'),
    cyan: wrap('36'),
    green: wrap('32'),
    yellow: wrap('33'),
    red: wrap('31'),
    magenta: wrap('35'),
    white: wrap('37'),
    bgGreen: wrap('42;30'),
    bgYellow: wrap('43;30'),
    bgRed: wrap('41;37'),
    bgCyan: wrap('46;30'),
  };
}

function asciiBar(remainingPercent, width = 20) {
  if (!Number.isFinite(remainingPercent)) return `[${'?'.repeat(width)}]`;
  const clamped = Math.max(0, Math.min(100, remainingPercent));
  const filled = Math.round((clamped / 100) * width);
  return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
}

function stateBadge(state, p) {
  const label = String(state || 'unknown').toUpperCase();
  if (state === 'surplus') return p.green(`[${label}]`);
  if (state === 'on-pace') return p.cyan(`[${label}]`);
  if (state === 'hot') return p.yellow(`[${label}]`);
  if (state === 'exhausted' || state === 'blocked') return p.red(`[${label}]`);
  return p.dim(`[${label}]`);
}

function strategyBadge(strategy, p) {
  const s = String(strategy || 'balanced').toUpperCase();
  if (strategy === 'accelerate') return p.bold(p.green(`[${s}]`));
  if (strategy === 'balanced') return p.bold(p.cyan(`[${s}]`));
  if (strategy === 'conserve') return p.bold(p.yellow(`[${s}]`));
  return p.bold(p.red(`[${s}]`));
}

function knobStateBadge(state, p) {
  const s = String(state || 'steady').toLowerCase();
  const raw = `[${s.toUpperCase()}]`;
  const pad = ' '.repeat(Math.max(0, 9 - raw.length));
  if (s === 'boost') return p.green(raw) + pad;
  if (s === 'steady') return p.cyan(raw) + pad;
  if (s === 'tighten') return p.yellow(raw) + pad;
  if (s === 'off') return p.red(raw) + pad;
  return p.dim(raw) + pad;
}

function selectCompactKnobs(knobs, maxCount = 3) {
  const priority = { off: 0, tighten: 1, boost: 2, steady: 3 };
  return knobs
    .map((knob, idx) => ({ knob, idx, pri: priority[knob.state] ?? 4 }))
    .sort((a, b) => a.pri - b.pri || a.idx - b.idx)
    .slice(0, maxCount)
    .sort((a, b) => a.idx - b.idx)
    .map((entry) => entry.knob);
}

function renderTerminal(data, { color = false, knobs = 'default', compact = false } = {}) {
  const p = makePalette(color);
  const opt = data?.optimizer || {};
  const lines = [];
  const hr = p.dim('------------------------------------------------------------------------------');
  const sourceLabel = data.source === 'controller' ? 'Guard controller' : 'Direct live collectors';
  const ts = data.generatedAt ? data.generatedAt.replace('T', ' ').slice(0, 19) + 'Z' : '';

  lines.push(hr);
  lines.push(`${p.bold(p.cyan('AI SPEND LIVE'))} ${p.dim('|')} Multi-Subscription Check-In ${p.dim(`(${sourceLabel} · ${ts})`)}`);
  lines.push(hr);
  lines.push(`${strategyBadge(opt.strategy, p)} ${p.bold(opt.headline || 'No optimizer verdict available')}`);

  const orderNames = { claude: 'Claude', codex: 'Codex', agy: 'AGY' };
  const orderStr = (opt.recommendedOrder || []).map((id) => orderNames[id] || id).join(' > ');
  const metaParts = [];
  if (orderStr) metaParts.push(`Order: ${p.bold(orderStr)}`);
  if (opt.nextUnlock?.label) metaParts.push(`Next unlock: ${p.yellow(opt.nextUnlock.label)}`);
  if (metaParts.length) lines.push(metaParts.join('  |  '));
  lines.push('');

  for (const prov of opt.providers || []) {
    const collector = data.collectors?.[prov.provider];
    const pctText = prov.remainingPercent === null ? '?' : `${Math.round(prov.remainingPercent)}% left`;
    const headParts = [p.bold(prov.label), stateBadge(prov.utilizationState, p), pctText];
    if (prov.hoursLeft !== null) headParts.push(p.dim(`resets in ${formatSpan(prov.hoursLeft)}`));
    if (prov.burnPercentPerHour !== null && prov.burnPercentPerHour > 0) headParts.push(p.dim(`-${prov.burnPercentPerHour}%/h`));
    if (prov.targetPercentPerDay !== null && prov.utilizationState !== 'exhausted') headParts.push(p.dim(`safe ${prov.targetPercentPerDay}%/day`));
    if (prov.projectedUnusedAtReset !== null && prov.projectedUnusedAtReset >= 20 && prov.utilizationState === 'surplus') {
      headParts.push(p.green(`~${Math.round(prov.projectedUnusedAtReset)}% unused risk`));
    }
    if ((prov.bankedResets?.usableCount || 0) > 0) {
      headParts.push(p.magenta(`${prov.bankedResets.usableCount} banked reset`));
    }
    lines.push(headParts.join('  '));

    if (prov.windows && prov.windows.length) {
      for (const w of prov.windows) {
        const bar = asciiBar(w.remainingPercent, 20);
        const coloredBar = w.remainingPercent >= 50 ? p.green(bar) : w.remainingPercent >= 20 ? p.cyan(bar) : w.remainingPercent > 0 ? p.yellow(bar) : p.red(bar);
        const label = w.label.padEnd(22, ' ').slice(0, 22);
        const pct = `${String(Math.round(w.remainingPercent)).padStart(3, ' ')}% left`;
        const rst = w.hoursLeft !== null ? `resets in ${formatSpan(w.hoursLeft)}` : '';
        const statusTag = ['stale', 'verify-reset'].includes(w.status) ? p.dim(` (${w.status})`) : '';
        lines.push(`  ${label} ${coloredBar} ${pct}  ${p.dim(rst)}${statusTag}`);
      }
    } else if (collector?.error) {
      lines.push(`  ${p.dim(collector.error)}`);
    } else {
      lines.push(`  ${p.dim('No allowance windows recorded.')}`);
    }

    if (prov.playbook) {
      const modeColor = prov.playbook.mode === 'accelerate' ? p.green : prov.playbook.mode === 'steady' ? p.cyan : prov.playbook.mode === 'conserve' ? p.yellow : p.red;
      lines.push(`  ${modeColor('Playbook:')} ${prov.playbook.headline}`);
      if (!compact) {
        if (prov.playbook.badges && prov.playbook.badges.length) {
          lines.push(`  ${p.dim('Tags:')} ${prov.playbook.badges.map((b) => `[${b}]`).join(' ')}`);
        }
        for (const tip of (prov.playbook.guidance || []).slice(0, 2)) {
          lines.push(`    - ${tip}`);
        }
      }
      if (knobs !== 'off' && Array.isArray(prov.playbook.knobs) && prov.playbook.knobs.length) {
        const allKnobs = prov.playbook.knobs;
        const shown = compact ? selectCompactKnobs(allKnobs, 3) : allKnobs;
        lines.push(`  ${p.dim(compact ? 'Key Knobs:' : 'Tuning Knobs:')}`);
        for (const k of shown) {
          const badge = knobStateBadge(k.state, p);
          const lbl = String(k.label || k.id).padEnd(24, ' ').slice(0, 24);
          const cmdSuffix = !compact && k.command && !String(k.value || '').toLowerCase().includes(String(k.command).toLowerCase())
            ? `  ${p.dim(`(${k.command})`)}`
            : '';
          lines.push(`    ${badge} ${lbl}  ${p.bold(k.value)}${cmdSuffix}`);
          if (knobs === 'full' && k.reason) {
            lines.push(`              ${p.dim(k.reason)}`);
          }
        }
        if (compact && allKnobs.length > shown.length) {
          lines.push(`    ${p.dim(`+${allKnobs.length - shown.length} more knobs (run with --knobs for all ${allKnobs.length} + rationale)`)}`);
        }
      }
    }
    lines.push('');
  }

  if (opt.alerts && opt.alerts.length) {
    lines.push(p.bold('Alerts & Opportunities'));
    for (const a of opt.alerts.slice(0, compact ? 3 : 5)) {
      const tag = a.severity === 'opportunity' ? p.green('[OPPORTUNITY]') : a.severity === 'critical' ? p.red('[CRITICAL]') : a.severity === 'warn' ? p.yellow('[WARN]') : p.dim('[INFO]');
      lines.push(`  ${tag} ${p.bold(a.title)} — ${a.detail}`);
    }
    lines.push('');
  }

  if (opt.quickCommands && opt.quickCommands.length) {
    lines.push(p.bold('Commands to Run Now'));
    for (const cmd of opt.quickCommands) {
      const toolTag = `[${cmd.tool}]`.padEnd(7, ' ');
      lines.push(`  ${p.cyan(toolTag)} ${p.bold(cmd.command.padEnd(28, ' '))} ${p.dim(cmd.why)}`);
    }
    lines.push('');
  }

  lines.push(p.dim(opt.note || ''));
  return lines.join('\n');
}

async function runCli(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(usageText() + '\n');
    return;
  }

  const executeOnce = async (clearScreen = false) => {
    const result = await fetchCheckin(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      return result;
    }
    if (clearScreen && process.stdout.isTTY) {
      process.stdout.write('\x1b[2J\x1b[H');
    }
    process.stdout.write(renderTerminal(result, { color: opts.color, knobs: opts.knobs, compact: opts.compact }) + '\n');
    if (opts.watchSeconds) {
      process.stdout.write(`\nRefreshing every ${opts.watchSeconds}s (Ctrl+C to stop)...\n`);
    }
    return result;
  };

  await executeOnce(false);

  if (opts.watchSeconds) {
    let busy = false;
    const timer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await executeOnce(true);
      } catch (err) {
        process.stderr.write(`Check-in error: ${err.message}\n`);
      } finally {
        busy = false;
      }
    }, opts.watchSeconds * 1000);

    const stop = () => {
      clearInterval(timer);
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
  }
}

if (require.main === module) {
  runCli().catch((err) => {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseArgs, fetchFromController, collectLive, fetchCheckin, renderTerminal, asciiBar, usageText };
