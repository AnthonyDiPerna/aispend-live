# AI Spend Live

**Release 0.7.0** turns AI Spend Live into a **native-first Multi-Subscription Command Center** across **Claude**, **Codex**, and **Antigravity (AGY)**. Measure real local usage across all three subscriptions — including AGY `transcript.jsonl` + `/swarm` workers, Codex `/fast` (`service_tier`) + reasoning effort, and Claude tiers/subagents — then run `npm run check` in any terminal for a 1-second verdict on what to use next.

- **Know when to accelerate**: spot expiring surplus allowance before a weekly reset and launch **`/swarm`** (3–4 workers + verifier) in AGY, enable **`/fast` + high/xhigh effort** in Codex, or run Opus/Fable planning in Claude.
- **Protect tight quotas**: see both Antigravity buckets (**Gemini** and **Claude/GPT** lanes) alongside Codex and Claude, know immediately when to turn `/fast` OFF, and offload coding work to an open lane while a tight subscription recovers.
- **Optional Pi Guard routing**: keep working across subscriptions automatically inside Pi with `pi-guard` (`/guard`, `/guard-check`, `/guard-order`, `/guard-block`), loop repair, context compaction, and banked reset inventory tracking.

See the [release history](CHANGELOG.md), [Pi setup and work modes](integrations/pi/README.md), [native hooks](integrations/native/README.md), and [recorded Pi walkthrough](public/guard-walkthrough.gif).

## Quick Start

```powershell
npm install

# 1. Instant 3-subscription check-in (works even if Guard server isn't running)
npm run check

# 2. Local 3-provider command center at http://127.0.0.1:9020/
npm run dashboard

# 3. Optional Guard controller at http://127.0.0.1:9021/
npm run guard
```

## What It Shows

- **Supported local sources (3 native providers + imports)**:
  - **Claude**: `~/.claude/projects` JSONL logs + `~/.claude/sessions/*.json` live status + subagent sidechains, capturing effort (`record.effort` / `output_config.effort`), `speed`/`service_tier`, and thinking tokens.
  - **Codex**: `~/.codex/sessions` (or `CODEX_HOME`) streaming JSONL rollouts (handles multi-GB files), `session_index.jsonl`, and `state_5.sqlite` recovery, capturing `thread_settings_applied` `/fast` (`priority` / `ultrafast`), reasoning effort, and `cache_write_input_tokens`.
  - **Antigravity (AGY)**: `~/.gemini/antigravity-cli/brain/<uuid>/.system_generated/logs/transcript.jsonl`, `swarm/members.json`, `subagents/*.json`, and read-only `conversation_summaries.db`, with accurate disjoint token math (`input + cache_read + output`) and effort-suffix extraction (`-xhigh`, `-high`, `-medium`).
  - **Normalized import**: optional JSON/JSONL import via `AI_SPEND_IMPORT_ROOT` or `AI_SPEND_IMPORT`.
- **Multi-Subscription Value Optimizer (`tools/subscription-optimizer.js`)**:
  - Evaluates Claude, Codex, and Antigravity (both **Gemini** and **Claude/GPT** lanes) plus banked reset credits and 24-hour usage insights.
  - Classifies each subscription (`surplus`, `on-pace`, `hot`, `exhausted`, `blocked`) with safe daily burn targets (`%/day`), next unlock countdowns, and per-tool tactical playbooks (`/swarm` sizing, `/fast` ON/OFF + effort, model tiers, and copyable commands).
  - Powers `npm run check`, the local dashboard cockpit, the Guard controller UI, and the static browser playground (`public/guard.html`).
- **Model coverage without a whitelist wall**: known API prices are shown where verified, while newer or unpriced models (such as `claude-fable-5-2`, `gpt-6.2-*`, `gemini-4-neon`, `gemini-4-carbon`, `gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3.8-flash`) stay in totals with an explicit “pricing not configured” state rather than fabricated dollars.
- **`/swarm`, `/fast`, subagent, and reasoning-effort splits**: tracks Main Threads vs Subagents, AGY `/swarm` share, Codex/Claude `/fast` & ultrafast share, and largest single turns.
- **Daily 3-provider token burn chart** across `1`, `7`, `30`, `90`, and `365` day windows (Claude, Codex, and Antigravity stacked cleanly).
- **Zero-PII public site & counter (`www.aispend.live`)**: aggregate-only telemetry export (`demo-data.json`), path-free Guard + Optimizer snapshot (`guard-snapshot.json`), interactive browser Check-In Simulator, live GitHub repo stats, and a zero-PII aggregate integer counter (`public/counter.php` + `public/.htaccess`) with zero cookies, IPs, or trackers.

No prompt text is exposed in any dashboard payload, CLI output, or export. Public exports contain aggregate counts, model IDs, optimizer guidance, and anonymized time buckets only; they never export prompts, titles, paths, session IDs, environment values, or credentials.

Normalized import record contract:

```json
{"timestamp":"2026-11-22T12:00:00Z","provider":"local-runner","model":"example-model","session_id":"optional","usage":{"input_tokens":1200,"cached_input_tokens":300,"output_tokens":400}}
```

## Scripts

