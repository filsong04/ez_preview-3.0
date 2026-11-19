'use strict';

// Integration smoke test for canceling an in-flight native preview conversion.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const Module = require('node:module');

const ffmpegPath = process.env.EZ_PREVIEW_FFMPEG || (() => {
  try { return require('ffmpeg-static'); } catch (_) { return null; }
})();
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  console.error('FFmpeg binary was not found. Run npm install or set EZ_PREVIEW_FFMPEG to a local FFmpeg binary.');
  process.exit(1);
}

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-preview-cancel-test-'));
const appData = path.join(testRoot, 'user-data');
const tempPath = path.join(testRoot, 'temp');
const handlers = new Map();
const fakeElectron = {
  app: {
    isPackaged: false,
    getPath(name) {
      if (name === 'userData') return appData;
      if (name === 'temp') return tempPath;
      if (name === 'pictures') return testRoot;
      throw new Error(`Unexpected app.getPath(${name})`);
    },
    whenReady() { return { then() { return undefined; } }; },
    on() {}, quit() {}
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
  dialog: {}
};

function run(args, label) {
  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed:\n${(result.stderr || `exit ${result.status}`).slice(-3500)}`);
  return result;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

(async () => {
  try {
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(tempPath, { recursive: true });
    const source = path.join(testRoot, 'cancel-source.mp4');
    run([
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=12',
      '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000:duration=12', '-shortest',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '25', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source
    ], 'Cancel-test source generation');

    process.env.EZ_PREVIEW_FFMPEG = ffmpegPath;
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    try { require(path.join(__dirname, '..', 'main.cjs')); }
    finally { Module._load = originalLoad; }

    assert.ok(handlers.has('ez-native:convert-preview'), 'Missing native convert handler');
    assert.ok(handlers.has('ez-native:cancel-preview-conversion'), 'Missing native cancel handler');
    const event = { sender: { isDestroyed: () => false, send() {} } };
    const jobId = `cancel-smoke-${Date.now()}`;
    const conversion = handlers.get('ez-native:convert-preview')(event, {
      inputPath: source, sourceName: path.basename(source), jobId, maxDimension: 1920, includeAudio: true
    });
    await delay(60);
    const cancelResult = await handlers.get('ez-native:cancel-preview-conversion')(event, { jobId });
    assert.equal(cancelResult.cancelled, true, `Expected the in-flight job to be cancelable, got ${JSON.stringify(cancelResult)}`);
    await assert.rejects(conversion, /canceled/i);
    const cache = await handlers.get('ez-native:proxy-cache-info')(event);
    assert.equal(cache.count, 0, 'Canceled conversion must not leave a published proxy in the cache');
    console.log('PASS: an in-flight FFmpeg preview conversion can be canceled without publishing a partial cache entry');
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`Preview conversion cancellation smoke test failed: ${error.stack || error}`);
  process.exitCode = 1;
});
