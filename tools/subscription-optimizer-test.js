'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execFileAsync = promisify(execFile);

const { initialState, buildPlan, cleanPolicy } = require('./usage-guard');
const { createGuardServer } = require('./usage-guard-server');
const { buildOptimizationPlan, formatSpan } = require('./subscription-optimizer');
const { parseArgs, fetchCheckin, renderTerminal } = require('./checkin-cli');

const NOW = Date.parse('2026-11-23T00:00:00Z');
const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();

function obs(provider, windowId, usedPercent, resetHours, { windowMinutes = 10080, ageMinutes = 1, modelFamily = undefined, source = 'provider' } = {}) {
  return {
    provider,
    windowId,
    windowMinutes,
    usedPercent,
    resetAt: iso(NOW + resetHours * HOUR),
    observedAt: iso(NOW - ageMinutes * 60000),
    source,
    ...(modelFamily ? { modelFamily } : {}),
  };
}

const EXPECTED_KNOB_IDS = {
  agy: ['swarm-size', 'separate-quotas', 'worker-tier', 'effort-suffix', 'session-5h', 'context-compact'],
  codex: ['speed-tier', 'reasoning-effort', 'model-tier', 'context-cliff', 'subagents-review', 'banked-resets'],
  claude: ['model-tier', 'effort-level', 'subagent-fanout', 'context-gravity', 'cache-ttl', 'scoped-windows'],
};

const EXPECTED_CUSTOM_KNOB_IDS = ['workload-share', 'model-choice', 'reading-freshness'];
const FORBIDDEN_JARGON_RE = new RegExp('\\b' + 'lan' + 'es?\\b|du' + 'al[- ]po' + 'ol|arbit' + 'rage', 'i');

function assertNoJargon(text, contextLabel = 'output') {
  const match = FORBIDDEN_JARGON_RE.exec(text);
  assert.equal(match, null, `${contextLabel} must not contain banned jargon (found: ${match?.[0]})`);
}

function findKnob(providerObj, id) {
  return (providerObj?.playbook?.knobs || []).find((k) => k.id === id);
}

