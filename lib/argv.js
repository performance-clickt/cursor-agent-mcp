// Pure, dependency-free helpers for the cursor-agent MCP server.
//
// This module intentionally imports NOTHING with side effects (no
// @modelcontextprotocol/sdk, no spawn, no server bootstrap) so it can be
// unit-tested with `node --test` without a cursor-agent binary, network,
// credentials, or installed npm dependencies.
//
// The functions here reproduce the runtime behavior of server.js exactly.

/**
 * Build the final argv passed to the spawned cursor-agent process.
 *
 * Reproduces the logic previously inlined in invokeCursorAgent():
 *  - optionally injects `--print --output-format <fmt>` (when print is true),
 *  - inserts `-f` from per-call `force` OR the CURSOR_AGENT_FORCE env, unless a
 *    force flag is already present or force is not effective,
 *  - inserts `-m <model>` from per-call `model` OR the CURSOR_AGENT_MODEL env,
 *    unless a model flag is already present or no model is effective,
 *  - passes user/extra args (the positional prompt lives here) through last,
 *    untouched.
 *
 * @param {object} opts
 * @param {string[]} [opts.argv]            user/extra args (positional prompt lives here)
 * @param {string}   [opts.output_format]   output format for --output-format
 * @param {string}   [opts.model]           per-call model override
 * @param {boolean}  [opts.force]           per-call force override
 * @param {boolean}  [opts.print]           whether to inject --print/--output-format
 * @param {object}   [env]                  environment (defaults to process.env)
 * @returns {string[]} the final argv
 */
export function buildArgv(
  { argv, output_format = 'text', model, force, print = true } = {},
  env = process.env,
) {
  const userArgs = [...(argv ?? [])];

  const hasModelFlag = userArgs.some(
    (a) => a === '-m' || a === '--model' || /^(?:-m=|--model=)/.test(String(a)),
  );
  const envModel = env.CURSOR_AGENT_MODEL && env.CURSOR_AGENT_MODEL.trim();
  const effectiveModel = model?.trim?.() || envModel;

  const hasForceFlag = userArgs.some((a) => a === '-f' || a === '--force');
  const envForce = (() => {
    const v = (env.CURSOR_AGENT_FORCE || '').toLowerCase();
    return v === '1' || v === 'true' || v === 'yes' || v === 'on';
  })();
  const effectiveForce = typeof force === 'boolean' ? force : envForce;

  // HM-558: emit the force/model flags BEFORE userArgs. userArgs ends with the
  // free-text positional prompt, and some CLI parsers stop reading flags after
  // the first positional, silently dropping a trailing -m/-f (and the model
  // override with it). Keeping the flags up front avoids that.
  return [
    ...(print ? ['--print', '--output-format', output_format] : []),
    ...(hasForceFlag || !effectiveForce ? [] : ['-f']),
    ...(hasModelFlag || !effectiveModel ? [] : ['-m', effectiveModel]),
    ...userArgs,
  ];
}

// Default executor timeout (ms) used when neither a per-call value nor the
// CURSOR_AGENT_TIMEOUT_MS env var is set. Raised from 30s to 120s (HM-559)
// because a scoped cursor-agent run routinely takes longer than 30s.
export const DEFAULT_TIMEOUT_MS = 120000;

/**
 * Resolve the effective timeout (ms) from a raw env value.
 *
 * Reproduces invokeCursorAgent()'s env-based timeout resolution: parse the env
 * value (or the default when the env value is empty/undefined) as a base-10
 * integer, and fall back to the default when the result is not a finite number
 * (NaN).
 *
 * @param {string|undefined} envValue   raw CURSOR_AGENT_TIMEOUT_MS value
 * @param {number} [defaultTimeout]     default when unset/invalid (120000)
 * @returns {number} a finite timeout in milliseconds
 */
export function resolveTimeout(envValue, defaultTimeout = DEFAULT_TIMEOUT_MS) {
  const parsed = Number.parseInt(envValue || String(defaultTimeout), 10);
  return Number.isFinite(parsed) ? parsed : defaultTimeout;
}

