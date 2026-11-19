'use strict';

const { spawnSync } = require('node:child_process');
const path = require('node:path');

const projectRoot = path.join(__dirname, '..');
const tests = [
  'smoke-test-media-browser.cjs',
  'smoke-test-import-performance.cjs',
  'smoke-test-switch-priority.cjs',
  'smoke-test-lut-storage.cjs',
  'smoke-test-ffmpeg.cjs',
  'smoke-test-export.cjs',
  'smoke-test-proxy-cache.cjs',
  'smoke-test-preview-cancel.cjs',
  'smoke-test-fullscreen-language.cjs',
  'smoke-test-png-fallback-language.cjs',
  'smoke-test-brand-assets.cjs',
  'smoke-test-sequence-dissolve.cjs'
];

const failures = [];
for (const testName of tests) {
  const testPath = path.join(__dirname, testName);
  console.log(`\n===== RUNNING ${testName} =====`);
  const result = spawnSync(process.execPath, [testPath], {
    cwd: projectRoot,
    env: process.env,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 10 * 60 * 1000,
    maxBuffer: 20 * 1024 * 1024
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);

  if (result.error || result.status !== 0) {
    const reason = result.error
      ? result.error.message
      : `exit code ${result.status}${result.signal ? ` (signal ${result.signal})` : ''}`;
    failures.push({ testName, reason });
    console.error(`===== FAILED ${testName}: ${reason} =====`);
  } else {
    console.log(`===== PASSED ${testName} =====`);
  }
}

if (failures.length) {
  console.error(`\n${failures.length} of ${tests.length} smoke tests failed:`);
  for (const failure of failures) console.error(`- ${failure.testName}: ${failure.reason}`);
  process.exitCode = 1;
} else {
  console.log(`\nAll ${tests.length} native smoke tests passed.`);
}
