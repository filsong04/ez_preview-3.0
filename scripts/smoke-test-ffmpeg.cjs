'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let ffmpegPath = process.env.EZ_PREVIEW_FFMPEG || null;
if (!ffmpegPath) { try { ffmpegPath = require('ffmpeg-static'); } catch (_) {} }
if (!ffmpegPath || !fs.existsSync(ffmpegPath)) {
  console.error('FFmpeg binary was not found. Run npm install first.');
  process.exit(1);
}

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-preview-stage18-smoke-'));
const source = path.join(tempDir, 'source.mp4');

function run(args, label, timeout = 120000) {
  const result = spawnSync(ffmpegPath, args, { encoding: 'utf8', windowsHide: true, timeout });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${label} failed:\n${(result.stderr || `FFmpeg exited ${result.status}`).slice(-5000)}`);
  return result;
}

function probeVideoSize(filePath) {
  const result = run([
    '-hide_banner', '-y', '-i', filePath, '-map', '0:v:0', '-vf', 'showinfo',
    '-frames:v', '1', '-f', 'null', '-'
  ], `Video probe (${path.basename(filePath)})`);
  const match = (result.stderr || '').match(/s:(\d+)x(\d+)/);
  if (!match) throw new Error(`Could not read the generated video dimensions for ${path.basename(filePath)}.`);
  return { width: Number(match[1]), height: Number(match[2]) };
}

function verifyAudio(filePath) {
  run(['-hide_banner', '-v', 'error', '-i', filePath, '-map', '0:a:0', '-frames:a', '1', '-f', 'null', '-'], `Audio verification (${path.basename(filePath)})`);
}

try {
  run([
    '-hide_banner', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=2560x1440:rate=60:duration=1',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=1',
    '-shortest', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '128k', source
  ], 'Test source generation');

  for (const maxDimension of [960, 1920]) {
    const output = path.join(tempDir, `proxy-${maxDimension}.mp4`);
    run([
      '-hide_banner', '-y', '-nostdin', '-i', source,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-vf', `fps='min(30,source_fps)',scale=w='min(${maxDimension},iw)':h='min(${maxDimension},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '160k', '-ac', '2',
      '-movflags', '+faststart', output
    ], `Proxy conversion (${maxDimension}px)`);

    const stats = fs.statSync(output);
    if (stats.size < 1024) throw new Error(`Generated proxy at ${maxDimension}px is unexpectedly small.`);
    const dimensions = probeVideoSize(output);
    if (Math.max(dimensions.width, dimensions.height) > maxDimension) {
      throw new Error(`Generated proxy is larger than ${maxDimension}px: ${dimensions.width}x${dimensions.height}.`);
    }
    verifyAudio(output);
    console.log(`Proxy smoke test passed: ${dimensions.width}x${dimensions.height}, audio present, ${stats.size.toLocaleString()} bytes.`);
  }
} catch (error) {
  console.error(`Stage 18 native FFmpeg smoke test failed: ${error.message}`);
  process.exitCode = 1;
} finally {
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
}
