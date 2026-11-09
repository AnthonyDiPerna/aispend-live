# Pi, HerdR, and fixed subscription budgets

Pi is useful here as a programmable place to enforce workflow rules. It does not grant a larger Claude or Codex subscription. The product is **AI Spend Guard**: a local allowance planner and policy controller, a Pi extension that acts on its decisions, and a public playground explaining those decisions. HerdR continues to organize the sessions.

## What the article and comments establish

[Caleb's article](https://caleb.software/posts/claude-to-pi.html) makes the case for a smaller, customizable harness and less product churn. The [Hacker News discussion](https://news.ycombinator.com/item?id=50410107) includes useful reports about customization, cache behavior, and subscription integration, but it is not a controlled savings benchmark. Neither establishes a reliable percentage by which moving to Pi extends a weekly allowance.

The [current official Claude bridge](https://github.com/earendil-works/pi-claude-code) sends requests through `claude -p`. Pi owns history and tool execution; the Claude subscription still owns its allowance. Anthropic currently says the previously announced SDK/noninteractive billing changes are paused, but this integration is experimental and can change. [Provider policy](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan).

[Codex allowances](https://developers.openai.com/codex/pricing/) are not a public fixed token balance for each dollar tier. Model choice, context, reasoning, caching, and provider accounting all matter. API-equivalent dollars in AI Spend are analytical comparisons, not money the subscription actually charged.

## What the local evidence suggests

The local seven-day analysis ending November 8, 2026 at 16:21 UTC covered 34,269 recorded requests and 698 sessions. It is an observed sample, not complete account billing telemetry.

| Measure | Claude | Codex |
| --- | ---: | ---: |
| Recorded raw tokens, including cache | 5.94B | 2.23B |
| Recorded requests | 17,360 | 16,909 |
| Median tokens per request | 300,521 | 128,613 |
| Tokens attributed to subagents | about 92% | about 68% |
| Hypothetical reduction from removing 3,000 input tokens per request | 0.88% of raw volume | 2.28% of raw volume |

Claude cache reads account for 5.85B of the 5.94B recorded tokens. Removing useful cache and forcing new context can make a workflow worse. The hypothetical 3,000-token calculation is an illustration, not a measured Pi saving or a prediction of allowance savings.

The strongest opportunities are fewer unnecessary parallel workers, smaller task scopes, bounded tool output, stopping repeated searches/tests, and deliberate context checkpoints. These need to preserve task quality and cache reuse. A thin harness alone is unlikely to be the largest improvement in this sample.

## Implemented experiment

The controller records provider quota observations separately from token counts. It evaluates each known allowance window against its own reset and freshness, retains a configurable reserve, and suggests a daily percentage budget. The Pi virtual model checks this before every request. It can switch to another eligible subscription, checkpoint context, or pause. When all available subscriptions are constrained, it preserves the session; it never silently buys API usage.

The public website and playground use the black canvas, restrained typography, fine grid/borders, and console presentation of [Text.js](https://textjs.org/) as visual direction. Existing aggregate usage features remain available. The playground uses synthetic quota data and the same deterministic policy implementation as the controller.

## What to measure next

Use a small set of comparable real tasks on the current workflow and on Guard. Record provider percentage used before/after, reset window, model, reasoning setting, success/acceptance checks, requests, tool-output trimming, context size, and pauses. Compare allowance consumed per successfully completed task. Repeat over several days to include cache expiry and different tasks. Do not compare raw tokens alone or call stopped work a productivity gain.

A fixed $20 or $200 plan cannot support unlimited demand. The useful promise is a controlled work schedule: spend deliberately, retain capacity for urgent tasks, use another supported subscription when available, and wait transparently when it is not. Fully unattended cross-provider work still requires reliable quota telemetry, authenticated supported connectors, and normal tool approvals.

The implementation now reads Claude allowances with the local CLI login, Codex through `account/rateLimits/read`, and AGY through its documented `--print /usage` command. These are read-only checks without model inference. Polls run about every five minutes; local request events stream immediately to the browser. A usage-reader connection is separate from an authenticated Pi model. AGY monitoring works, but this Pi installation still needs a compatible AGY subscription connector to route tasks there.

The controller enforces request, token, time, reasoning, known-subagent, and concurrency limits. API fallback requires opt-in and both dollar caps. Costs remain estimates and unknown prices block paid routing. The dashboard distinguishes subscription reference prices from plan allowances and preserves model-scoped limits alongside account-wide limits. The native Claude snapshot (100% all-model weekly use and 41% Fable use) must block all Claude work until an account-wide reset is confirmed.

Local 24-hour insights run separately from request gating: subagent token share, requests above 150k context, recorded effort with coverage, and sessions spanning eight hours. These overlap and use a different denominator from native provider usage attribution. Missing effort metadata stays unknown; user-supplied native snapshots retain their own timestamp and source.
