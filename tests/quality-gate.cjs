'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateReport } = require('../scripts/scan.cjs');
function report() {
  return { cliVersion: '0.16.1', schemaVersion: '1', scoreable: true, score: 100,
    coverage: { scoreable: true, supportedFiles: 9 }, diagnostics: [], summary: { errors: 0 },
    engines: Object.fromEntries(['format', 'lint', 'code-quality', 'ai-slop', 'security'].map(e => [e, { skipped: false }])) };
}
test('quality gate accepts the configured boundary and rejects scores below 95', () => {
  validateReport({ ...report(), score: 95 }, 95, 0);
  assert.throws(() => validateReport({ ...report(), score: 94 }, 95, 0));
  for (const score of [null, NaN, undefined]) assert.throws(() => validateReport({ ...report(), score }, 95, 0));
  assert.throws(() => validateReport(report(), 94, 0));
});
test('quality gate fails closed on non-scoreable, failed, skipped, missing and malformed reports', () => {
  for (const change of [{ scoreable: false }, { coverage: {} }, { engines: {} }, { cliVersion: 'other' },
    { schemaVersion: 'other' }, { diagnostics: null }, { summary: { errors: 1 } }]) {
    assert.throws(() => validateReport({ ...report(), ...change }, 95, 0));
  }
  const skipped = report(); skipped.engines.security.skipped = true;
  assert.throws(() => validateReport(skipped, 95, 0));
  for (const status of [1, null]) assert.throws(() => validateReport(report(), 95, status));
});
