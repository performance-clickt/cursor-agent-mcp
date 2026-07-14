// MCP wrapper server for cursor-agent CLI
// Exposes multiple tools (chat/edit/analyze/search/plan/raw + legacy run) for better discoverability.
// Start via MCP config (stdio). Requires Node 18+.

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { spawn } from 'node:child_process';
import process from 'node:process';
import { buildArgv, resolveEffectiveTimeout, resolveMaxOutputBytes, normalizeArgs, isModelAllowed } from './lib/argv.js';

// Grace period (ms) between the SIGTERM sent on timeout and the follow-up
// SIGKILL. Gives the child a moment to flush partial output before it is
// force-killed. (HM-559)
const TIMEOUT_KILL_GRACE_MS = 2000;

// Tool input schema
const RUN_SCHEMA = z.object({
  prompt: z.string().min(1, 'prompt is required'),
  output_format: z.enum(['text', 'json', 'markdown']).default('text'),
  extra_args: z.array(z.string()).optional(),
  cwd: z.string().optional(),
  // Optional override for the executable path if not on PATH
  executable: z.string().optional(),
  // Optional model and force for parity with other tools/env overrides
  model: z.string().optional(),
  force: z.boolean().optional(),
  // Per-call timeout override (ms). Precedence: this > CURSOR_AGENT_TIMEOUT_MS env > default (120000).
  timeout_ms: z.number().int().positive().optional(),
  // Per-call stdout byte cap. Precedence: this > CURSOR_AGENT_MAX_OUTPUT_BYTES env > default (1000000).
  max_output_bytes: z.number().int().positive().optional(),
});

// Resolve the executable path for cursor-agent
function resolveExecutable(explicit) {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.CURSOR_AGENT_PATH && process.env.CURSOR_AGENT_PATH.trim()) {
    return process.env.CURSOR_AGENT_PATH.trim();
  }
  // default assumes "cursor-agent" is on PATH
  return 'cursor-agent';
}

