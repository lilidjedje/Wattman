const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('desktopEnvironment', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  importCanFiles(files) {
    return ipcRenderer.invoke('import-can-files', Array.from(files, file => webUtils.getPathForFile(file)));
  },
  openMeasurementExports(sessionId) {
    return ipcRenderer.invoke('open-measurement-exports', sessionId);
  },
  projectStore(operation, payload) {
    const result = ipcRenderer.sendSync('project-store', operation, payload);
    if (result.error) throw new Error(result.error);
    return result.value;
  }
}));
