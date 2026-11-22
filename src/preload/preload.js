'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('api', {
  pathForFile: (file) => webUtils.getPathForFile(file),
  addPaths: (paths) => ipcRenderer.invoke('paths:add', paths),
  pickFiles: () => ipcRenderer.invoke('dialog:files'),
  pickFolder: () => ipcRenderer.invoke('dialog:folder'),
  start: () => ipcRenderer.invoke('batch:start'),
  cancel: () => ipcRenderer.invoke('batch:cancel'),
  clear: () => ipcRenderer.invoke('jobs:clear'),
  reveal: (id) => ipcRenderer.invoke('file:reveal', id),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (s) => ipcRenderer.invoke('settings:set', s),
  onJob: (cb) => ipcRenderer.on('job:update', (_e, job) => cb(job)),
  onBatchState: (cb) => ipcRenderer.on('batch:state', (_e, s) => cb(s)),
});
