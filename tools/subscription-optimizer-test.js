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

function assertExactSchema(opt) {
  assert.equal(typeof opt.generatedAt, 'string');
  assert.equal(typeof opt.headline, 'string');
  assert.ok(['accelerate', 'balanced', 'conserve', 'wait'].includes(opt.strategy));
  assert.ok(opt.primaryProvider === null || ['claude', 'codex', 'agy'].includes(opt.primaryProvider));
  assert.ok(opt.secondaryProvider === null || ['claude', 'codex', 'agy'].includes(opt.secondaryProvider));
  if (opt.nextUnlock !== null) {
    assert.equal(typeof opt.nextUnlock.provider, 'string');
    assert.equal(typeof opt.nextUnlock.windowId, 'string');
    assert.equal(typeof opt.nextUnlock.resetAt, 'string');
    assert.equal(typeof opt.nextUnlock.hoursLeft, 'number');
    assert.equal(typeof opt.nextUnlock.label, 'string');
  }
  assert.ok(Array.isArray(opt.alerts));
  assert.equal(opt.providers.length, 3);
  assert.equal(opt.recommendedOrder.length, 3);
  assert.deepEqual([...opt.recommendedOrder].sort(), ['agy', 'claude', 'codex']);
  assert.ok(Array.isArray(opt.quickCommands));
  assert.equal(typeof opt.note, 'string');
  for (const p of opt.providers) {
    assert.ok(['claude', 'codex', 'agy'].includes(p.provider));
    assert.equal(typeof p.label, 'string');
    assert.ok(['surplus', 'on-pace', 'hot', 'exhausted', 'blocked', 'unknown'].includes(p.utilizationState));
    assert.ok(Array.isArray(p.windows));
    assert.ok(p.playbook && ['accelerate', 'steady', 'conserve', 'pause'].includes(p.playbook.mode));
    assert.ok(Array.isArray(p.playbook.badges));
    assert.ok(Array.isArray(p.playbook.guidance));
    assert.ok(Array.isArray(p.playbook.commands));
  }
  // Strict zero-path privacy guarantee for snapshot exports.
  assert.ok(!/[A-Za-z]:\\|\/Users\/|\/home\//.test(JSON.stringify(opt)), 'optimizer output must never include filesystem paths');
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
  //    plus legacy stale gemini-argon:weekly window that should NOT poison healthy AGY lanes.
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
    assert.ok(opt.alerts.some((a) => a.kind === 'lane-opportunity' && a.provider === 'agy'));

    assert.equal(codex.utilizationState, 'hot');
    assert.equal(codex.remainingPercent, 5);
    assert.equal(codex.playbook.mode, 'conserve');
    assert.match(codex.playbook.headline, /\/fast OFF/i);
    assert.ok(opt.alerts.some((a) => a.kind === 'fast-burn' && a.provider === 'codex'));

    assert.equal(claude.utilizationState, 'exhausted');
    assert.equal(claude.remainingPercent, 0);
    assert.equal(claude.playbook.mode, 'pause');
    assert.match(claude.playbook.headline, /AGY Claude\/GPT/i);
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
      assert.match(textOut, /AI SPEND LIVE/);
      assert.match(textOut, /Gemini weekly/);
      assert.match(textOut, /Claude\/GPT weekly/);
      assert.match(textOut, /\/swarm/);
      assert.match(textOut, /\/fast off/i);
      assert.match(textOut, /\[#+-+\]/, 'must include ASCII progress bar');

      // Live fallback test when controller is unreachable
      const fallback = await fetchCheckin({
        url: 'http://127.0.0.1:9',
        timeoutMs: 250,
        now: NOW,
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
      assert.match(renderedFallback, /Direct live collectors/);
      assert.match(renderedFallback, /Antigravity CLI is unavailable/);

      // parseArgs sanity
      assert.deepEqual(parseArgs(['--live', '--json', '--watch', '30', '--no-color']), {
        url: process.env.AI_SPEND_GUARD_URL || 'http://127.0.0.1:9021',
        live: true,
        json: true,
        watchSeconds: 30,
        color: false,
        help: false,
      });
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

  console.log('Multi-subscription optimizer, /api/checkin, checkin-cli, browser VM bundle, and Pi guard fix tests passed');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
