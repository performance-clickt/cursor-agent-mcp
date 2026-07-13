# CLAUDE.md — build governance for cursor-agent-mcp

This file governs how coding agents (Claude Code and any delegate) work in this
repo. Read it before making changes. It is the source of truth for **what we're
building, how work is tracked in Linear, and the discipline every change follows.**

---

## 1. What this repo is

An MCP server (`server.js`) that wraps the `cursor-agent` CLI and exposes focused
tools (chat / edit / analyze / search / plan / raw / run) so an MCP host can offload
heavy, repo-aware work to a cheaper model and keep its own context small.

**Current build goal:** turn this into a governed **Claude Code → GLM 5.2 handoff**
path — Claude Code delegates the right tasks to GLM 5.2 "when appropriate," verifies
what comes back, and stays cheap. The docs today hard-code `gpt-5`; that is being
migrated to `glm-5.2`.

The full scan and rationale behind the current work live in
[`misc/glm-handoff-opportunities.md`](misc/glm-handoff-opportunities.md).

---

## 2. Repository map

| Path | What it is |
|------|-----------|
| `server.js` | The whole server. `invokeCursorAgent()` (executor: spawn, flags, timeout, idle-kill) → `runCursorAgent()` (legacy prompt runner) → `server.tool(...)` registrations. |
| `test_client.mjs` | Stdio smoke client; drives one tool over MCP. Requires a real `cursor-agent` binary + credentials, so it is **not** a CI-safe unit test. |
| `package.json` | ESM (`"type": "module"`), Node 18+. Deps: `@modelcontextprotocol/sdk`, `zod`. |
| `README.md` | User-facing docs and host config examples. |
| `misc/` | Governance/instruction docs + the handoff-opportunities scan. |

Key entry points in `server.js`: executor `invokeCursorAgent()` (~L38), argv
assembly (~L54), timeout (~L119), tool registrations start (~L276). Line numbers
drift — confirm with a grep before citing them (see HM-568).

---

## 3. Commands

```bash
npm ci                 # install (lockfile committed)
npm start              # node ./server.js  (stdio MCP server)
npm test               # runs test_client.mjs — needs cursor-agent on PATH + creds
node ./test_client.mjs "hello"                 # smoke one tool
TEST_TOOL=cursor_agent_raw TEST_ARGV='["--version"]' node ./test_client.mjs
```

Relevant env: `CURSOR_AGENT_PATH`, `CURSOR_AGENT_MODEL`, `CURSOR_AGENT_FORCE`,
`CURSOR_AGENT_TIMEOUT_MS`, `CURSOR_AGENT_IDLE_EXIT_MS`, `CURSOR_AGENT_ECHO_PROMPT`,
`DEBUG_CURSOR_MCP`. See `README.md` for meanings.

---

## 4. Linear discipline (source of truth for work)

All work is tracked in the Linear project **Cursor MCP** (team **Hive Mind**):
https://linear.app/clickt/project/cursor-mcp-f6d508e22579

Do **not** freelance work that isn't captured as an issue, and do **not** rewrite
existing issues without being asked. The backlog is HM-557 – HM-570.

**Per-issue loop:**
1. **Pick up** an issue (respect the build order in §5). Move it `Backlog → Todo →
   In Progress`.
2. **Branch** off the working branch using Linear's suggested name where practical
   (e.g. `john/hm-558-...`). Current working branch:
   `claude/glm-handoff-opportunities-na6f56`.
3. **Implement** the smallest change that satisfies the issue. Match surrounding
   style.
4. **Verify** behavior (see §6) — not just "it compiles."
5. **Reference the issue** in the commit subject/body (e.g. `HM-558: put -m/-f
   before the prompt positional`). Linear auto-links commits/PRs that name the ID.
6. **Move to Done** only after verification. If you opened a PR, let review close it.

**When you discover new work** mid-task, do not silently expand scope: file a new
issue in the Cursor MCP project (or note it) and link it — don't fold unrelated
fixes into an unrelated issue.

---

## 5. Build order (P0 → P2)

Do the P0s first — until they're done, the handoff either runs the wrong model or
gets killed, and everything downstream is unprovable.

1. **P0 — prove the path:** HM-557 (GLM 5.2 reachability + preflight),
   HM-558 (flag ordering), HM-559 (timeout default + per-call `timeout_ms`).
2. **P0 — define the policy:** HM-560 (routing + verify/escalate),
   HM-561 (docs `gpt-5 → glm-5.2`).
3. **P1 — safe & cheap:** HM-562 (idle-kill truncation), HM-563 (output cap),
   HM-564 (unit tests), HM-565 (apply/force dry-run default).
4. **P2 — polish:** HM-566, HM-567, HM-568, HM-569, HM-570.

`misc/glm-handoff-opportunities.md` maps each issue to its section (§0–§7).

---

## 6. Reflexion discipline (verify + record before "Done")

Every non-trivial change closes the loop:

- **Verify against real behavior.** For server changes, exercise the affected tool
  end-to-end via `test_client.mjs` (or a raw `cursor-agent` call) and observe the
  actual argv/output — don't rely on reading the diff. Argv-construction changes
  (HM-558) especially must be observed, since a wrong-model bug is silent.
- **Record what you learned on the issue.** Add a short Linear comment: what
  changed, how you verified it, and anything surprising or newly discovered. This
  is the reflexion step — the next agent picks up your findings, not just your code.
- **Surface follow-ups as issues,** not as scope creep in the current one.
- **Definition of done:** issue's stated "Do" is satisfied, behavior verified,
  issue commented + moved to Done, change committed referencing the ID.

---

## 7. Conventions & guardrails

- **ES modules, Node 18+.** No CommonJS, no TypeScript build step.
- **Validate all tool input with `zod`.** New tool args get a schema; reject
  unknown/malformed input.
- **Spawn safety:** keep `shell: false` and never interpolate untrusted strings
  into a shell. Don't pass shell metacharacters via `extra_args`.
- **Cost is a feature.** This server exists to shrink context. Keep outputs small,
  prefer scoped prompts, cap/truncate large output (HM-563). Don't stream whole
  files back.
- **Edits default to dry-run.** Treat `apply`/`-f` (auto-apply) as opt-in; a
  delegate model must not write to disk unsupervised (HM-565).
- **No secrets in logs.** `DEBUG_*` output must not echo credentials.
- **Model handoff is the point:** when routing to GLM 5.2, make the resolved model
  observable (HM-570) so a mis-route is visible, not silent.
- **Keep docs honest.** If you move code, fix the line/path references you
  invalidate (HM-568).
- **Never commit a model identifier or internal session IDs** into code, comments,
  README, or commit bodies beyond the standard co-author/session trailer.

---

## 8. Reference

- Handoff scan & priorities: [`misc/glm-handoff-opportunities.md`](misc/glm-handoff-opportunities.md)
- Host policy: [`misc/claude-project-instructions.md`](misc/claude-project-instructions.md)
- Delegate policy: [`misc/cursor-agent-instructions.md`](misc/cursor-agent-instructions.md)
- User docs: [`README.md`](README.md)
- Linear project: https://linear.app/clickt/project/cursor-mcp-f6d508e22579
