// Unit tests for lib/argv.js — the pure, dependency-free helpers.
//
// These import ONLY the pure module (never server.js), so they run with no
// cursor-agent binary, no network, no credentials, and no installed npm deps.
// Run with: node --test test/
//
// NOTE: assertions capture TODAY'S behavior. In particular, argv ordering emits
// the -f/-m flags AFTER the positional prompt. HM-558 will change that ordering
// and these expectations will need to move with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildArgv, resolveTimeout, normalizeArgs } from '../lib/argv.js';

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

test('buildArgv appends -m <model> from per-call arg (after the prompt)', () => {
  // HM-558 will change this ordering.
  assert.deepEqual(
    buildArgv({ argv: ['p'], model: 'gpt-5' }, {}),
    ['--print', '--output-format', 'text', 'p', '-m', 'gpt-5'],
  );
});

test('buildArgv appends -m <model> from CURSOR_AGENT_MODEL env', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'] }, { CURSOR_AGENT_MODEL: 'glm-5.2' }),
    ['--print', '--output-format', 'text', 'p', '-m', 'glm-5.2'],
  );
});

test('buildArgv per-call model takes precedence over env model', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'], model: 'call-model' }, { CURSOR_AGENT_MODEL: 'env-model' }),
    ['--print', '--output-format', 'text', 'p', '-m', 'call-model'],
  );
});

test('buildArgv trims the per-call model', () => {
  assert.deepEqual(
    buildArgv({ argv: ['p'], model: '  spaced  ' }, {}),
    ['--print', '--output-format', 'text', 'p', '-m', 'spaced'],
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

test('buildArgv appends -f from per-call force=true (after the prompt)', () => {
  // HM-558 will change this ordering.
  assert.deepEqual(
    buildArgv({ argv: ['p'], force: true }, {}),
    ['--print', '--output-format', 'text', 'p', '-f'],
  );
});

test('buildArgv appends -f from CURSOR_AGENT_FORCE env truthy variants', () => {
  for (const v of ['1', 'true', 'yes', 'on', 'TRUE', 'On']) {
    assert.deepEqual(
      buildArgv({ argv: ['p'] }, { CURSOR_AGENT_FORCE: v }),
      ['--print', '--output-format', 'text', 'p', '-f'],
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

test('buildArgv emits -f before -m, both after the prompt', () => {
  // HM-558 will change this ordering.
  assert.deepEqual(
    buildArgv({ argv: ['p'], force: true, model: 'm1' }, {}),
    ['--print', '--output-format', 'text', 'p', '-f', '-m', 'm1'],
  );
});

// --- resolveTimeout --------------------------------------------------------

test('resolveTimeout returns the default when env value is unset/empty', () => {
  assert.equal(resolveTimeout(undefined), 30000);
  assert.equal(resolveTimeout(''), 30000);
});

test('resolveTimeout parses a valid numeric env value', () => {
  assert.equal(resolveTimeout('5000'), 5000);
  assert.equal(resolveTimeout('60000'), 60000);
});

test('resolveTimeout falls back to default on NaN', () => {
  assert.equal(resolveTimeout('abc'), 30000);
});

test('resolveTimeout honors a custom default', () => {
  assert.equal(resolveTimeout(undefined, 10), 10);
  assert.equal(resolveTimeout('nope', 12345), 12345);
});

test('resolveTimeout preserves an explicit 0 (truthy-guard on env string)', () => {
  // "0" is a non-empty string, so it is parsed rather than defaulted.
  assert.equal(resolveTimeout('0'), 0);
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