/**
 * Resolve the effective timeout (ms) applying the full precedence chain:
 *   per-call `timeout_ms` > CURSOR_AGENT_TIMEOUT_MS env > default (120000).
 *
 * The per-call override wins only when it is a finite, positive number (the
 * shape zod already guarantees for `timeout_ms`); anything else (undefined,
 * NaN, <= 0) falls through to the env-then-default resolution.
 *
 * @param {number|undefined} perCall      per-call timeout_ms override
 * @param {string|undefined} envValue     raw CURSOR_AGENT_TIMEOUT_MS value
 * @param {number} [defaultTimeout]       default when unset/invalid (120000)
 * @returns {number} a finite timeout in milliseconds
 */
export function resolveEffectiveTimeout(perCall, envValue, defaultTimeout = DEFAULT_TIMEOUT_MS) {
  if (typeof perCall === 'number' && Number.isFinite(perCall) && perCall > 0) {
    return perCall;
  }
  return resolveTimeout(envValue, defaultTimeout);
}

// Default cap (bytes) on the stdout streamed back from a single cursor-agent
// run, used when neither a per-call value nor the CURSOR_AGENT_MAX_OUTPUT_BYTES
// env var is set. 1,000,000 bytes (~1 MB) is generous for a scoped prompt while
// still stopping a runaway response from flooding the host's context (HM-563).
export const DEFAULT_MAX_OUTPUT_BYTES = 1000000;

/**
 * Resolve the effective stdout byte budget applying the full precedence chain:
 *   per-call `max_output_bytes` > CURSOR_AGENT_MAX_OUTPUT_BYTES env > default.
 *
 * Mirrors resolveEffectiveTimeout: the per-call override wins only when it is a
 * finite, positive number (the shape zod already guarantees for
 * `max_output_bytes`); anything else (undefined, NaN, <= 0) falls through to the
 * env value, and a missing/invalid/non-positive env value falls through to the
 * default. A byte cap of <= 0 is meaningless (it would truncate everything), so
 * unlike resolveTimeout the env value is also required to be positive.
 *
 * @param {number|undefined} perCall     per-call max_output_bytes override
 * @param {string|undefined} envValue    raw CURSOR_AGENT_MAX_OUTPUT_BYTES value
 * @param {number} [defaultBytes]        default when unset/invalid (1000000)
 * @returns {number} a finite, positive byte budget
 */
export function resolveMaxOutputBytes(perCall, envValue, defaultBytes = DEFAULT_MAX_OUTPUT_BYTES) {
  if (typeof perCall === 'number' && Number.isFinite(perCall) && perCall > 0) {
    return perCall;
  }
  const parsed = Number.parseInt(envValue, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultBytes;
}

/**
 * Normalize tool input that may arrive either flat or nested under an
 * `arguments` key (some MCP hosts wrap params). Reproduces the exact
 * normalization used by runCursorAgent(): unwrap to `input.arguments` only when
 * `input` is an object, `input.arguments` is truthy, and no top-level `prompt`
 * is present; otherwise return `input` unchanged.
 *
 * @param {*} input
 * @returns {*} the normalized source object (or the original input)
 */
export function normalizeArgs(input) {
  return input && typeof input === 'object' && input.arguments && typeof input.prompt === 'undefined'
    ? input.arguments
    : input;
}

/**
 * Parse CURSOR_AGENT_MODEL_ALLOWLIST into a list of allowed model names.
 *
 * Comma-separated; each entry is trimmed and empty entries are dropped. An
 * unset or empty env value yields an empty list, which callers treat as
 * "no allowlist configured" (HM-567).
 *
 * @param {object} [env] environment (defaults to process.env)
 * @returns {string[]} the parsed, trimmed, non-empty allowlist entries
 */
export function parseAllowlist(env = process.env) {
  const raw = (env.CURSOR_AGENT_MODEL_ALLOWLIST || '').trim();
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * Determine whether a resolved model is allowed to run.
 *
 * HM-567: the allowlist is opt-in via CURSOR_AGENT_MODEL_ALLOWLIST. When that
 * env var is unset or empty, every model is allowed (backward-compatible) —
 * we don't yet know the full set of models `cursor-agent` exposes (HM-557 is
 * blocked), so we must not hardcode a rejecting default. When the env var IS
 * set, `model` must match one of the comma-separated entries exactly (after
 * trimming both sides).
 *
 * @param {string} model  the resolved model name to check
 * @param {object} [env]  environment (defaults to process.env)
 * @returns {boolean} true if the model is allowed (or no allowlist is configured)
 */
export function isModelAllowed(model, env = process.env) {
  const allowlist = parseAllowlist(env);
  if (allowlist.length === 0) return true;
  return allowlist.includes(String(model).trim());
}
