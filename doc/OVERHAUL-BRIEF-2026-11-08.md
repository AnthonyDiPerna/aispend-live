# AI Spend Live overhaul brief

You are working in `C:\devland\aispend-live` (plain Node, no dependencies, MIT). Version 0.5.0 is in the working tree, uncommitted: `tools/export-history.js` (the merging ledger export), `tools/export-history-test.js`, parser fixes in `tools/ai-spend-dashboard-server.js`, and README updates. Read the README, the server, the export script, and both test files before changing anything. `npm test` must pass before and after every step.

The goal is to turn a live dashboard into a usage system that can answer "where did my year go, and what did it buy" with the same honesty as the three November 8 posts on anthonydiperna.com (Where a hundred billion tokens went; What the tokens bought; A ledger that outlives the logs). Everything below comes from building those posts by hand. The product should make that work unnecessary next year.

## Non-negotiables

1. Local only. No network calls, no telemetry, nothing leaves the machine. The public landing page shows an aggregate example exported on purpose.
2. Privacy by construction. No prompt text, titles, nicknames, raw session ids, environment values, or paths beyond the scan roots ever appear in the ledger, the dashboard payload, or the demo export. Session ids are hashed. Codex working-directory names that read like prompts become generated labels. The existing tests assert this; extend them.
3. Coverage before charts. Every chart and every total carries a coverage caption: first and last record per source, days with no record, and which source quality each bar came from. A chart that silently omits March is a bug.
4. Nulls, not zeros. A model without a configured price is unpriced, never free. A thread total without a breakdown is a lump, never fresh input. Unknown model ids stay in the totals and the catalog.
5. Ratios over totals. Totals were wrong by half for six months and the ratios still led to the right decisions. Lead with shares, per-turn and per-prompt costs, and trends; show totals with their error bars (source quality).
6. The weekly limit is the real price. API-equivalent dollars are a reference, not a bill. Pacing against the user's plan window stays first-class.
7. Plain Node, no dependencies, Node 22 or later. SQLite through `node:sqlite`. Streaming parsers only; a 53 GB Codex rollout set must finish in minutes with memory in the low gigabytes.
8. Commit messages carry no AI attribution of any kind: no Co-Authored-By trailers, no "generated with" lines, no model names, no session links. The author and committer are the configured git user. Commit only when asked.

## Parser rules that must survive (each has a fixture test; add more, remove none)

- Claude Code writes one `assistant` record per content block and repeats the message usage on each. Collapse by `message.id` with field-wise max; later records carry the final `output_tokens`. On a 2.3 GB sample this removed 26,445 duplicates and took the total from 16.4B to 7.7B.
- `cache_creation_input_tokens` already equals the sum of `usage.cache_creation.ephemeral_*`. Never add both.
- Codex forked and spawned threads replay the parent's event stream, including `token_count` events, with fresh timestamps milliseconds apart. Key cumulative snapshots to the root `session_id` and a cumulative-total signature; process rollouts chronologically; skip echoes. This removed 93,205 replayed events and 14.0B phantom tokens.
- The first `session_meta` in a rollout owns the file. Replayed parent metadata must not overwrite the child's identity, or children collapse into parents and get recovered again from SQLite as lumps.
- Repeated `token_count` snapshots with identical cumulative totals are skipped.
- Codex model comes from the latest `turn_context`, never from `token_count`. Reasoning effort lives at `turn_context.payload.effort` or `collaboration_mode.settings.reasoning_effort`. Sub-thread flags live at `session_meta.payload.source.subagent` (`thread_spawn`, `other:"guardian"`), with `parent_thread_id` and `forked_from_id`.
- Claude's `stats-cache.json` counts raw records, about 2.11 times deduplicated usage on days where both exist. Keep its totals in their own block, divide by a measured ratio when estimating, and never merge them into ledger rows.
- Codex `state_5.sqlite` thread totals are dated by last update and have no breakdown. They are the only Codex source for anything older than the retained rollouts; show them as a distinct quality tier.

## Data layer

The ledger is the primary store; the live logs are an input to it.

- Ledger rows: day × provider × model × project, with fresh input, cache read, cache write, output, reasoning output, total, breakdown-unknown, turns, sessions touched, subagent tokens and turns, effort buckets or null, estimated USD or null, priced and unpriced tokens. Keep the existing `days`, `sessions`, `largestTurns`, `coverage`, `sourcesScanned`, `runs`, and `claudeStatsCache*` blocks.
- Merge rule stays max-per-field by key; re-running on the same logs is byte-identical; pruned days survive; a bigger scan wins. Previous ledger kept as `.bak`; atomic writes.
- Add a `quality` field per row: `exact` (transcript with breakdown), `lump` (SQLite thread total), `estimate` (stats-file derived). Every aggregate reports the quality mix it was built from.
- Default ledger location is a user-chosen path persisted in a small local config file (`AI_SPEND_LEDGER` env var or `--ledger`). The dashboard reads the ledger first and overlays the live logs for the current day so history and present are one timeline.
- Add `npm run history:schedule` that prints the exact Windows Task Scheduler and cron commands to run the export weekly against the configured ledger. Do not register the task silently.
- Add prompt-count ingestion from both history files (`~/.claude/history.jsonl` and `$CODEX_HOME/history.jsonl`): per day × provider × project, counts and distinct session ids only. The prompt text is read to be discarded; it never reaches memory structures that are written out. Store under `prompts` in the ledger with its own coverage entry. These files are the only complete year-long record either tool keeps.

