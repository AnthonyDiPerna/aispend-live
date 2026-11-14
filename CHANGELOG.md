# Release history

Dates below identify releases, not reconstructed commit dates. Existing Git
history is preserved. Annotated tags explain the older 0.4 and 0.5 changes.

## 0.6.4 — 2026-11-14

- Route Antigravity through the optional pi-antigravity-bridge, which uses the
  CLI's official `agy acp` server. The launcher loads the bridge when it is
  installed in the runtime folder and defaults its engine to acp.
- Group local CLI bridges (`claude-code`, `antigravity`, `antigravity-acp`) as
  subscription routes by provider id. Pi holds no OAuth token for a bridge, so
  the previous OAuth-only test filed their models under paid API and left them
  unroutable.
- Document Argon window matching, the bridge's tool-loop and cost limits, and
  the unpublished policy position on driving `agy` from another agent.

## 0.6.3 — 2026-11-09

- Default to Keep working: fresh positive allowance remains usable when a
  pace forecast or reserve target is exceeded. Actual exhaustion, stale
  readings and unconfirmed resets still block requests. Strict reserve/pace
  gates remain an explicit Advanced option.
- Add /guard continuous, /guard preserve and /guard max. Stretch mode lowers
  context, tool-output, response and effort ceilings as a reversible overlay.
  Use it now follows provider preference without enabling API spending,
  raising quality settings or renewing task budgets.
- Bridge toward a connected preferred subscription's scheduled return.
  Keep each quota independent; require a fresh reading after every reset.
- Read Codex banked reset inventory through account/rateLimits/read. Preserve
  unknown vs zero, status, expiry and count-only/capped detail responses.
  Strip opaque credit IDs and account fields. Manual reports cover missing
  inventory, while provider readings take precedence. Keep an earlier
  user-reported deadline visible. There is no credit-redemption endpoint.
- Restart burn-rate forecasts after a usage-counter decrease, including
  redemptions that retain the weekly reset timestamp. Never add a credit to
  the live allowance or infer a refill from the passage of time.
- Fix output ceilings discarded by Pi's router: pass them in the actual
  provider options. Document Codex subscription transport's unsupported
  maximum-output field. Reserve full catalog output for paid API estimates
  rather than assuming that a requested shorter response is enforced.
- Learn from native Codex cache reuse alongside context, effort and fan-out.
  Do not shorten hard time budgets based on wall-clock session spans that
  include idle time. Show why protections change; native hook coverage stays
  explicit and does not claim every-request protection in native Codex.
- Add policy/RPC/persistence/native mode regressions and four real-Pi offline
  mode cases. Update the public controls, setup and fixture walkthrough.

## 0.6.2 — 2026-11-09

- Make `/guard` activate protected Pi routing and automatic tuning/recovery.
  Subscription model picks update preferences while requests stay guarded;
  `/guard-unlock` explicitly permits direct model selection.
- Block a repeated tool before its third identical execution. Save a handoff
  and permit one different approach, subject to the same allowance, time,
  request, token and API caps. Persist repair counts; never renew budgets
  automatically. Fall through unavailable model bindings to a ready route.
- Add an evidence-based impact report and local JSON download. Measure net
  text removed, estimate avoided input once on a completed replay, show cached
  versus uncached API-price ranges, and separate subscription reference costs
  and repair/compaction overhead. Do not invent savings for blocked operations.
- Add project-local Claude/Codex/Antigravity hook adapters and a capability
  table. Native hooks enforce only documented boundaries; Codex model hooks
  are diagnostic, native dollar caps/routing are not claimed. Preserve other
  hooks and back up configuration. Native adapters have offline contract tests.
- Extend the real-Pi offline tests and walkthrough with activation, model
  selection protection, successful/exhausted repair, and savings evidence.

## 0.6.1 — 2026-11-09

- Make every public Guard model selector usable with labeled example choices.
  Selections stay in the tab and never connect accounts or authorize calls.
- Start new installations with a 10% reserve, 120k context ceiling, 40 requests
  and 60 minutes per task, one concurrent request, medium effort, and API off.
- Select available authenticated subscription models when no preference exists.
  Keep explicit selections and leave API fallback opt-in.
- Recompute explainable recommendations from local usage. With automatic tuning
  enabled, tighten context, task, concurrency and effort bounds when fresh,
  sufficient evidence warrants it. Never raise a spending cap automatically.
- Put settings under Advanced; show the active protection and its reasons first.
- Add Pi Guard 0.3.0 handoff commands: `/guard-handoff`, `/guard-new`, and
  `/guard-import path/to/handoff.md`. Saved sessions and source files are kept.
- Add a GIF replay of real Pi RPC output, recorded with offline fixture providers.
  The recording verifies switching, compaction, reserve pauses and handoff import.

## 0.6.0 — 2026-11-08

[Source and detailed commit](https://github.com/AnthonyDiPerna/aispend-live/commit/e2dc2949030d414b78df93a5cfdc3b8fe66e3f59) · tag `v0.6.0`

Introduce Pi Guard 0.2.0: local Claude, Codex and Antigravity allowance/reset
collectors; live work and estimated-cost accounting; and 24-hour protection
insights. Before guarded requests, check reserves, pacing, context, task budgets,
reasoning, known subagents and concurrency. Trim long tool output, pause loops,
compact context and wait for fresh readings. API fallback requires explicit caps.

Include a synthetic public planner and portable setup. Correct large-context
insights to include one-hour Claude cache writes. AGY monitoring is supported;
model routing requires a compatible authenticated Pi connector.

Validation: extracted dashboard/history/privacy/Guard tests, 10 offline Pi
scenarios, public export and HTTP startup, browser smoke and served-file hashes.

## 0.5.1 — 2026-11-08

[Preserved release snapshot](https://github.com/AnthonyDiPerna/aispend-live/commit/b24776fd275cf88b6a17c00f4f8f9e42b5a64b40) · tag `v0.5.1`

Explain measured allowance pressure through public insights and clearly labeled
five-hour/weekly examples. Recommend focused checks and compact handoffs near
limits. Reject stale forecasts and require a fresh reading after reset. Keep
corrected accounting and durable history export.

The snapshot was recorded later from the preserved original 0.5.1 archive. The
legacy website filename `ai-spend-live-0.5.1-source.zip` is a compatibility URL
for current source; use this Git tag for the historical 0.5.1 source.

## 0.5.0 — 2026-11-08

[Original commit](https://github.com/AnthonyDiPerna/aispend-live/commit/5afea383e234ea0e99121a54d881c9b8a8dbbbd8) · tag `v0.5.0`

Add a merging history export so usage aggregates survive transcript cleanup.
Correct Claude content-block double counting and Codex fork-replay duplication.
Keep missing prices unknown and expose source coverage rather than inventing
complete billing history.

## 0.4 series / 0.4.1 — 2026-11-07

[Original 0.4.1 commit](https://github.com/AnthonyDiPerna/aispend-live/commit/cd5941bb83d1e0ddb4b5497d2718c4f4a8ed2fc3) · tag `v0.4.1`

Add canonical per-model daily burn and reconciled fresh, cache, write and output
components. Distinguish unknown pricing from a known free rate. Expand model
coverage, aggregate public demos, usage insights and pacing guidance. The 0.4.1
tag identifies the completed 0.4-series source; no synthetic 0.4.0 commit is
presented as an original historical commit.
