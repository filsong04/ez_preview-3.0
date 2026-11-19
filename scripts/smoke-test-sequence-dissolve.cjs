'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(projectRoot, 'index.html'), 'utf8');
const mainSource = fs.readFileSync(path.join(projectRoot, 'main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(projectRoot, 'preload.cjs'), 'utf8');

// 1. Markup, IPC & WebGL2 dual-deck shader verification
assert.match(html, /<video id="videoB"/, 'secondary deck videoB should exist');
assert.match(html, /id="sequenceBar"/, 'collapsible sequence bar should exist');
assert.match(html, /id="seqSetInBtn"/, 'Set In button should exist');
assert.match(html, /id="seqSetOutBtn"/, 'Set Out button should exist');
assert.match(html, /id="seqExportBtn"/, 'Export MP4 button should exist');
assert.match(preloadSource, /exportSequenceMp4\(options\)/, 'preload should expose exportSequenceMp4');
assert.match(mainSource, /ez-native:export-sequence-mp4/, 'main process should handle ez-native:export-sequence-mp4');
assert.match(html, /uniform sampler2D u_imageB;/, 'WebGL2 shader must declare u_imageB');
assert.match(html, /uniform float u_mix;/, 'WebGL2 shader must declare u_mix');
assert.match(html, /baseRgb=mix\(baseRgb,rgbB,clamp\(u_mix,0\.0,1\.0\)\);/, 'WebGL2 shader must blend Deck A and Deck B');

// 2. Execute pure sequence layout & In/Out trim time-resolution engine in VM
const start = html.indexOf('  const DISSOLVE_PRESETS =');
const end = html.indexOf('  function clearDeckB() {', start);
assert.ok(start >= 0 && end > start, 'sequence layout helpers should exist');

const state = {
  mediaItems: [
    { id: 'c1', file: { name: 'A001.mov' }, info: { durationSeconds: 10 } },
    { id: 'c2', file: { name: 'A002.mov' }, info: { durationSeconds: 8 } },
    { id: 'c3', file: { name: 'A003.mov' }, info: { durationSeconds: 1 } }
  ]
};
const ctx = {
  state,
  findMediaItem: id => state.mediaItems.find(m => m.id === id) || null
};
vm.createContext(ctx);
vm.runInContext(`${html.slice(start, end)}\nthis.computeSequenceLayout = computeSequenceLayout; this.resolveSequenceTime = resolveSequenceTime;`, ctx);

// Test trimmed In/Out + 1.0s Dissolve + Short-clip clamped Dissolve
const items = [
  { uid: '1', mediaId: 'c1', transition: 'dissolve', dissolveSec: 1.0, duration: 10, inPoint: 2, outPoint: 8 }, // trimmed 6s
  { uid: '2', mediaId: 'c2', transition: 'dissolve', dissolveSec: 1.5, duration: 8, inPoint: 1, outPoint: 5 },  // trimmed 4s
  { uid: '3', mediaId: 'c3', transition: 'cut', dissolveSec: 0.5, duration: 1, inPoint: 0, outPoint: null }     // 1s
];
const layout = ctx.computeSequenceLayout(items);
assert.equal(layout.segments.length, 3);
assert.equal(layout.segments[0].duration, 6, 'clip 1 trimmed duration should be 6s');
assert.equal(layout.segments[0].overlap, 1.0, '1.0s dissolve between 6s and 4s clips should remain 1.0s');
assert.equal(layout.segments[1].start, 5.0, 'clip 2 should start at 5.0s (6 - 1.0 overlap)');
assert.ok(Math.abs(layout.segments[1].overlap - 0.45) < 1e-6, 'dissolve must clamp to 45% of shorter 1s clip');
assert.ok(Math.abs(layout.totalDuration - (6 + 4 + 1 - 1.0 - 0.45)) < 1e-6, 'total sequence duration should equal trimmed sum minus overlaps');

const midDissolve = ctx.resolveSequenceTime(layout, 5.5);
assert.equal(midDissolve.index, 0);
assert.ok(Math.abs(midDissolve.dissolveMix - 0.5) < 1e-6, 'midpoint of 1.0s dissolve at 5.5s should have mix=0.5');
assert.ok(Math.abs(midDissolve.localTimeA - 7.5) < 1e-6, 'Deck A local time should include inPoint (2 + 5.5 = 7.5)');
assert.ok(Math.abs(midDissolve.localTimeB - 1.5) < 1e-6, 'Deck B local time should include next inPoint (1 + 0.5 = 1.5)');

// 3. Real end-to-end FFmpeg xfade + acrossfade + lut3d MP4 export test
let ffmpegPath = process.env.EZ_PREVIEW_FFMPEG || null;
if (!ffmpegPath) { try { ffmpegPath = require('ffmpeg-static'); } catch (_) {} }
assert.ok(ffmpegPath && fs.existsSync(ffmpegPath), 'FFmpeg binary must be available for sequence export smoke test');

const safeNumCode = mainSource.match(/function safeNumber[\s\S]*?^}/m)[0];
const graphStart = mainSource.indexOf('function buildSequenceExportGraph(');
const graphEnd = mainSource.indexOf('\nasync function probeHasAudioStream(', graphStart);
assert.ok(graphStart >= 0 && graphEnd > graphStart, 'buildSequenceExportGraph should exist in main.cjs');
const graphCtx = {};
vm.createContext(graphCtx);
vm.runInContext(`${safeNumCode}\n${mainSource.slice(graphStart, graphEnd)}\nthis.buildSequenceExportGraph = buildSequenceExportGraph;`, graphCtx);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-seq-export-'));
try {
  const clipA = path.join(tmpDir, 'clipA.mp4');
  const clipB = path.join(tmpDir, 'clipB.mp4');
  const outMp4 = path.join(tmpDir, 'exported_seq.mp4');

  // Clip A: 3s with audio; Clip B: 3s silent (tests mixed audio/silent acrossfade!)
  let r = spawnSync(ffmpegPath, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=24:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', clipA], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'clipA generation should succeed');
  r = spawnSync(ffmpegPath, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=640x360:r=24:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-an', clipB], { encoding: 'utf8' });
  assert.equal(r.status, 0, 'clipB generation should succeed');

  const graph = graphCtx.buildSequenceExportGraph([
    { inputPath: clipA, inPoint: 0.5, duration: 2.0, transition: 'dissolve', dissolveSec: 0.5, hasAudio: true },
    { inputPath: clipB, inPoint: 0.5, duration: 2.0, transition: 'cut', dissolveSec: 0.5, hasAudio: false }
  ], { width: 640, height: 360, fps: 24, includeAudio: true });

  const exp = spawnSync(ffmpegPath, [
    '-hide_banner', '-y', '-nostdin',
    ...graph.inputArgs,
    '-filter_complex', graph.filterComplex,
    '-map', graph.videoMap, '-map', graph.audioMap,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-movflags', '+faststart',
    outMp4
  ], { encoding: 'utf8', timeout: 60000 });
  assert.equal(exp.status, 0, `FFmpeg sequence export failed:\n${(exp.stderr || '').slice(-1500)}`);
  const stat = fs.statSync(outMp4);
  assert.ok(stat.size > 4096, 'exported sequence MP4 should be non-empty');

  const probe = spawnSync(ffmpegPath, ['-hide_banner', '-i', outMp4], { encoding: 'utf8' });
  assert.match(probe.stderr, /640x360/, 'exported MP4 should match target resolution');
  assert.match(probe.stderr, /Audio: aac/, 'exported MP4 should preserve audio with silent pad for Clip B');
  assert.match(probe.stderr, /Duration:\s*00:00:03\.5/, 'trimmed 2s + 2s with 0.5s dissolve should export ~3.5s');

  assert.match(html, /window\.addEventListener\('pointermove', onMove\)/, 'timeline trim drag must bind pointermove on window so DOM updates never cancel drag');
assert.match(mainSource, /-pix_fmt', 'rgb24'/, 'original-resolution PNG export should use fast 8-bit rgb24');
console.log(`PASS: dual-deck WebGL2 dissolve, In/Out trim math, and real FFmpeg xfade+acrossfade MP4 export (640x360, 3.5s, ${stat.size.toLocaleString()} bytes).`);
} finally {
  fs.rmSync(tmpDir, { recursive: true, force: true });
}
