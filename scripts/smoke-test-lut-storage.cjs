'use strict';

// Isolated smoke test for the Electron main-process LUT store without launching a GUI.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ez-preview-lut-storage-test-'));
const handlers = new Map();
const fakeElectron = {
  app: {
    isPackaged: false,
    getPath(name) {
      if (name === 'userData') return testRoot;
      if (name === 'temp') return testRoot;
      if (name === 'pictures') return testRoot;
      throw new Error(`Unexpected app.getPath(${name}) in LUT storage test`);
    },
    whenReady() { return { then() { return undefined; } }; },
    on() {},
    quit() {}
  },
  BrowserWindow: class BrowserWindow {},
  ipcMain: { handle(name, handler) { handlers.set(name, handler); } },
  dialog: {}
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'electron') return fakeElectron;
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  try {
    require(path.join(__dirname, '..', 'main.cjs'));
    for (const name of [
      'ez-native:lut-list', 'ez-native:lut-get', 'ez-native:lut-save',
      'ez-native:lut-delete', 'ez-native:lut-preference-get', 'ez-native:lut-preference-set'
    ]) assert.ok(handlers.has(name), `Missing IPC handler: ${name}`);

    const invoke = async (name, ...args) => handlers.get(name)(null, ...args);
    const cubeText = [
      'TITLE "EZ Preview storage smoke test"',
      'LUT_3D_SIZE 2',
      '0 0 0', '1 0 0', '0 1 0', '1 1 0',
      '0 0 1', '1 0 1', '0 1 1', '1 1 1', ''
    ].join('\n');
    const record = {
      id: 'lut-storage-smoke-test',
      name: 'smoke-test.cube',
      favorite: true,
      text: cubeText,
      size: 2,
      bytes: Buffer.byteLength(cubeText),
      addedAt: Date.now()
    };

    await invoke('ez-native:lut-save', record);
    const saved = await invoke('ez-native:lut-get', record.id);
    assert.equal(saved.name, record.name);
    assert.equal(saved.text, cubeText);
    assert.equal(saved.favorite, true);
    const listed = await invoke('ez-native:lut-list');
    assert.ok(listed.some(item => item.id === record.id));

    await invoke('ez-native:lut-preference-set', { key: 'currentLutId', value: record.id });
    assert.equal(await invoke('ez-native:lut-preference-get', 'currentLutId'), record.id);

    await invoke('ez-native:lut-delete', record.id);
    assert.equal(await invoke('ez-native:lut-get', record.id), null);
    assert.ok(!(await invoke('ez-native:lut-list')).some(item => item.id === record.id));

    await assert.rejects(invoke('ez-native:lut-get', '../not-allowed'));

    const externalPath = process.env.EZ_PREVIEW_TEST_LUT;
    if (externalPath) {
      const sourceText = fs.readFileSync(externalPath, 'utf8');
      const realRecord = {
        id: 'lut-real-cube-smoke-test',
        name: path.basename(externalPath),
        text: sourceText,
        bytes: Buffer.byteLength(sourceText),
        addedAt: Date.now()
      };
      await invoke('ez-native:lut-save', realRecord);
      const reopened = await invoke('ez-native:lut-get', realRecord.id);
      assert.equal(reopened.size, 33);
      assert.equal(reopened.text, sourceText);
      await invoke('ez-native:lut-delete', realRecord.id);
      console.log(`PASS: real .cube file persisted and reloaded (${reopened.size}³, ${reopened.bytes} bytes)`);
    }
    console.log('PASS: native LUT storage create/list/read/delete and preferences');
  } finally {
    Module._load = originalLoad;
    fs.rmSync(testRoot, { recursive: true, force: true });
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
