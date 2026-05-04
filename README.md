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
npm run dashboard
```

## Notes On Cost

Costs are API-equivalent estimates based on local token logs and pricing tables in `tools/ai-spend-dashboard-server.js`. They are not provider invoices, subscription limit counters, or guaranteed billing totals.

## License

MIT.
