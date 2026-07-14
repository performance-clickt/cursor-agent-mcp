# Cursor MCP

**Brief:** [glm-handoff-opportunities.md](./glm-handoff-opportunities.md) <!-- sibling file, this doc lives in docs/ -->
**Linear project:** https://linear.app/clickt/project/cursor-mcp-f6d508e22579
**Team:** Hive Mind (HM)
**Lessons Log:** the Linear document named "Lessons Log" on this project
**Domain:** software
**Client-facing identity:** Internal (Clickt) — not client-facing
**Tools & channels:** Node.js 18+ (ESM), `@modelcontextprotocol/sdk`, `zod`; the `cursor-agent` CLI; stdio MCP transport. Repo: [performance-clickt/cursor-agent-mcp](https://github.com/performance-clickt/cursor-agent-mcp) (default branch `main`).

## Summary

An MCP server (`server.js`) that wraps the `cursor-agent` CLI and exposes focused tools (chat / edit / analyze / search / plan / raw / run) so an MCP host can offload heavy, repo-aware work to a cheaper model and keep its own context small. This project turns it into a **clean, governed Claude Code → GLM 5.2 handoff path** — delegating the right tasks to GLM 5.2 "when appropriate," verifying what comes back, and staying cheap. The docs today hard-code `gpt-5`; that is being migrated to `glm-5.2`.

## Milestones

- **M1 · Prove the path (P0)** — GLM 5.2 reachability + preflight, flag-ordering fix, timeout default + per-call `timeout_ms`. (HM-557, HM-558, HM-559)
- **M2 · Define the policy (P0)** — routing/verify/escalate matrix, docs `gpt-5 → glm-5.2`. (HM-560, HM-561)
- **M3 · Safe & cheap (P1)** — idle-kill truncation, output cap/budget, unit tests, apply/force dry-run default. (HM-562, HM-563, HM-564, HM-565)
- **M4 · Polish (P2)** — robustness cleanup, model allowlist, stale-doc fixes, repo hygiene (`.gitignore`/CI/`engines`/`LICENSE`), run-metadata observability. (HM-566, HM-567, HM-568, HM-569, HM-570)

## Key decisions

See the brief's priority ordering (§0–§7 → P0/P1/P2). Decisions made after planning live in the affected Linear issues, not here.

**Open decision — HM-557 (M1):** if `cursor-agent` cannot reach GLM 5.2, the transport must be chosen — (a) point `cursor-agent` at a GLM 5.2 endpoint (Z.ai/Zhipu) via provider config, or (b) generalize the wrapper into a backend-agnostic delegate. This gates HM-557's acceptance criteria; resolve before starting M1.

## How work happens here

All work is tracked in Linear; every issue is written to be executed as a standalone prompt. Session rules live in the root [CLAUDE.md](../CLAUDE.md). This document is orientation only — no status, no task lists (they would drift from Linear, and Linear wins).
