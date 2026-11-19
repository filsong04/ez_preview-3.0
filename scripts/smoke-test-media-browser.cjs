'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const htmlPath = path.join(__dirname, '..', 'index.html');
const html = fs.readFileSync(htmlPath, 'utf8');
const inline = html.match(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/i)?.[1];
assert.ok(inline, 'renderer inline script should exist');
const start = inline.indexOf('  function mediaFolderDescriptor(item) {');
const end = inline.indexOf('  function updateProxyQueueUI() {', start);
assert.ok(start >= 0 && end > start, 'folder browser renderer functions should exist');

class FakeNode {
  constructor(tagName = 'div') {
    this.tagName = tagName; this.children = []; this.attributes = {}; this.dataset = {};
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
    this.listeners = {}; this.className = ''; this.textContent = ''; this.title = ''; this.disabled = false;
  }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = [...children]; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(key, callback) { this.listeners[key] = callback; }
  click() { this.listeners.click?.({ stopPropagation() {} }); }
}
const elements = Object.fromEntries([
  'mediaBinList', 'mediaBinCount', 'mediaBinSubtitle', 'mediaFolderTree', 'mediaFolderAllBtn',
  'mediaClipFolderName', 'mediaClipCount'
].map(id => [id, new FakeNode()]));
const state = {
  mediaItems: [
    { id: 'a', createdAt: 100, file: { name: 'DJI_0001_LONG_NAME.mp4', size: 123456, lastModified: 1 }, path: '/media/Footage/A/DJI_0001_LONG_NAME.mp4', relativePath: 'Footage/A/DJI_0001_LONG_NAME.mp4', rootKey: '/media/Footage', proxyStatus: 'ready', proxyBytes: 111000, proxyMaxDimension: 960, info: { width: 1920, height: 1080, fps: 29.97, durationSeconds: 12 } },
    { id: 'b', createdAt: 300, file: { name: 'DJI_0002.mxf', size: 222222, lastModified: 1 }, path: '/media/Footage/B/DJI_0002.mxf', relativePath: 'Footage/B/DJI_0002.mxf', rootKey: '/media/Footage', proxyStatus: 'queued' },
    { id: 'c', createdAt: 200, file: { name: 'Loose Clip.mov', size: 3333, lastModified: 1 }, path: '/media/Loose Clip.mov', relativePath: '', rootKey: '__imported_files__', proxyStatus: 'queued' }
  ], currentMediaId: 'a', selectedMediaFolder: null, mediaSort: 'name-asc'
};
const context = {
  state, document: { createElement: tag => new FakeNode(tag) }, $: id => elements[id],
  fmtBytes: n => `${Math.round(n)} B`, fileExtension: file => (file?.name?.match(/\.([^.]+)$/)?.[1] || 'unknown').toUpperCase(),
  timecode: n => String(n), updateProxyQueueUI() {}, findMediaItem: id => state.mediaItems.find(item => item.id === id) || null,
  yieldProxyQueueForPriorityWork: async () => {}, scheduleProxyQueue() {}, toast() {}, activateMediaItem() {}, console
};
vm.createContext(context);
vm.runInContext(`${inline.slice(start, end)}\nthis.renderMediaBin = renderMediaBin; this.mediaFolderModel = mediaFolderModel;`, context);
context.renderMediaBin();

const allNames = elements.mediaBinList.children.map(row => row.children[0].children[0].textContent);
assert.equal(allNames.length, 3, 'all clips should be shown initially');
assert.ok(allNames.includes('DJI_0001_LONG_NAME.mp4'), 'long filename should be visible');
assert.ok(allNames.includes('Loose Clip.mov'), 'loose files should be grouped separately');
const folderRows = elements.mediaFolderTree.children;
assert.ok(folderRows.some(row => row.children[1]?.textContent === 'Footage'), 'imported root folder should appear');
const subfolderA = folderRows.find(row => row.children[1]?.textContent === 'A');
assert.ok(subfolderA, 'nested folder should appear as its own row');
subfolderA.click();
const filtered = elements.mediaBinList.children.map(row => row.children[0].children[0].textContent);
assert.deepEqual(filtered, ['DJI_0001_LONG_NAME.mp4'], 'selecting a nested folder should filter to its clips');
assert.equal(elements.mediaFolderAllBtn.attributes['aria-pressed'], 'false', 'All clips should deactivate when a folder is selected');
state.selectedMediaFolder = null;
context.renderMediaBin();
assert.equal(elements.mediaBinList.children.length, 3, 'All clips restores the full list');
state.mediaSort = 'created-desc';
context.renderMediaBin();
assert.deepEqual(elements.mediaBinList.children.map(row => row.children[0].children[0].textContent), ['DJI_0002.mxf', 'Loose Clip.mov', 'DJI_0001_LONG_NAME.mp4'], 'creation-date newest-first sorting should work');
state.mediaSort = 'name-desc';
context.renderMediaBin();
assert.deepEqual(elements.mediaBinList.children.map(row => row.children[0].children[0].textContent), ['Loose Clip.mov', 'DJI_0002.mxf', 'DJI_0001_LONG_NAME.mp4'], 'filename descending sorting should work');
assert.match(html, /mediaFolderAllBtn'\)\.addEventListener\('click'/, 'All clips control should be wired');
assert.match(html, /id="mediaBinAddFilesBtn"[^>]*>＋ Add video</, 'import control should read Add video');
assert.match(html, /id="mediaClipSort"[\s\S]*?value="created-desc"[\s\S]*?value="created-asc"/, 'sort control should expose creation-date ordering');
const toolbarStart = html.indexOf('<div class="toolbar-right">');
const headerEnd = html.indexOf('</header>', toolbarStart);
assert.ok(!html.slice(toolbarStart, headerEnd).includes('id="fullscreenBtn"'), 'fullscreen control should no longer be in the top toolbar');
const frameStart = html.indexOf('<div id="videoFrame">');
const hudStart = html.indexOf('<div class="hud', frameStart);
assert.ok(frameStart >= 0 && hudStart > frameStart && html.slice(frameStart, hudStart).includes('id="fullscreenBtn"'), 'fullscreen control should be overlaid inside the video frame');
assert.match(html, /preview-fullscreen-btn\{position:absolute;right:[^;]+;bottom:[^;]+/, 'fullscreen control should be anchored at the frame bottom-right');
const mainSource = fs.readFileSync(path.join(__dirname, '..', 'main.cjs'), 'utf8');
const preloadSource = fs.readFileSync(path.join(__dirname, '..', 'preload.cjs'), 'utf8');
assert.match(mainSource, /ez-native:file-metadata/, 'main process should provide file date metadata');
assert.match(mainSource, /stats\.birthtimeMs/, 'creation-date sorting should use native file birth time when available');
assert.match(preloadSource, /getFileMetadata\(paths\)/, 'preload should expose the file metadata method');
assert.match(html, /mediaClipSort'\)\.addEventListener\('change'/, 'sort select should be wired to rerender the list');

const ids = [...html.matchAll(/\bid=["']([^"']+)["']/g)].map(match => match[1]);
assert.equal(new Set(ids).size, ids.length, 'HTML element IDs should be unique');
assert.equal((html.match(/id="mediaBinPanel"/g) || []).length, 1, 'only one Media Browser should exist');
assert.match(html, /class="workspace" id="workspace"/, 'workspace should own the fixed sidebar');
console.log('PASS: folder filtering, filename/date sorting, Add video label, bottom-right fullscreen placement, and markup integrity.');
