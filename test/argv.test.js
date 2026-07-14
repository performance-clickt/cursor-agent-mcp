// Unit tests for lib/argv.js — the pure, dependency-free helpers.
//
// These import ONLY the pure module (never server.js), so they run with no
// cursor-agent binary, no network, no credentials, and no installed npm deps.
// Run with: node --test test/
//
// NOTE: argv ordering emits the -f/-m flags BEFORE the positional prompt (HM-558)
// so a trailing prompt cannot cause a parser to drop the model/force override.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildArgv,
  resolveTimeout,
  resolveEffectiveTimeout,
  resolveMaxOutputBytes,
  DEFAULT_MAX_OUTPUT_BYTES,
  normalizeArgs,
  isModelAllowed,
} from '../lib/argv.js';

// --- buildArgv: --print / --output-format injection + passthrough ----------

test('buildArgv injects --print and --output-format then user args', () => {
  assert.deepEqual(
    buildArgv({ argv: ['hello'], output_format: 'json' }, {}),
    ['--print', '--output-format', 'json', 'hello'],
  );
});

test('buildArgv defaults output_format to text', () => {
  assert.deepEqual(
    buildArgv({ argv: ['hello'] }, {}),
    ['--print', '--output-format', 'text', 'hello'],
  );
});

test('buildArgv with print=false omits --print/--output-format', () => {
  assert.deepEqual(
    buildArgv({ argv: ['--help'], print: false }, {}),
    ['--help'],
  );
});

test('buildArgv passes through multiple extra/user args in order', () => {
  assert.deepEqual(
    buildArgv({ argv: ['sub', '--flag', 'prompt'], output_format: 'text' }, {}),
    ['--print', '--output-format', 'text', 'sub', '--flag', 'prompt'],
  );
});

test('buildArgv handles missing argv (undefined) as empty', () => {
  assert.deepEqual(
    buildArgv({}, {}),
    ['--print', '--output-format', 'text'],
  );
});

// --- buildArgv: model injection -------------------------------------------

test('buildArgv inserts -m <model> from per-call arg (before the prompt)', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'], model: 'gpt-5' }, {}),
    ['--print', '--output-format', 'text', '-m', 'gpt-5', 'p'],
  );
});

test('buildArgv inserts -m <model> from CURSOR_AGENT_MODEL env', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'] }, { CURSOR_AGENT_MODEL: 'glm-5.2' }),
    ['--print', '--output-format', 'text', '-m', 'glm-5.2', 'p'],
  );
});

test('buildArgv per-call model takes precedence over env model', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'], model: 'call-model' }, { CURSOR_AGENT_MODEL: 'env-model' }),
    ['--print', '--output-format', 'text', '-m', 'call-model', 'p'],
  );
});

test('buildArgv trims the per-call model', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'], model: '  spaced  ' }, {}),
    ['--print', '--output-format', 'text', '-m', 'spaced', 'p'],
  );
});

test('buildArgv does not inject -m when -m already present in user args', () => {
  assert.deepEqual(
    buildArgv({ argv: ['-m', 'preset', 'p'], model: 'ignored' }, { CURSOR_AGENT_MODEL: 'env' }),
    ['--print', '--output-format', 'text', '-m', 'preset', 'p'],
  );
});

test('buildArgv does not inject -m when --model= form already present', () => {
  assert.deepEqual(
    buildArgv({ argv: ['--model=preset', 'p'] }, { CURSOR_AGENT_MODEL: 'env' }),
    ['--print', '--output-format', 'text', '--model=preset', 'p'],
  );
});

test('buildArgv does not inject -m when no model is effective', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'] }, {}),
    ['--print', '--output-format', 'text', 'p'],
  );
});

// --- buildArgv: force injection -------------------------------------------

test('buildArgv inserts -f from per-call force=true (before the prompt)', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'], force: true }, {}),
    ['--print', '--output-format', 'text', '-f', 'p'],
  );
});

test('buildArgv inserts -f from CURSOR_AGENT_FORCE env truthy variants', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    assert.deepEqual(
      buildArgv({ argv: ['p'] }, { CURSOR_AGENT_FORCE: v }),
      ['--print', '--output-format', 'text', '-f', 'p'],
      `expected -f for CURSOR_AGENT_FORCE=${v}`,
    );
  }
});

test('buildArgv does not append -f for falsy/other CURSOR_AGENT_FORCE values', () => {
  for (const v of ['0', 'false', 'no', 'off', '', 'maybe']) {
    assert.deepEqual(
      buildArgv({ argv: ['p'] }, { CURSOR_AGENT_FORCE: v }),
      ['--print', '--output-format', 'text', 'p'],
      `expected no -f for CURSOR_AGENT_FORCE=${v}`,
    );
  }
});

test('buildArgv per-call force=false overrides env force=1', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'], force: false }, { CURSOR_AGENT_FORCE: '1' }),
    ['--print', '--output-format', 'text', 'p'],
  );
});

