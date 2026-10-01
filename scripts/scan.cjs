/* Fail-closed quality gate around the pinned scanner's native CI command. */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const ENGINES = ['format', 'lint', 'code-quality', 'ai-slop', 'security'];

function validateReport(report, threshold, status) {
  if (!Number.isFinite(threshold) || threshold < 95 || threshold > 100) {
    throw new Error('AISLOP ci.failBelow must be between 95 and 100.');
  }
  if (status !== 0 || report.cliVersion !== '0.16.1' || report.schemaVersion !== '1') {
    throw new Error('The pinned AISLOP CI command did not complete successfully.');
  }
  if (report.scoreable !== true || report.coverage?.scoreable !== true ||
      !(report.coverage.supportedFiles > 0) || !Number.isFinite(report.score) || report.score < threshold) {
    throw new Error(`AISLOP requires a scoreable result of at least ${threshold}/100.`);
  }
  for (const engine of ENGINES) {
    if (report.engines?.[engine]?.skipped !== false) throw new Error(`AISLOP engine unavailable: ${engine}`);
  }
  if (!Array.isArray(report.diagnostics) || report.summary?.errors !== 0) {
    throw new Error('AISLOP report is incomplete or contains errors.');
  }
}

function runReport(command, args, name, output) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', timeout: 120000,
    maxBuffer: 16 * 1024 * 1024, env: { ...process.env, AISLOP_NO_HISTORY: '1' } });
  fs.writeFileSync(path.join(output, name + '.json'), result.stdout || '');
  fs.writeFileSync(path.join(output, name + '.stderr.txt'), result.stderr || String(result.error || ''));
  if (result.error) throw result.error;
  return { report: JSON.parse(result.stdout), status: result.status };
}

async function main() {
  const output = path.join(ROOT, 'tests/artifacts/quality');
  fs.mkdirSync(output, { recursive: true });
  const { loadConfig } = await import('aislop');
  const config = loadConfig(ROOT);
  const cli = path.join(path.dirname(require.resolve('aislop')), 'cli.js');
  const scan = runReport(process.execPath, [cli, 'ci'], 'aislop', output);
  validateReport(scan.report, config.ci.failBelow, scan.status);
  // The scanner can hide rejected audit sub-tasks. Require a complete audit too.
  const audit = runReport('npm', ['audit', '--json'], 'npm-audit', output);
  if (audit.status !== 0 || audit.report.error || audit.report.metadata?.vulnerabilities?.total !== 0) {
    throw new Error('Dependency audit failed, is incomplete, or found vulnerabilities.');
  }
  console.log(`AISLOP ${scan.report.score}/100 (minimum ${config.ci.failBelow}); all five engines completed; audit clean.`);
}

module.exports = { validateReport };
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