/**
* Internal executor that spawns cursor-agent with provided argv and common options.
* Adds --print and --output-format, handles env/model/force, timeouts and idle kill.
*/
async function invokeCursorAgent({ argv, output_format = 'text', cwd, executable, model, force, print = true, timeout_ms, max_output_bytes }) {
 const cmd = resolveExecutable(executable);

 // HM-567: opt-in model allowlist. Mirrors buildArgv's own model resolution
 // (per-call `model` wins, falling back to CURSOR_AGENT_MODEL) so the check
 // reflects whatever model would actually be passed to cursor-agent. Only
 // enforced when CURSOR_AGENT_MODEL_ALLOWLIST is set; unset/empty allows all
 // models (see isModelAllowed in lib/argv.js for the full rationale).
 const resolvedModel = (model && model.trim && model.trim()) || (process.env.CURSOR_AGENT_MODEL || '').trim();
 if (resolvedModel && !isModelAllowed(resolvedModel, process.env)) {
   return {
     content: [{ type: 'text', text: `Model "${resolvedModel}" is not in the allowlist (CURSOR_AGENT_MODEL_ALLOWLIST).` }],
     isError: true,
   };
 }

 // Compute the final argv (model/force from args/env, --print injection).
 // HM-558 will change the flag ordering; buildArgv preserves today's behavior.
 const finalArgv = buildArgv({ argv, output_format, model, force, print });

 return new Promise((resolve) => {
   let settled = false;
   let out = '';
   let err = '';
   let idleTimer = null;
   let killTimer = null;
   let mainTimer = null;
   let killedByIdle = false;
   let timedOut = false;
   let truncated = false;

   // Cap total stdout accumulation. Precedence: per-call max_output_bytes >
   // CURSOR_AGENT_MAX_OUTPUT_BYTES env > default (1,000,000). Stops a runaway
   // response from streaming unboundedly back into the host's context (HM-563).
   const maxOutputBytes = resolveMaxOutputBytes(max_output_bytes, process.env.CURSOR_AGENT_MAX_OUTPUT_BYTES);

   const cleanup = () => {
     if (mainTimer) clearTimeout(mainTimer);
     if (idleTimer) clearTimeout(idleTimer);
     if (killTimer) clearTimeout(killTimer);
   };

   if (process.env.DEBUG_CURSOR_MCP === '1') {
     try {
       console.error('[cursor-mcp] spawn:', cmd, ...finalArgv);
     } catch {}
   }

   const child = spawn(cmd, finalArgv, {
     shell: false, // safer across platforms; rely on PATH/PATHEXT
     cwd: cwd || process.cwd(),
     env: process.env,
   });
   try { child.stdin?.end(); } catch {}

   const idleMs = Number.parseInt(process.env.CURSOR_AGENT_IDLE_EXIT_MS || '0', 10);
   const scheduleIdleKill = () => {
     if (!Number.isFinite(idleMs) || idleMs <= 0) return;
     if (idleTimer) clearTimeout(idleTimer);
     idleTimer = setTimeout(() => {
       killedByIdle = true;
       try { child.kill('SIGKILL'); } catch {}
     }, idleMs);
   };

   child.stdout.on('data', (d) => {
     // Cap accumulation at maxOutputBytes: grow `out` up to the cap, then stop.
     // Once the cap is hit we slice `out` back to exactly the cap and flip
     // `truncated`, so later chunks are dropped instead of ballooning context.
     // (Length is measured in JS string units, a close-enough proxy for bytes.)
     if (!truncated) {
       out += d.toString();
       if (out.length >= maxOutputBytes) {
         out = out.slice(0, maxOutputBytes);
         truncated = true;
       }
     }
     scheduleIdleKill();
   });

   child.stderr.on('data', (d) => {
     err += d.toString();
     scheduleIdleKill();
   });

   child.on('error', (e) => {
     if (settled) return;
     settled = true;
     cleanup();
     if (process.env.DEBUG_CURSOR_MCP === '1') {
       try { console.error('[cursor-mcp] error:', e); } catch {}
     }
     const msg =
       `Failed to start "${cmd}": ${e?.message || e}\n` +
       `Args: ${JSON.stringify(finalArgv)}\n` +
       (process.env.CURSOR_AGENT_PATH ? `CURSOR_AGENT_PATH=${process.env.CURSOR_AGENT_PATH}\n` : '');
     resolve({ content: [{ type: 'text', text: msg }], isError: true });
   });

   // Precedence: per-call timeout_ms > CURSOR_AGENT_TIMEOUT_MS env > default.
   // resolveEffectiveTimeout always returns a finite number (default 120000).
   const timeoutMs = resolveEffectiveTimeout(timeout_ms, process.env.CURSOR_AGENT_TIMEOUT_MS);
   mainTimer = setTimeout(() => {
     // Graceful kill: SIGTERM first so the child can flush partial output,
     // then SIGKILL after a short grace if it hasn't exited on its own. We do
     // NOT settle here — the 'close' handler settles once the child exits (via
     // SIGTERM or the follow-up SIGKILL), returning any flushed partial output.
     timedOut = true;
     try { child.kill('SIGTERM'); } catch {}
     killTimer = setTimeout(() => {
       try { child.kill('SIGKILL'); } catch {}
     }, TIMEOUT_KILL_GRACE_MS);
   }, timeoutMs);

   child.on('close', (code) => {
     if (settled) return;
     settled = true;
     cleanup();
     if (process.env.DEBUG_CURSOR_MCP === '1') {
       try { console.error('[cursor-mcp] exit:', code, 'stdout bytes=', out.length, 'stderr bytes=', err.length); } catch {}
     }
     if (timedOut) {
       // The main timer fired: report the timeout, appending any partial
       // stdout the child managed to flush during the SIGTERM grace period.
       const text = `cursor-agent timed out after ${timeoutMs}ms` + (out ? `\n${out}` : '');
       resolve({ content: [{ type: 'text', text }], isError: true });
     } else if (killedByIdle) {
       // The idle-kill fired mid-generation: the output is partial, not a
       // completed run. Return any flushed stdout followed by a truncation
       // marker, and flag it as an error so callers don't treat it as success.
       const text = (out ? `${out}\n` : '') + '[truncated: idle timeout]';
       resolve({ content: [{ type: 'text', text }], isError: true });
     } else if (code === 0) {
       // Success: return the (possibly capped) stdout. When the cap was hit,
       // append a marker so the caller knows output was cut, not merely short.
       const text = truncated
         ? `${out}\n[output truncated at ${maxOutputBytes} bytes]`
         : (out || '(no output)');
       resolve({ content: [{ type: 'text', text }] });
     } else {
       resolve({
         content: [{ type: 'text', text: `cursor-agent exited with code ${code}\n${err || out || '(no output)'}` }],
         isError: true,
       });
     }
   });
 });
}

