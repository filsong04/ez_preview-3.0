'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');

assert.match(html, /video\.src = state\.objectUrl;\s*video\.load\(\);/, 'the original file should still be loaded directly first');
assert.match(html, /metadataProbeCleanup: null, proxyQueuePaused: true/, 'background proxy preparation should start paused by default');
assert.match(html, /function deferMediaProbeUntilFirstFrame\(item\)/, 'metadata probing should be deferred until first-frame delivery');
assert.match(html, /video\.addEventListener\('loadeddata', onLoadedData, \{ once: true \}\)/, 'deferred metadata probing should wait for the first frame');
assert.match(html, /\}, 900\);/, 'metadata probing should yield briefly after first-frame delivery');

const queueStart = html.indexOf('  function scheduleProxyQueue() {');
const queueRun = html.indexOf('    state.proxyQueueRunning = true;', queueStart);
assert.ok(queueStart >= 0 && queueRun > queueStart, 'proxy queue implementation should exist');
assert.match(html.slice(queueStart, queueRun), /state\.proxyQueuePaused/, 'a paused queue must not start a background transcode');
assert.match(html.slice(queueStart, queueStart + 1800), /candidate\.id !== state\.currentMediaId && candidate\.proxyStatus === 'queued'/, 'background prebuilding must not take priority over the selected clip');
assert.match(html, /autoFallbackEligible[\s\S]*?tryCompatiblePreview\(\)/, 'unsupported media should retain the compatibility-preview fallback');
assert.match(main, /function handleConvertPreview\(/, 'native FFmpeg preview conversion must remain available');

console.log('PASS: direct playback first, deferred metadata probe, opt-in background proxies, current-clip priority, and fallback preserved.');