test('buildArgv does not duplicate -f when force flag already present', () => {
  const out = buildArgv({ argv: ['-f', 'p'], force: true }, { CURSOR_AGENT_FORCE: '1' });
  assert.deepEqual(out, ['--print', '--output-format', 'text', '-f', 'p']);
  assert.equal(out.filter((a) => a === '-f').length, 1);
});

test('buildArgv does not duplicate -f when --force already present', () => {
  const out = buildArgv({ argv: ['--force', 'p'], force: true }, {});
  assert.deepEqual(out, ['--print', '--output-format', 'text', '--force', 'p']);
});

// --- buildArgv: force + model ordering together ---------------------------

test('buildArgv emits -f before -m, both before the prompt', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'], force: true, model: 'm1' }, {}),
    ['--print', '--output-format', 'text', '-f', '-m', 'm1', 'p'],
  );
});

// --- resolveTimeout --------------------------------------------------------

test('resolveTimeout returns the default (120000) when env value is unset/empty', () => {
  assert.equal(resolveTimeout(undefined), 120000);
  assert.equal(resolveTimeout(''), 120000);
});

test('resolveTimeout parses a valid numeric env value', () => {
  assert.equal(resolveTimeout('5000'), 5000);
  assert.equal(resolveTimeout('60000'), 60000);
});

test('resolveTimeout falls back to the default (120000) on NaN', () => {
  assert.equal(resolveTimeout('abc'), 120000);
});

test('resolveTimeout honors a custom default', () => {
  assert.equal(resolveTimeout(undefined, 10), 10);
  assert.equal(resolveTimeout('nope', 12345), 12345);
});

test('resolveTimeout preserves an explicit 0 (truthy-guard on env string)', () => {
  // "0" is a non-empty string, so it is parsed rather than defaulted.
  assert.equal(resolveTimeout('0'), 0);
});

// --- resolveEffectiveTimeout: per-call > env > default ---------------------

test('resolveEffectiveTimeout per-call value wins over env and default', () => {
  // per-call beats env...
  assert.equal(resolveEffectiveTimeout(5000, '60000'), 5000);
  // ...and beats the default when env is unset.
  assert.equal(resolveEffectiveTimeout(5000, undefined), 5000);
});

test('resolveEffectiveTimeout env wins over default when no per-call value', () => {
  assert.equal(resolveEffectiveTimeout(undefined, '60000'), 60000);
});

test('resolveEffectiveTimeout falls back to default (120000) with no per-call and no/invalid env', () => {
  assert.equal(resolveEffectiveTimeout(undefined, undefined), 120000);
  assert.equal(resolveEffectiveTimeout(undefined, ''), 120000);
  assert.equal(resolveEffectiveTimeout(undefined, 'abc'), 120000);
});

test('resolveEffectiveTimeout ignores invalid per-call values and falls through', () => {
  // NaN / non-positive / non-number per-call must not win; env/default takes over.
  assert.equal(resolveEffectiveTimeout(Number.NaN, '60000'), 60000);
  assert.equal(resolveEffectiveTimeout(0, '60000'), 60000);
  assert.equal(resolveEffectiveTimeout(-1, '60000'), 60000);
  assert.equal(resolveEffectiveTimeout('5000', '60000'), 60000); // string is not a number override
  assert.equal(resolveEffectiveTimeout(Number.NaN, undefined), 120000);
});

test('resolveEffectiveTimeout honors a custom default when falling through', () => {
  assert.equal(resolveEffectiveTimeout(undefined, undefined, 9999), 9999);
  assert.equal(resolveEffectiveTimeout(undefined, 'nope', 9999), 9999);
});

// --- resolveMaxOutputBytes: per-call > env > default -----------------------

