'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ezNative', Object.freeze({
  isDesktop: true,
  getPathForFile(file) {
    try {
      return webUtils.getPathForFile(file);
    } catch (error) {
      console.error('Could not resolve local file path:', error);
      return '';
    }
  },
  convertPreview(options) {
    return ipcRenderer.invoke('ez-native:convert-preview', options);
  },
  cancelPreviewConversion(jobId) {
    return ipcRenderer.invoke('ez-native:cancel-preview-conversion', { jobId });
  },
  getFileMetadata(paths) {
    return ipcRenderer.invoke('ez-native:file-metadata', { paths });
  },
  probeMedia(options) {
    return ipcRenderer.invoke('ez-native:probe-media', options);
  },
  getProxyCacheInfo() {
    return ipcRenderer.invoke('ez-native:proxy-cache-info');
  },
  clearProxyCache(keepPaths = []) {
    return ipcRenderer.invoke('ez-native:proxy-cache-clear', { keepPaths });
  },
  exportOriginalFrame(options) {
    return ipcRenderer.invoke('ez-native:export-original-frame', options);
  },
  exportSequenceMp4(options) {
    return ipcRenderer.invoke('ez-native:export-sequence-mp4', options);
  },
  saveSnapshotPng(options) {
    return ipcRenderer.invoke('ez-native:save-snapshot-png', options);
  },
  getBundledLut() {
    return ipcRenderer.invoke('ez-native:get-bundled-lut');
  },
  listLuts() {
    return ipcRenderer.invoke('ez-native:lut-list');
  },
  getLut(id) {
    return ipcRenderer.invoke('ez-native:lut-get', id);
  },
  saveLut(record) {
    return ipcRenderer.invoke('ez-native:lut-save', record);
  },
  deleteLut(id) {
    return ipcRenderer.invoke('ez-native:lut-delete', id);
  },
  getLutPreference(key) {
    return ipcRenderer.invoke('ez-native:lut-preference-get', key);
  },
  setLutPreference(key, value) {
    return ipcRenderer.invoke('ez-native:lut-preference-set', { key, value });
  },
  onConversionProgress(callback) {
    if (typeof callback !== 'function') return () => {};
    const handler = (_event, message) => callback(message);
    ipcRenderer.on('ez-native:conversion-progress', handler);
    return () => ipcRenderer.removeListener('ez-native:conversion-progress', handler);
  }
}));
