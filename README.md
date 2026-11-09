# AI Spend Live

Release 0.6.1 makes Guard easier to use: connect Pi and work with protected
defaults, automatic subscription model selection, and optional usage-based
tightening. Detailed settings are under Advanced. Public example selectors
now work. Pi Guard 0.3.0 adds local handoff, fresh-session, and cross-agent
Markdown import commands without making a model call.

See the [release history](CHANGELOG.md), [Pi setup](integrations/pi/README.md),
and [recorded Pi walkthrough](public/guard-walkthrough.gif). The GIF replays
real Pi RPC output with offline fixture providers and scripted allowances.

Release 0.6.0 adds live Claude, Codex, and Antigravity allowance/reset readers,
24-hour protection insights, and Pi Guard 0.2.0. Guard checks subscription
reserves, pace, context, reasoning, task time, requests, and known subagent
calls; its API fallback stays off until you set dollar caps. Request counters
and cost estimates update live, while account allowances refresh about every
five minutes. One-hour Claude cache writes now count toward large-context
insights. The public playground uses synthetic readings and cannot spend tokens.

Release 0.5.1 adds measured limit-pressure warnings, focused-check and compact
handoff recommendations, stale-window guards, and public insight examples.
The landing page can demonstrate five-hour and weekly alerts without exposing
private sessions or presenting sample pressure as a visitor's live allowance.

Release 0.5.0 adds a merging history export (`npm run history:export`) so usage
survives transcript cleanup, and corrects Claude content-block double counting
and Codex fork-replay double counting in the parsers. 0.4.1 added canonical
per-model daily burn, reconciled token components, and explicit unknown pricing.

See what is burning your local AI usage, then decide what to do next.

AI Spend Live turns supported local usage records into model-level totals,
cache and context signals, measured 5-hour/weekly pacing, and deterministic
workflow suggestions. It helps you choose a model tier for the task in front
of you, preserve useful cache reuse, split a runaway thread, and checkpoint
before a rolling limit is reached. The core dashboard does not change models
or install skills. The optional Pi Guard extension can route explicitly guarded
requests between your configured subscriptions.

## What It Shows

- **Supported local sources**: Claude JSONL project logs, Codex JSONL
  rollouts, Codex state SQLite recovery, and an optional normalized JSON/JSONL
  import for other tools. This is not an all-cloud or all-chat tracker.
- **Model coverage without a whitelist wall**: known pricing is shown when
  configured, while every observed/new/unknown model ID remains in totals and
  the model catalog with a clear “pricing not configured” state.