## Features, in priority order, each with its acceptance test

### 1. History view

Stacked bars of tokens per month and per ISO week, by model, by provider, and by project, with the three quality tiers visually distinct (solid, hatched, outlined) and missing-day ranges drawn as gaps, not zeros. Click a bar to see its rows. Window presets: 30, 90, 365 days, all. Acceptance: with the current machine's ledger the view shows Codex exact from July 10, lumps from March 9, Claude exact from October 15, and labels Claude February to August as "no daily record".

### 2. Concentration

Per window: subagent share of tokens (sidechains for Claude, spawned and reviewer threads for Codex), the ten largest turns with their fresh/cache/write/output split, the ten longest and ten largest sessions, and the top session's share of the window. Add two alerts: a session whose last ten turns each exceed a configurable cache-read threshold (default 500,000 tokens) is flagged "context gravity: restart and move durable context to a file"; a fork or spawn whose first turn's cache write exceeds the parent's current context size is flagged "fork carried the whole parent". Acceptance: the November 7 subagent turns of about 965,000 tokens appear as the largest turns, and the 87 percent Claude subagent share since mid October is reproduced.

### 3. Model mix and effort

Shares by model family and by generation in arrival order; Codex reasoning-effort buckets as a stacked bar; a "models you did not choose" row for automatic reviewers and other system-initiated usage; a "price tier" split that classifies models as frontier, mid, cheap from the pricing table and shows the cheap-tier share over time. Acceptance: GPT-5.6 Sol at 43 percent, Luna-class at about 28 percent, auto-review at about 10 percent, xhigh at about half of Codex tokens on the current ledger.

### 4. Output side: the Git join

New `tools/git-metrics.js` and a dashboard panel. Configuration lists repositories and the author identity. Read-only Git: log, rev-list, numstat, for-each-ref, tag. Never stash, checkout, reset, add, commit, pull, fetch, push, or clean; other agents share these trees.

Compute per repo per day: commits, files changed, raw insertions and deletions, filtered insertions and deletions, active day flag. Filtering drops node_modules, bin, dist, build, _site, .jekyll-cache, vendor, Export, exports, minified files, lock files, .pck, .wasm, .map, and binary rows. Flag mass commits at 20,000 filtered lines or more and report every aggregate both with and without them. Deduplicate commits by author timestamp across all refs, excluding refs/backup, refs/original, and stashes, because rewritten history keeps pre-rewrite chains. Record milestones: `config/version=` changes in project.godot, `"version"` changes in package.json, tags.

Derived metrics, each shown with its definition:
- Lines per prompt: filtered lines added excluding mass commits in a period, divided by prompts to both tools in that period.
- Tokens per line and tokens per surviving line: period tokens divided by filtered lines, and divided by lines times one minus churn.
- Two-week churn: per ISO week and file, the lesser of lines added that week and lines deleted from the same file in the following fourteen days, summed over files, divided by lines added. State that numstat is per file so this approximates same-file rework.
- Active days, longest streak, commits per active day.
- Shipped versions: count of version-stamp commits and tags in the period, listed with dates.
- Prompts per commit and tokens per commit, labeled as weak because commit granularity is arbitrary.

Acceptance against the current machine: 3,496 commits across 21 repositories, 164 active days, 59 mass commits carrying 71 percent of raw insertions, 2,159,224 filtered insertions excluding them, 8.8 percent churn on the game repository, lines per prompt 84 for February to April and 202 for August to October.

### 5. Pacing

Keep the five-hour and weekly envelopes and plan presets. Add "limit events": when the observed burn in a window reaches the plan estimate, record the timestamp in the ledger so the history view can mark the days the limit was hit. Show time-to-limit at the current rate next to the current session's per-turn cost.

### 6. Reports

`npm run report -- --ledger <path> --from YYYY-MM-DD --to YYYY-MM-DD --out <file.md>` writes a Markdown report with the standard tables used in the posts: coverage, tokens per month by provider and quality, per-model totals with cache share and USD or unpriced, concentration (subagent share, largest turns, longest sessions), prompts per month, and, when Git is configured, the output table and the derived ratios. Also emit the charts as 1200 by 675 SVGs in the editorial style below, so a post can embed them unchanged.

### 7. Landing site (aispend.live)

