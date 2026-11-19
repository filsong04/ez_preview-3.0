'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const projectRoot = path.join(__dirname, '..');
let ffmpegPath = process.env.EZ_PREVIEW_FFMPEG || null;
if (!ffmpegPath) {
  try { ffmpegPath = require('ffmpeg-static'); } catch (_) {}
}
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  console.error('FFmpeg binary was not found. Run npm install first.');
  process.exit(1);
}

// Verify the actual helper used by the Electron main process to escape paths
// inserted into an FFmpeg filter expression. The path deliberately contains
// Windows drive syntax and characters that require escaping in filter options.
const mainSource = fs.readFileSync(path.join(projectRoot, 'main.cjs'), 'utf8');
const escapeStart = mainSource.indexOf('function escapeFilterPath(filePath) {');
const escapeEndMarker = mainSource.indexOf('\n}', escapeStart);
assert.ok(escapeStart >= 0 && escapeEndMarker > escapeStart, 'main process FFmpeg path-escape helper should exist');
const escapeFunctionSource = mainSource.slice(escapeStart, escapeEndMarker + 2);
const escapeContext = {};
vm.createContext(escapeContext);
vm.runInContext(`${escapeFunctionSource}\nthis.escapeFilterPath = escapeFilterPath;`, escapeContext);
const windowsTestPath = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\EZ Preview\lut,grade[1]'s.cube`;
assert.equal(
  escapeContext.escapeFilterPath(windowsTestPath),
  String.raw`C\:/Users/RUNNER~1/AppData/Local/Temp/EZ Preview/lut\,grade\[1\]\'s.cube`,
  'FFmpeg filter paths should escape drive colons, commas, quotes, and square brackets'
);

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-preview-png-export-'));
const source = path.join(tempDir, 'source.mp4');
const lutFileName = 'identity.cube';
const lut = path.join(tempDir, lutFileName);
const output = path.join(tempDir, 'graded-split.png');
const lutText = [
  'TITLE "Identity smoke test"',
  'LUT_3D_SIZE 2',
  'DOMAIN_MIN 0 0 0',
  'DOMAIN_MAX 1 1 1',
  '0 0 0', '1 0 0', '0 1 0', '1 1 0',
  '0 0 1', '1 0 1', '0 1 1', '1 1 1', ''
].join('\n');

function run(args, label, options = {}) {
  const result = spawnSync(ffmpegPath, args, {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    ...options
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed:\n${(result.stderr || `FFmpeg exited ${result.status}`).slice(-5000)}`);
  }
  return result;
}

try {
  run([
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=24:duration=1',
    '-c:v', 'libx264', '-preset', 'ultrafast', source
  ], 'PNG test source generation');

  fs.writeFileSync(lut, lutText, 'utf8');

  // Resolve the fixture LUT relative to cwd rather than embedding a Windows
  // absolute path inside filter_complex. This tests LUT/split rendering while
  // avoiding path-parser ambiguity in the test itself.
  const graph =
    `[0:v:0]crop=w='round(min(iw,ih*1.7777777777777777))':h='round(min(ih,iw/1.7777777777777777))':x='(iw-ow)/2':y='(ih-oh)/2'[cropped];` +
    `[cropped]split=2[original][gradeinput];` +
    `[gradeinput]lut3d=file='${lutFileName}':interp=trilinear[graded];` +
    `[original][graded]blend=all_expr='if(lt(X,W*0.5),B,A)'[composite];` +
    `[composite]drawbox=x='iw*0.5-iw*0.004444444/2':y=0:w='iw*0.004444444':h=ih:color=black@0.8:t=fill,` +
    `drawbox=x='iw*0.5-iw*0.002222222/2':y=0:w='iw*0.002222222':h=ih:color=0xf4ae36:t=fill[framed];` +
    `[framed]format=rgb48be[out]`;

  run([
    '-hide_banner', '-y', '-nostdin', '-ss', '0.5', '-i', source,
    '-filter_complex', graph, '-map', '[out]', '-frames:v', '1', '-an',
    '-c:v', 'png', '-compression_level', '6', '-pred', 'mixed', '-pix_fmt', 'rgb48be', output
  ], 'Original-resolution LUT/split PNG export', { cwd: tempDir });

  const stats = fs.statSync(output);
  if (stats.size < 1024) throw new Error('Generated PNG is unexpectedly small.');

  const inspected = run([
    '-hide_banner', '-i', output, '-vf', 'showinfo', '-frames:v', '1', '-f', 'null', '-'
  ], 'PNG dimension probe');
  const match = (inspected.stderr || '').match(/s:(\d+)x(\d+)/);
  if (!match || Number(match[1]) !== 1280 || Number(match[2]) !== 720) {
    throw new Error(`PNG does not preserve native dimensions: ${match ? `${match[1]}x${match[2]}` : 'unknown dimensions'}.`);
  }

  console.log(`PASS: FFmpeg filter path escaping handles Windows paths and special characters.`);
  console.log(`PASS: original-resolution LUT/split PNG export (${match[1]}x${match[2]}, 16-bit RGB PNG, ${stats.size.toLocaleString()} bytes).`);
} catch (error) {
  console.error(`PNG export smoke test failed: ${error.stack || error.message || error}`);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