function assertExactSchema(opt, { expectedCustomIds = [] } = {}) {
  const allowedIds = ['claude', 'codex', 'agy', ...expectedCustomIds];
  assert.equal(typeof opt.generatedAt, 'string');
  assert.equal(typeof opt.headline, 'string');
  assert.ok(['accelerate', 'balanced', 'conserve', 'wait'].includes(opt.strategy));
  assert.ok(opt.primaryProvider === null || allowedIds.includes(opt.primaryProvider));
  assert.ok(opt.secondaryProvider === null || allowedIds.includes(opt.secondaryProvider));
  if (opt.nextUnlock !== null) {
    assert.equal(typeof opt.nextUnlock.provider, 'string');
    assert.equal(typeof opt.nextUnlock.windowId, 'string');
    assert.equal(typeof opt.nextUnlock.resetAt, 'string');
    assert.equal(typeof opt.nextUnlock.hoursLeft, 'number');
    assert.equal(typeof opt.nextUnlock.label, 'string');
  }
  assert.ok(Array.isArray(opt.alerts));
  assert.ok(Array.isArray(opt.customProviders));
  assert.equal(opt.customProviders.length, expectedCustomIds.length);
  assert.equal(opt.providers.length, 3 + expectedCustomIds.length);
  assert.equal(opt.recommendedOrder.length, 3 + expectedCustomIds.length);
  assert.deepEqual([...opt.recommendedOrder].sort(), [...allowedIds].sort());
  assert.ok(Array.isArray(opt.quickCommands));
  assert.equal(typeof opt.note, 'string');
  for (const p of opt.providers) {
    assert.ok(allowedIds.includes(p.provider));
    assert.equal(typeof p.label, 'string');
    assert.ok(['surplus', 'on-pace', 'hot', 'exhausted', 'blocked', 'unknown'].includes(p.utilizationState));
    assert.ok(Array.isArray(p.windows));
    assert.ok(p.playbook && ['accelerate', 'steady', 'conserve', 'pause'].includes(p.playbook.mode));
    assert.ok(Array.isArray(p.playbook.badges));
    assert.ok(Array.isArray(p.playbook.guidance));
    assert.ok(Array.isArray(p.playbook.commands));
    assert.ok(Array.isArray(p.playbook.knobs), `${p.provider} playbook must include knobs array`);
    if (p.custom) {
      assert.equal(p.playbook.knobs.length, 3, `${p.provider} custom plan must expose 3 knobs`);
      assert.deepEqual(Array.from(p.playbook.knobs, (k) => k.id), EXPECTED_CUSTOM_KNOB_IDS);
    } else {
      assert.equal(p.playbook.knobs.length, 6, `${p.provider} must expose exactly 6 knobs`);
      assert.deepEqual(
        Array.from(p.playbook.knobs, (k) => k.id),
        EXPECTED_KNOB_IDS[p.provider],
        `${p.provider} knobs must match expected IDs in order`
      );
    }
    for (const k of p.playbook.knobs) {
      assert.equal(typeof k.id, 'string');
      assert.ok(k.id.length > 0);
      assert.equal(typeof k.label, 'string');
      assert.ok(k.label.length > 0);
      assert.ok(['boost', 'steady', 'tighten', 'off'].includes(k.state), `invalid knob state ${k.state} on ${p.provider}.${k.id}`);
      assert.equal(typeof k.value, 'string');
      assert.ok(k.value.length > 0);
      assert.equal(typeof k.reason, 'string');
      assert.ok(k.reason.length > 0);
      if (k.command !== undefined) {
        assert.equal(typeof k.command, 'string');
        assert.ok(k.command.length > 0);
      }
    }
  }
  const serialized = JSON.stringify(opt);
  // Strict zero-path privacy guarantee for snapshot exports.
  assert.ok(!/[A-Za-z]:\\|\/Users\/|\/home\//.test(serialized), 'optimizer output must never include filesystem paths');
  // Strict plain-English copy guarantee.
  assertNoJargon(serialized, 'optimizer output');
}

async function run() {
  // 0. formatSpan checks
  assert.equal(formatSpan(0.5), '30m');
  assert.equal(formatSpan(16), '16h');
  assert.equal(formatSpan(48), '2d');
  assert.equal(formatSpan(52), '2d 4h');
  assert.equal(formatSpan(-1), '?');
  assert.equal(formatSpan(NaN), '?');

  // 1. Real-world scenario from tonight:
  //    Claude 100% weekly (47h) + 49% fable, Codex 95% weekly (16h),
  //    AGY Gemini 73% left (140h) + 74% 5h (4h) & Claude/GPT 97% left (140h) + 100% 5h (4h),
  //    plus legacy stale gemini-argon:weekly window that should NOT poison healthy AGY quotas.
  {
    const s = initialState();
    s.bindings = {
      claude: { provider: 'claude-code', model: 'claude-sonnet-5' },
      codex: { provider: 'openai', model: 'gpt-6.2-sol' },
      agy: { provider: 'antigravity', model: 'gemini-4-argon' },
    };
    s.observations = [
      obs('claude', 'weekly', 100, 47),
      obs('claude', 'weekly:fable', 49, 47, { modelFamily: 'fable' }),
      obs('codex', 'codex:primary', 95, 16),
      obs('agy', 'gemini:weekly', 27, 140, { modelFamily: 'gemini' }),
      obs('agy', 'gemini:session', 26, 4, { windowMinutes: 300, modelFamily: 'gemini' }),
      obs('agy', 'claude-gpt:weekly', 3, 140, { modelFamily: 'claude-gpt' }),
      obs('agy', 'claude-gpt:session', 0, 4, { windowMinutes: 300, modelFamily: 'claude-gpt' }),
      obs('agy', 'gemini-argon:weekly', 100, 100, { ageMinutes: 3000, modelFamily: 'gemini-argon' }),
    ];
    s.resetCredits = { codex: { source: 'codex-rpc', observedAt: iso(NOW), availableCount: 0, detailsKnown: true, credits: [] } };
    const plan = buildPlan(s, NOW);
    const opt = buildOptimizationPlan(plan, null, NOW);
    assertExactSchema(opt);

    assert.equal(opt.strategy, 'accelerate');
    assert.equal(opt.primaryProvider, 'agy');
    assert.equal(opt.secondaryProvider, 'codex');
    assert.deepEqual(opt.recommendedOrder, ['agy', 'codex', 'claude']);
    assert.equal(opt.nextUnlock.provider, 'codex', 'soonest constrained unlock is Codex in 16h');
    assert.equal(opt.nextUnlock.hoursLeft, 16);

    const agy = opt.providers.find((p) => p.provider === 'agy');
    const codex = opt.providers.find((p) => p.provider === 'codex');
    const claude = opt.providers.find((p) => p.provider === 'claude');

    assert.equal(agy.utilizationState, 'surplus');
    assert.equal(agy.remainingPercent, 73);
    assert.equal(agy.playbook.mode, 'accelerate');
    assert.match(agy.playbook.headline, /\/swarm/i);
    assert.match(agy.playbook.headline + ' ' + agy.playbook.guidance.join(' '), /claude\/gpt.*97%/i);
    assert.ok(agy.windows.some((w) => w.windowId === 'gemini:weekly' && w.remainingPercent === 73));
    assert.ok(agy.windows.some((w) => w.windowId === 'claude-gpt:weekly' && w.remainingPercent === 97));
    assert.ok(opt.alerts.some((a) => a.kind === 'quota-opportunity' && a.provider === 'agy'));

    assert.equal(codex.utilizationState, 'hot');
    assert.equal(codex.remainingPercent, 5);
    assert.equal(codex.playbook.mode, 'conserve');
    assert.match(codex.playbook.headline, /\/fast OFF/i);
    assert.ok(opt.alerts.some((a) => a.kind === 'fast-burn' && a.provider === 'codex'));

    assert.equal(claude.utilizationState, 'exhausted');
    assert.equal(claude.remainingPercent, 0);
    assert.equal(claude.playbook.mode, 'pause');
    assert.match(claude.playbook.headline, /AGY's Claude\/GPT/i);

    // Per-harness tuning knobs verification on Scenario 1
    assert.equal(findKnob(agy, 'swarm-size').state, 'boost');
    assert.match(findKnob(agy, 'swarm-size').value, /3–4 workers/i);
    assert.equal(findKnob(agy, 'separate-quotas').state, 'boost');
    assert.equal(findKnob(agy, 'separate-quotas').label, 'AGY Claude/GPT quota');
    assert.match(findKnob(agy, 'separate-quotas').value, /Claude\/GPT.*97%/i);
    assert.match(findKnob(agy, 'separate-quotas').reason, /tracks Gemini and Claude\/GPT separately/i);
    assert.equal(findKnob(agy, 'worker-tier').state, 'boost');
    assert.equal(findKnob(agy, 'effort-suffix').state, 'boost');
    assert.match(findKnob(agy, 'effort-suffix').value, /-xhigh/i);
    assert.equal(findKnob(agy, 'session-5h').state, 'boost');
    assert.match(findKnob(agy, 'session-5h').value, /74%.*100%/);

    assert.equal(findKnob(codex, 'speed-tier').state, 'off');
    assert.match(findKnob(codex, 'speed-tier').value, /\/fast off/i);
    assert.equal(findKnob(codex, 'reasoning-effort').state, 'tighten');
    assert.equal(findKnob(codex, 'model-tier').state, 'tighten');
    assert.equal(findKnob(codex, 'context-cliff').state, 'tighten');
    assert.equal(findKnob(codex, 'subagents-review').state, 'tighten');

    assert.equal(findKnob(claude, 'model-tier').state, 'off');
    assert.match(findKnob(claude, 'model-tier').value, /Shift to AGY Claude\/GPT/i);
    assert.equal(findKnob(claude, 'scoped-windows').state, 'off');
    assert.match(findKnob(claude, 'scoped-windows').reason, /51%.*0%/);
  }

  // 2. Surplus / expiring-value scenario: Codex 70% left resetting in 14h -> Codex FIRST with /fast + xhigh
  //    even when AGY has a healthy 5h session resetting in 1h (weekly is 130h away, not expiring!).
  {
    const s = initialState();
    s.observations = [
      obs('codex', 'codex:primary', 30, 14),
      obs('agy', 'gemini:weekly', 27, 130, { modelFamily: 'gemini' }),
      obs('agy', 'gemini:session', 29, 1, { windowMinutes: 300, modelFamily: 'gemini' }),
      obs('agy', 'claude-gpt:weekly', 20, 130, { modelFamily: 'claude-gpt' }),
      obs('claude', 'weekly', 55, 72),
    ];
    const plan = buildPlan(s, NOW);
    const opt = buildOptimizationPlan(plan, null, NOW);
    assertExactSchema(opt);

    assert.equal(opt.strategy, 'accelerate');
    assert.equal(opt.primaryProvider, 'codex', 'expiring Codex weekly surplus (14h) must rank #1 ahead of AGY 5h session');
    assert.equal(opt.recommendedOrder[0], 'codex');
    const agy = opt.providers.find((p) => p.provider === 'agy');
    assert.equal(agy.hoursLeft, 130, 'healthy 5h session must not masquerade as weekly reset countdown');
    assert.ok(!opt.alerts.some((a) => a.provider === 'agy' && a.kind === 'surplus' && /1h/.test(a.title)), 'healthy 5h session must not emit expiring-in-1h surplus alert');

    const codex = opt.providers.find((p) => p.provider === 'codex');
    assert.equal(codex.utilizationState, 'surplus');
    assert.ok(codex.projectedUnusedAtReset > 50, 'should detect large unused quota expiring at reset');
    assert.equal(codex.playbook.mode, 'accelerate');
    assert.match(codex.playbook.headline, /\/fast ON/i);
    assert.match(codex.playbook.headline, /xhigh/i);
    assert.ok(codex.playbook.commands.includes('/fast'));
    assert.ok(codex.playbook.commands.includes('/effort xhigh'));
    assert.ok(opt.alerts.some((a) => a.kind === 'surplus' && a.provider === 'codex'));
    assert.equal(findKnob(codex, 'speed-tier').state, 'boost');
    assert.match(findKnob(codex, 'speed-tier').value, /\/fast safe/i);
    assert.equal(findKnob(codex, 'reasoning-effort').state, 'boost');
    assert.match(findKnob(codex, 'reasoning-effort').value, /high \/ xhigh/i);
    assert.equal(findKnob(codex, 'model-tier').state, 'boost');
    assert.match(findKnob(codex, 'model-tier').value, /gpt-6\.2-sol/i);
  }

  // 3. All-exhausted + banked reset credit scenario -> strategy 'wait', recommends redeeming banked reset or waiting
  {
    const s = initialState();
    s.observations = [
      obs('claude', 'weekly', 100, 36),
      obs('codex', 'codex:primary', 100, 20),
      obs('agy', 'gemini:weekly', 100, 48, { modelFamily: 'gemini' }),
      obs('agy', 'claude-gpt:weekly', 100, 48, { modelFamily: 'claude-gpt' }),
    ];
    s.resetCredits = {
      codex: {
        source: 'codex-rpc',
        observedAt: iso(NOW),
        availableCount: 1,
        detailsKnown: true,
        credits: [{ status: 'available', resetType: 'codexRateLimits', expiresAt: iso(NOW + 10 * 24 * HOUR), expiryKnown: true }],
      },
    };
    const plan = buildPlan(s, NOW);
    const opt = buildOptimizationPlan(plan, null, NOW);
    assertExactSchema(opt);

    assert.equal(opt.strategy, 'wait');
    assert.equal(opt.primaryProvider, null);
    assert.equal(opt.secondaryProvider, null);
    assert.match(opt.headline, /banked reset/i);
    assert.equal(opt.recommendedOrder[0], 'codex', 'provider with usable banked reset sorts ahead of other exhausted plans');
    const codex = opt.providers.find((p) => p.provider === 'codex');
    assert.equal(codex.bankedResets.usableCount, 1);
    assert.match(codex.playbook.headline, /1 banked reset/i);
    assert.ok(opt.alerts.some((a) => a.kind === 'banked-reset' && a.provider === 'codex'));
    assert.equal(findKnob(codex, 'banked-resets').state, 'boost');
    assert.match(findKnob(codex, 'banked-resets').value, /Redeem 1 of 1/i);
    assert.equal(findKnob(codex, 'speed-tier').state, 'off');
    assert.equal(findKnob(opt.providers.find((p) => p.provider === 'agy'), 'swarm-size').state, 'off');
  }

  // 4. AGY tight (<25% Gemini and <25% Claude/GPT) -> scale /swarm down to 1-2 / Hydrogen / Flash; Claude surplus -> Opus/Fable
  {
    const s = initialState();
    s.observations = [
      obs('agy', 'gemini:weekly', 82, 48, { modelFamily: 'gemini' }),
      obs('agy', 'claude-gpt:weekly', 85, 48, { modelFamily: 'claude-gpt' }),
      obs('claude', 'weekly', 20, 60),
      obs('codex', 'codex:primary', 60, 80),
    ];
    const plan = buildPlan(s, NOW);
    const opt = buildOptimizationPlan(plan, null, NOW);
    assertExactSchema(opt);

    assert.equal(opt.primaryProvider, 'claude');
    const agy = opt.providers.find((p) => p.provider === 'agy');
    const claude = opt.providers.find((p) => p.provider === 'claude');
    assert.equal(agy.utilizationState, 'hot');
    assert.equal(agy.playbook.mode, 'conserve');
    assert.match(agy.playbook.headline, /scale \/swarm down/i);
    assert.match(agy.playbook.headline, /Hydrogen\/Flash/i);
    assert.equal(claude.utilizationState, 'surplus');
    assert.match(claude.playbook.headline, /Opus\/Fable/i);
  }

  // 5. Browser-bundle check (zero Node imports, works in isolated VM as GuardOptimizer)
  {
    const src = fs.readFileSync(path.join(__dirname, 'subscription-optimizer.js'), 'utf8')
      .replace('module.exports =', 'globalThis.GuardOptimizer =');
    assert.ok(!src.includes('require('), 'subscription-optimizer.js must have zero require() calls for browser bundling');
    const sandbox = { console };
    vm.createContext(sandbox);
    vm.runInContext(`(function(){${src}})();`, sandbox);
    const s = initialState();
    s.observations = [obs('claude', 'weekly', 40, 72)];
    const plan = buildPlan(s, NOW);
    const vmOpt = sandbox.GuardOptimizer.buildOptimizationPlan(plan, null, NOW);
    assertExactSchema(vmOpt);
    assert.equal(sandbox.GuardOptimizer.formatSpan(52), '2d 4h');
  }

  // 6. Guard server GET /api/checkin + GET /api/state optimizer + checkin-cli.js --json & --no-color + offline live fallback
  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-checkin-'));
    const server = createGuardServer({ stateDir: dir, sync: false, now: () => NOW });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    try {
      await fetch(`${url}/api/observations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          observations: [
            obs('claude', 'weekly', 100, 47),
            obs('codex', 'codex:primary', 95, 16),
            obs('agy', 'gemini:weekly', 27, 140, { modelFamily: 'gemini' }),
            obs('agy', 'claude-gpt:weekly', 3, 140, { modelFamily: 'claude-gpt' }),
          ],
        }),
      });

      const checkinRes = await fetch(`${url}/api/checkin`);
      assert.equal(checkinRes.status, 200);
      const checkin = await checkinRes.json();
      assert.equal(checkin.generatedAt, iso(NOW));
      assertExactSchema(checkin.optimizer);
      assert.equal(checkin.optimizer.primaryProvider, 'agy');
      assert.ok(checkin.windows && typeof checkin.windows.active === 'number');
      assert.ok(checkin.collectors && typeof checkin.collectors === 'object');

      const stateRes = await (await fetch(`${url}/api/state`)).json();
      assert.ok(stateRes.optimizer, '/api/state must embed optimizer');
      assert.equal(stateRes.optimizer.primaryProvider, 'agy');

      // CLI subprocess --json test
      const { stdout: jsonOut } = await execFileAsync(process.execPath, [path.join(__dirname, 'checkin-cli.js'), '--url', url, '--json'], { encoding: 'utf8' });
      assert.ok(!/\x1b\[/.test(jsonOut), '--json output must contain zero ANSI escape codes');
      const parsed = JSON.parse(jsonOut);
      assert.equal(parsed.source, 'controller');
      assertExactSchema(parsed.optimizer);
      assert.equal(parsed.optimizer.primaryProvider, 'agy');

      // CLI subprocess human terminal test (--no-color)
      const { stdout: textOut } = await execFileAsync(process.execPath, [path.join(__dirname, 'checkin-cli.js'), '--url', url, '--no-color'], { encoding: 'utf8' });
      assert.ok(!/\x1b\[/.test(textOut), '--no-color output must contain zero ANSI escape codes');
      assertNoJargon(textOut, 'CLI default output');
      assert.match(textOut, /AI SPEND LIVE/);
      assert.match(textOut, /Gemini weekly/);
      assert.match(textOut, /Claude\/GPT weekly/);
      assert.match(textOut, /\/swarm/);
      assert.match(textOut, /\/fast off/i);
      assert.match(textOut, /\[#+-+\]/, 'must include ASCII progress bar');
      assert.match(textOut, /Tuning Knobs:/);
      assert.match(textOut, /\[BOOST\]/);
      assert.match(textOut, /\[TIGHTEN\]/);
      assert.match(textOut, /\[OFF\]/);
      assert.match(textOut, /AGY Claude\/GPT quota/);
      assert.match(textOut, /272k context limit/);
      assert.match(textOut, /Weekly caps & \/fast/);

      // CLI --knobs (detailed rationale) & --compact & --no-knobs tests
      const { stdout: fullKnobsOut } = await execFileAsync(process.execPath, [path.join(__dirname, 'checkin-cli.js'), '--url', url, '--knobs', '--no-color'], { encoding: 'utf8' });
      assert.ok(fullKnobsOut.length > textOut.length, '--knobs must include expanded knob rationales');
      assertNoJargon(fullKnobsOut, 'CLI --knobs output');
      assert.match(fullKnobsOut, /272k 2x input/i);

      const { stdout: compactOut } = await execFileAsync(process.execPath, [path.join(__dirname, 'checkin-cli.js'), '--url', url, '--compact', '--no-color'], { encoding: 'utf8' });
      assert.ok(compactOut.length < textOut.length, '--compact output must be shorter than default');
      assertNoJargon(compactOut, 'CLI --compact output');
      assert.match(compactOut, /Key Knobs:/);
      assert.match(compactOut, /\+3 more knobs/);
      assert.ok(!compactOut.includes('Tags:'), '--compact omits redundant Tags line');

      const { stdout: noKnobsOut } = await execFileAsync(process.execPath, [path.join(__dirname, 'checkin-cli.js'), '--url', url, '--no-knobs', '--no-color'], { encoding: 'utf8' });
      assert.ok(!noKnobsOut.includes('Tuning Knobs:'), '--no-knobs hides tuning knobs');

      // Live fallback test when controller is unreachable
      const fallback = await fetchCheckin({
        url: 'http://127.0.0.1:9',
        timeoutMs: 250,
        now: NOW,
        customProviders: [],
        fetchClaude: async () => ({ observations: [obs('claude', 'weekly', 100, 40)] }),
        fetchCodex: async () => ({ observations: [obs('codex', 'codex:primary', 30, 14)], resetCredits: { source: 'codex-rpc', observedAt: iso(NOW), availableCount: 1, detailsKnown: true, credits: [] } }),
        fetchAgy: async () => { throw new Error('Antigravity CLI is unavailable.'); },
      });
      assert.equal(fallback.source, 'live');
      assert.equal(fallback.collectors.claude.status, 'connected');
      assert.equal(fallback.collectors.codex.status, 'connected');
      assert.equal(fallback.collectors.agy.status, 'unavailable');
      assert.equal(fallback.optimizer.primaryProvider, 'codex');
      const renderedFallback = renderTerminal(fallback, { color: false });
      assertNoJargon(renderedFallback, 'CLI live fallback output');
      assert.match(renderedFallback, /Direct live collectors/);
      assert.match(renderedFallback, /Antigravity CLI is unavailable/);
      assert.match(renderedFallback, /Tuning Knobs:/);
      const renderedColor = renderTerminal(fallback, { color: true });
      assert.match(renderedColor, /\x1b\[32m\[BOOST\]\x1b\[0m/, 'color mode applies green ANSI to [BOOST]');

      // parseArgs sanity
      assert.deepEqual(parseArgs(['--live', '--json', '--watch', '30', '--no-color']), {
        url: process.env.AI_SPEND_GUARD_URL || 'http://127.0.0.1:9021',
        customFile: null,
        live: true,
        json: true,
        watchSeconds: 30,
        color: false,
        knobs: 'default',
        compact: false,
        help: false,
      });
      assert.equal(parseArgs(['--custom', 'custom-providers.json']).customFile, 'custom-providers.json');
      assert.equal(parseArgs(['--custom=extra.json']).customFile, 'extra.json');
      assert.equal(parseArgs(['--knobs']).knobs, 'full');
      assert.equal(parseArgs(['--compact']).compact, true);
      assert.equal(parseArgs(['--no-knobs']).knobs, 'off');
      assert.equal(parseArgs(['--watch']).watchSeconds, 60);
    } finally {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  // 7. Verify cleanPolicy xhigh & Pi extension fixes (parseRuleRequest, split regexes, /guard-check)
  {
    assert.equal(cleanPolicy({ maxThinkingLevel: 'xhigh' }).maxThinkingLevel, 'xhigh');
    assert.throws(() => cleanPolicy({ maxThinkingLevel: 'ultra' }));

    const piSource = fs.readFileSync(path.join(__dirname, '..', 'integrations', 'pi', 'index.ts'), 'utf8');
    assert.ok(!piSource.includes('.split(/[s,>]+/)'), '/guard-order split regex bug must be fixed');
    assert.ok(!piSource.includes('.split(/[s,]+/)'), '/guard-block split regex bug must be fixed');
    assert.ok(piSource.includes('.split(/[\\s,>]+/)'), '/guard-order uses whitespace split');
    assert.ok(piSource.includes('.split(/[\\s,]+/)'), '/guard-block uses whitespace split');
    assert.ok(piSource.includes("pi.registerCommand('guard-check'"), '/guard-check command must be registered');
    for (const alias of ['neon', 'carbon', 'terra', 'spark']) {
      assert.ok(piSource.includes(`${alias}:[`), `MODEL_ALIASES must include ${alias}`);
    }

    // Exercise exact parseRuleRequest logic from integrations/pi/index.ts
    const fnMatch = /function parseRuleRequest\(text:string\)[\s\S]*?\n  \}/.exec(piSource);
    const aliasMatch = /const MODEL_ALIASES:Record<string,\[string,string\|null\]>=(\{[\s\S]*?\});/.exec(piSource);
    assert.ok(fnMatch && aliasMatch, 'parseRuleRequest and MODEL_ALIASES found');
    const jsFn = fnMatch[0]
      .replace('text:string', 'text')
      .replace('):{match:string,provider:string,model:string|null}|null{', '){');
    const parseRuleRequest = new Function(`const MODEL_ALIASES=${aliasMatch[1]}; ${jsFn}; return parseRuleRequest;`)();

    assert.deepEqual(parseRuleRequest('all translations use argon'), { match: 'translations', provider: 'agy', model: 'argon' });
    assert.deepEqual(parseRuleRequest('website updates -> neon'), { match: 'website updates', provider: 'agy', model: 'neon' });
    assert.deepEqual(parseRuleRequest('docs always use terra'), { match: 'docs', provider: 'codex', model: 'terra' });
    assert.equal(parseRuleRequest('only argon for agy is exhausted it can run on opus'), null, 'conversational sentence must never save as rule');
    assert.equal(parseRuleRequest('fix the bug with codex'), null, 'ordinary work with "with" must not save as persistent rule');
    assert.equal(parseRuleRequest('code changes on opus'), null, 'conversational "on" must not save as persistent rule');
    assert.equal(parseRuleRequest('one two three four five six seven -> opus'), null, '>6 word match phrase rejected');
  }

  // 8. Dynamic 24h insights reactions across Claude, Codex, and AGY knobs
  {
    const s = initialState();
    s.observations = [
      obs('claude', 'weekly', 55, 72),
      obs('codex', 'codex:primary', 58, 72),
      obs('agy', 'gemini:weekly', 25, 18, { modelFamily: 'gemini' }),
      obs('agy', 'gemini:session', 30, 3, { windowMinutes: 300, modelFamily: 'gemini' }),
    ];
    s.resetCredits = {
      codex: {
        source: 'codex-rpc',
        observedAt: iso(NOW),
        availableCount: 1,
        detailsKnown: true,
        credits: [{ status: 'available', resetType: 'codexRateLimits', expiresAt: iso(NOW + 12 * HOUR), expiryKnown: true }],
      },
    };
    const insights = {
      generatedAt: iso(NOW),
      providers: [
        {
          provider: 'claude',
          requests: 120,
          metrics: [
            { id: 'subagents', percent: 58 },
            { id: 'context', percent: 62 },
            { id: 'effort', percent: 55 },
            { id: 'cache', percent: 68 },
            { id: 'fast', percent: 22 },
          ],
        },
        {
          provider: 'codex',
          requests: 95,
          metrics: [
            { id: 'effort', percent: 52 },
            { id: 'context', percent: 48 },
            { id: 'subagents', percent: 44 },
            { id: 'fast', percent: 30 },
            { id: 'cache', percent: 62 },
          ],
        },
        {
          provider: 'agy',
          requests: 80,
          metrics: [
            { id: 'context', percent: 55 },
            { id: 'swarm', percent: 8 },
          ],
        },
      ],
    };

    const plan = buildPlan(s, NOW);
    const opt = buildOptimizationPlan(plan, insights, NOW);
    assertExactSchema(opt);

    const claude = opt.providers.find((p) => p.provider === 'claude');
    const codex = opt.providers.find((p) => p.provider === 'codex');
    const agy = opt.providers.find((p) => p.provider === 'agy');

    assert.equal(findKnob(claude, 'subagent-fanout').state, 'tighten', 'high Claude subagents must tighten subagent-fanout');
    assert.match(findKnob(claude, 'subagent-fanout').reason, /58%.*fresh context window/i);
    assert.equal(findKnob(claude, 'context-gravity').state, 'tighten', 'high Claude >150k context must tighten context-gravity');
    assert.match(findKnob(claude, 'context-gravity').value, /6-bullet handoff \+ \/clear/i);
    assert.equal(findKnob(claude, 'cache-ttl').state, 'tighten', 'low Claude cache reuse tightens cache-ttl');
    assert.equal(findKnob(claude, 'effort-level').state, 'tighten', 'high Claude max effort tightens effort-level');
    assert.equal(findKnob(claude, 'scoped-windows').state, 'tighten', 'high Claude /fast usage tightens scoped-windows');

    assert.equal(findKnob(codex, 'reasoning-effort').state, 'tighten', 'high Codex >=40% effort tightens reasoning-effort');
    assert.match(findKnob(codex, 'reasoning-effort').reason, /52%/);
    assert.equal(findKnob(codex, 'context-cliff').state, 'tighten', 'high Codex >150k context tightens context-cliff');
    assert.match(findKnob(codex, 'context-cliff').reason, /272k/);
    assert.equal(findKnob(codex, 'subagents-review').state, 'tighten', 'high Codex subagents tightens subagents-review');
    assert.match(findKnob(codex, 'subagents-review').reason, /luna/i);
    assert.equal(findKnob(codex, 'speed-tier').state, 'tighten', 'high Codex /fast share on-pace tightens speed-tier');
    assert.equal(findKnob(codex, 'banked-resets').state, 'boost', 'banked reset expiring <24h surfaces boost/redeem action');
    assert.match(findKnob(codex, 'banked-resets').value, /Redeem soon/i);

    assert.equal(findKnob(agy, 'context-compact').state, 'tighten', 'high AGY >150k context tightens context-compact');
    assert.match(findKnob(agy, 'context-compact').value, /\/compact now/i);
    assert.equal(findKnob(agy, 'swarm-size').state, 'boost', 'surplus AGY with low /swarm share boosts swarm-size');
    assert.match(findKnob(agy, 'swarm-size').reason, /8%/);
  }

  // 9. AGY 5h burst wall vs healthy weekly, Claude scoped Fable tight vs open overall weekly, plus blocked/unknown states
  {
    const s = initialState();
    s.policy.blockedProviders = ['codex'];
    s.observations = [
      obs('agy', 'gemini:weekly', 30, 120, { modelFamily: 'gemini' }),
      obs('agy', 'gemini:session', 84, 2, { windowMinutes: 300, modelFamily: 'gemini' }),
      obs('claude', 'weekly', 35, 80),
      obs('claude', 'weekly:fable', 88, 80, { modelFamily: 'fable' }),
    ];
    const plan = buildPlan(s, NOW);
    const opt = buildOptimizationPlan(plan, null, NOW);
    assertExactSchema(opt);

    const agy = opt.providers.find((p) => p.provider === 'agy');
    const claude = opt.providers.find((p) => p.provider === 'claude');
    const codex = opt.providers.find((p) => p.provider === 'codex');

    assert.equal(findKnob(agy, 'swarm-size').state, 'tighten', '5h session <25% tightens AGY /swarm even when weekly is 70%');
    assert.match(findKnob(agy, 'swarm-size').value, /1–2 workers/);
    assert.equal(findKnob(agy, 'session-5h').state, 'tighten');
    assert.match(findKnob(agy, 'session-5h').reason, /16%.*70%/);
    assert.equal(findKnob(agy, 'effort-suffix').state, 'tighten');
    assert.match(findKnob(agy, 'effort-suffix').value, /-medium/);

    assert.equal(findKnob(claude, 'scoped-windows').state, 'tighten', 'tight scoped Fable vs healthy overall weekly must tighten');
    assert.match(findKnob(claude, 'scoped-windows').reason, /12%.*65%/);

    assert.equal(codex.utilizationState, 'blocked');
    assert.ok(codex.playbook.knobs.every((k) => k.state === 'off'), 'blocked provider marks all 6 knobs off');

    // Also test unknown state across all 3 providers
    const emptyOpt = buildOptimizationPlan(buildPlan(initialState(), NOW), null, NOW);
    assertExactSchema(emptyOpt);
    for (const p of emptyOpt.providers) {
      assert.equal(p.utilizationState, 'unknown');
      assert.ok(p.playbook.knobs.every((k) => k.state === 'steady'));
    }
  }

  // 10. Custom / other subscriptions (Cursor, Copilot, Windsurf, etc.):
  //     optimizer ranking, expiring-surplus alert, browser VM bundle, server /api/custom-providers + /api/checkin,
  //     CLI --custom rendering, and strict rejection of bad input / PII / paths / secrets.
  {
    const cursorEntry = {
      id: 'cursor',
      label: 'Cursor Pro',
      remainingPercent: 80,
      resetAt: iso(NOW + 18 * HOUR),
      windowMinutes: 43200,
      observedAt: iso(NOW - 5 * 60000),
      notes: '500 fast reqs',
    };
    const copilotEntry = {
      id: 'copilot',
      label: 'GitHub Copilot',
      remainingPercent: 10,
      resetAt: iso(NOW + 72 * HOUR),
      windowMinutes: 43200,
      observedAt: iso(NOW - 5 * 60000),
      notes: 'Pro+ monthly',
    };

    const s = initialState();
    s.observations = [
      obs('claude', 'weekly', 100, 47),
      obs('codex', 'codex:primary', 95, 16),
      obs('agy', 'gemini:weekly', 27, 140, { modelFamily: 'gemini' }),
      obs('agy', 'claude-gpt:weekly', 3, 140, { modelFamily: 'claude-gpt' }),
    ];
    s.customProviders = [cursorEntry, copilotEntry];
    const plan = buildPlan(s, NOW);
    assert.equal(plan.customProviders.length, 2);
    const opt = buildOptimizationPlan(plan, null, NOW);
    assertExactSchema(opt, { expectedCustomIds: ['cursor', 'copilot'] });

    assert.equal(opt.strategy, 'accelerate');
    assert.equal(opt.primaryProvider, 'cursor', 'Cursor 80% expiring in 18h must rank #1');
    assert.equal(opt.secondaryProvider, 'agy');
    assert.deepEqual(opt.recommendedOrder, ['cursor', 'agy', 'copilot', 'codex', 'claude']);
    assert.ok(opt.alerts.some((a) => a.kind === 'surplus' && a.provider === 'cursor' && /18h/.test(a.title)), 'expiring Cursor surplus must emit alert');

    const cursorSummary = opt.providers.find((p) => p.provider === 'cursor');
    const copilotSummary = opt.providers.find((p) => p.provider === 'copilot');
    assert.equal(cursorSummary.custom, true);
    assert.equal(cursorSummary.utilizationState, 'surplus');
    assert.equal(cursorSummary.playbook.mode, 'accelerate');
    assert.equal(findKnob(cursorSummary, 'workload-share').state, 'boost');
    assert.equal(copilotSummary.custom, true);
    assert.equal(copilotSummary.utilizationState, 'hot');
    assert.equal(copilotSummary.playbook.mode, 'conserve');
    assert.equal(findKnob(copilotSummary, 'workload-share').state, 'tighten');

    const piCmd = opt.quickCommands.find((q) => q.tool === 'pi');
    assert.ok(piCmd && !piCmd.why.includes('Cursor'), 'Pi /guard-order command only lists built-in providers');

    // Direct optimizer call silently strips malformed / PII custom entries in browser mode
    const dirtyPlan = {
      ...plan,
      customProviders: [
        cursorEntry,
        { id: '../evil', label: 'Bad', remainingPercent: 50, resetAt: iso(NOW + 10 * HOUR), observedAt: iso(NOW) },
        { id: 'leaked', label: 'C:\\Users\\alice\\secret', remainingPercent: 50, resetAt: iso(NOW + 10 * HOUR), observedAt: iso(NOW) },
        { id: 'email-pii', label: 'alice@example.com', remainingPercent: 50, resetAt: iso(NOW + 10 * HOUR), observedAt: iso(NOW) },
      ],
    };
    const safeOpt = buildOptimizationPlan(dirtyPlan, null, NOW);
    assertExactSchema(safeOpt, { expectedCustomIds: ['cursor'] });

    // Server /api/custom-providers + /api/checkin + CLI --custom integration
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optimizer-custom-'));
    const server = createGuardServer({ stateDir: dir, sync: false, now: () => NOW });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${server.address().port}`;
    const post = async (route, payload) => {
      const res = await fetch(`${url}${route}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      return { status: res.status, data: await res.json() };
    };
    try {
      await post('/api/observations', {
        observations: [
          obs('claude', 'weekly', 100, 47),
          obs('codex', 'codex:primary', 95, 16),
          obs('agy', 'gemini:weekly', 27, 140, { modelFamily: 'gemini' }),
        ],
      });

      const addCursor = await post('/api/custom-providers', { provider: cursorEntry });
      assert.equal(addCursor.status, 200);
      const addCopilot = await post('/api/custom-providers', { provider: copilotEntry });
      assert.equal(addCopilot.status, 200);

      // Bad input / PII / secret rejection
      assert.equal((await post('/api/custom-providers', { provider: { ...cursorEntry, id: 'Bad_ID' } })).status, 400);
      assert.equal((await post('/api/custom-providers', { provider: { ...cursorEntry, id: 'claude' } })).status, 400);
      assert.equal((await post('/api/custom-providers', { provider: { ...cursorEntry, remainingPercent: 150 } })).status, 400);
      assert.equal((await post('/api/custom-providers', { provider: { ...cursorEntry, label: 'C:\\Users\\alice\\key' } })).status, 400);
      assert.equal((await post('/api/custom-providers', { provider: { ...cursorEntry, notes: 'alice@example.com' } })).status, 400);
      assert.equal((await post('/api/custom-providers', { provider: { ...cursorEntry, notes: 'sk-1234567890abcdef' } })).status, 400);
      assert.equal((await post('/api/custom-providers', { provider: { ...cursorEntry, apiKey: 'sk-1234567890abcdef' } })).status, 400);

      const checkin = await (await fetch(`${url}/api/checkin`)).json();
      assert.equal(checkin.customProviders.length, 2);
      assertExactSchema(checkin.optimizer, { expectedCustomIds: ['cursor', 'copilot'] });
      assert.equal(checkin.optimizer.primaryProvider, 'cursor');

      // CLI against controller displays custom subscriptions alongside built-ins
      const { stdout: cliOut } = await execFileAsync(process.execPath, [path.join(__dirname, 'checkin-cli.js'), '--url', url, '--no-color'], { encoding: 'utf8' });
      assertNoJargon(cliOut, 'CLI custom-provider output');
      assert.match(cliOut, /Cursor Pro/);
      assert.match(cliOut, /GitHub Copilot/);
      assert.match(cliOut, /\(custom\)/);
      assert.ok(!cliOut.includes(dir), 'CLI output must never leak stateDir path');

      // Standalone live fallback loading custom-providers.json via --custom file option
      const customFile = path.join(dir, 'custom-providers.json');
      assert.ok(fs.existsSync(customFile), 'server must persist custom-providers.json in stateDir');
      const liveWithCustom = await fetchCheckin({
        url: 'http://127.0.0.1:9',
        timeoutMs: 250,
        now: NOW,
        customFile,
        fetchClaude: async () => ({ observations: [obs('claude', 'weekly', 100, 47)] }),
        fetchCodex: async () => ({ observations: [obs('codex', 'codex:primary', 95, 16)] }),
        fetchAgy: async () => ({ observations: [obs('agy', 'gemini:weekly', 27, 140, { modelFamily: 'gemini' })] }),
      });
      assert.equal(liveWithCustom.source, 'live');
      assertExactSchema(liveWithCustom.optimizer, { expectedCustomIds: ['cursor', 'copilot'] });
      assert.equal(liveWithCustom.optimizer.primaryProvider, 'cursor');

      // Remove one custom provider via API
      const removed = await post('/api/custom-providers', { action: 'remove', id: 'copilot' });
      assert.equal(removed.status, 200);
      assert.equal(removed.data.customProviders.length, 1);
      assert.equal(removed.data.customProviders[0].id, 'cursor');
    } finally {
      await new Promise((r) => server.close(r));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  console.log('Multi-subscription optimizer, custom providers, /api/checkin, checkin-cli, browser VM bundle, and Pi guard fix tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