The site is static: `index.html`, `demo-data.json`, versioned source zips. Regenerate the demo from the ledger rather than from a raw scan, so it always reflects the corrected parsers. Add a history section (one year of tokens by month with quality tiers and gaps), a concentration section (subagent share, biggest turn, longest session), and, if a Git configuration is present at export time, an output section (lines per prompt, churn, shipped versions). Keep the privacy statement; extend the demo test to assert the new sections contain only aggregates. Bump `demo-data.json` to schema v2 with a `coverage` block identical in shape to the ledger's. Download buttons: current version primary, previous version secondary; the source zip must keep the `tools/` folder so `npm run dashboard` works from an unzip. Every release updates: `package.json` version, the README release paragraph, the demo data, the landing page version strings and the fetch cache-buster, and the zip.

## Chart style for exports

1200 by 675 SVG. Paper `#FCFAF5`, panel `#F5F1E8`, ink `#203330`, muted `#65736A`, grid `#C7CCBF`, teal `#22766B`, copper `#AC5736`, slate `#6E8CA0`, gold `#C9A227`. Georgia for the title at 44px, Arial for everything else at 17 to 21px. Title, one-line subtitle stating the window and the source, legend under the axis, a one-line footnote stating exclusions. Values labeled on bars when they exceed about one percent of the axis. Never draw a missing period as zero.

## Validation

- Fixture tests for every parser rule above, including a Claude multi-block message, a doubled cache write, a Codex fork replay, a replayed session_meta, and a repeated snapshot.
- Idempotence test: export twice, ledger identical. Pruned-day test: remove a day's logs, export, row survives.
- Sanity check command: compare a window's deduplicated Claude total with `stats-cache.json` for the same days and print the ratio; warn if it drifts far from about 2.1.
- Performance check: full Codex scan under five minutes and under 1.5 GB resident on the current 53 GB set; print throughput.
- Dashboard smoke: `--summary --days 1` and a headless page load with the demo data; no console errors, no horizontal scroll at 390 pixels.
- The Git tool must refuse to run any write command even if asked; test that.

## Non-goals

Cloud usage, chat-app usage, billing reconciliation, automatic model switching, installing skills or hooks, and anything that uploads data. Do not add a framework, a bundler, or a dependency.

## Working rules

Plan the ledger `quality` field and the prompt ingestion first, since every view depends on them. Keep each change small enough to test in isolation. Do not touch the blog repository or any game repository. Report what was verified and what was not; do not claim a view works until it has rendered the current machine's ledger.

## 8. Guard mode (after features 1 to 5 exist)

Guard turns pacing from a chart into enforcement, within what the tools actually allow. It never pretends to control what it cannot.

Goals, set in the local config and shown on the dashboard and status line:
- Do not run out before the reset: weekly and five-hour envelopes from the plan preset and the user's reset timestamps, projected from observed burn. Thresholds at 60, 80, 95 percent.
- Reserve: hold a percentage of the window for a named purpose (weekend, a project, a deadline).
- Caps: per-project share, subagent share, cache reads per turn (default 500,000), fork or spawn whose first turn carries the parent's full context, parallel session count.
- Output goal, when the Git join exists: tokens per surviving line or cost per shipped version, trending down month over month.

Enforcement points, in order of reliability:
1. Session launch. `npm run launch -- --tool claude|codex --task <class>` chooses model and reasoning effort from the task class, the remaining budget, and what the last ten similar tasks cost in the ledger, then prints or runs the exact command (`claude --model`, `codex -m` with `model_reasoning_effort`). Task classes: plan, review, bounded-edit, exploration, capture, docs. This is the only place auto-selection is honest.
2. Subagent spawn in Claude Code. A `PreToolUse` hook on the Agent tool reads the budget state and either rewrites the requested model to the cheaper tier, or denies the spawn with a reason, when a cap is hit. A `UserPromptSubmit` hook injects one line of budget state and the current recommendation into each prompt.
3. Status line: remaining budget, time to limit at the current rate, current session's per-turn cache cost.
4. Mid-session main model: cannot be switched by a tool. Guard shows the recommendation to `/model` or restart, and records whether it was followed.
5. Codex: launcher plus profiles only. Do not claim per-turn control for Codex.

Install nothing silently. `npm run guard:install` prints the hook and status-line JSON for the user to paste into their settings, with an explanation of each line, and `guard:uninstall` prints the reverse. Hooks must fail open: if the ledger or config is missing, allow the action and log once.

Complexity routing uses only observable proxies: number of files named in the brief, whether a test command is named, the task class tag, and the ledger's cost of the last similar tasks. Say in the UI that these are proxies.

Acceptance: with a weekly budget set to the current week's burn so far, the launcher recommends the cheap tier for a bounded-edit task and the frontier tier for a plan task; the spawn hook denies a fourth parallel subagent when the cap is three; removing the ledger file makes every hook allow and log exactly once.
