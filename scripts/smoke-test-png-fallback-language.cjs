'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const main = fs.readFileSync(path.join(root, 'main.cjs'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'preload.cjs'), 'utf8');

// Current-state language indicator (not the next language to switch to).
assert.match(html, /button\.textContent = state\.language === 'en' \? 'EN' : 'KO'/);
assert.match(html, /button\.dataset\.language = state\.language/);
assert.match(html, /button\.setAttribute\('aria-pressed', String\(state\.language === 'ko'\)\)/);
assert.match(html, /\.language-toggle\[data-language="en"\]/);
assert.match(html, /\.language-toggle\[data-language="ko"\]/);

// Original-resolution path must be allowed to fall back rather than hard-stop.
assert.match(html, /if \(state\.proxyQueueRunning\) \{\s*return \{ fallback: true/);
assert.match(html, /if \(state\.compatibilityBusy\) \{\s*return \{ fallback: true/);
assert.match(html, /Original-resolution PNG export unavailable; falling back to preview capture/);
assert.match(html, /Original-resolution export is unavailable\. EZ Preview will save a capture of the current preview as PNG\./);
assert.match(html, /원본 해상도 추출을 사용할 수 없어 현재 프리뷰 화면을 캡처해 PNG로 저장합니다\./);
assert.match(html, /await exportPreviewSnapshot\(\{ nativeSave: true, fallbackCapture: true \}\)/);
assert.match(html, /await window\.ezNative\.saveSnapshotPng\(/);

// Native save flow is isolated behind the context bridge and validates PNG bytes.
assert.match(preload, /saveSnapshotPng\(options\)\s*\{\s*return ipcRenderer\.invoke\('ez-native:save-snapshot-png', options\)/);
assert.match(main, /ipcMain\.handle\('ez-native:save-snapshot-png'/);
assert.match(main, /256 MB safety limit/);
assert.match(main, /imageBytes\.subarray\(0, 8\)\.equals\(pngSignature\)/);
assert.match(main, /dialog\.showSaveDialog/);

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML IDs must remain unique');
console.log('PASS: current-language indicator, localized PNG capture fallback, native save dialog, and PNG validation.');