// Back-compat: single-shot run by prompt as positional argument.
// Accepts either a flat args object or an object with an "arguments" field (some hosts).
async function runCursorAgent(input) {
  const source = normalizeArgs(input);

  const {
    prompt,
    output_format = 'text',
    extra_args,
    cwd,
    executable,
    model,
    force,
    timeout_ms,
    max_output_bytes,
  } = source || {};

  const argv = [...(extra_args ?? []), String(prompt)];
  const usedPrompt = argv.length ? String(argv[argv.length - 1]) : '';
 
  // Optional prompt echo and debug diagnostics
  if (process.env.DEBUG_CURSOR_MCP === '1') {
    try {
      const preview = usedPrompt.slice(0, 400).replace(/\n/g, '\\n');
      console.error('[cursor-mcp] prompt:', preview);
      if (extra_args?.length) console.error('[cursor-mcp] extra_args:', JSON.stringify(extra_args));
      if (model) console.error('[cursor-mcp] model:', model);
      if (typeof force === 'boolean') console.error('[cursor-mcp] force:', String(force));
    } catch {}
  }
 
  const result = await invokeCursorAgent({ argv, output_format, cwd, executable, model, force, timeout_ms, max_output_bytes });
 
  // Echo prompt either when env is set or when caller provided echo_prompt: true (if host forwards unknown args it's fine)
  const echoEnabled = process.env.CURSOR_AGENT_ECHO_PROMPT === '1' || source?.echo_prompt === true;
  if (echoEnabled) {
    const text = `Prompt used:\n${usedPrompt}`;
    const content = Array.isArray(result?.content) ? result.content : [];
    return { ...result, content: [{ type: 'text', text }, ...content] };
  }
 
  return result;
}

/**
* Create MCP server and register a suite of cursor-agent tools.
* We expose multiple verbs for better discoverability in hosts (chat/edit/analyze/search/plan),
* plus the legacy cursor_agent_run for back-compat and a raw escape hatch.
*/
const server = new McpServer(
 {
   name: 'cursor-agent',
   version: '1.1.0',
   description: 'MCP wrapper for cursor-agent CLI (multi-tool: chat/edit/analyze/search/plan/raw)',
 },
 {
   instructions:
     [
       'Tools:',
       '- cursor_agent_chat: chat with a prompt; optional model/force/format.',
       '- cursor_agent_edit_file: prompt-based file edit wrapper; you provide file and instruction.',
       '- cursor_agent_analyze_files: prompt-based analysis of one or more paths.',
       '- cursor_agent_search_repo: prompt-based code search with include/exclude globs.',
       '- cursor_agent_plan_task: prompt-based planning given a goal and optional constraints.',
       '- cursor_agent_raw: pass raw argv directly to cursor-agent; set print=false to avoid implicit --print.',
       '- cursor_agent_run: legacy single-shot chat (prompt as positional).',
       'For when to hand off to GLM 5.2 vs. keep in Claude, and the verify/escalate loop, see the routing policy in misc/claude-project-instructions.md and misc/claude-agent-instructions.md.',
     ].join(' '),
 },
);

