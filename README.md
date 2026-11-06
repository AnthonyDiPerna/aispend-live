# AI Spend Live

Find the Claude or Codex session (or subagent swarm) draining your token budget.

AI Spend Live reads local JSONL usage logs and SQLite session state from Claude Code and Codex CLI, estimates API-equivalent cost and OpenAI Standard-speed credit use across the current model catalog, and shows which sessions, subagents, reasoning efforts, and turns are driving the burn. The goal is action, not trivia: split the thread, cap subagent fan-out, summarize and restart, narrow the context, or route the work to the right model tier before wasting another hundred million tokens.

## What It Shows

- **Claude & Codex token usage** from local JSONL logs plus `~/.codex/state_*.sqlite` thread history when JSONL rollouts are rotated
- **Current model catalog, API pricing, and OpenAI credit reference** (verified 2026-11-06):
  - **Claude**: `claude-fable-5-1`, `claude-opus-5-5`, `claude-sonnet-5-5`, and `claude-haiku-5-5`, with legacy models retained for historical logs
  - **OpenAI / Codex**: `gpt-6-astra`, `gpt-6.1-sol`, `gpt-6.1-terra`, `gpt-6-sol`, and `gpt-6-luna`, with legacy models retained for historical logs
- **Subagent & live-session attribution**:
  - Resolves `~/.claude/sessions/*.json` live process status (`busy`, `idle`, `shell`, PID) and session names
  - Attributes `<project>/<sessionId>/subagents/agent-<id>.jsonl` sidechains to their true project and parent session + subagent slug (`launch-taketoon-platform / parallel-pudding #a0145c`)
  - Tracks **Main Threads vs Subagents** token share and **Reasoning Effort** (`low`, `medium`, `high`, `xhigh`, `max`, `ultra`)
- **Largest single turns** for sudden spike detection (excluding synthetic full-thread SQLite totals so genuine single-turn spikes stand out)
- **Session duration, cache reuse, token totals, and estimated API-equivalent cost**
- **Provider, model, subagent, and reasoning-effort splits**
- **Daily token burn chart** across `1`, `7`, `30`, `90`, and `365` day windows
- **Remaining-budget cards** for rolling 5-hour and weekly envelopes when you set local budget values
- **Selectable Claude and Codex plan presets** that convert published message windows into local token estimates
- **Actionable recommendations & copyable prompts** for when to split, summarize, restart, `/clear`, cap subagents, close stale CLI windows, or step down from frontier models

No prompt text is exposed in the dashboard payload. Session names come from metadata only:

- Claude: `custom-title`, live `~/.claude/sessions/*.json` `name`, `agent-name`, subagent `slug` / `agentId`
- Codex: `~/.codex/session_index.jsonl` `thread_name`, `agent_nickname` / `agent_role`
- Fallback: project path or short session ID (raw prompt text in SQLite `threads.title` is never exposed)

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
npm test
```

## Expected Local Log Paths

By default the dashboard reads:

```text
%USERPROFILE%\.claude\projects
%USERPROFILE%\.claude\sessions
%USERPROFILE%\.codex\sessions
%USERPROFILE%\.codex\session_index.jsonl
%USERPROFILE%\.codex\state_5.sqlite
```

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

Costs and OpenAI credit equivalents are estimates based on local token logs, SQLite thread totals, and pricing tables in `tools/ai-spend-dashboard-server.js`. They are not provider invoices, subscription limit counters, or guaranteed billing totals. Subscription plans publish message windows and fair-use limits rather than a fixed included token balance, so the dashboard keeps those signals separate from API dollars and credits.

## License

MIT.