- **Subagent & live-session attribution**:
  - Resolves `~/.claude/sessions/*.json` live process status (`busy`, `idle`, `shell`, PID) and session names
  - Attributes `<project>/<sessionId>/subagents/agent-<id>.jsonl` sidechains to their true project and parent session + subagent slug (`launch-taketoon-platform / parallel-pudding #a0145c`)
  - Tracks **Main Threads vs Subagents** token share and **Reasoning Effort** (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`)
- **Largest single turns** for sudden spike detection (excluding synthetic full-thread SQLite totals so genuine single-turn spikes stand out)
- **Session duration, reconciled fresh/cache/write/output token totals, and estimated API-equivalent cost**
- **Provider, model, subagent, and reasoning-effort splits**
- **Daily token burn chart** across `1`, `7`, `30`, `90`, and `365` day windows
- **Measured pacing** for rolling 5-hour and weekly envelopes when you set
  local budgets. Projections use observed token rates and an optional local
  reset timestamp; they are not provider quota counters.
- **Selectable Claude and Codex plan presets** that convert published message windows into local token estimates
- **Actionable recommendations & copyable prompts** for when to split, summarize, restart, `/clear`, cap subagents, close stale CLI windows, or step down from frontier models

No prompt text is exposed in the dashboard payload. Session names come from metadata only for the local view. Public demo exports contain aggregate counts, model IDs, and anonymized time buckets only; they contain no prompts, titles, paths, IDs, environment values, or credentials.

- Claude: `custom-title`, live `~/.claude/sessions/*.json` `name`, `agent-name`, subagent `slug` / `agentId`
- Codex: `~/.codex/session_index.jsonl` `thread_name`, `agent_nickname` / `agent_role`
- Fallback: project path or short session ID (raw prompt text in SQLite `threads.title` is never exposed)

Normalized import records may be JSONL rows or a JSON array. The minimal
contract is:

```json
{"timestamp":"2026-11-07T12:00:00Z","provider":"local-runner","model":"example-model","session_id":"optional","usage":{"input_tokens":1200,"cached_input_tokens":300,"output_tokens":400}}
```

Set `AI_SPEND_IMPORT_ROOT` or `AI_SPEND_IMPORT` to a file or directory. Keep
imports aggregate-safe if the dashboard is ever exported.

## Quick Start

```powershell
npm install
npm run dashboard
```

Open:

```text
http://127.0.0.1:9020/
```

## Scripts

```powershell
npm run dashboard
npm run summary
npm run demo:export
npm run history:export -- --out <ledger.json>
npm run test:public-demo
npm run test:history
npm test
```

`npm run demo:export` writes an aggregate-only public example. Pass `--out`
to place it in a static landing folder; it never exports prompts, titles,
paths, session IDs, environment values, or credentials.

## History Export

Claude Code prunes transcripts after roughly 30 days and the dashboard only
reads what is still on disk. `npm run history:export` walks every local record
for both providers with the same parsers and merges the aggregates into a
durable ledger, so a year-long "where did my tokens go" analysis survives log
cleanup:

```powershell
npm run history:export -- --out D:\aispend-ledger\ai-spend-ledger.json --since 2026-01-01 --summary-out D:\aispend-ledger\ai-spend-summary.md
```

- One row per **day x provider x model x project** with fresh input, cache
  read, cache write, output, reasoning output, turns, sessions touched,
  subagent tokens, reasoning-effort buckets, and estimated API-equivalent USD
  (`null` when pricing is unknown, never zero), plus per-day totals, hashed
  per-session summaries, the 100 largest single turns, and a `coverage` block
  with first/last record per source and explicit missing-day ranges.
- **Merge semantics**: when `--out` already exists, rows merge by
  (day, provider, model, project) taking the max of each token field.
  Re-scanning the same logs never double counts, and a day whose logs were
  pruned keeps its old row. Run it weekly; the previous file is kept as `.bak`.
- `stats-cache.json` whole-history model totals and its patchy daily series are
  folded in as separate `claudeStatsCacheTotals` / `claudeStatsCacheDaily`
  blocks and never mixed into the rows.
- `--since` / `--until` limit the aggregated days (files that cannot overlap
  the window are skipped), `--provider claude|codex` scans one source, and
  `--summary-only` regenerates the Markdown summary from an existing ledger.
  Files stream through the parser, so a 50 GB Codex history runs in a few
  hundred MB of memory.
- Project names are directory basenames (`H--devland-aiv-git` becomes
  `aiv-git`; Codex uses the rollout `cwd`, else `unknown`). Session ids are
  hashed. No prompt text, titles, or user content is written.

## Expected Local Log Paths

By default the dashboard reads:

```text
%USERPROFILE%\.claude\projects
%USERPROFILE%\.claude\sessions
%USERPROFILE%\.codex\sessions
%USERPROFILE%\.codex\session_index.jsonl
%USERPROFILE%\.codex\state_5.sqlite
```

If Codex uses a separate home, `CODEX_HOME` is honored automatically (for
example `H:\CodexData`). Explicit `CODEX_SESSIONS_ROOT`, `CODEX_SESSION_INDEX`,
and `CODEX_STATE_DB` values still take precedence.

You can override paths and budgets with environment variables:

```powershell
$env:CLAUDE_PROJECTS_ROOT="C:\path\to\.claude\projects"
$env:CLAUDE_SESSIONS_ROOT="C:\path\to\.claude\sessions"
$env:CODEX_SESSIONS_ROOT="C:\path\to\.codex\sessions"
$env:CODEX_SESSION_INDEX="C:\path\to\.codex\session_index.jsonl"
$env:CODEX_STATE_DB="C:\path\to\.codex\state_5.sqlite"
$env:AI_SPEND_PORT="9020"
$env:AI_SPEND_CLAUDE_PLAN="claude-ultra"
$env:AI_SPEND_CODEX_PLAN="codex-pro-200"
$env:AI_SPEND_5H_TOKEN_BUDGET="8000000"
$env:AI_SPEND_WEEKLY_TOKEN_BUDGET="50000000"
$env:AI_SPEND_5H_RESET_AT="2026-11-07T17:00:00-05:00"
$env:AI_SPEND_WEEKLY_RESET_AT="2026-11-10T00:00:00-05:00"
npm run dashboard
```

## Prompt And Token Pacing

The dashboard separates raw token burn from workflow guidance:

- **Use GPT-6 Astra, GPT-6.1 Sol, Claude Fable 5.1, and Claude Opus 5.5 for planning gates**: ambiguous goals, architecture tradeoffs, write sets, risk checks, acceptance criteria, and final review.
- **Step down for bounded execution**: route scoped implementation and worker subagents to **GPT-6.1 Terra / GPT-6 Luna** or **Claude Sonnet 5.5 / Haiku 5.5** once the files, allowed side effects, and test commands are clear.
- **Cap subagent fan-out**: every spawned subagent builds its own context window. Keep routine multi-file work with a single implementation owner and give subagents explicit file lists rather than open repo searches.
- **Treat `/fast` and `xhigh`/`ultra` effort as targeted tools**: avoid `/fast` during repo-wide discovery, and reserve `xhigh`/`ultra` reasoning effort on Sol for genuinely complex architecture or race/memory debugging.
- **Protect the 5-hour and weekly windows**: pick your Claude and Codex plan in the dashboard or set `AI_SPEND_5H_TOKEN_BUDGET` and `AI_SPEND_WEEKLY_TOKEN_BUDGET` to track projected runout risk.

Plan and price sources:

- Claude API pricing: <https://platform.claude.com/docs/en/about-claude/pricing>
- Claude Pro, Max, and Ultra plans: <https://support.claude.com/en/articles/8324991-about-claude-s-pro-plan-usage>, <https://support.claude.com/en/articles/11014257-about-claude-s-max-plan-usage>, and <https://support.claude.com/en/articles/13680274-about-claude-s-ultra-plan-usage>
- OpenAI plans and Standard-speed credits: <https://learn.chatgpt.com/docs/pricing>
- OpenAI API pricing: <https://developers.openai.com/api/docs/pricing>

## Notes On Cost

Costs and credit equivalents are estimates based on local token logs, SQLite
thread totals, and pricing tables in `tools/ai-spend-dashboard-server.js`.
They are not provider invoices, subscription limit counters, or guaranteed
billing totals. Subscription plans publish message windows and fair-use limits
rather than a fixed included token balance, so the dashboard keeps those
signals separate from API dollars and credits. Guard automatically reads provider
allowances and reset timestamps using local Claude, Codex, and AGY logins.

## AI Spend Guard (Pi preview)

Guard adds subscription reset planning and per-task work budgets to Pi. Run
`npm run guard` for the local controller at <http://127.0.0.1:9021>, or
`npm run guard:demo` for a synthetic scenario at <http://127.0.0.1:9022>.
The public playground is `public/guard.html` and can never authorize model calls.
The local dashboard also shows live allowance readings from Guard. Choose your
provider order and models, reserve, reasoning ceiling, task time budget, and
optional API dollar caps in Guard. API spending stays off until explicitly enabled.

See [Pi setup and limits](integrations/pi/README.md) and
[the Pi/HerdR analysis](doc/PI-GUARD-ANALYSIS.md). Run `npm run test:guard` for
policy and HTTP checks, and `npm run test:pi` after installing the pinned local
Pi runtime. `npm run guard:export` rebuilds the public playground from the same
policy implementation. `npm run site:preview` serves the public site on port 9023.

## License

MIT.
