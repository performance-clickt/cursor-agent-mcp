# CLAUDE.md — Cursor MCP

Guidance for executing this project. It is planned in Linear; this file keeps every session on-rails.

- **Project:** Cursor MCP
- **Domain:** software
- **Tools & channels:** Node.js 18+ (ESM), `@modelcontextprotocol/sdk`, `zod`; the `cursor-agent` CLI; stdio MCP transport.
- **Repo / default branch:** https://github.com/performance-clickt/cursor-agent-mcp / `main`
- **Linear team / project:** Hive Mind (HM) / Cursor MCP — https://linear.app/clickt/project/cursor-mcp-f6d508e22579
- **Milestones (integration checkpoints):** M1 Prove the path · M2 Define the policy · M3 Safe & cheap · M4 Polish
- **Lessons Log:** the Linear document named "Lessons Log" on the Cursor MCP project

## Session start

Before pulling an issue:

1. Read the project's **Lessons Log** document in Linear and apply any relevant entries.
2. Pull the next issue from the project and read it in full — it contains everything needed to execute that task.

## Linear is the source of truth

Every unit of work is a Linear issue, and each issue is written to be executed as a standalone prompt.

- **Execute only what the issue specifies.** If the issue is missing context or contains an unresolved decision, stop and flag it rather than improvising — a well-formed issue shouldn't need outside context.
- **Update issue status** as you move: claim it (In Progress) when you start — this claim happens *before* any git action and is the lock that stops two agents taking one issue — and Done only when acceptance criteria are proven, reflect has run (see below), and the PR is merged (see Git workflow).
- **Never work off-Linear.** If new work surfaces mid-project, create an issue for it in the Cursor MCP project rather than silently expanding scope.
- **Assume parallel agents.** Other agents may be executing other issues at the same time. Coordinate only through Linear: an In-Progress issue is owned — never start it. Pick only unclaimed, unblocked issues (a `blockedBy` issue must be merged first).

## Linear sync at issue boundaries

Exactly two comments per issue:

- **On starting**: post the todo plan as a comment — checkable items for what you're about to do. This is the human's chance to catch a bad plan early.
- **On completing**: post one wrap-up comment: what changed, verification evidence (the affected tool exercised end-to-end — see Plan mode + verification gates), deviations from the plan, the reflect verdict, and the PR link and its check status. Then update the issue status.
- **No per-item progress comments.** No comment per checkbox, no mid-flight updates unless the plan's items materially change. The oversight value is in plan and outcome, not noise. (Status transitions and Lessons Log appends are separate normal actions, not counted against this cap.)
- If a Linear write fails, don't block the work: note the failure and fold the missed update into the completion comment or the next session.

Track the plan locally as checkable items (`tasks/todo.md` or your todo tool) while you work; the Linear comments are the record.

## Lessons Log

The project's Linear document "Lessons Log" is the single canonical store of lessons. There is no local lessons file.

- **After any correction from the user** (or a review pass that surfaces a repeatable mistake): append one line to the document **immediately**, before resuming work — format: `pattern → rule that prevents it (issue ID)`. Keep entries terse; the log is read at every session start.
- If the append fails, record the lesson in the issue's completion comment and append it at the next session start.

## Reflexion at the end of every issue

Before marking any issue done, run:

```
/reflexion:reflect
```

- **Let the skill triage, never pre-triage.** Do not decide "this issue is trivial, skipping reflect" — invoke it and let its own complexity triage route trivial changes to its quick path. Skipping the invocation because the work "obviously passes" is the exact rationalization this rule exists to block.
- **Record the verdict** in the completion comment: path taken, confidence, any issues found and fixed. Recording a verdict presupposes reflect actually ran — never write one from your own judgment.
- An issue is not done until reflect passes and acceptance criteria are proven.

## Milestone integration check

At each milestone boundary — M1 → M2 → M3 → M4 — before starting the next milestone's issues:

1. Run the milestone verification — the full test suite (once HM-564 lands unit tests) plus a smoke pass of the affected tools via `test_client.mjs` / a raw `cursor-agent` call — across the whole milestone, not just the last issue.
2. **Re-read every issue in the milestone** and verify its acceptance criteria still hold in the assembled state — don't trust "done" status alone.
3. **Read the Lessons Log and the milestone's completion comments** for unresolved flags or deferred concerns. Resolve mechanical items yourself; for judgment calls, file a follow-up issue rather than deciding unilaterally or silently dropping them. If a completion comment is missing its verification evidence (or its reflect verdict), flag that in the summary — don't backfill it.
4. **Post a milestone summary comment** on the project recording verification results and how each flag was handled.

This is integration verification: per-issue checks cover each piece of work while it's still in context; this checkpoint catches cross-issue interaction problems no single session could see. Note M1 lands before the test suite exists (HM-564 is in M3), so M1's check leans on `test_client.mjs` smoke runs and observed argv/output.

## Git workflow

Repo: **https://github.com/performance-clickt/cursor-agent-mcp** · default branch: **`main`**. Every issue is delivered on its own branch and PR. **Assume other agents are working other issues in parallel** — these rules exist to keep parallel work from colliding. Per issue, in order:

