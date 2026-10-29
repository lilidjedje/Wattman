const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopEnvironment', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  projectStore(operation, payload) {
    const result = ipcRenderer.sendSync('project-store', operation, payload);
    if (result.error) throw new Error(result.error);
    return result.value;
  }
}));