// Common shape used by multiple schemas
const COMMON = {
 output_format: z.enum(['text', 'json', 'markdown']).default('text'),
 extra_args: z.array(z.string()).optional(),
 cwd: z.string().optional(),
 executable: z.string().optional(),
 model: z.string().optional(),
 force: z.boolean().optional(),
 // Per-call timeout override (ms). Precedence: this > CURSOR_AGENT_TIMEOUT_MS env > default (120000).
 timeout_ms: z.number().int().positive().optional(),
 // Per-call stdout byte cap. Precedence: this > CURSOR_AGENT_MAX_OUTPUT_BYTES env > default (1000000).
 max_output_bytes: z.number().int().positive().optional(),
 // When true, the server will prepend the effective prompt to the tool output (useful for Claude debugging)
 echo_prompt: z.boolean().optional(),
};

// Schemas
const CHAT_SCHEMA = z.object({
 prompt: z.string().min(1, 'prompt is required'),
 ...COMMON,
});

const EDIT_FILE_SCHEMA = z.object({
 file: z.string().min(1, 'file is required'),
 instruction: z.string().min(1, 'instruction is required'),
 apply: z.boolean().optional(),
 dry_run: z.boolean().optional(),
 // optional free-form prompt to pass if the CLI supports one
 prompt: z.string().optional(),
 ...COMMON,
});

const ANALYZE_FILES_SCHEMA = z.object({
  paths: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]),
  prompt: z.string().optional(),
  ...COMMON,
});

const SEARCH_REPO_SCHEMA = z.object({
  query: z.string().min(1, 'query is required'),
  include: z.union([z.string(), z.array(z.string())]).optional(),
  exclude: z.union([z.string(), z.array(z.string())]).optional(),
  ...COMMON,
});

const PLAN_TASK_SCHEMA = z.object({
 goal: z.string().min(1, 'goal is required'),
 constraints: z.array(z.string()).optional(),
 ...COMMON,
});

const RAW_SCHEMA = z.object({
  // raw argv to pass after common flags; e.g., ["--help"] or ["subcmd","--flag"]
  argv: z.array(z.string()).min(1, 'argv must contain at least one element'),
  print: z.boolean().optional(),
  ...COMMON,
});