```powershell
# Multi-subscription check-in CLI
npm run check                  # fast check via Guard controller, or auto-fallback to live collectors
npm run check:live             # force direct live poll of Claude + Codex + AGY
npm run check:watch            # auto-refreshing terminal cockpit (60s)

# Local dashboards & controllers
npm run dashboard              # 3-provider dashboard on http://127.0.0.1:9020/
npm run summary                # CLI summary output (--days 7|30)
npm run guard                  # Guard controller on http://127.0.0.1:9021/
npm run guard:demo             # Synthetic Guard demo on http://127.0.0.1:9022/

# Exports & site preview
npm run demo:export            # sanitized public/demo-data.json (supports --days 30)
npm run guard:snapshot         # sanitized public/guard-snapshot.json (includes optimizer summary)
npm run guard:export           # rebuild static public/guard.html playground with real optimizer
npm run history:export -- --out <ledger.json>
npm run site:preview           # serve public/ on http://127.0.0.1:9023/ (includes /counter.php mock)

# Tests
npm test                       # dashboard & history export tests
npm run test:guard             # Guard, collectors, advisor, recovery, watchdog & optimizer tests
npm run test:optimizer         # standalone multi-subscription optimizer tests
npm run test:public-demo       # public demo breakdown, AGY, speed/swarm & privacy tests
npm run test:pi                # real Pi offline RPC integration suite
```

## History Export

Claude Code prunes transcripts after roughly 30 days and the dashboard only reads what is still on disk. `npm run history:export` walks local records with the same parsers and merges aggregates into a durable ledger so long-term analysis survives log cleanup:

```powershell
npm run history:export -- --out D:\aispend-ledger\ai-spend-ledger.json --since 2026-01-01 --summary-out D:\aispend-ledger\ai-spend-summary.md
```

- One row per **day × provider × model × project** with fresh input, cache read, cache write, output, reasoning output, turns, sessions touched, subagent tokens, reasoning-effort buckets, and estimated API-equivalent USD (`null` when pricing is unknown, never zero).
- **Merge semantics**: re-scanning merges by `(day, provider, model, project)` taking the max of each token field so re-runs never double-count and pruned days keep their history. Previous file is backed up as `.bak`.
- Streams multi-GB rollouts in bounded memory. Session IDs are hashed; no prompt text, titles, or user content is written.

## Expected Local Log Paths

By default the dashboard reads:

```text
%USERPROFILE%\.claude\projects
%USERPROFILE%\.claude\sessions
%USERPROFILE%\.codex\sessions
%USERPROFILE%\.codex\session_index.jsonl
%USERPROFILE%\.codex\state_5.sqlite
%USERPROFILE%\.gemini\antigravity-cli
```

If Codex uses a separate home, `CODEX_HOME` is honored automatically (for example `H:\CodexData`). Explicit overrides take precedence:

```powershell
$env:CLAUDE_PROJECTS_ROOT="C:\path\to\.claude\projects"
$env:CLAUDE_SESSIONS_ROOT="C:\path\to\.claude\sessions"
$env:CODEX_SESSIONS_ROOT="C:\path\to\.codex\sessions"
$env:CODEX_SESSION_INDEX="C:\path\to\.codex\session_index.jsonl"
$env:CODEX_STATE_DB="C:\path\to\.codex\state_5.sqlite"
$env:AGY_ROOT="C:\path\to\.gemini\antigravity-cli"
$env:AI_SPEND_PORT="9020"
$env:AI_SPEND_GUARD_URL="http://127.0.0.1:9021"
npm run dashboard
```

## Prompt And Token Pacing

- **Maximize expiring surplus intentionally**: when an Antigravity lane (`Gemini` or `Claude/GPT`) or Codex weekly window has heavy headroom before reset, use `/swarm` or `/fast` deliberately instead of letting paid allowance expire unused.
- **Protect tight windows early**: turn Codex `/fast` OFF below 20% remaining, keep frontier models (`GPT-6 Astra`, `GPT-6.1/6.2 Sol`, `Claude Fable`, `Claude Opus`) for architecture and review gates, and step down to `Terra`/`Luna`, `Sonnet`/`Haiku`, or `Hydrogen`/`Flash` for bounded execution.
- **Keep context compact**: high cache reuse still burns rolling allowances when giant threads replay every turn. Use `/clear` or compact handoffs when a task changes direction.

## Notes On Cost

Costs and credit equivalents are estimates based on local token logs, SQLite thread totals, and configured pricing tables in `tools/ai-spend-dashboard-server.js`. They are not provider invoices or guaranteed billing totals. Live provider allowances and reset timestamps come directly from local Claude, Codex, and AGY logins via read-only collectors.

## AI Spend Guard (Optional Pi Routing)

Guard adds subscription reset planning, multi-subscription optimizer verdicts, and per-task budgets to Pi. Run `npm run guard` for the local controller at <http://127.0.0.1:9021>, or `npm run guard:demo` for a synthetic scenario at <http://127.0.0.1:9022>. The static public playground (`public/guard.html`) bundles the same policy and optimizer modules and can never authorize model calls. API spending stays off until explicitly enabled.

See [Pi setup and limits](integrations/pi/README.md) and [the Pi/HerdR analysis](doc/PI-GUARD-ANALYSIS.md).

## License

MIT.
