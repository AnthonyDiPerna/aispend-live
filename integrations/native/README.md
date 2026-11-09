# Native Guard hooks

Guard can enforce useful boundaries in Claude Code, Codex and Antigravity,
including when HerdR launches them. Pi remains the integration with full request
routing, output trimming, automatic compaction and API budget reservations.

Start `npm run guard`, then install into the project you want protected:

```powershell
node tools/guard-hooks.js install claude --project C:\your\project
node tools/guard-hooks.js install codex --project C:\your\project
node tools/guard-hooks.js install agy --project C:\your\project
```

Each command merges only its Guard hooks and backs up an existing file. It does
not change global settings or logins. Restart that harness, open `/hooks`, and
enable/review/trust the installed hooks. Codex explicitly requires trust before
non-managed hooks execute. To inspect configuration without writing a file,
use `node tools/guard-hooks.js config codex` (or `claude`, `agy`).

The controller's **Protection in each harness** section shows the latest adapter
event. A recent event proves contact; it does not prove every hook remains enabled.
These adapters have offline contract and HTTP tests. Pi additionally has real
runtime end-to-end tests. Validate hooks in your installed native version before
depending on them for unattended work.

| Harness | Enforced boundary | Automatic correction | Limits |
| --- | --- | --- | --- |
| Pi / Guard | Every request routed through `aispend/guard` | Ready subscription selection; effort/output caps; archive oversized results; compact; one loop repair; saved handoff | Other models and outside sessions bypass the controller |
| Claude Code | User prompt, tool call, post-tool batch | Block repeated results/agent fan-out; one alternative approach; pause at reserve or task limit | Request count approximates prompt/batch boundaries; internal retries/compaction are not gated; no automatic routing or trimming |
| Codex | User prompt and tool call | Block repeated results/agent fan-out; one alternative approach; pause at supported boundaries | Model-request hooks only observe. They cannot block individual inference; no automatic compaction or effort override |
| Antigravity | Before invocation and before tool | Request/time/reserve checks; one repeated-failure repair; block fan-out | Successful output is unavailable to hooks, so loop detection uses errors only; no token/cost totals, automatic routing or trimming |

Native adapters retain the native model and billing settings. They do not enforce
API dollar caps or infer whether a CLI login bills a subscription versus API.
Use Pi Guard for that control. Missing/stale quota readings block supported
boundaries. Hook timeout/disabled-hook behavior still belongs to the native client.

Automatic repair denies the repeated tool with one concise instruction to change
approach. It never starts another agent, opens a new session, increases a spending
cap or resets counters. Further repeats pause at the supported boundary. Native
clients can continue model-only work between those boundaries; Codex hook denials
are feedback, not a guarantee that inference stops immediately.

The adapters send hashed session/operation/result IDs, model names and recorded
token counters to the loopback controller. They do not send prompts, tool text,
credentials, transcript paths or workspace paths. Native interventions appear in
the same impact report; blocked calls do not receive invented token/dollar values.
The optional JSON report downloads locally from the dashboard.

For a custom harness, implement `/api/preflight` before every model call and
`/api/complete` afterward, enforce returned caps, and gate tools locally. Send
deduplicated `/api/intervention` records with measured net removed characters.
`/api/recovery` permits one changed approach after a repeated-tool tripwire; the
next request must still pass preflight. No adapter may treat a repair grant as a
request lease or renew a task automatically. See the Pi adapter and HTTP tests.

Contracts checked November 9, 2026:
[Claude hooks](https://code.claude.com/docs/en/hooks),
[Codex hooks](https://learn.chatgpt.com/docs/hooks),
[Antigravity hooks](https://antigravity.google/docs/hooks?tab=cli).
