# Improvement Opportunities — enabling Claude Code → GLM 5.2 handoff

Audience: maintainers of this MCP server.
Purpose: Today this repo wraps the `cursor-agent` CLI to offload work from Claude
Code to a cheaper model (the docs default it to `gpt-5`). The goal now is to make
this a clean, governed **handoff path to GLM 5.2** so Claude Code can delegate the
right tasks to GLM 5.2 "when appropriate" and keep its own context small.

This is a scan-and-list document — nothing here has been implemented yet. Items are
grouped by theme and tagged **P0/P1/P2** by how directly they block a reliable GLM 5.2
handoff.

---

## 0. The central question (verify before anything else) — P0

**Can `cursor-agent` actually target GLM 5.2?**

The entire server assumes the cheaper model is reachable through `cursor-agent -m <model>`
(`server.js:38` `invokeCursorAgent`, model injected at `server.js:58`). `cursor-agent` is
Cursor's CLI and only exposes the models Cursor's backend supports. If GLM 5.2 is **not**
in that list, no amount of `-m glm-5.2` will route to it and every other item below is moot.

Opportunities:
- **Preflight the model.** Add a startup / on-demand check (`cursor-agent --version` and a
  model-list probe via `cursor_agent_raw`) that fails loudly with an actionable message if
  GLM 5.2 is not reachable, instead of silently falling back to Cursor's default model.
- **Decide the transport.** If `cursor-agent` cannot reach GLM 5.2, either:
  - point `cursor-agent` at a GLM 5.2 endpoint (Z.ai / Zhipu OpenAI-/Anthropic-compatible
    API) via provider config + base URL + key, and document exactly how; **or**
  - generalize the wrapper into a backend-agnostic "delegate CLI" abstraction so GLM 5.2
    can be driven by a dedicated CLI/endpoint while keeping the same tool surface.
- **Document credentials.** Nothing in the repo mentions how GLM 5.2 auth is supplied. The
  server forwards `process.env` to the child (`server.js:82`), so document the required env
  (API key / base URL) and add it to the host-config example in the README.

Until this is answered, treat "GLM 5.2 handoff" as unproven.

---

## 1. Handoff policy — the "when appropriate" is undefined — P0

The request is to hand off "when appropriate," but there is no decision policy anywhere.
The instruction docs (`misc/claude-project-instructions.md`, `misc/claude-agent-instructions.md`)
only say "prefer MCP tools to save tokens" and hard-code `gpt-5` in every example.

Opportunities:
- **Add a routing/decision matrix** describing which task classes go to GLM 5.2 vs stay in
  Claude. e.g. delegate to GLM 5.2: bulk/first-pass code search, wide repo summaries,
  boilerplate edits, draft plans, mechanical refactors. Keep in Claude: nuanced/safety-
  critical reasoning, final review, ambiguous requirements, anything a wrong answer is
  expensive on.
- **Add a verification/escalation loop.** When GLM 5.2 handles something load-bearing,
  Claude should verify the result (and optionally escalate to a stronger model on low
  confidence). Today there is no tiered-routing or escalation concept — one call, one model.
- **Update all example models from `gpt-5` → `glm-5.2`** across `README.md` and the three
  `misc/*instructions*.md` files so the docs actually describe the intended handoff.
- **Encode a short handoff hint in the server `instructions` field** (`server.js:207`) so any
  MCP host discovers the policy, not just readers of the docs.

---

## 2. Correctness bugs that hurt handoff reliability — P0/P1

### 2a. Model/force flags are appended *after* the positional prompt — P0
`finalArgv` (`server.js:54`) is built as `[--print, --output-format, fmt, ...userArgs, -f, -m <model>]`,
and for the prompt tools `userArgs` ends with the prompt positional
(`runCursorAgent`, `server.js:168`). So the argv becomes `… "<the whole prompt>" -m glm-5.2`.
Model selection is the single most important thing for a handoff wrapper, and placing `-m`
after a free-text positional is fragile — some arg parsers stop flag parsing after the first
positional, which would silently drop the model override and run Cursor's default model.
**Fix:** emit `-m`/`-f` (and other flags) *before* the positional prompt.

### 2b. Idle-kill can return truncated output as success — P1
On the close handler, `code === 0 || (killedByIdle && out)` (`server.js:139`) resolves as a
successful result even when the process was SIGKILL'd mid-generation just because *some*
stdout had arrived. A handoff that gets killed halfway would hand Claude a partial answer
that looks complete. **Fix:** don't treat idle-killed runs as success, or clearly mark the
output as truncated.

### 2c. Idle timer only resets on stdout, not stderr — P2
`scheduleIdleKill()` is called only from the stdout handler (`server.js:98`); the stderr
handler (`server.js:101`) doesn't reset it. A model that emits progress/thinking on stderr
can be idle-killed while actively working. **Fix:** reset the idle timer on stderr activity too.

### 2d. `cleanup()` closes over `mainTimer` before it is declared — P2
`cleanup` (`server.js:68`) references `mainTimer`, which is `const`-declared later at
`server.js:121`. It works today only because the callbacks that call `cleanup` fire
asynchronously (after the `const` runs), but it's a temporal-dead-zone footgun. **Fix:**
declare the timer handles with `let` at the top of the promise body.

---

## 3. Timeouts & long-running work — P0