test('resolveMaxOutputBytes falls back to the default when no per-call and no/empty env', () => {
  assert.equal(resolveMaxOutputBytes(undefined, undefined), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(resolveMaxOutputBytes(undefined, ''), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(DEFAULT_MAX_OUTPUT_BYTES, 1000000);
});

test('resolveMaxOutputBytes per-call value wins over env and default', () => {
  // per-call beats env...
  assert.equal(resolveMaxOutputBytes(2048, '999999'), 2048);
  // ...and beats the default when env is unset.
  assert.equal(resolveMaxOutputBytes(2048, undefined), 2048);
});

test('resolveMaxOutputBytes env wins over default when no per-call value', () => {
  assert.equal(resolveMaxOutputBytes(undefined, '4096'), 4096);
});

test('resolveMaxOutputBytes ignores invalid per-call values and falls through', () => {
  // NaN / non-positive / non-number per-call must not win; env/default takes over.
  assert.equal(resolveMaxOutputBytes(Number.NaN, '4096'), 4096);
  assert.equal(resolveMaxOutputBytes(0, '4096'), 4096);
  assert.equal(resolveMaxOutputBytes(-1, '4096'), 4096);
  assert.equal(resolveMaxOutputBytes('2048', '4096'), 4096); // string is not a number override
  assert.equal(resolveMaxOutputBytes(Number.NaN, undefined), DEFAULT_MAX_OUTPUT_BYTES);
});

test('resolveMaxOutputBytes falls back to default on invalid/NaN/non-positive env', () => {
  assert.equal(resolveMaxOutputBytes(undefined, 'abc'), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(resolveMaxOutputBytes(undefined, '0'), DEFAULT_MAX_OUTPUT_BYTES);
  assert.equal(resolveMaxOutputBytes(undefined, '-5'), DEFAULT_MAX_OUTPUT_BYTES);
});

test('resolveMaxOutputBytes honors a custom default when falling through', () => {
  assert.equal(resolveMaxOutputBytes(undefined, undefined, 512), 512);
  assert.equal(resolveMaxOutputBytes(undefined, 'nope', 512), 512);
  assert.equal(resolveMaxOutputBytes(0, '0', 512), 512);
});

// --- normalizeArgs ---------------------------------------------------------

test('normalizeArgs returns a flat object unchanged', () => {
  const input = { prompt: 'hi', model: 'x' };
  assert.equal(normalizeArgs(input), input);
});

test('normalizeArgs unwraps nested arguments when no top-level prompt', () => {
  const nested = { prompt: 'hi', model: 'x' };
  assert.equal(normalizeArgs({ arguments: nested }), nested);
});

test('normalizeArgs keeps the flat object when a top-level prompt is present', () => {
  const input = { prompt: 'flat', arguments: { prompt: 'nested' } };
  // Top-level prompt present => do NOT unwrap.
  assert.equal(normalizeArgs(input), input);
});

test('normalizeArgs passes through non-objects untouched', () => {
  assert.equal(normalizeArgs('str'), 'str');
  assert.equal(normalizeArgs(null), null);
  assert.equal(normalizeArgs(undefined), undefined);
});

// --- isModelAllowed (HM-567) -----------------------------------------------
// Opt-in allowlist: enforced ONLY when CURSOR_AGENT_MODEL_ALLOWLIST is set.

test('isModelAllowed allows any model when the allowlist env is unset', () => {
  assert.equal(isModelAllowed('glm-5.2', {}), true);
  assert.equal(isModelAllowed('gpt-5', {}), true);
  assert.equal(isModelAllowed('anything-goes', {}), true);
});

test('isModelAllowed allows any model when the allowlist env is empty', () => {
  assert.equal(isModelAllowed('glm-5.2', { CURSOR_AGENT_MODEL_ALLOWLIST: '' }), true);
  assert.equal(isModelAllowed('glm-5.2', { CURSOR_AGENT_MODEL_ALLOWLIST: '   ' }), true);
});

test('isModelAllowed allows a model present in the configured allowlist', () => {
  const env = { CURSOR_AGENT_MODEL_ALLOWLIST: 'glm-5.2,gpt-5' };
  assert.equal(isModelAllowed('glm-5.2', env), true);
  assert.equal(isModelAllowed('gpt-5', env), true);
});

test('isModelAllowed rejects a model not present in the configured allowlist', () => {
  const env = { CURSOR_AGENT_MODEL_ALLOWLIST: 'glm-5.2' };
  assert.equal(isModelAllowed('gtp-5', env), false); // typo, must not match gpt-5
  assert.equal(isModelAllowed('gpt-5', env), false);
});

test('isModelAllowed tolerates whitespace around allowlist entries and the model', () => {
  const env = { CURSOR_AGENT_MODEL_ALLOWLIST: '  glm-5.2 ,  gpt-5  ' };
  assert.equal(isModelAllowed('glm-5.2', env), true);
  assert.equal(isModelAllowed('  gpt-5  ', env), true);
  assert.equal(isModelAllowed('gpt-4', env), false);
});

test('isModelAllowed drops empty entries from a trailing/double comma', () => {
  const env = { CURSOR_AGENT_MODEL_ALLOWLIST: 'glm-5.2,,gpt-5,' };
  assert.equal(isModelAllowed('glm-5.2', env), true);
  assert.equal(isModelAllowed('gpt-5', env), true);
  assert.equal(isModelAllowed('', env), false);
});

test('isModelAllowed defaults env to process.env when omitted', () => {
  const prev = process.env.CURSOR_AGENT_MODEL_ALLOWLIST;
  delete process.env.CURSOR_AGENT_MODEL_ALLOWLIST;
  try {
    assert.equal(isModelAllowed('anything'), true);
  } finally {
    if (prev === undefined) delete process.env.CURSOR_AGENT_MODEL_ALLOWLIST;
    else process.env.CURSOR_AGENT_MODEL_ALLOWLIST = prev;
  }
});
