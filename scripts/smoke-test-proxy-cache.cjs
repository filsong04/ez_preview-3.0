'use strict';

// Integration smoke test for native media probing and persistent proxy-cache reuse.
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

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-preview-stage18-cache-test-'));
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
    on() {},
    quit() {}
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

(async () => {
  const source = path.join(testRoot, 'source-with-audio.mp4');
  const progress = [];
  try {
    fs.mkdirSync(appData, { recursive: true });
    fs.mkdirSync(tempPath, { recursive: true });
    run([
      '-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=1',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1', '-shortest',
      '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', source
    ], 'Smoke source generation');

    process.env.EZ_PREVIEW_FFMPEG = ffmpegPath;
    const originalLoad = Module._load;
    Module._load = function patchedLoad(request, parent, isMain) {
      if (request === 'electron') return fakeElectron;
      return originalLoad.call(this, request, parent, isMain);
    };
    try { require(path.join(__dirname, '..', 'main.cjs')); }
    finally { Module._load = originalLoad; }

    for (const name of ['ez-native:probe-media', 'ez-native:convert-preview', 'ez-native:proxy-cache-info', 'ez-native:proxy-cache-clear']) {
      assert.ok(handlers.has(name), `Missing IPC handler: ${name}`);
    }
    const invoke = (name, event, payload) => handlers.get(name)(event || { sender: { isDestroyed: () => false, send: (_channel, message) => progress.push(message) } }, payload);

    const info = await invoke('ez-native:probe-media', null, { inputPath: source });
    assert.equal(info.width, 1280);
    assert.equal(info.height, 720);
    assert.ok(info.videoCodec && info.videoCodec !== 'Unknown');
    assert.ok(info.audioCodec && info.audioCodec !== 'No audio track');
    assert.ok(Number.isFinite(info.fps) && info.fps > 0);
    console.log(`PASS: source metadata probe (${info.width}x${info.height}, ${info.fps} fps, audio ${info.audioCodec})`);

    const payload = { inputPath: source, sourceName: path.basename(source), jobId: 'cache-smoke', maxDimension: 960, includeAudio: true };
    const first = await invoke('ez-native:convert-preview', null, payload);
    assert.equal(first.cached, false);
    assert.ok(fs.existsSync(first.outputPath));
    assert.ok(first.outputBytes > 1024);
    const second = await invoke('ez-native:convert-preview', null, payload);
    assert.equal(second.cached, true);
    assert.equal(second.outputPath, first.outputPath);
    console.log(`PASS: native proxy cached and reused (${first.encoder}, ${first.outputBytes.toLocaleString()} bytes)`);

    let cache = await invoke('ez-native:proxy-cache-info');
    assert.equal(cache.count, 1);
    assert.equal(cache.totalBytes, first.outputBytes);
    const protectedClear = await invoke('ez-native:proxy-cache-clear', null, { keepPaths: [first.outputPath] });
    assert.equal(protectedClear.count, 1, 'active cache entry should be protected');
    const cleared = await invoke('ez-native:proxy-cache-clear', null, { keepPaths: [] });
    assert.equal(cleared.count, 0);
    assert.equal(cleared.removedCount, 1);
    console.log('PASS: cache size accounting, active-proxy protection, and cache clear');
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(`Stage 18 proxy cache smoke test failed: ${error.stack || error}`);
  process.exitCode = 1;
});