The default hard timeout is **30 s** (`server.js:119`) and it is **env-only**, not a per-call
argument. The whole point of a handoff is to give heavy, slow tasks to the cheaper model —
big repo analyses routinely exceed 30 s, so the default will SIGKILL exactly the work this
tool exists to offload. (The README already recommends 60000, which shows the default is
wrong.) Opportunities:
- Raise the default to something realistic for agentic runs (e.g. 120000).
- Add a per-call `timeout_ms` argument to the tool schemas so a big analyze/plan call can
  ask for more time without changing global env.
- Consider SIGTERM-then-SIGKILL (grace period) instead of an immediate SIGKILL
  (`server.js:122`) so the child can flush partial output.

---

## 4. Cost & context hygiene (the reason this MCP exists) — P1

The server's premise is reducing tokens/cost, but a few things work against it:
- **Unbounded output buffering.** `out += d.toString()` (`server.js:97`) has no cap. A runaway
  GLM 5.2 response streams straight back into Claude's context — the opposite of the cost
  goal. **Fix:** cap the buffer and truncate with a "[output truncated at N bytes]" note.
- **No token/size budget knob.** There's no `max_output_bytes` / top-N enforcement in code;
  it's only advisory in the prompt text. A hard cap makes cost predictable.
- **`json` output is passed through verbatim** with no summary path; combined with no cap,
  structured GLM output can be large. Pair the cap above with the "return JSON + short
  summary" pattern the docs recommend.

---

## 5. Model governance & safety — P1/P2

- **No model allowlist / validation** — P2. `model` is `z.string().optional()` (`server.js:20`,
  and in `COMMON` `server.js:227`). Any string is accepted. For governed handoff, validate
  against a known set (including `glm-5.2`) and return a clear error for unknowns rather than
  passing a typo'd model straight to the CLI.
- **`force` / `-f` auto-applies changes** — P1. `edit_file` accepts `apply` and the wrapper
  can inject `-f` (`server.js:57`), which tells `cursor-agent` to bypass confirmations. A
  cheaper delegate model writing to disk unsupervised is risky; default hard to dry-run and
  require an explicit opt-in for apply, and document the blast radius.
- **`executable` + `cwd` are fully client-controlled** — P2. `resolveExecutable` honors an
  explicit path (`server.js:25`) and `cwd` is arbitrary (`server.js:81`); combined with
  `cursor_agent_raw`'s free-form argv this is an arbitrary-process-exec surface. Expected for
  a CLI wrapper, but worth an allowlist / documented trust boundary.

---

## 6. Repo hygiene, docs, tests, CI — P1/P2

- **Stale/broken doc references** — P2. `README.md:146` reads `[…](mserver.js:286)` (typo +
  wrong path), and the code line numbers cited throughout the README and `misc/` docs are
  stale — e.g. "tool registrations start at server.js:273" but the first `server.tool` is at
  `server.js:276`, and the per-tool anchors (286/306/325/347/369/385) don't match the actual
  registrations (299/320/339/361/382/398). Docs also mix two folder names,
  `cursor-agent-mcp/` and `mcp-cursor-agent/`, for the same files (which actually live at the
  repo root), so the clickable links are broken.
- **No tests** — P1. `npm test` just runs `test_client.mjs`, which requires a real
  `cursor-agent` binary + provider credentials, so it can't run in CI. Add unit tests for the
  pure logic (argv construction, model/force injection, idle/timeout handling, `arguments`-vs-
  flat input normalization) by factoring `invokeCursorAgent`'s argv assembly into a testable
  function.
- **No CI workflow** — P2. Nothing lints or runs tests on push. Add a minimal GitHub Actions
  workflow (Node 18/20/22, `npm ci`, unit tests) — ironically `cursor_agent_plan_task`'s own
  example is "set up CI for this repo."
- **Missing `.gitignore`** — P2. No ignore file, so `node_modules/` can be committed by
  accident.
- **`package.json` gaps** — P2. No `engines` field despite "Node 18+" in the README; `license`
  is set to MIT but there's no `LICENSE` file; no `bin` entry (README notes `npx` isn't
  possible for this reason).

---

## 7. Observability for handoff decisions — P2

- **Debug logging is all-or-nothing to stderr** (`server.js:73`, `server.js:136`) and, as the
  README notes, many hosts don't surface server stderr. Add lightweight, structured run
  metadata to the *result* (model used, duration, exit code, bytes, truncated?) behind a flag,
  so Claude can see which model actually served a call and how much it cost — essential for
  tuning the "when appropriate" policy.
- **No record of the effective model.** Because of 2a, a call can silently run the wrong model;
  echoing the resolved model back in the result makes handoff mistakes visible.

---

## Suggested order of attack

1. **P0 – prove the path:** verify GLM 5.2 is reachable (§0), fix flag ordering (§2a), fix the
   30 s timeout default + per-call timeout (§3). Without these, handoff either doesn't run the
   right model or gets killed.
2. **P0 – define the policy:** add the routing/verification matrix and switch docs
   `gpt-5 → glm-5.2` (§1).
3. **P1 – make it safe & cheap:** output cap (§4), idle-kill truncation (§2b), apply/force
   safety (§5), tests (§6).
4. **P2 – polish:** stale docs, `.gitignore`, CI, `engines`/`LICENSE`, observability, idle-on-
   stderr, allowlist (§2c, §5, §6, §7).
