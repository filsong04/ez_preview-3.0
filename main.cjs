'use strict';

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');
const { randomUUID, createHash } = require('node:crypto');

let mainWindow = null;
let ffmpegPath = null;
let proxyDirectory = null;
const liveProcesses = new Set();
const activePreviewProcesses = new Map();
const runningPreviewJobs = new Set();
const cancelledPreviewJobs = new Set();
const PROXY_CACHE_LIMIT_BYTES = 8 * 1024 * 1024 * 1024;
const PROXY_CACHE_VERSION = 3;

function resolveFFmpegPath() {
  const executableName = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';
  const bundledPath = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', executableName)
    : path.join(__dirname, 'vendor', 'ffmpeg', executableName);

  if (fs.existsSync(bundledPath)) return bundledPath;

  // Explicit local override is useful for development and automated tests.
  // Packaged builds prefer the bundled executable above and should not depend on this.
  if (!app.isPackaged && process.env.EZ_PREVIEW_FFMPEG && fs.existsSync(process.env.EZ_PREVIEW_FFMPEG)) {
    return path.resolve(process.env.EZ_PREVIEW_FFMPEG);
  }

  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath) {
      const unpackedPath = staticPath.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`);
      if (app.isPackaged && unpackedPath !== staticPath && fs.existsSync(unpackedPath)) return unpackedPath;
      if (fs.existsSync(staticPath)) return staticPath;
      if (fs.existsSync(unpackedPath)) return unpackedPath;
    }
  } catch (error) {
    console.warn('ffmpeg-static was not resolved:', error.message);
  }

  // Helpful for development only. Release packages are expected to bundle FFmpeg.
  return process.env.EZ_PREVIEW_FFMPEG || null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 930,
    minWidth: 1050,
    minHeight: 680,
    backgroundColor: '#09090b',
    title: 'EZ Preview',
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true
    }
  });

  if (process.platform !== 'darwin') mainWindow.setMenuBarVisibility(false);
  mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const expectedUrl = pathToFileURL(path.join(__dirname, 'index.html')).href;
    if (navigationUrl !== expectedUrl) event.preventDefault();
  });
  mainWindow.loadFile(path.join(__dirname, 'index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

function sendProgress(sender, jobId, details) {
  if (sender && !sender.isDestroyed()) {
    sender.send('ez-native:conversion-progress', { jobId, ...details });
  }
}

function parseTimeToSeconds(timeText) {
  if (typeof timeText !== 'string') return null;
  const match = timeText.match(/^(\d+):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (!match) return null;
  const fractional = match[4] ? Number(`0.${match[4]}`) : 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + fractional;
}

function ensureProxyDirectory() {
  if (!proxyDirectory) {
    proxyDirectory = path.join(app.getPath('temp'), `EZPreview-${process.pid}-${randomUUID().slice(0, 8)}`);
  }
  fs.mkdirSync(proxyDirectory, { recursive: true });
  return proxyDirectory;
}

function getProxyCacheDirectory() {
  const root = path.join(app.getPath('userData'), 'proxy-cache');
  fs.mkdirSync(root, { recursive: true });
  return root;
}

function createProxyCacheKey(inputPath, inputStats, maxDimension, includeAudio) {
  const identity = {
    version: PROXY_CACHE_VERSION,
    path: path.resolve(inputPath),
    size: inputStats.size,
    mtimeMs: inputStats.mtimeMs,
    maxDimension,
    includeAudio
  };
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

async function getProxyCacheInfo() {
  const root = getProxyCacheDirectory();
  const names = await fs.promises.readdir(root).catch(() => []);
  let totalBytes = 0;
  let count = 0;
  const stalePartialCutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of names) {
    // Clean up abandoned conversion outputs after a crash or forced quit, but never
    // interfere with a recent in-progress conversion.
    if (/^[a-f0-9]{64}\.[a-f0-9-]{36}\.partial\.mp4$/i.test(name)) {
      const partialPath = path.join(root, name);
      const partialStats = await fs.promises.stat(partialPath).catch(() => null);
      if (partialStats && partialStats.mtimeMs < stalePartialCutoff) {
        await fs.promises.rm(partialPath, { force: true }).catch(() => {});
      }
      continue;
    }
    if (!/^[a-f0-9]{64}\.mp4$/i.test(name)) continue;
    const stats = await fs.promises.stat(path.join(root, name)).catch(() => null);
    if (!stats || !stats.isFile()) continue;
    count += 1;
    totalBytes += stats.size;
  }
  return { count, totalBytes, limitBytes: PROXY_CACHE_LIMIT_BYTES };
}

async function pruneProxyCache(keepPaths = []) {
  const root = getProxyCacheDirectory();
  const keep = new Set(keepPaths.filter(value => typeof value === 'string').map(value => path.resolve(value)));
  const names = await fs.promises.readdir(root).catch(() => []);
  const entries = [];
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.mp4$/i.test(name)) continue;
    const filePath = path.join(root, name);
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (stats && stats.isFile()) entries.push({ filePath, size: stats.size, touched: stats.mtimeMs });
  }
  let total = entries.reduce((sum, entry) => sum + entry.size, 0);
  entries.sort((a, b) => a.touched - b.touched);
  for (const entry of entries) {
    if (total <= PROXY_CACHE_LIMIT_BYTES) break;
    if (keep.has(path.resolve(entry.filePath))) continue;
    await fs.promises.rm(entry.filePath, { force: true }).catch(() => {});
    await fs.promises.rm(entry.filePath.replace(/\.mp4$/i, '.json'), { force: true }).catch(() => {});
    total -= entry.size;
  }
}

function parseMediaInfoFromFfmpeg(stderr, inputPath, inputStats) {
  const lines = String(stderr || '').split(/\r?\n/);
  const videoLine = lines.find(line => /Stream #\d+:\d+.*Video:/i.test(line));
  if (!videoLine) {
    const details = lines.filter(Boolean).slice(-10).join('\n');
    throw new Error(`FFmpeg could not read video stream metadata.${details ? `\n${details}` : ''}`);
  }
  const audioLine = lines.find(line => /Stream #\d+:\d+.*Audio:/i.test(line));
  const durationMatch = String(stderr || '').match(/Duration:\s*(\d+:\d{2}:\d{2}(?:\.\d+)?)/i);
  const formatMatch = String(stderr || '').match(/Input #0,\s*([^,\r\n]+)/i);
  const videoPart = videoLine.slice(videoLine.indexOf('Video:') + 6).trim();
  const videoFields = videoPart.split(',').map(value => value.trim());
  const resolutionMatch = videoPart.match(/(?:^|\s)(\d{2,6})x(\d{2,6})(?=\s|,|\[|$)/);
  const fpsMatch = videoPart.match(/(\d+(?:\.\d+)?)\s*fps/i) || videoPart.match(/(\d+(?:\.\d+)?)\s*tbr/i);
  const colorMatch = videoPart.match(/\b(bt709|bt2020(?:nc|c)?|smpte(?:170m|240m|2084|428|431|432)|bt470bg|bt470m|film)\b/i);
  let audioCodec = 'No audio track';
  let audioSampleRate = '';
  let audioChannels = '';
  if (audioLine) {
    const audioPart = audioLine.slice(audioLine.indexOf('Audio:') + 6).trim();
    const audioFields = audioPart.split(',').map(value => value.trim());
    audioCodec = audioFields[0] || 'Audio';
    audioSampleRate = (audioPart.match(/(\d{4,6})\s*Hz/i) || [])[1] || '';
    audioChannels = (audioPart.match(/(?:mono|stereo|[2-9]\.\d(?:\+\d)?(?:\(side\))?)/i) || [])[0] || '';
  }
  const stat = inputStats || {};
  const extension = path.extname(inputPath).replace(/^\./, '').toUpperCase() || 'UNKNOWN';
  return {
    fileName: path.basename(inputPath),
    extension,
    container: formatMatch ? formatMatch[1].trim() : extension,
    sizeBytes: Number(stat.size) || 0,
    modifiedAt: Number(stat.mtimeMs) || 0,
    durationSeconds: durationMatch ? parseTimeToSeconds(durationMatch[1]) : null,
    videoCodec: (videoFields[0] || 'Unknown').trim(),
    pixelFormat: (videoFields[1] || '').split(/[\s(]/)[0] || 'Unknown',
    width: resolutionMatch ? Number(resolutionMatch[1]) : null,
    height: resolutionMatch ? Number(resolutionMatch[2]) : null,
    fps: fpsMatch ? Number(fpsMatch[1]) : null,
    audioCodec,
    audioSampleRate,
    audioChannels,
    colorSpace: colorMatch ? colorMatch[1] : 'Not reported'
  };
}

function safeNumber(value, fallback, min, max) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

function lutLibraryPaths() {
  const root = path.join(app.getPath('userData'), 'lut-library');
  return { root, luts: path.join(root, 'luts'), preferences: path.join(root, 'preferences.json') };
}

function validateLutId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,120}$/.test(id)) {
    throw new Error('Invalid LUT library identifier.');
  }
  return id;
}

function validatePreferenceKey(key) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(key)) {
    throw new Error('Invalid LUT preference key.');
  }
  return key;
}

async function readJsonOrDefault(filePath, fallback) {
  try {
    return JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    if (error && error.code === 'ENOENT') return fallback;
    throw new Error(`Could not read EZ Preview LUT storage: ${error.message}`);
  }
}

async function writeJsonAtomically(filePath, data) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await fs.promises.writeFile(tempPath, JSON.stringify(data), { encoding: 'utf8', flag: 'wx' });
    await fs.promises.rename(tempPath, filePath);
  } finally {
    await fs.promises.rm(tempPath, { force: true }).catch(() => {});
  }
}

async function listUserLuts() {
  const paths = lutLibraryPaths();
  await fs.promises.mkdir(paths.luts, { recursive: true });
  const filenames = await fs.promises.readdir(paths.luts);
  const records = [];
  for (const filename of filenames) {
    if (!/^[a-zA-Z0-9_-]{1,120}\.json$/.test(filename)) continue;
    try {
      const record = JSON.parse(await fs.promises.readFile(path.join(paths.luts, filename), 'utf8'));
      if (record && typeof record.id === 'string' && `${record.id}.json` === filename && typeof record.text === 'string') records.push(record);
    } catch (error) {
      console.warn(`Skipping unreadable LUT record ${filename}:`, error.message);
    }
  }
  return records;
}

ipcMain.handle('ez-native:get-bundled-lut', async () => {
  const bundledPath = path.join(__dirname, 'assets', 'bundled-dji-dlogm.cube');
  try {
    return await fs.promises.readFile(bundledPath, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return '';
    throw error;
  }
});
ipcMain.handle('ez-native:lut-list', async () => listUserLuts());
ipcMain.handle('ez-native:lut-get', async (_event, id) => {
  validateLutId(id);
  const filePath = path.join(lutLibraryPaths().luts, `${id}.json`);
  return readJsonOrDefault(filePath, null);
});
ipcMain.handle('ez-native:lut-save', async (_event, record) => {
  if (!record || typeof record !== 'object') throw new Error('LUT record is missing.');
  const id = validateLutId(record.id);
  if (typeof record.name !== 'string' || !record.name.trim() || record.name.length > 512) throw new Error('The LUT filename is invalid.');
  if (typeof record.text !== 'string' || !record.text.trim() || Buffer.byteLength(record.text, 'utf8') > 32 * 1024 * 1024) throw new Error('The LUT data is missing or too large.');
  const parsed = parseCubeText(record.text);
  const stored = {
    id,
    name: path.basename(record.name),
    text: record.text,
    size: parsed.size,
    bytes: Number.isFinite(Number(record.bytes)) && Number(record.bytes) >= 0 ? Number(record.bytes) : Buffer.byteLength(record.text, 'utf8'),
    addedAt: Number.isFinite(Number(record.addedAt)) ? Number(record.addedAt) : Date.now(),
    ...(record.bundled === true ? { bundled: true } : {}),
    favorite: record.favorite === true
  };
  const filePath = path.join(lutLibraryPaths().luts, `${id}.json`);
  await writeJsonAtomically(filePath, stored);
  return stored;
});
ipcMain.handle('ez-native:lut-delete', async (_event, id) => {
  validateLutId(id);
  const filePath = path.join(lutLibraryPaths().luts, `${id}.json`);
  await fs.promises.rm(filePath, { force: true });
  return true;
});
ipcMain.handle('ez-native:lut-preference-get', async (_event, key) => {
  validatePreferenceKey(key);
  const preferences = await readJsonOrDefault(lutLibraryPaths().preferences, {});
  return Object.prototype.hasOwnProperty.call(preferences, key) ? preferences[key] : undefined;
});
ipcMain.handle('ez-native:lut-preference-set', async (_event, payload) => {
  if (!payload || typeof payload !== 'object') throw new Error('LUT preference is missing.');
  const key = validatePreferenceKey(payload.key);
  const paths = lutLibraryPaths();
  const preferences = await readJsonOrDefault(paths.preferences, {});
  preferences[key] = payload.value;
  await writeJsonAtomically(paths.preferences, preferences);
  return true;
});

function parseCubeText(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('The selected 3D LUT data is missing.');
  let size = null;
  const domainMin = [0, 0, 0];
  const domainMax = [1, 1, 1];
  const entries = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === 'TITLE' || key === 'DOMAIN_1D_MIN' || key === 'DOMAIN_1D_MAX') continue;
    if (key === 'LUT_1D_SIZE') throw new Error('Only 3D .cube LUTs can be used for original-resolution PNG export.');
    if (key === 'LUT_3D_SIZE') {
      size = Number.parseInt(parts[1], 10);
      if (!Number.isInteger(size) || size < 2 || size > 129) throw new Error('The 3D LUT size is invalid.');
      continue;
    }
    if (key === 'DOMAIN_MIN' || key === 'DOMAIN_MAX') {
      const values = parts.slice(1, 4).map(Number);
      if (values.length !== 3 || values.some(value => !Number.isFinite(value))) throw new Error(`${key} values are invalid.`);
      (key === 'DOMAIN_MIN' ? domainMin : domainMax).splice(0, 3, ...values);
      continue;
    }
    if (/^[+\-.\d]/.test(parts[0])) {
      const values = parts.slice(0, 3).map(Number);
      if (values.length !== 3 || values.some(value => !Number.isFinite(value))) throw new Error('The 3D LUT contains invalid numeric data.');
      entries.push(values);
    }
  }
  if (!size) throw new Error('LUT_3D_SIZE was not found in the selected LUT.');
  if (domainMax.some((value, index) => value <= domainMin[index])) throw new Error('The LUT domain is invalid.');
  if (entries.length !== size ** 3) throw new Error(`The LUT needs ${size ** 3} RGB entries but contains ${entries.length}.`);
  return { size, domainMin, domainMax, entries };
}

function buildExportCubeText(lutText, useLut, adjustmentInput) {
  const adjustments = {
    exposure: safeNumber(adjustmentInput && adjustmentInput.exposure, 0, -2, 2),
    contrast: safeNumber(adjustmentInput && adjustmentInput.contrast, 1, 0.5, 1.5),
    saturation: safeNumber(adjustmentInput && adjustmentInput.saturation, 1, 0, 2),
    temperature: safeNumber(adjustmentInput && adjustmentInput.temperature, 0, -100, 100),
    tint: safeNumber(adjustmentInput && adjustmentInput.tint, 0, -100, 100)
  };
  const hasAdjustments = Math.abs(adjustments.exposure) > 1e-6
    || Math.abs(adjustments.contrast - 1) > 1e-6
    || Math.abs(adjustments.saturation - 1) > 1e-6
    || Math.abs(adjustments.temperature) > 1e-6
    || Math.abs(adjustments.tint) > 1e-6;
  const cube = useLut ? parseCubeText(lutText) : {
    size: hasAdjustments ? 49 : 33,
    domainMin: [0, 0, 0],
    domainMax: [1, 1, 1],
    entries: []
  };
  if (!useLut) {
    for (let b = 0; b < cube.size; b++) {
      for (let g = 0; g < cube.size; g++) {
        for (let r = 0; r < cube.size; r++) cube.entries.push([r / (cube.size - 1), g / (cube.size - 1), b / (cube.size - 1)]);
      }
    }
  }

  const exposureMultiplier = Math.pow(2, adjustments.exposure);
  const temperature = Math.max(-1, Math.min(1, adjustments.temperature / 100));
  const tint = Math.max(-1, Math.min(1, adjustments.tint / 100));
  const contrast = adjustments.contrast;
  const saturation = adjustments.saturation;

  const transform = ([sourceR, sourceG, sourceB]) => {
    let r = sourceR * exposureMultiplier;
    let g = sourceG * exposureMultiplier;
    let b = sourceB * exposureMultiplier;
    r = (r - 0.5) * contrast + 0.5;
    g = (g - 0.5) * contrast + 0.5;
    b = (b - 0.5) * contrast + 0.5;
    r += temperature * 0.10 + tint * 0.035;
    g += -tint * 0.075;
    b += -temperature * 0.10 + tint * 0.035;
    const luminance = r * 0.2126 + g * 0.7152 + b * 0.0722;
    r = Math.max(0, Math.min(1, luminance + (r - luminance) * saturation));
    g = Math.max(0, Math.min(1, luminance + (g - luminance) * saturation));
    b = Math.max(0, Math.min(1, luminance + (b - luminance) * saturation));
    return [r, g, b];
  };

  let outputSize = cube.size;
  let transformedEntries;
  if (useLut && !hasAdjustments) {
    // No post-LUT adjustments active: preserve the exact source LUT grid without resampling loss.
    outputSize = cube.size;
    transformedEntries = cube.entries.map(([r, g, b]) => [
      Math.max(0, Math.min(1, r)),
      Math.max(0, Math.min(1, g)),
      Math.max(0, Math.min(1, b))
    ]);
  } else if (useLut) {
    // Bake the LUT plus adjustments into a 49^3 dense cube (fast bake + high accuracy).
    outputSize = 49;
    const maxIndex = cube.size - 1;
    const entryAt = (r, g, b) => cube.entries[b * cube.size * cube.size + g * cube.size + r];
    const sampleOriginalCube = (r, g, b) => {
      const coords = [r, g, b].map((value, i) => {
        const normalized = Math.max(0, Math.min(1, (value - cube.domainMin[i]) / (cube.domainMax[i] - cube.domainMin[i])));
        return normalized * maxIndex;
      });
      const low = coords.map(Math.floor);
      const high = low.map((v, i) => Math.min(maxIndex, v + 1));
      const f = coords.map((v, i) => v - low[i]);
      const c000 = entryAt(low[0], low[1], low[2]);
      const c100 = entryAt(high[0], low[1], low[2]);
      const c010 = entryAt(low[0], high[1], low[2]);
      const c110 = entryAt(high[0], high[1], low[2]);
      const c001 = entryAt(low[0], low[1], high[2]);
      const c101 = entryAt(high[0], low[1], high[2]);
      const c011 = entryAt(low[0], high[1], high[2]);
      const c111 = entryAt(high[0], high[1], high[2]);
      const lerp = (a, b, amount) => a + (b - a) * amount;
      return [0, 1, 2].map(channel => {
        const c00 = lerp(c000[channel], c100[channel], f[0]);
        const c10 = lerp(c010[channel], c110[channel], f[0]);
        const c01 = lerp(c001[channel], c101[channel], f[0]);
        const c11 = lerp(c011[channel], c111[channel], f[0]);
        return lerp(lerp(c00, c10, f[1]), lerp(c01, c11, f[1]), f[2]);
      });
    };
    transformedEntries = [];
    for (let b = 0; b < outputSize; b++) {
      for (let g = 0; g < outputSize; g++) {
        for (let r = 0; r < outputSize; r++) {
          const source = [r, g, b].map((index, i) => cube.domainMin[i] + index / (outputSize - 1) * (cube.domainMax[i] - cube.domainMin[i]));
          transformedEntries.push(transform(sampleOriginalCube(...source)));
        }
      }
    }
  } else {
    transformedEntries = cube.entries.map(transform);
  }

  const fmt = value => Number(value).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');
  const lines = [
    'TITLE "EZ Preview graded original-resolution frame"',
    `LUT_3D_SIZE ${outputSize}`,
    `DOMAIN_MIN ${cube.domainMin.map(fmt).join(' ')}`,
    `DOMAIN_MAX ${cube.domainMax.map(fmt).join(' ')}`
  ];
  for (const rgb of transformedEntries) lines.push(rgb.map(fmt).join(' '));
  return lines.join('\n') + '\n';
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/,/g, '\\,').replace(/'/g, "\\'").replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}

function cropFilterForAspect(aspectRatio) {
  const ratio = safeNumber(aspectRatio, 16 / 9, 0.1, 10);
  // Crop rather than resize: the output keeps the source's native pixel density.
  return `crop=w='round(min(iw,ih*${ratio}))':h='round(min(ih,iw/${ratio}))':x='(iw-ow)/2':y='(ih-oh)/2'`;
}

function splitDividerFilters(splitInput, orientation, previewWidth, previewHeight) {
  const split = splitInput || {};
  const position = safeNumber(split.position, 0.5, 0.03, 0.97);
  const thickness = safeNumber(split.thickness, 2, 1, 10);
  const color = typeof split.color === 'string' && /^#[0-9a-f]{6}$/i.test(split.color) ? `0x${split.color.slice(1)}` : '0xf4ae36';
  const isVertical = orientation !== 'horizontal';
  const frameDimension = safeNumber(isVertical ? previewWidth : previewHeight, 900, 1, 10000);
  const lineRatio = thickness / frameDimension;
  const outlineRatio = (thickness + 2) / frameDimension;
  if (isVertical) {
    return [
      `drawbox=x='iw*${position}-iw*${outlineRatio}/2':y=0:w='iw*${outlineRatio}':h=ih:color=black@0.8:t=fill`,
      `drawbox=x='iw*${position}-iw*${lineRatio}/2':y=0:w='iw*${lineRatio}':h=ih:color=${color}:t=fill`
    ];
  }
  return [
    `drawbox=x=0:y='ih*${position}-ih*${outlineRatio}/2':w=iw:h='ih*${outlineRatio}':color=black@0.8:t=fill`,
    `drawbox=x=0:y='ih*${position}-ih*${lineRatio}/2':w=iw:h='ih*${lineRatio}':color=${color}:t=fill`
  ];
}

ipcMain.handle('ez-native:proxy-cache-info', async () => getProxyCacheInfo());
ipcMain.handle('ez-native:proxy-cache-clear', async (_event, payload) => {
  const root = getProxyCacheDirectory();
  const keepPaths = Array.isArray(payload && payload.keepPaths) ? payload.keepPaths.filter(value => typeof value === 'string').map(value => path.resolve(value)) : [];
  const keep = new Set(keepPaths);
  const names = await fs.promises.readdir(root).catch(() => []);
  let removedCount = 0;
  let removedBytes = 0;
  for (const name of names) {
    if (!/^[a-f0-9]{64}\.mp4$/i.test(name)) continue;
    const filePath = path.join(root, name);
    if (keep.has(path.resolve(filePath))) continue;
    const stats = await fs.promises.stat(filePath).catch(() => null);
    if (stats && stats.isFile()) {
      await fs.promises.rm(filePath, { force: true });
      await fs.promises.rm(filePath.replace(/\.mp4$/i, '.json'), { force: true }).catch(() => {});
      removedCount += 1;
      removedBytes += stats.size;
    }
  }
  return { removedCount, removedBytes, ...(await getProxyCacheInfo()) };
});

ipcMain.handle('ez-native:file-metadata', async (_event, payload) => {
  const paths = Array.isArray(payload && payload.paths) ? payload.paths.slice(0, 5000) : [];
  const results = await Promise.all(paths.map(async inputPath => {
    if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) return null;
    const stats = await fs.promises.stat(path.resolve(inputPath)).catch(() => null);
    if (!stats || !stats.isFile()) return null;
    const createdAt = Number(stats.birthtimeMs);
    const modifiedAt = Number(stats.mtimeMs);
    const hasCreationTime = Number.isFinite(createdAt) && createdAt > 0;
    return {
      path: inputPath,
      createdAt: hasCreationTime ? createdAt : (Number.isFinite(modifiedAt) ? modifiedAt : 0),
      modifiedAt: Number.isFinite(modifiedAt) ? modifiedAt : 0,
      dateSource: hasCreationTime ? 'created' : 'modified'
    };
  }));
  return results.filter(Boolean);
});

ipcMain.handle('ez-native:probe-media', async (_event, payload) => {
  const inputPath = payload && payload.inputPath;
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) throw new Error('The selected media does not have a valid local path.');
  const inputStats = await fs.promises.stat(inputPath).catch(() => null);
  if (!inputStats || !inputStats.isFile()) throw new Error('The selected source file could not be accessed.');
  ffmpegPath = resolveFFmpegPath();
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error('The native FFmpeg executable is missing.');
  return await new Promise((resolve, reject) => {
    let child;
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      try { child && child.kill('SIGKILL'); } catch (_) {}
    }, 15000);
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error); else resolve(result);
    };
    try {
      child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-probesize', '20M', '-analyzeduration', '20M', '-i', inputPath], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      finish(new Error(`Could not start FFmpeg media probe: ${error.message}`));
      return;
    }
    liveProcesses.add(child);
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 48000) stderr = stderr.slice(-36000); });
    child.once('error', error => {
      liveProcesses.delete(child);
      finish(new Error(`FFmpeg media probe failed: ${error.message}`));
    });
    child.once('close', () => {
      liveProcesses.delete(child);
      try {
        const result = parseMediaInfoFromFfmpeg(stderr, inputPath, inputStats);
        if (timedOut && !result.width) throw new Error('Media probing timed out after 15 seconds.');
        finish(null, result);
      } catch (error) {
        finish(error);
      }
    });
  });
});

let hardwareEncoderProbe = null;
function getHardwareEncoderArgs(encoder, maxDimension) {
  if (encoder === 'h264_videotoolbox') return ['-c:v', encoder, '-b:v', maxDimension >= 1920 ? '5M' : '2M', '-allow_sw', '1'];
  if (encoder === 'h264_nvenc') return ['-c:v', encoder, '-preset', 'p1', '-rc', 'vbr', '-cq', '29', '-b:v', '0'];
  if (encoder === 'h264_qsv') return ['-c:v', encoder, '-preset', 'veryfast', '-global_quality', '29'];
  if (encoder === 'h264_amf') return ['-c:v', encoder, '-quality', 'speed', '-qp_i', '29', '-qp_p', '29'];
  return ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '29'];
}

function detectHardwareEncoder(executable) {
  if (hardwareEncoderProbe) return hardwareEncoderProbe;
  hardwareEncoderProbe = (async () => {
    const available = await new Promise(resolve => {
      let child;
      let output = '';
      let settled = false;
      const finish = value => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      };
      let timer;
      try {
        child = spawn(executable, ['-hide_banner', '-encoders'], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(''); }, 10000);
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        child.once('error', () => finish(''));
        child.once('close', () => finish(output));
      } catch (_) { finish(''); }
    });

    const platformCandidates = process.platform === 'darwin'
      ? ['h264_videotoolbox']
      : process.platform === 'win32'
        ? ['h264_nvenc', 'h264_qsv', 'h264_amf']
        : ['h264_nvenc', 'h264_qsv'];
    const candidates = platformCandidates.filter(name => new RegExp(`\\b${name}\\b`).test(available));

    // An FFmpeg build may list an encoder even when its GPU/runtime is unavailable.
    // Validate each candidate against a single synthetic frame before processing user media.
    for (const encoder of candidates) {
      const args = [
        '-hide_banner', '-loglevel', 'error', '-nostdin',
        '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=1:d=1',
        '-frames:v', '1', '-an',
        ...getHardwareEncoderArgs(encoder, 960),
        '-pix_fmt', 'yuv420p', '-f', 'null', '-'
      ];
      const works = await new Promise(resolve => {
        let child;
        let settled = false;
        const finish = value => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        };
        let timer;
        try {
          child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore'] });
          timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} finish(false); }, 8000);
          child.once('error', () => finish(false));
          child.once('close', code => finish(code === 0));
        } catch (_) { finish(false); }
      });
      if (works) return encoder;
    }
    return null;
  })().catch(error => {
    console.warn('Hardware encoder probe failed:', error.message);
    return null;
  });
  return hardwareEncoderProbe;
}

function runFfmpegWithProgress(executable, args, sender, jobId) {
  return new Promise(resolve => {
    let child;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let progressRecord = {};
    let settled = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      if (child) {
        liveProcesses.delete(child);
        const key = jobId == null ? '' : String(jobId);
        if (key && activePreviewProcesses.get(key) === child) activePreviewProcesses.delete(key);
      }
      resolve({ ...result, stderr: stderrBuffer });
    };
    try {
      child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      finish({ error: new Error(`Could not start native FFmpeg: ${error.message}`), code: null, signal: null });
      return;
    }
    liveProcesses.add(child);
    const previewJobKey = jobId == null ? '' : String(jobId);
    if (previewJobKey) activePreviewProcesses.set(previewJobKey, child);
    if (previewJobKey.startsWith('queue-')) {
      // Best-effort lower CPU scheduling priority so cache preparation is less intrusive.
      try {
        const priority = process.platform === 'win32'
          ? os.constants.priority.PRIORITY_BELOW_NORMAL
          : os.constants.priority.PRIORITY_LOW;
        if (Number.isInteger(priority)) os.setPriority(child.pid, priority);
      } catch (_) {}
    }
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdoutBuffer += chunk;
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() || '';
      for (const line of lines) {
        const separator = line.indexOf('=');
        if (separator <= 0) continue;
        progressRecord[line.slice(0, separator)] = line.slice(separator + 1);
        if (line.startsWith('progress=')) {
          const outTime = progressRecord.out_time || '';
          sendProgress(sender, jobId, {
            frame: Number(progressRecord.frame) || 0,
            fps: progressRecord.fps || '',
            speed: progressRecord.speed || '',
            outTime,
            outSeconds: parseTimeToSeconds(outTime),
            status: progressRecord.progress
          });
          progressRecord = {};
        }
      }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderrBuffer += chunk;
      if (stderrBuffer.length > 24000) stderrBuffer = stderrBuffer.slice(-18000);
    });
    child.once('error', error => finish({ error: new Error(`Could not start native FFmpeg: ${error.message}`), code: null, signal: null }));
    child.once('close', (code, signal) => finish({ code, signal }));
  });
}

async function handleConvertPreview(event, payload) {
  const inputPath = payload && payload.inputPath;
  const jobId = payload && payload.jobId;
  const jobKey = jobId == null ? '' : String(jobId);
  if (jobKey && cancelledPreviewJobs.has(jobKey)) throw new Error('Preview conversion was canceled.');
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) throw new Error('The selected video does not have a valid local file path.');
  const inputStats = await fs.promises.stat(inputPath).catch(() => null);
  if (!inputStats || !inputStats.isFile()) throw new Error('The selected source file could not be accessed. Re-select the video and retry.');

  ffmpegPath = resolveFFmpegPath();
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error('The native FFmpeg executable is missing. Install project dependencies and rebuild the app so the FFmpeg binary is bundled.');

  const maxDimension = [960, 1920].includes(Number(payload && payload.maxDimension)) ? Number(payload.maxDimension) : 960;
  const includeAudio = !(payload && payload.includeAudio === false);
  const cacheRoot = getProxyCacheDirectory();
  const cacheKey = createProxyCacheKey(inputPath, inputStats, maxDimension, includeAudio);
  const destination = path.join(cacheRoot, `${cacheKey}.mp4`);
  const metadataPath = path.join(cacheRoot, `${cacheKey}.json`);

  try {
    const [cachedStats, cachedMeta] = await Promise.all([
      fs.promises.stat(destination),
      fs.promises.readFile(metadataPath, 'utf8').then(JSON.parse)
    ]);
    if (cachedStats.isFile() && cachedStats.size >= 1024
      && cachedMeta.cacheKey === cacheKey
      && cachedMeta.sourcePath === path.resolve(inputPath)
      && cachedMeta.sourceSize === inputStats.size
      && cachedMeta.sourceMtimeMs === inputStats.mtimeMs
      && cachedMeta.maxDimension === maxDimension
      && cachedMeta.includeAudio === includeAudio
      && cachedMeta.cacheVersion === PROXY_CACHE_VERSION
      && cachedMeta.outputBytes === cachedStats.size) {
      if (jobKey && cancelledPreviewJobs.has(jobKey)) throw new Error('Preview conversion was canceled.');
      const now = new Date();
      await fs.promises.utimes(destination, now, now).catch(() => {});
      return { outputPath: destination, outputUrl: pathToFileURL(destination).href, outputBytes: cachedStats.size, cached: true, encoder: cachedMeta.encoder || 'cached', maxDimension, includeAudio };
    }
  } catch (_) {}
  await fs.promises.rm(destination, { force: true }).catch(() => {});
  await fs.promises.rm(metadataPath, { force: true }).catch(() => {});

  const temporaryDestination = path.join(cacheRoot, `${cacheKey}.${randomUUID()}.partial.mp4`);
  const hardwareEncoder = await detectHardwareEncoder(ffmpegPath);
  if (jobKey && cancelledPreviewJobs.has(jobKey)) {
    await fs.promises.rm(temporaryDestination, { force: true }).catch(() => {});
    throw new Error('Preview conversion was canceled.');
  }
  const makeArgs = encoder => [
    '-hide_banner', '-y', '-nostdin',
    '-i', inputPath,
    '-map', '0:v:0',
    ...(includeAudio ? ['-map', '0:a:0?'] : ['-an']),
    '-vf', `fps='min(30,source_fps)',scale=w='min(${maxDimension},iw)':h='min(${maxDimension},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`,
    ...getHardwareEncoderArgs(encoder, maxDimension),
    '-pix_fmt', 'yuv420p',
    ...(includeAudio ? ['-c:a', 'aac', '-b:a', '160k', '-ac', '2'] : []),
    '-movflags', '+faststart',
    '-progress', 'pipe:1', '-nostats',
    temporaryDestination
  ];

  let activeEncoder = hardwareEncoder || 'libx264';
  let conversion = await runFfmpegWithProgress(ffmpegPath, makeArgs(activeEncoder), event.sender, jobId);
  if (jobKey && cancelledPreviewJobs.has(jobKey)) {
    await fs.promises.rm(temporaryDestination, { force: true }).catch(() => {});
    throw new Error('Preview conversion was canceled.');
  }
  if ((conversion.error || conversion.code !== 0) && activeEncoder !== 'libx264') {
    const hardwareFailure = conversion.error?.message || conversion.stderr.split(/\r?\n/).filter(Boolean).slice(-8).join('\n');
    console.warn(`Hardware encoder ${activeEncoder} failed; retrying with libx264.`, hardwareFailure);
    hardwareEncoderProbe = Promise.resolve(null);
    await fs.promises.rm(temporaryDestination, { force: true }).catch(() => {});
    sendProgress(event.sender, jobId, { frame: 0, fps: '', speed: '', outTime: '', outSeconds: null, status: 'retrying-software' });
    activeEncoder = 'libx264';
    conversion = await runFfmpegWithProgress(ffmpegPath, makeArgs(activeEncoder), event.sender, jobId);
    if (jobKey && cancelledPreviewJobs.has(jobKey)) {
      await fs.promises.rm(temporaryDestination, { force: true }).catch(() => {});
      throw new Error('Preview conversion was canceled.');
    }
  }

  try {
    if (conversion.error) throw conversion.error;
    if (conversion.code !== 0) {
      const details = String(conversion.stderr || '').split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
      throw new Error(`FFmpeg stopped with ${conversion.signal ? `signal ${conversion.signal}` : `exit code ${conversion.code}`}.${details ? `\n\n${details}` : ''}`);
    }
    const stats = await fs.promises.stat(temporaryDestination).catch(() => null);
    if (!stats || !stats.isFile() || stats.size < 1024) throw new Error('FFmpeg finished, but the preview output is empty or incomplete.');
    if (jobKey && cancelledPreviewJobs.has(jobKey)) throw new Error('Preview conversion was canceled.');
    await fs.promises.rename(temporaryDestination, destination);
    const finalStats = await fs.promises.stat(destination);
    const metadata = {
      cacheKey,
      sourcePath: path.resolve(inputPath),
      sourceSize: inputStats.size,
      sourceMtimeMs: inputStats.mtimeMs,
      maxDimension,
      includeAudio,
      encoder: activeEncoder,
      outputBytes: finalStats.size,
      createdAt: Date.now(),
      cacheVersion: PROXY_CACHE_VERSION
    };
    const metadataTemp = `${metadataPath}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(metadataTemp, JSON.stringify(metadata), { encoding: 'utf8', flag: 'wx' });
      await fs.promises.rename(metadataTemp, metadataPath);
    } finally {
      await fs.promises.rm(metadataTemp, { force: true }).catch(() => {});
    }
    await pruneProxyCache([destination]);
    return { outputPath: destination, outputUrl: pathToFileURL(destination).href, outputBytes: finalStats.size, cached: false, encoder: activeEncoder, maxDimension, includeAudio };
  } catch (error) {
    await fs.promises.rm(temporaryDestination, { force: true }).catch(() => {});
    throw error;
  }
}

ipcMain.handle('ez-native:convert-preview', async (event, payload) => {
  const suppliedJobId = payload && payload.jobId;
  const jobKey = suppliedJobId == null ? '' : String(suppliedJobId);
  if (jobKey) {
    cancelledPreviewJobs.delete(jobKey);
    runningPreviewJobs.add(jobKey);
  }
  try {
    return await handleConvertPreview(event, payload);
  } finally {
    if (jobKey) {
      runningPreviewJobs.delete(jobKey);
      cancelledPreviewJobs.delete(jobKey);
      activePreviewProcesses.delete(jobKey);
    }
  }
});

ipcMain.handle('ez-native:cancel-preview-conversion', async (_event, payload) => {
  const jobId = payload && payload.jobId;
  if (jobId == null) return { cancelled: false, reason: 'missing-job-id' };
  const jobKey = String(jobId);
  if (!runningPreviewJobs.has(jobKey)) return { cancelled: false, reason: 'not-running' };
  cancelledPreviewJobs.add(jobKey);
  const child = activePreviewProcesses.get(jobKey);
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  return { cancelled: true, processTerminated: !!child };
});

ipcMain.handle('ez-native:export-original-frame', async (event, payload) => {
  const inputPath = payload && payload.inputPath;
  if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) throw new Error('The selected source file does not have a valid local path.');
  const inputStats = await fs.promises.stat(inputPath).catch(() => null);
  if (!inputStats || !inputStats.isFile()) throw new Error('The original source file could not be accessed. Re-select the video and retry.');

  ffmpegPath = resolveFFmpegPath();
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error('The native FFmpeg executable is missing. Reinstall the app with its bundled FFmpeg engine.');

  const timeSeconds = safeNumber(payload && payload.timeSeconds, 0, 0, 1e8);
  const sourceBase = path.basename(typeof payload.sourceName === 'string' ? payload.sourceName : 'EZ_preview').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'EZ_preview';
  const timeLabel = `${Math.round(timeSeconds * 1000)}ms`;
  const defaultPath = path.join(app.getPath('pictures'), `${sourceBase}_${timeLabel}_original.png`);
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) || null;
  const saveDialogOptions = {
    title: 'Export original-resolution PNG',
    defaultPath,
    buttonLabel: 'Export PNG',
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  };
  const saveResult = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, saveDialogOptions)
    : await dialog.showSaveDialog(saveDialogOptions);
  if (saveResult.canceled || !saveResult.filePath) return { cancelled: true };
  const outputPath = /\.png$/i.test(saveResult.filePath) ? saveResult.filePath : `${saveResult.filePath}.png`;

  let cubePath = null;
  let renderPath = null;
  try {
    const grade = payload && payload.grade && typeof payload.grade === 'object' ? payload.grade : {};
    const gradeEnabled = grade.enabled === true;
    const useLut = gradeEnabled && grade.useLut === true;
    let lutFilter = null;
    if (gradeEnabled) {
      const cubeText = buildExportCubeText(grade.lutText || '', useLut, grade.adjustments || {});
      cubePath = path.join(ensureProxyDirectory(), `export-grade-${randomUUID()}.cube`);
      await fs.promises.writeFile(cubePath, cubeText, 'utf8');
      lutFilter = `lut3d=file='${escapeFilterPath(cubePath)}':interp=trilinear`;
    }

    const split = payload && payload.split && typeof payload.split === 'object' ? payload.split : {};
    const splitEnabled = gradeEnabled && split.enabled === true;
    const orientation = split.orientation === 'horizontal' ? 'horizontal' : 'vertical';
    const position = safeNumber(split.position, 0.5, 0.03, 0.97);
    const invert = split.invert === true;
    const crop = cropFilterForAspect(payload && payload.aspectRatio);
    const filters = [`[0:v:0]${crop}[cropped]`];

    if (splitEnabled && lutFilter) {
      const axis = orientation === 'vertical' ? 'X' : 'Y';
      const extent = orientation === 'vertical' ? 'W' : 'H';
      const first = invert ? 'A' : 'B';
      const second = invert ? 'B' : 'A';
      filters.push(`[cropped]split=2[original][gradeinput]`);
      filters.push(`[gradeinput]${lutFilter}[graded]`);
      filters.push(`[original][graded]blend=all_expr='if(lt(${axis},${extent}*${position}),${first},${second})'[composite]`);
      const dividerFilters = splitDividerFilters(split, orientation, payload.previewFrameWidth, payload.previewFrameHeight);
      filters.push(`[composite]${dividerFilters.join(',')}[framed]`);
      filters.push(`[framed]format=rgb24[out]`);
    } else if (gradeEnabled && lutFilter) {
      filters.push(`[cropped]${lutFilter},format=rgb24[out]`);
    } else {
      filters.push(`[cropped]format=rgb24[out]`);
    }

    renderPath = path.join(ensureProxyDirectory(), `original-frame-${randomUUID()}.png`);
    const args = [
      '-hide_banner', '-y', '-nostdin',
      '-ss', String(timeSeconds), '-i', inputPath,
      '-filter_complex', filters.join(';'),
      '-map', '[out]', '-frames:v', '1',
      '-an', '-c:v', 'png', '-compression_level', '2', '-pred', 'sub', '-pix_fmt', 'rgb24',
      renderPath
    ];

    await new Promise((resolve, reject) => {
      let child;
      let stderr = '';
      let didSettle = false;
      const finishError = error => {
        if (didSettle) return;
        didSettle = true;
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      try {
        child = spawn(ffmpegPath, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      } catch (error) {
        finishError(new Error(`Could not start FFmpeg for PNG export: ${error.message}`));
        return;
      }
      liveProcesses.add(child);
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => {
        stderr += chunk;
        if (stderr.length > 30000) stderr = stderr.slice(-22000);
      });
      child.once('error', error => {
        liveProcesses.delete(child);
        finishError(new Error(`FFmpeg PNG export could not start: ${error.message}`));
      });
      child.once('close', (code, signal) => {
        liveProcesses.delete(child);
        if (didSettle) return;
        if (code !== 0) {
          const details = stderr.split(/\r?\n/).filter(Boolean).slice(-24).join('\n');
          finishError(new Error(`Original-resolution PNG export failed (${signal ? `signal ${signal}` : `exit code ${code}`}).${details ? `\n\n${details}` : ''}`));
          return;
        }
        didSettle = true;
        resolve();
      });
    });
    const renderedStats = await fs.promises.stat(renderPath).catch(() => null);
    if (!renderedStats || !renderedStats.isFile() || renderedStats.size < 128) throw new Error('FFmpeg completed but the PNG file is missing or incomplete.');
    await fs.promises.copyFile(renderPath, outputPath);
    const outputStats = await fs.promises.stat(outputPath);
    if (!outputStats.isFile() || outputStats.size < 128) throw new Error('The saved PNG file is missing or incomplete.');
    return { cancelled: false, outputPath, outputBytes: outputStats.size, bitDepth: 8 };
  } finally {
    if (cubePath) await fs.promises.rm(cubePath, { force: true }).catch(() => {});
    if (renderPath) await fs.promises.rm(renderPath, { force: true }).catch(() => {});
  }
});

ipcMain.handle('ez-native:save-snapshot-png', async (event, payload) => {
  const raw = payload && payload.data;
  let imageBytes;
  if (Buffer.isBuffer(raw)) imageBytes = raw;
  else if (raw instanceof ArrayBuffer) imageBytes = Buffer.from(new Uint8Array(raw));
  else if (ArrayBuffer.isView(raw)) imageBytes = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
  else if (Array.isArray(raw) && raw.length <= 256 * 1024 * 1024) imageBytes = Buffer.from(raw);
  else throw new Error('Preview capture data is missing or invalid.');

  if (imageBytes.length < 64 || imageBytes.length > 256 * 1024 * 1024) {
    throw new Error('Preview PNG size is invalid or exceeds the 256 MB safety limit.');
  }
  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!imageBytes.subarray(0, 8).equals(pngSignature)) throw new Error('The preview capture is not a valid PNG image.');

  const sourceBase = path.basename(typeof payload.sourceName === 'string' ? payload.sourceName : 'EZ_preview')
    .replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]/g, '_') || 'EZ_preview';
  const timeSeconds = safeNumber(payload.timeSeconds, 0, 0, 1e8);
  const timeLabel = `${Math.round(timeSeconds * 1000)}ms`;
  const defaultPath = path.join(app.getPath('pictures'), `${sourceBase}_${timeLabel}_preview.png`);
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) || null;
  const options = {
    title: 'Save preview capture as PNG',
    defaultPath,
    buttonLabel: 'Save PNG',
    filters: [{ name: 'PNG Image', extensions: ['png'] }]
  };
  const saveResult = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, options)
    : await dialog.showSaveDialog(options);
  if (saveResult.canceled || !saveResult.filePath) return { cancelled: true };

  const outputPath = /\.png$/i.test(saveResult.filePath) ? saveResult.filePath : `${saveResult.filePath}.png`;
  await fs.promises.writeFile(outputPath, imageBytes);
  const outputStats = await fs.promises.stat(outputPath);
  if (!outputStats.isFile() || outputStats.size !== imageBytes.length) {
    await fs.promises.rm(outputPath, { force: true }).catch(() => {});
    throw new Error('The preview PNG was not saved completely.');
  }
  return { cancelled: false, outputPath, outputBytes: outputStats.size, bitDepth: 8, previewCapture: true };
});


function buildSequenceExportGraph(clips, options = {}) {
  const outW = safeNumber(options.width, 1920, 320, 3840);
  const outH = safeNumber(options.height, 1080, 180, 2160);
  const fps = safeNumber(options.fps, 24, 12, 60);
  const includeAudio = options.includeAudio !== false;
  const lutFilter = typeof options.lutFilter === 'string' && options.lutFilter ? options.lutFilter : null;

  const inputArgs = [];
  const filters = [];
  const durations = [];

  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i];
    const inPt = Math.max(0, Number(clip.inPoint) || 0);
    const clipDur = Math.max(0.1, Number(clip.duration) || 1);
    durations.push(clipDur);
    inputArgs.push('-ss', inPt.toFixed(4), '-t', clipDur.toFixed(4), '-i', clip.inputPath);
    filters.push(
      `[${i}:v:0]scale=${outW}:${outH}:force_original_aspect_ratio=decrease,pad=${outW}:${outH}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=${fps},format=yuv420p,setpts=PTS-STARTPTS,settb=AVTB[v${i}]`
    );
    if (includeAudio) {
      if (clip.hasAudio) {
        filters.push(`[${i}:a:0]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${i}]`);
      } else {
        filters.push(`anullsrc=r=48000:cl=stereo,atrim=0:${clipDur.toFixed(4)},asetpts=PTS-STARTPTS[a${i}]`);
      }
    }
  }

  let curV = 'v0';
  let curA = 'a0';
  let runningDuration = durations[0];

  for (let i = 0; i < clips.length - 1; i++) {
    const nextIdx = i + 1;
    const rawOv = clips[i].transition === 'dissolve' ? (Number(clips[i].dissolveSec) || 0.5) : 0;
    const ov = rawOv > 0 ? Math.max(0, Math.min(rawOv, durations[i] * 0.45, durations[nextIdx] * 0.45)) : 0;
    const nextV = `vx${nextIdx}`;
    const nextA = `ax${nextIdx}`;

    if (ov > 0.02) {
      const xfadeOffset = Math.max(0, runningDuration - ov);
      filters.push(`[${curV}][v${nextIdx}]xfade=transition=fade:duration=${ov.toFixed(4)}:offset=${xfadeOffset.toFixed(4)},settb=AVTB[${nextV}]`);
      if (includeAudio) {
        filters.push(`[${curA}][a${nextIdx}]acrossfade=d=${ov.toFixed(4)}:c1=tri:c2=tri[${nextA}]`);
      }
      runningDuration = xfadeOffset + durations[nextIdx];
    } else {
      filters.push(`[${curV}][v${nextIdx}]concat=n=2:v=1:a=0,settb=AVTB[${nextV}]`);
      if (includeAudio) {
        filters.push(`[${curA}][a${nextIdx}]concat=n=2:v=0:a=1[${nextA}]`);
      }
      runningDuration += durations[nextIdx];
    }
    curV = nextV;
    curA = nextA;
  }

  if (lutFilter) {
    filters.push(`[${curV}]${lutFilter},format=yuv420p[vout]`);
    curV = 'vout';
  }

  return { inputArgs, filterComplex: filters.join(';'), videoMap: `[${curV}]`, audioMap: includeAudio ? `[${curA}]` : null, expectedDuration: runningDuration };
}

async function probeHasAudioStream(executable, inputPath) {
  return await new Promise(resolve => {
    let child;
    let stderr = '';
    let settled = false;
    const done = val => { if (settled) return; settled = true; clearTimeout(timer); resolve(val); };
    const timer = setTimeout(() => { try { child && child.kill('SIGKILL'); } catch (_) {} done(false); }, 8000);
    try {
      child = spawn(executable, ['-hide_banner', '-nostdin', '-i', inputPath], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { stderr += chunk; if (stderr.length > 24000) stderr = stderr.slice(-18000); });
      child.once('error', () => done(false));
      child.once('close', () => done(/Stream #\d+:\d+.*Audio:/i.test(stderr)));
    } catch (_) { done(false); }
  });
}

ipcMain.handle('ez-native:export-sequence-mp4', async (event, payload) => {
  const rawClips = Array.isArray(payload && payload.clips) ? payload.clips.slice(0, 50) : [];
  if (rawClips.length < 2) throw new Error('At least 2 clips are required to export a sequence.');

  ffmpegPath = resolveFFmpegPath();
  if (!ffmpegPath || !fs.existsSync(ffmpegPath)) throw new Error('The native FFmpeg executable is missing.');

  const verifiedClips = [];
  for (const clip of rawClips) {
    const inputPath = clip && clip.inputPath;
    if (typeof inputPath !== 'string' || !path.isAbsolute(inputPath)) throw new Error('Every sequence clip must have a valid local file path.');
    const stat = await fs.promises.stat(inputPath).catch(() => null);
    if (!stat || !stat.isFile()) throw new Error(`Could not access sequence clip: ${path.basename(inputPath)}`);
    const inPoint = Math.max(0, Number(clip.inPoint) || 0);
    const outPoint = Number(clip.outPoint);
    const duration = Number.isFinite(outPoint) && outPoint > inPoint + 0.1 ? (outPoint - inPoint) : Math.max(0.1, Number(clip.duration) || 5);
    const hasAudio = await probeHasAudioStream(ffmpegPath, inputPath);
    verifiedClips.push({
      inputPath,
      inPoint,
      duration,
      transition: clip.transition === 'dissolve' ? 'dissolve' : 'cut',
      dissolveSec: safeNumber(clip.dissolveSec, 0.5, 0.1, 5),
      hasAudio
    });
  }

  const defaultName = `EZ_Sequence_${verifiedClips.length}clips.mp4`;
  const defaultPath = path.join(app.getPath('videos') || app.getPath('pictures'), defaultName);
  const ownerWindow = BrowserWindow.fromWebContents(event.sender) || null;
  const saveOptions = {
    title: 'Export Sequence MP4',
    defaultPath,
    buttonLabel: 'Export MP4',
    filters: [{ name: 'MP4 Video', extensions: ['mp4'] }]
  };
  const saveResult = ownerWindow
    ? await dialog.showSaveDialog(ownerWindow, saveOptions)
    : await dialog.showSaveDialog(saveOptions);
  if (saveResult.canceled || !saveResult.filePath) return { cancelled: true };
  const outputPath = /\.mp4$/i.test(saveResult.filePath) ? saveResult.filePath : `${saveResult.filePath}.mp4`;

  let cubePath = null;
  let renderPath = null;
  try {
    const grade = payload && payload.grade && typeof payload.grade === 'object' ? payload.grade : {};
    const gradeEnabled = grade.enabled === true;
    const useLut = gradeEnabled && grade.useLut === true;
    let lutFilter = null;
    if (gradeEnabled) {
      const cubeText = buildExportCubeText(grade.lutText || '', useLut, grade.adjustments || {});
      cubePath = path.join(ensureProxyDirectory(), `seq-grade-${randomUUID()}.cube`);
      await fs.promises.writeFile(cubePath, cubeText, 'utf8');
      lutFilter = `lut3d=file='${escapeFilterPath(cubePath)}':interp=trilinear`;
    }

    const anyAudio = verifiedClips.some(c => c.hasAudio);
    const graph = buildSequenceExportGraph(verifiedClips, {
      width: payload && payload.width ? Number(payload.width) : 1920,
      height: payload && payload.height ? Number(payload.height) : 1080,
      fps: payload && payload.fps ? Number(payload.fps) : 24,
      includeAudio: anyAudio,
      lutFilter
    });

    renderPath = path.join(ensureProxyDirectory(), `sequence-export-${randomUUID()}.mp4`);
    const args = [
      '-hide_banner', '-y', '-nostdin',
      ...graph.inputArgs,
      '-filter_complex', graph.filterComplex,
      '-map', graph.videoMap,
      ...(graph.audioMap ? ['-map', graph.audioMap] : ['-an']),
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '20', '-pix_fmt', 'yuv420p',
      ...(graph.audioMap ? ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'] : []),
      '-movflags', '+faststart',
      renderPath
    ];

    const result = await runFfmpegWithProgress(ffmpegPath, args, event.sender, `seq-export-${Date.now()}`);
    if (result.error) throw result.error;
    if (result.code !== 0) {
      const details = String(result.stderr || '').split(/\r?\n/).filter(Boolean).slice(-20).join('\n');
      throw new Error(`Sequence MP4 export failed (exit code ${result.code}).${details ? `\n\n${details}` : ''}`);
    }
    const renderedStats = await fs.promises.stat(renderPath).catch(() => null);
    if (!renderedStats || !renderedStats.isFile() || renderedStats.size < 1024) {
      throw new Error('FFmpeg completed but the exported MP4 is missing or incomplete.');
    }
    await fs.promises.copyFile(renderPath, outputPath);
    const outputStats = await fs.promises.stat(outputPath);
    return { cancelled: false, outputPath, outputBytes: outputStats.size, durationSeconds: graph.expectedDuration };
  } finally {
    if (cubePath) await fs.promises.rm(cubePath, { force: true }).catch(() => {});
    if (renderPath) await fs.promises.rm(renderPath, { force: true }).catch(() => {});
  }
});

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  for (const child of liveProcesses) {
    try { child.kill(); } catch (_) {}
  }
  liveProcesses.clear();
  if (proxyDirectory) {
    try { fs.rmSync(proxyDirectory, { recursive: true, force: true }); } catch (_) {}
  }
});