1. **Claim before touching git.** Move the issue to In Progress and self-assign in Linear *first*. An issue already In Progress is owned by another agent — never start it. This claim is the lock that prevents two agents on one issue.
2. **Isolate in a worktree.** From an up-to-date `main`, create a git **worktree** on a new branch named with the issue's Linear `gitBranchName` (Linear generates one per issue — e.g. `john/hm-558-...`; using it exactly is what auto-links the branch, PR, and status). One issue = one branch = one worktree = one agent. Never work on `main`, never inside another agent's worktree. (See the `git-worktrees` skill for the commands.)
3. **Commit small.** Focused commits, each message referencing the issue key (e.g. `HM-558: …`) so Linear links them.
4. **Open a PR** from the issue branch to `main`, with the issue key in the title and body. Rebase on the latest `main` first; resolve any conflict on your own branch — never force-push `main`.
5. **Verify.** The PR must be green — the affected tool exercised end-to-end with actual argv/output observed (and, once HM-564 lands, tests passing) — and reflect must have passed. Prove it before asking for merge.
6. **Stop for merge approval — never self-merge.** Post the wrap-up comment with the PR link and evidence, then ask the user to approve the merge. Merging to `main` is outward-facing and hard to reverse: it is a hard gate, every time. Only after explicit approval: merge the PR, delete the branch, remove the worktree, and mark the issue done.

Parallel-safety rules:

- **Claim in Linear before any git action** (step 1) — the anti-collision lock.
- **Never start an issue whose `blockedBy` isn't merged** — its output doesn't exist yet.
- **Small PRs, merged promptly** — long-lived branches diverge and conflict; keep each issue's change tight.
- **Rebase, don't force.** Bring `main` into your branch; never rewrite shared history.

**Linear ↔ GitHub linkage:** using the exact `gitBranchName` and the issue key in the PR lets Linear's GitHub integration move issue status automatically. If that integration is **not** enabled in the Linear workspace, update issue status through the Linear MCP manually at each step — do not assume it happened.

## Plan mode + verification gates

- **Plan first.** For any non-trivial task (3+ steps or a structural decision), enter plan mode before starting execution. If something goes sideways mid-execution, stop and re-plan — don't keep pushing.
- **Verification before done.** Never mark an issue complete without proving it works: exercise the affected tool end-to-end via `test_client.mjs` (or a raw `cursor-agent` call) and observe the actual argv/output — don't rely on reading the diff. Argv-construction changes (HM-558) especially must be observed, since a wrong-model bug is silent. Ask: "would a senior engineer approve this?"
- **Autonomous fixing.** Given a failing check or a flagged defect (failing test, dropped model flag, truncated output returned as success), fix it — point at the evidence and resolve it rather than asking for hand-holding.

## Core principles

- **Simplicity first.** Make every change as simple as possible — the smallest change that works.
- **No laziness.** Find root causes; no band-aid fixes. Senior-engineer standards.
- **Minimal impact.** Touch only what's necessary. Don't introduce defects.

---

## Repository map

| Path | What it is |
|------|-----------|
| `server.js` | The whole server. `invokeCursorAgent()` (executor: spawn, flags, timeout, idle-kill) → `runCursorAgent()` (legacy prompt runner) → `server.tool(...)` registrations. |
| `test_client.mjs` | Stdio smoke client; drives one tool over MCP. Requires a real `cursor-agent` binary + credentials, so it is **not** a CI-safe unit test (see HM-564). |
| `package.json` | ESM (`"type": "module"`), Node 18+. Deps: `@modelcontextprotocol/sdk`, `zod`. |
| `README.md` | User-facing docs and host config examples. |
| `docs/` | `PROJECT.md` (project home) + `glm-handoff-opportunities.md` (the brief / handoff scan). |
| `misc/` | Host + delegate instruction docs. |
| `tasks/todo.md` | Per-issue local scratchpad (reset each issue). |

Key entry points in `server.js`: executor `invokeCursorAgent()` (~L38), argv assembly (~L54), timeout (~L119), tool registrations start (~L276). Line numbers drift — confirm with a grep before citing them (see HM-568).

## Commands

```bash
npm ci                 # install (lockfile committed)
npm start              # node ./server.js  (stdio MCP server)
npm test               # runs test_client.mjs — needs cursor-agent on PATH + creds
node ./test_client.mjs "hello"                 # smoke one tool
TEST_TOOL=cursor_agent_raw TEST_ARGV='["--version"]' node ./test_client.mjs
```

Relevant env: `CURSOR_AGENT_PATH`, `CURSOR_AGENT_MODEL`, `CURSOR_AGENT_FORCE`, `CURSOR_AGENT_TIMEOUT_MS`, `CURSOR_AGENT_IDLE_EXIT_MS`, `CURSOR_AGENT_ECHO_PROMPT`, `DEBUG_CURSOR_MCP`. See `README.md` for meanings.

## Conventions & guardrails

- **ES modules, Node 18+.** No CommonJS, no TypeScript build step.
- **Validate all tool input with `zod`.** New tool args get a schema; reject unknown/malformed input.
- **Spawn safety:** keep `shell: false` and never interpolate untrusted strings into a shell. Don't pass shell metacharacters via `extra_args`.
- **Cost is a feature.** This server exists to shrink context. Keep outputs small, prefer scoped prompts, cap/truncate large output (HM-563). Don't stream whole files back.
- **Edits default to dry-run.** Treat `apply`/`-f` (auto-apply) as opt-in; a delegate model must not write to disk unsupervised (HM-565).
- **No secrets in logs.** `DEBUG_*` output must not echo credentials.
- **Model handoff is the point:** when routing to GLM 5.2, make the resolved model observable (HM-570) so a mis-route is visible, not silent.
- **Keep docs honest.** If you move code, fix the line/path references you invalidate (HM-568).
