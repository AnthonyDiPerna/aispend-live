# AI Spend Guard for Pi 0.3.3 (AI Spend Live 0.6.4 preview)

Run `/guard` to activate the guarded model, automatic tuning and bounded loop
recovery. `/guard status` only inspects. Once activated, selecting a subscription
model updates its preference and keeps requests routed through Guard. Use
`/guard-unlock` only when you deliberately want to select an unguarded model.

Repeated identical results block the next identical operation before execution.
Guard writes a local handoff and allows one different approach per task by
default. That follow-up still consumes the original request/time/token/API
budget and needs fresh allowance. Another repeat or an exhausted budget pauses;
there is no automatic budget renewal or new-session bypass. Context growth
continues to use bounded compaction. Settings are optional under Advanced.

The **What Guard saved** report counts interventions and measures net characters
removed, including the cost of its archive notice. Estimated input tokens use
characters / 4 and receive credit once, only after a subsequent completed request
with usage. Known catalog rates give a cached-to-uncached input-cost range.
Subscription dollars are comparisons, not refunds or known quota savings.
Unknown prices remain unknown. Compaction reduction is separate; repair and
compaction overhead is shown, so gross savings cannot be mistaken for net bills.
The JSON report contains counters and hashed task IDs, not your work text.

[Native hook setup and coverage](../native/README.md) covers supported Claude,
Codex and Antigravity boundaries. Full request routing/compaction remains in Pi.

Guard is a local controller plus a Pi virtual model. It checks measured subscription allowance before each request, tracks a reserve target, keeps a task request budget, and pauses when it cannot make a supported decision. HerdR remains the terminal and session manager.

## Choose a work mode

The default **Keep working** mode uses fresh positive allowance even when the
burn-rate forecast is poor or the reserve target has been reached. It prefers
a steadier connected subscription when starting new work, and retains useful
cache through tool continuations. Pacing is advisory; actual exhaustion,
staleness and unconfirmed resets still stop requests.

- `/guard continuous`: keep working, with automatic efficiency protections.
- `/guard preserve`: stretch toward the preferred provider's return. Use at
  most 60k context, 8k tool characters, low effort, and request 2,048 output tokens.
  Tighter configured limits still apply. This overlay reverts on mode change.
- `/guard max`: use the preferred subscription's available allowance now.
  This does not enable maximum reasoning or increase configured work caps.
- `/guard strict`: opt into hard reserve and pace gates.
- `/guard-order`: set the subscription priority from a list (clickable in
  fullscreen Pi), or `/guard-order auto` for use-it-or-lose-it ordering (usable
  allowances first, soonest reset in front), or `/guard-order codex claude agy`.
  The footer shows the order left to right.
  A short typed request such as "use agy then codex then claude" or "codex
  first" is applied the same way, locally, without reaching a model.
- `/guard-block claude` keeps Guard off a subscription entirely; it pauses rather
  than route there. `/guard-block none` clears. Typing "dont touch claude" or
  "block codex" does the same locally.
- `/guard-rule translations -> argon` (or typing "all translations use argon",
  "website updates use argon", "code changes use opus") saves a task routing
  rule. A new task whose message mentions the phrase is routed to that
  subscription, and to the named model when Pi has it. Matching is a local
  substring test on your own text; nothing is sent anywhere. `/guard-rule list`
  and `/guard-rule remove <phrase>` manage rules. Allowance, blocks and work
  budgets still apply; a rule cannot route to a blocked or exhausted provider.
- `/guard-start` lists saved checkpoints (newest handoff per task, with its goal
  and why it paused) and opens a fresh session from the one you pick. A new
  session with a checkpoint under 48 hours old is told so at start, so work
  continues instead of restarting with no context. Repeated pauses for the
  same reason now keep the first handoff instead of writing one per retry.

## Several Pi windows

Every window talks to the same controller on port 9021, so there is one set of
allowance readings, one reserve, and one concurrency cap. Each window keeps
its own task budget (requests, minutes, context, repeated tools) and its own
footer. The footer shows `N windows/S slots` when more than one is open, and
the next step names it when windows outnumber slots. `/guard-windows 3`, or
typing "3 windows", lets three guarded requests run at once; the default is
one, which queues the others for up to 15 minutes per lease. More slots means
the same subscription burns faster, which the burn rate in the footer shows.
A window is counted while it has polled or requested within two minutes.
Launching `pi-guard` again reuses the running controller instead of starting
a second one.

