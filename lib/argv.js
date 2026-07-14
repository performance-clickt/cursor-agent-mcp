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

/**
 * Resolve the effective timeout (ms) from a raw env value.
 *
 * Reproduces invokeCursorAgent()'s timeout resolution: parse the env value (or
 * the default when the env value is empty/undefined) as a base-10 integer, and
 * fall back to the default when the result is not a finite number (NaN).
 *
 * @param {string|undefined} envValue   raw CURSOR_AGENT_TIMEOUT_MS value
 * @param {number} [defaultTimeout]     default when unset/invalid (30000)
 * @returns {number} a finite timeout in milliseconds
 */
export function resolveTimeout(envValue, defaultTimeout = 30000) {
  const parsed = Number.parseInt(envValue || String(defaultTimeout), 10);
  return Number.isFinite(parsed) ? parsed : defaultTimeout;
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
