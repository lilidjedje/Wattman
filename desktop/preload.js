const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('desktopEnvironment', Object.freeze({
  isDesktop: true,
  platform: process.platform
}));