// Tools
server.tool(
  'cursor_agent_chat',
  'Chat with cursor-agent using a prompt and optional model/force/output_format.',
  CHAT_SCHEMA.shape,
  async (args) => {
    try {
      // Normalize prompt in case the host nests under "arguments"
      const prompt =
        (args && typeof args === 'object' && 'prompt' in args ? args.prompt : undefined) ??
        (args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments.prompt : undefined);

      const flat = {
        ...(args && typeof args === 'object' && args.arguments && typeof args.arguments === 'object' ? args.arguments : args),
        prompt,
      };

      return await runCursorAgent(flat);
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_edit_file',
  'Edit a file with an instruction. Prompt-based wrapper; no CLI subcommand required. ' +
    'Dry-run by default: proposes a patch/diff without writing to disk. Pass apply: true to ' +
    'allow the edit to be applied; the CURSOR_AGENT_FORCE env var alone can never auto-apply an edit (HM-565).',
  EDIT_FILE_SCHEMA.shape,
  async (args) => {
    try {
      const { file, instruction, apply, dry_run, prompt, output_format, cwd, executable, model, force, extra_args, timeout_ms, max_output_bytes } = args;
      // HM-565: apply is an explicit per-call opt-in. A cheaper delegate model
      // must not write to disk unsupervised, so only applyRequested === true may
      // apply the edit / inject -f. When not applying, force is hard-pinned to
      // false so CURSOR_AGENT_FORCE env cannot auto-apply (it would otherwise
      // win in buildArgv's `typeof force === 'boolean' ? force : envForce`).
      const applyRequested = apply === true;
      const effectiveForce = applyRequested ? (typeof force === 'boolean' ? force : true) : false;
      const composedPrompt =
        `Edit the repository file:\n` +
        `- File: ${String(file)}\n` +
        `- Instruction: ${String(instruction)}\n` +
        (applyRequested
          ? `- Apply changes if safe.\n`
          : `- Dry-run: propose a patch/diff only; do not write to disk.\n`) +
        (dry_run ? `- Treat as dry-run; do not write to disk.\n` : ``) +
        (prompt ? `- Additional context: ${String(prompt)}\n` : ``);
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force: effectiveForce, timeout_ms, max_output_bytes });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_analyze_files',
  'Analyze one or more paths; optional prompt. Prompt-based wrapper.',
  ANALYZE_FILES_SCHEMA.shape,
  async (args) => {
    try {
      const { paths, prompt, output_format, cwd, executable, model, force, extra_args, timeout_ms, max_output_bytes } = args;
      const list = Array.isArray(paths) ? paths : [paths];
      const composedPrompt =
        `Analyze the following paths in the repository:\n` +
        list.map((p) => `- ${String(p)}`).join('\n') + '\n' +
        (prompt ? `Additional prompt: ${String(prompt)}\n` : '');
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force, timeout_ms, max_output_bytes });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_search_repo',
  'Search repository code with include/exclude patterns. Prompt-based wrapper.',
  SEARCH_REPO_SCHEMA.shape,
  async (args) => {
    try {
      const { query, include, exclude, output_format, cwd, executable, model, force, extra_args, timeout_ms, max_output_bytes } = args;
      const inc = include == null ? [] : (Array.isArray(include) ? include : [include]);
      const exc = exclude == null ? [] : (Array.isArray(exclude) ? exclude : [exclude]);
      const composedPrompt =
        `Search the repository for occurrences relevant to:\n` +
        `- Query: ${String(query)}\n` +
        (inc.length ? `- Include globs:\n${inc.map((p)=>`  - ${String(p)}`).join('\n')}\n` : '') +
        (exc.length ? `- Exclude globs:\n${exc.map((p)=>`  - ${String(p)}`).join('\n')}\n` : '') +
        `Return concise findings with file paths and line references.`;
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force, timeout_ms, max_output_bytes });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

server.tool(
  'cursor_agent_plan_task',
  'Generate a plan for a goal with optional constraints. Prompt-based wrapper.',
  PLAN_TASK_SCHEMA.shape,
  async (args) => {
    try {
      const { goal, constraints, output_format, cwd, executable, model, force, extra_args, timeout_ms, max_output_bytes } = args;
      const cons = constraints ?? [];
      const composedPrompt =
        `Create a step-by-step plan to accomplish the following goal:\n` +
        `- Goal: ${String(goal)}\n` +
        (cons.length ? `- Constraints:\n${cons.map((c)=>`  - ${String(c)}`).join('\n')}\n` : '') +
        `Provide a numbered list of actions.`;
      return await runCursorAgent({ prompt: composedPrompt, output_format, extra_args, cwd, executable, model, force, timeout_ms, max_output_bytes });
    } catch (e) {
      return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
    }
  },
);

// Raw escape hatch for power-users and forward compatibility
server.tool(
 'cursor_agent_raw',
 'Advanced: provide raw argv array to pass after common flags (e.g., ["search","--query","foo"]).',
 RAW_SCHEMA.shape,
 async (args) => {
   try {
     const { argv, output_format, cwd, executable, model, force, timeout_ms, max_output_bytes } = args;
     // For raw calls we disable implicit --print to allow commands like "--help"
     return await invokeCursorAgent({ argv, output_format, cwd, executable, model, force, print: false, timeout_ms, max_output_bytes });
   } catch (e) {
     return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
   }
 },
);

// Legacy single-shot prompt tool retained for compatibility
server.tool(
 'cursor_agent_run',
 'Run cursor-agent with a prompt and desired output format (legacy single-shot).',
 RUN_SCHEMA.shape,
 async (args) => {
   try {
     return await runCursorAgent(args);
   } catch (e) {
     return { content: [{ type: 'text', text: `Invalid params: ${e?.message || e}` }], isError: true };
   }
 },
);

// Connect using stdio transport
const transport = new StdioServerTransport();

server.connect(transport).catch((e) => {
 console.error('MCP server failed to start:', e);
 process.exit(1);
});