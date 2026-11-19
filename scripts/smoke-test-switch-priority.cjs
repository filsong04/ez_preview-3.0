'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const start = html.indexOf('  async function activateMediaItem(id, options = {}) {');
const end = html.indexOf('\n  function toggleVideoInfo', start);
assert.ok(start >= 0 && end > start, 'media activation function should exist');
const activate = html.slice(start, end);
assert.match(activate, /const canceledJobId = state\.compatibilityJobId;/, 'switching must capture the active conversion job');
assert.match(activate, /state\.compatibilityJobId\+\+;/, 'switching must invalidate the previous job immediately');
assert.match(activate, /cancelPreviewConversion\(canceledJobId\)/, 'desktop conversion should be canceled when switching');
assert.match(activate, /state\.ffmpeg\.terminate\(\)/, 'browser fallback worker should be terminated when switching');
assert.doesNotMatch(activate, /Wait for the current preview conversion to finish/, 'switching must not be blocked by conversion');

const nativeStart = html.indexOf('  async function tryNativeCompatiblePreview(');
const nativeEnd = html.indexOf('\n  async function tryCompatiblePreview', nativeStart);
const nativeFn = html.slice(nativeStart, nativeEnd);
assert.match(nativeFn, /await yieldProxyQueueForPriorityWork\(\);\s*if \(jobId !== state\.compatibilityJobId \|\| sourceFile !== state\.file\) return;/, 'stale native jobs must stop before starting FFmpeg');


const onFilesStart = html.indexOf('  function onFiles(files, options = {}) {');
const onFilesEnd = html.indexOf('\n  // -------------------- Optional codec compatibility path', onFilesStart);
assert.ok(onFilesStart >= 0 && onFilesEnd > onFilesStart, 'onFiles function should exist');
const onFilesFn = html.slice(onFilesStart, onFilesEnd);
assert.doesNotMatch(onFilesFn, /Switch after the current conversion finishes/, 'adding files during conversion must not block immediate switching');

const scopeStart = html.indexOf('  function prepareScopeFrame() {');
const scopeEnd = html.indexOf('\n  function drawScope()', scopeStart);
assert.ok(scopeStart >= 0 && scopeEnd > scopeStart, 'prepareScopeFrame function should exist');
const scopeFn = html.slice(scopeStart, scopeEnd);
assert.match(scopeFn, /if\(state\.splitEnabled && shouldRenderGrade\(\)\)/, 'scopes must honor split comparison for adjustments even when LUT is off');

console.log('PASS: switching clips invalidates/cancels compatibility work and prioritizes the newly selected original.');