## Auto-fix

Work budgets are pacing devices, not quotas. By default Guard fixes what it
can and keeps going: a tripped request, time or token budget renews itself
(the renewal is recorded, so the budget learns upward), a bridge that cannot
compact gets a warning instead of a dead end, and when more Pi windows are
open than concurrency slots the slots grow to match, up to eight. A handoff
is still saved at each of these points so you can go back. What still stops a
task: an allowance that is exhausted, stale or past an unconfirmed reset, a
provider you blocked, a repeated-tool loop after its one repair, and a
controller that is unreachable. Turn it off with `autoFix: false` under
Advanced if you want the old review-first pauses.

## Refusals that look like answers

Some bridges return a quota wall as an ordinary reply ("Individual quota
reached ... Resets in 154h30m7s") rather than an error, so Pi sees a finished
turn and nothing is retried. Guard reads every bridge reply: a short reply with
no tool calls that is only a quota, rate-limit or upgrade notice is treated as
a refusal. The request is settled as failed, the model's window is marked
exhausted until the reset the notice names (five hours when it names none), and
Guard re-sends your last instruction on the next eligible route, up to four
times in a row before it stops and saves a handoff. Direct API and OAuth
providers raise real errors, which Pi already handles, so they are not parsed.

An instruction with a provider in it also steers the task without a model
call: "switch to codex" alone reorders priority; "fix that, use codex" or
"switch to codex and finish everything" sets the task's route to Codex and then
sends the message as usual.

## Next model when one is exhausted

On by default (`fallbackModels`). When the selected model's allowance is
exhausted, stale or past an unconfirmed reset, Guard tries the other models
Pi has on the same subscription in discovery order (an empty Argon window
can leave Hydrogen or Flash with room), then the next subscription in your
priority order. The switch becomes the new binding, is announced in Pi, and
is recorded as a lesson. Blocked subscriptions are never tried. Set
`fallbackModels: false` to pause instead.

## Feedback loop

Guard records what it did and what you did next: pauses with their cause and
route, renewals, compactions, completed requests with tokens, loop blocks.
Two rules act on that record today, each one bounded step at a time, with the
reason and the evidence shown in `/guard-lessons` and undoable with
`/guard-lessons undo <id>`:

- A request-budget pause that you renew within 30 minutes, twice in a week,
  raises the starting budget one step (40, 60, 90, 135, 200, 300, 400). Time,
  token and loop rules are unchanged.
- A compaction that cannot lower the context on a CLI bridge (Antigravity keeps
  the conversation on its side) makes the ceiling advisory for that bridge:
  Guard warns and suggests `/guard-new` instead of pausing. Antigravity starts
  advisory; the rule covers other bridges as they appear.

Native-session insights (every Claude Code, Codex and AGY session on the
machine) no longer tighten Pi bounds on their own. A bound tightens only when
guarded Pi tasks show the same pattern, so one harness cannot tune another.

Route scores compare tokens per request and Guard interruptions per task for
each provider/model over seven days. They inform your routing rules; nothing
switches a model by itself.

## Next

Not built yet: scoring finished tasks on accepted output per token, flagging
an inefficient pattern while it happens (fan-out, re-reading, high effort on a
routine edit), and proposing the cheaper model or option for that task shape.

The planner defaults to Claude returning, then Codex, then other connected
subscriptions. Change the preference or bridge target under Advanced.
An unsupported routing connector cannot promise a Pi handoff. Allowances are
never added together, and a scheduled return needs fresh confirmation.

### Banked resets

Codex 0.167's native `account/rateLimits/read` response can include
`rateLimitResetCredits`: an available count and optional credit details.
Guard polls that with the weekly/short-window limits without calling a model.
Missing inventory stays unknown; a provider-reported zero overrides an older
manual report. Expired credits cannot extend the plan. IDs are discarded.
The API's reset type is provider-defined; a user-reported weekly scope is
labeled separately. Guard does not infer how much of each window a credit resets.

Redeem in Codex `/usage` when you choose. Guard has no consume action, and a
credit never appears as current allowance. It waits for a fresh lower usage
reading, restarts the trend after that decrease, and interactive Pi can resume
an allowance wait. Other work caps still apply. Claude and Antigravity readers
do not currently expose banked inventory; use the optional reported-reset form.
If reported and provider expiry dates differ, both remain visible and planning
uses the earlier date. Counts, forecasts and recommendations are not a promise
of uninterrupted work.

Protocol reference: [Codex app-server account methods](https://learn.chatgpt.com/docs/app-server).

## First run

Complete the [portable installation](#portable-installation) below, then run `integrations/pi/Start-Guard.ps1` from your terminal or a HerdR tab. The launcher creates an isolated Pi profile and leaves your existing Claude and Codex configuration in place.

1. After launching Guard, open <http://127.0.0.1:9021> for your local controller. To try the synthetic playground separately, run `npm.cmd run site:preview` from the repository and open <http://127.0.0.1:9023/guard.html>.
2. Wait for fresh readings from the automatic readers: Claude's account usage endpoint, Codex's native account API, and `agy --print /usage`. They use existing CLI logins and make no inference requests. Both account-wide and model-scoped windows are preserved. Missing readings remain unknown; manual entry is a fallback.
3. In Pi, run `/guard`. Authenticated subscription models are selected automatically when no preference exists, favoring a balanced family when available. Existing model choices are preserved. The website shows the active protection; model choices and Advanced settings are optional.
4. Keep `aispend/guard` selected in Pi. To add Codex, use Pi's `/login` and select the OpenAI subscription login, then run `/guard` to discover and select its model. Credentials stay in Pi's local auth store; Guard never receives them.
5. Run a small real task first. Review its counters in **Guarded tasks**. `/guard-hold` cancels automatic waiting; `/guard-resume` resumes a saved task after review. Renewing the task budget in the dashboard does not refill your subscription.

Your existing Claude CLI login is used by the official experimental `pi-claude-code` bridge. Claude Code still transports the requests, while Pi manages tools and history. The bridge uses the same subscription allowance. To keep a strict subscription cost ceiling, disable extra usage/overage in the provider account: the bridge can detect overage after a response, but cannot guarantee that the first such request was free.

AGY quota monitoring uses the native CLI. Its Gemini, Claude/GPT, and Argon scopes are tracked separately. Routing uses the optional [pi-antigravity-bridge](https://github.com/EstebanForge/pi-extensions) (MIT), which drives Google's own `agy acp` server on the login `agy` already holds and registers `antigravity/*` models (`gemini-4-argon`, `gemini-4-hydrogen`, `gemini-3-8-flash`, plus the Claude models Antigravity resells). The launcher loads it when it is installed in the runtime folder and defaults the engine to `acp`. Guard groups those models as the `agy` subscription; the Argon allowance window applies when the selected model name contains `argon`. Antigravity runs its own tool loop, so its edits land on disk without Pi's diff review, and the bridge reports tokens but no dollar cost. Driving `agy` from another agent is not covered by a published Google policy; the bridge author calls it a grey area. Radius is Pi's separate gateway service, not an import of existing subscription entitlements.

## Portable installation

Requires Node 22.19+ (tested on Node 24.13), Git, and a logged-in Claude CLI if using Claude.

```powershell
# Run from the aispend-live repository. Installation is local, not global.
npm.cmd install --prefix .guard-runtime --ignore-scripts @earendil-works/pi-coding-agent@1.5.0
git clone https://github.com/earendil-works/pi-claude-code .guard-runtime/pi-claude-code
git -C .guard-runtime/pi-claude-code checkout d5b5e04c314d3452d357174d16d10dda34daa2d2
# Optional: Antigravity routing through the official agy acp server (needs a logged-in agy CLI).
npm.cmd install --prefix .guard-runtime --ignore-scripts @estebanforge/pi-antigravity-bridge@1.10.6
powershell.exe -NoProfile -ExecutionPolicy Bypass -File integrations/pi/Start-Guard.ps1 -ProjectPath C:\your\project
```

The launcher pins Pi, starts the loopback controller if needed, and creates a separate profile in `.guard-data/pi-agent`. Cache warming and built-in automatic retries are disabled in that profile. Guard owns context checkpoints. The launcher loads only the official bridge and Guard extensions. On other platforms, use the same extension paths with `pi -e <bridge>/src/index.ts -e <repo>/integrations/pi/index.ts --model aispend/guard` and the equivalent isolated settings.

Resume a saved session with `-Resume`. Run the launcher with `-ListModels` to check available models without generating a response. Real model names come from the provider catalog, rather than a hardcoded marketing tier.

## Protected defaults and usage-based recommendations

New installations start in Keep working mode with a 10% reserve target, 120k context ceiling, 40 requests
and 60 minutes per task, one concurrent request, medium reasoning, no known
subagent calls, and API spending off. Sign in and use `aispend/guard`; you do
not need to tune every field first.

The local advisor recomputes rules from recent usage; it does not train an AI
or make extra model calls. With at least 20 recorded requests and analysis
less than six hours old, substantial large-context usage suggests an 80k
checkpoint. Subagent and effort signals can tighten their respective ceilings.
Long session spans include idle time and no longer shorten the hard time budget.
Recorded cache reuse is measured separately; retain useful prefixes. Only strict
mode uses pace to shorten work to 25 requests. Reasons are visible.

Automatic tuning only tightens these work bounds. It never buys API access,
raises dollar caps, relaxes a tighter user setting, or replaces a selected
model. New installations enable it by default. Running `/guard` enables automatic tuning and recovery on existing installations too.
Use `/guard status` for inspection without changing those settings. Turn it off for
recommendations-only operation; review and apply suggestions when convenient.

### Output limits and provider support

Guard passes the response ceiling in the actual provider options. Pi 1.5's
router resolves models from its catalog, so a modified model returned by the
router alone cannot enforce that limit. The Claude bridge forwards the option;
the installed Codex subscription transport does not serialize a maximum-output
field. For Codex this is a request preference, not an enforced output bound.
Context, effort, request and allowance checks still apply. Native clients have
the narrower coverage documented in the harness table.

API reservations use full catalog context and output capacity with headroom,
even when the requested output is shorter. A provider-side billing ceiling is
still needed for a strict monetary guarantee.

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
- Configurable subscription preference, selected models, request/token/time budgets, reasoning ceiling (medium by default), concurrent-request cap, and a repeated-result tripwire with one bounded repair. Known subagent tools are denied by default; arbitrary shell-launched agents are outside this tool-name guard.
- Live browser events for guarded requests, model-price cost estimates, and budget reservations. API fallback is disabled by default. To enable it, connect an API model in Pi, select it in Guard, and set both daily and task dollar caps. Daily accounting uses UTC. Unknown pricing blocks API routing. Pending requests reserve estimated dollars across controller restarts; missing cost telemetry keeps the reservation as an estimate.
- Local 24-hour insights for subagents, large contexts, recorded reasoning effort, and long sessions. Metrics use recorded tokens, not provider quota weights. Effort is shown as unknown where the logs omit it. The existing AI Spend dashboard shows Guard's live allowances and these insights.
- Long shell/search output is archived locally and shortened before the next request. Images remain intact.
- One context compaction at the configured ceiling, preserving the original task and unfinished work, followed by continuation. Compaction itself needs available allowance and counts as a request.
- In interactive Pi/RPC, allowance or concurrency pauses check readiness every 30 seconds without calling a model. Work resumes when fresh readings and task budgets permit. Timers never invent refreshed quota. Hard-budget pauses and exhausted repair attempts need explicit review. Closing Pi cancels waiting.

## Limits and data

This is a preview, not a provider-enforced billing cap. Only requests routed through `aispend/guard` are controlled. Other Claude/Codex/AGY sessions can consume the same allowance between readings. A request already in flight can exceed a token budget. Compaction's exact token total is not exposed by Pi's callback; its request counts, while its reported-token entry is zero. Concurrent leases expire after 15 minutes to recover from a crashed client. Terminal `-p` mode saves a context checkpoint, but automatic compaction/resumption requires a long-lived interactive or RPC session.

Pace forecasts extend the recent observed percentage-per-hour to the earlier of its own reset and the connected preferred provider's return. They are deliberately conservative, can overestimate bursty or intermittent work, and are not predicted invoices. A provider remains paused while an applicable window is exhausted, stale, or past reset without confirmation. Reserve and pace are hard gates only in strict mode. Supply fresh readings to correct old observations.

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
