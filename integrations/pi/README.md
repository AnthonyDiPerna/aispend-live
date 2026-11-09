# AI Spend Guard for Pi 0.3.0 (AI Spend Live 0.6.1 preview)

Guard is a local controller plus a Pi virtual model. It checks measured subscription allowance before each request, preserves a reserve, keeps a task request budget, and pauses when it cannot make a supported decision. HerdR remains the terminal and session manager.

## First run

Complete the [portable installation](#portable-installation) below, then run `integrations/pi/Start-Guard.ps1` from your terminal or a HerdR tab. The launcher creates an isolated Pi profile and leaves your existing Claude and Codex configuration in place.

1. After launching Guard, open <http://127.0.0.1:9021> for your local controller. To try the synthetic playground separately, run `npm.cmd run site:preview` from the repository and open <http://127.0.0.1:9023/guard.html>.
2. Wait for fresh readings from the automatic readers: Claude's account usage endpoint, Codex's native account API, and `agy --print /usage`. They use existing CLI logins and make no inference requests. Both account-wide and model-scoped windows are preserved. Missing readings remain unknown; manual entry is a fallback.
3. In Pi, run `/guard`. Authenticated subscription models are selected automatically when no preference exists, favoring a balanced family when available. Existing model choices are preserved. The website shows the active protection; model choices and Advanced settings are optional.
4. Keep `aispend/guard` selected in Pi. To add Codex, use Pi's `/login` and select the OpenAI subscription login, then run `/guard` to discover and select its model. Credentials stay in Pi's local auth store; Guard never receives them.
5. Run a small real task first. Review its counters in **Guarded tasks**. `/guard-hold` cancels automatic waiting; `/guard-resume` resumes a saved task after review. Renewing the task budget in the dashboard does not refill your subscription.

Your existing Claude CLI login is used by the official experimental `pi-claude-code` bridge. Claude Code still transports the requests, while Pi manages tools and history. The bridge uses the same subscription allowance. To keep a strict subscription cost ceiling, disable extra usage/overage in the provider account: the bridge can detect overage after a response, but cannot guarantee that the first such request was free.

AGY quota monitoring uses the native CLI. Its Gemini, Claude/GPT, and Argon scopes are tracked separately. Monitoring does not make AGY routable in Pi. Guard only routes it when a compatible authenticated `google-antigravity` connector is available; this setup does not install one. Radius is Pi's separate gateway service, not an import of existing subscription entitlements.

## Portable installation

Requires Node 22.19+ (tested on Node 24.13), Git, and a logged-in Claude CLI if using Claude.

```powershell
# Run from the aispend-live repository. Installation is local, not global.
npm.cmd install --prefix .guard-runtime --ignore-scripts @earendil-works/pi-coding-agent@1.5.0
git clone https://github.com/earendil-works/pi-claude-code .guard-runtime/pi-claude-code
git -C .guard-runtime/pi-claude-code checkout d5b5e04c314d3452d357174d16d10dda34daa2d2
powershell.exe -NoProfile -ExecutionPolicy Bypass -File integrations/pi/Start-Guard.ps1 -ProjectPath C:\your\project
```

The launcher pins Pi, starts the loopback controller if needed, and creates a separate profile in `.guard-data/pi-agent`. Cache warming and built-in automatic retries are disabled in that profile. Guard owns context checkpoints. The launcher loads only the official bridge and Guard extensions. On other platforms, use the same extension paths with `pi -e <bridge>/src/index.ts -e <repo>/integrations/pi/index.ts --model aispend/guard` and the equivalent isolated settings.

Resume a saved session with `-Resume`. Run the launcher with `-ListModels` to check available models without generating a response. Real model names come from the provider catalog, rather than a hardcoded marketing tier.

## Protected defaults and usage-based recommendations

New installations start with a 10% reserve, 120k context ceiling, 40 requests
and 60 minutes per task, one concurrent request, medium reasoning, no known
subagent calls, and API spending off. Sign in and use `aispend/guard`; you do
not need to tune every field first.

The local advisor recomputes rules from recent usage; it does not train an AI
or make extra model calls. With at least 20 recorded requests and analysis
less than six hours old, substantial large-context usage suggests an 80k
checkpoint, and substantial long-session usage suggests a 30-minute review.
Subagent and effort signals can tighten their respective ceilings. A measured
pace warning can shorten work to 25 requests per task. Reasons are visible.

Automatic tuning only tightens these work bounds. It never buys API access,
raises dollar caps, relaxes a tighter user setting, or replaces a selected
model. New installations enable it by default. Existing installations keep
manual control until you enable it under Advanced settings. Turn it off for
recommendations-only operation; review and apply suggestions when convenient.

## Portable handoffs between agents

- `/guard-handoff` writes bounded Markdown excerpts of the goal, recent
  instructions, latest compaction, progress, and files mentioned by edit tools.
- `/guard-new` saves that handoff, opens a fresh session from it, and keeps
  the original session. It waits for your next instruction before inference.
- `/guard-import path/to/handoff.md` opens a fresh session from a Claude,
  Codex, or other agent's local Markdown/text handoff. Imports are capped at
  16,000 characters; files over 256 KB and non-text extensions are rejected.

These commands make no model calls. Imported notes are reference context, not
verified facts or higher-priority instructions. Review unfinished checks before
continuing. Normal Guard checks apply to the next request. Give the same local
handoff document to Claude or Codex when moving work back; Guard does not send
messages to your other agents or upload their transcripts.

Pauses also save a local handoff automatically when storage is available.
These are bounded excerpts, not a guaranteed semantic summary. Compaction
uses a model and needs available allowance; starting a fresh session is an
explicit action. Private notes stay in the local artifact directory.

[Watch the walkthrough](../../public/guard-walkthrough.gif) or inspect its
[recorded transcript](../../public/guard-walkthrough.json). It runs the real Pi
runtime with offline fixture providers. Allowances are scripted and no paid
model calls occur. To reproduce after installing Pi and Pillow:

```powershell
node tools/record-guard-demo.cjs
py -3 tools/render-guard-demo.py
```

## What is automatic

- Claude, Codex, and AGY quota collection every five minutes, with cooldown/backoff and visible check times. Local Codex logs also supply recent snapshots. Claude's usage endpoint is undocumented and can change; a failed check preserves dated readings instead of inventing a balance.
- Claude → Codex → AGY preference among configured, authenticated, ready subscriptions. Tool continuations stay on the same provider while eligible to preserve cache reuse.
- Configurable subscription preference, selected models, request/token/time budgets, reasoning ceiling (medium by default), concurrent-request cap, and three-identical-result loop stop. Known subagent tools are denied by default; arbitrary shell-launched agents are outside this tool-name guard.
- Live browser events for guarded requests, model-price cost estimates, and budget reservations. API fallback is disabled by default. To enable it, connect an API model in Pi, select it in Guard, and set both daily and task dollar caps. Daily accounting uses UTC. Unknown pricing blocks API routing. Pending requests reserve estimated dollars across controller restarts; missing cost telemetry keeps the reservation as an estimate.
- Local 24-hour insights for subagents, large contexts, recorded reasoning effort, and long sessions. Metrics use recorded tokens, not provider quota weights. Effort is shown as unknown where the logs omit it. The existing AI Spend dashboard shows Guard's live allowances and these insights.
- Long shell/search output is archived locally and shortened before the next request. Images remain intact.
- One context compaction at the configured ceiling, preserving the original task and unfinished work, followed by continuation. Compaction itself needs available allowance and counts as a request.
- In interactive Pi/RPC, allowance or concurrency pauses check readiness every 30 seconds without calling a model. Work resumes when fresh readings and task budgets permit. Timers never invent refreshed quota. Budget and repeated-result pauses need explicit review. Closing Pi cancels waiting.

## Limits and data

This is a preview, not a provider-enforced billing cap. Only requests routed through `aispend/guard` are controlled. Other Claude/Codex/AGY sessions can consume the same allowance between readings. A request already in flight can exceed a token budget. Compaction's exact token total is not exposed by Pi's callback; its request counts, while its reported-token entry is zero. Concurrent leases expire after 15 minutes to recover from a crashed client. Terminal `-p` mode saves a context checkpoint, but automatic compaction/resumption requires a long-lived interactive or RPC session.

Pace forecasts extend the recent observed percentage-per-hour to reset. They are deliberately conservative, can overestimate bursty or intermittent work, and are not predicted invoices. A provider remains paused while a known allowance window is stale, in reserve, past reset without confirmation, or consuming too quickly. Supply fresh readings to correct old observations.

The controller binds to `127.0.0.1`, rejects foreign browser origins, and accepts authenticated models discovered by Pi. Its browser payload contains percentages, reset times, model IDs, hashed task IDs, counters, aggregate insights, and decisions. Credentials and prompts are never sent to the website. Native credentials are read only for official provider endpoints or by their own CLI. Local Pi session files and archived tool output can contain private work; keep the state and artifact directories private. The public playground has no controller connection and cannot authorize requests.

API estimates are not billing guarantees: catalog prices, provider surcharges, or an in-flight request can differ. Guard reserves a conservative full-context estimate with pricing headroom, then reconciles the reported cost. Compaction with missing usage is marked unknown. Set provider-side spend limits for a billing ceiling. Subscription reference dollars are never subtracted from a plan balance.

Optional native session telemetry uses `node tools/guard-statusline.js agy <state-directory>` (or `claude`) as the CLI's supported status-line command. It writes sanitized quota/cost/context metadata locally and omits account identity, prompts, and paths. It is not required for automatic quota polling and does not install itself into global settings.

## Checks

```powershell
npm.cmd run test:guard
npm.cmd test
npm.cmd run test:public-demo
npm.cmd run test:pi
node tools/export-guard-demo.js
```

Install the pinned runtime before running `test:pi`. The test uses `.guard-runtime` by default; for a runtime installed elsewhere, set `AI_SPEND_PI_RUNTIME` to its installation directory. It exercises the real Pi runtime with a fake local provider, including context compaction, continuation, allowance resumption, and API opt-in. It makes no real model calls.

Sources checked November 8, 2026: [Pi](https://github.com/earendil-works/pi), [virtual models](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/virtual-models.md), [official Claude bridge](https://github.com/earendil-works/pi-claude-code), [Claude plan/SDK usage](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan), [Codex pricing and allowances](https://developers.openai.com/codex/pricing/).

Allowance reader references: [Codex account/rateLimits/read](https://learn.chatgpt.com/docs/app-server), [AGY native /usage in print mode](https://antigravity.google/docs/cli/headless/), [AGY status-line metadata](https://antigravity.google/docs/cli/statusline/), [Claude status-line limits](https://code.claude.com/docs/en/statusline), [Claude usage reader implementation](https://github.com/steipete/CodexBar/blob/main/docs/claude.md).
