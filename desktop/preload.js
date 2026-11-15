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
  generateSynthesisPdf(projectName, bytes) {
    return ipcRenderer.invoke('generate-synthesis-pdf', projectName, bytes);
  },
  saveSynthesisExcel(fileName, bytes) {
    return ipcRenderer.invoke('save-synthesis-excel', fileName, bytes);
  },
  exportChartPdf(meta, svg) {
    return ipcRenderer.invoke('export-chart-pdf', meta, svg);
  },
  projectStore(operation, payload) {
    const result = ipcRenderer.sendSync('project-store', operation, payload);
    if (result.error) throw new Error(result.error);
    return result.value;
  }
}));
