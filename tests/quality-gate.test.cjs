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

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(path.dirname(require.resolve('aislop')), 'cli.js');

function isolatedProject(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'coin-quest-quality-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'checkout'), home = path.join(parent, 'home');
  for (const dir of [parent, root, home]) fs.mkdirSync(path.join(dir, '.aislop'), { recursive: true });
  // Deliberately permissive parent/home settings must not weaken the project gate.
  for (const dir of [parent, home]) fs.writeFileSync(path.join(dir, '.aislop/config.yml'),
    'ci:\n  failBelow: 1\nengines:\n  security: false\nexclude: ["**/*"]\n');
  fs.copyFileSync(path.join(ROOT, '.aislop/config.yml'), path.join(root, '.aislop/config.yml'));
  return { root, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home,
    XDG_STATE_HOME: home, AISLOP_NO_HISTORY: '1', DO_NOT_TRACK: '1' } };
}
function run(project, command, args) {
  const result = spawnSync(command, args, { cwd: project.root, env: project.env,
    encoding: 'utf8', timeout: 120000, maxBuffer: 16 * 1024 * 1024 });
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  return result;
}
function installGate(project) {
  fs.mkdirSync(path.join(project.root, 'scripts'));
  fs.copyFileSync(path.join(ROOT, 'scripts/scan.cjs'), path.join(project.root, 'scripts/scan.cjs'));
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(project.root, 'node_modules'), 'dir');
  fs.writeFileSync(path.join(project.root, 'package.json'), JSON.stringify({
    name: 'quality-gate-fixture', private: true, scripts: { scan: 'node scripts/scan.cjs' }
  }));
}
function promotionAttempt(project, gate) {
  const result = run(project, 'sh', ['-c', `${gate} && mkdir promoted && cp dist/index.html promoted/index.html`]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(project.root, 'promoted')), false, 'failed checks must not promote the site');
  return result;
}

test('real local config wins over isolated parent and home settings', async t => {
  const project = isolatedProject(t);
  const modulePath = require.resolve('aislop');
  const result = run(project, process.execPath, ['--input-type=module', '-e',
    `import {loadConfig} from ${JSON.stringify(modulePath)}; console.log(JSON.stringify(loadConfig(process.cwd())));`]);
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config.ci.failBelow, 95);
  assert.equal(config.engines.security, true);
  assert.deepEqual(config.rules, {});
  const { loadConfig } = await import('aislop');
  assert.deepEqual(config, loadConfig(ROOT));
});

test('real below-threshold npm gate exits nonzero and cannot promote a Pages artifact', t => {
  const project = isolatedProject(t);
  installGate(project);
  fs.mkdirSync(path.join(project.root, 'dist'));
  fs.writeFileSync(path.join(project.root, 'dist/index.html'), '<title>Unapproved fixture</title>');
  fs.writeFileSync(path.join(project.root, 'wide.js'),
    'export function sum(a,b,c,d,e,f,g,h) { return a+b+c+d+e+f+g+h; }\n' +
    'export function more(a,b,c,d,e,f,g,h,i) { return a+b+c+d+e+f+g+h+i; }\n');
  promotionAttempt(project, 'npm run scan');
  const result = JSON.parse(fs.readFileSync(path.join(project.root, 'tests/artifacts/quality/aislop.json'), 'utf8'));
  assert.equal(result.scoreable, true);
  assert.ok(Number.isFinite(result.score) && result.score < 95, JSON.stringify(result));
  assert.equal(result.summary.errors, 0, 'the score threshold alone must block promotion');
  assert.ok(result.summary.warnings > 0);
  t.diagnostic(`Real fixture score: ${result.score}/100; npm gate failed; no artifact promoted.`);
  // A missing scanner is also a hard failure, not an implicit clean score.
  fs.unlinkSync(path.join(project.root, 'node_modules'));
  const missing = promotionAttempt(project, 'npm run scan');
  assert.match(missing.stderr, /Cannot find package 'aislop'/);
});

test('real non-scoreable CLI output is rejected even when the scanner exits zero', t => {
  const project = isolatedProject(t);
  const result = run(project, process.execPath, [CLI, 'ci', project.root]);
  const data = JSON.parse(result.stdout);
  assert.equal(result.status, 0, 'the wrapper must close the native CLI unscored-success gap');
  assert.equal(data.scoreable, false);
  assert.equal(data.score, null);
  const reportFile = path.join(project.root, 'unscored.json');
  fs.writeFileSync(reportFile, result.stdout);
  const validator = path.join(ROOT, 'scripts/scan.cjs');
  const check = `const {validateReport}=require(${JSON.stringify(validator)}); ` +
    `validateReport(require('./unscored.json'),95,${JSON.stringify(result.status)});`;
  promotionAttempt(project, `${JSON.stringify(process.execPath)} -e ${JSON.stringify(check)}`);
});
