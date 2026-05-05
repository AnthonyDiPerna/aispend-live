# AI Spend Live

Find the Claude or Codex session draining your token budget.

AI Spend Live reads local JSONL usage logs from Claude Code and Codex, estimates API-equivalent cost, and shows which sessions and turns are driving the burn. The goal is action, not trivia: split the thread, summarize and restart, narrow the context, or route the work to the better tool before wasting another million tokens.

## What It Shows

- Claude and Codex token usage from local logs
- Per-session burn with readable names when available
- Largest turns for sudden spike detection
- Session duration, cache reuse, token totals, and estimated API-equivalent cost
- Provider and model split
- Daily token burn chart
- Recent-session hints inferred from log activity
- Remaining-budget cards for rolling 5-hour and weekly envelopes when you set local budget values
- Selectable Claude and Codex plan presets that convert published message windows into local token estimates
- Budget-by-session ranking so you can see which sessions consumed the most of each window
- Actionable recommendations for when to split, summarize, restart, `/clear`, close stale CLI windows, or route work between Claude and Codex
- Suggested prompts to ask Claude/Codex before continuing expensive sessions
- Weekly pacing guidance when you set a local token envelope
- Prompt-shape and model-routing guidance: plan with GPT-5.5 for ambiguity, execute scoped work with Codex, and reserve `/fast` for bounded edits

No prompt text is exposed in the dashboard payload. Session names come from metadata only:

- Claude: `custom-title`, fallback `agent-name`
- Codex: `~/.codex/session_index.jsonl` `thread_name`
- Fallback: project path or session id

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
%USERPROFILE%\.codex\sessions
%USERPROFILE%\.codex\session_index.jsonl
```

You can override paths with environment variables:

```powershell
$env:CLAUDE_PROJECTS_ROOT="C:\path\to\.claude\projects"
$env:CODEX_SESSIONS_ROOT="C:\path\to\.codex\sessions"
$env:CODEX_SESSION_INDEX="C:\path\to\.codex\session_index.jsonl"
$env:AI_SPEND_PORT="9020"
$env:AI_SPEND_CLAUDE_PLAN="claude-max-20x"
$env:AI_SPEND_CODEX_PLAN="codex-pro-20x"
$env:AI_SPEND_5H_TOKEN_BUDGET="8000000"
$env:AI_SPEND_WEEKLY_TOKEN_BUDGET="50000000"
npm run dashboard
```

## Prompt And Token Pacing

The dashboard now separates token burn from workflow guidance:

- Use GPT-5.5 for planning gates: ambiguous goals, tradeoffs, write sets, risk checks, acceptance criteria, and review.
- Move scoped implementation to Codex once the files, allowed side effects, and test command are clear.
- Treat `/fast` as a bounded-edit mode. Avoid it during discovery, repo-wide search, and unclear debugging because it can burn through turns quickly.
- Start scoped execution at low or medium reasoning effort. Raise effort only when the task is still ambiguous and the output quality justifies the extra burn.
- Pick your Claude and Codex plan in the dashboard to compare current 5-hour burn against official message-window ranges. The token budget is estimated from your observed local token burn because neither provider publishes a fixed token cap for these subscriptions.
- Set `AI_SPEND_5H_TOKEN_BUDGET` to show remaining tokens in a rolling 5-hour envelope and identify the sessions eating that short-window budget.
- Set `AI_SPEND_WEEKLY_TOKEN_BUDGET` to show rolling 7-day usage against a weekly envelope and flag projected runout risk. Claude and Codex both describe weekly limits, but neither publishes exact weekly token caps for these consumer subscriptions.

Plan preset sources:

- Claude Pro and Max usage: <https://support.anthropic.com/en/articles/8324991-about-claude-s-pro-plan-usage/> and <https://support.anthropic.com/en/articles/11014257-about-claude-s-max-plan-usage/>
- Codex pricing and usage limits: <https://developers.openai.com/codex/pricing>

## Notes On Cost

Costs are API-equivalent estimates based on local token logs and pricing tables in `tools/ai-spend-dashboard-server.js`. They are not provider invoices, subscription limit counters, or guaranteed billing totals.

## License

MIT.
