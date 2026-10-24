const { app, BrowserWindow, Menu, dialog, protocol } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

protocol.registerSchemesAsPrivileged([{
  scheme: 'app',
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true
  }
}]);

let mainWindow;
let backend;
let sequence = 0;
const pending = new Map();
const hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });
}

function backendCommand() {
  if (app.isPackaged) {
    return {
      executable: path.join(process.resourcesPath, 'backend', 'engineering-backend.exe'),
      args: []
    };
  }
  return {
    executable: process.env.PYTHON || 'python',
    args: [path.join(__dirname, 'bridge.py'), '--source-root', path.join(__dirname, '..')]
  };
}

function startBackend() {
  const command = backendCommand();
  // Program Files n'est pas inscriptible pour un utilisateur standard.
  // Les données persistantes et temporaires doivent vivre dans son profil.
  const backendDataPath = process.env.ENGINEERING_APP_DATA
    || path.join(app.getPath('userData'), 'application-data');
  const backendTempPath = path.join(backendDataPath, 'temp');
  fs.mkdirSync(backendTempPath, { recursive: true });
  backend = spawn(command.executable, command.args, {
    cwd: app.isPackaged ? process.resourcesPath : path.join(__dirname, '..'),
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONUTF8: '1',
      ENGINEERING_APP_DATA: backendDataPath,
      TEMP: backendTempPath,
      TMP: backendTempPath,
      TMPDIR: backendTempPath,
      ESP32_BASE_URL: 'http://192.168.4.1',
      CAN_COLLECTOR_ENABLED: '0'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  readline.createInterface({ input: backend.stdout }).on('line', line => {
    try {
      const response = JSON.parse(line);
      const callback = pending.get(response.id);
      if (callback) {
        pending.delete(response.id);
        callback.resolve(response);
      }
    } catch (error) {
      console.error('Réponse backend invalide', error);
    }
  });
  backend.stderr.on('data', chunk => console.error(chunk.toString()));
  backend.on('exit', code => {
    for (const callback of pending.values()) callback.reject(new Error(`Backend arrêté (${code}).`));
    pending.clear();
  });
  backend.on('error', error => {
    for (const callback of pending.values()) callback.reject(error);
    pending.clear();
  });
}

function callBackend(message) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    backend.stdin.write(`${JSON.stringify({ ...message, id })}\n`);
  });
}

async function handleAppRequest(request) {
  const url = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method)
    ? Buffer.alloc(0)
    : Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  const result = await callBackend({
    path: `${url.pathname}${url.search}`,
    method: request.method,
    headers,
    body: body.toString('base64')
  });

  const responseHeaders = new Headers();
  for (const [name, rawValue] of result.headers || []) {
    const lower = name.toLowerCase();
    if (['content-length', 'content-encoding', 'connection'].includes(lower)) continue;
    let value = rawValue;
    if (lower === 'location' && value.startsWith('/')) value = `app://local${value}`;
    responseHeaders.append(name, value);
  }
  const responseBody = [101, 204, 205, 304].includes(result.status)
    ? null
    : Buffer.from(result.body || '', 'base64');
  return new Response(responseBody, {
    status: result.status || 500,
    headers: responseHeaders
  });
}

async function rendererSnapshot() {
  return mainWindow.webContents.executeJavaScript(`(() => {
    const copy = storage => Object.fromEntries(Array.from({length: storage.length}, (_, i) => {
      const key = storage.key(i); return [key, storage.getItem(key)];
    }));
    return {
      format: 'engineering-calculator-project',
      version: 1,
      savedAt: new Date().toISOString(),
      localStorage: copy(localStorage),
      sessionStorage: copy(sessionStorage)
    };
  })()`);
}

async function saveJsonProject() {
  const snapshot = await rendererSnapshot();
  let project = {};
  try { project = JSON.parse(snapshot.localStorage.activeProject || '{}'); } catch {}
  const safeName = String(project.name || 'projet').replace(/[<>:"/\\|?*]+/g, '_');
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Enregistrer le projet JSON',
    defaultPath: `${safeName}.engineering.json`,
    filters: [{ name: 'Projet Engineering JSON', extensions: ['json'] }]
  });
  if (!result.canceled) fs.writeFileSync(result.filePath, JSON.stringify(snapshot, null, 2), 'utf8');
}

async function openJsonProject() {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Ouvrir un projet JSON',
    properties: ['openFile'],
    filters: [{ name: 'Projet Engineering JSON', extensions: ['json'] }]
  });
  if (result.canceled) return;
  const snapshot = JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8'));
  if (snapshot.format !== 'engineering-calculator-project') {
    throw new Error('Ce fichier JSON n’est pas un projet Engineering Calculator.');
  }
  await mainWindow.webContents.executeJavaScript(`(() => {
    localStorage.clear(); sessionStorage.clear();
    const data = ${JSON.stringify(snapshot)};
    Object.entries(data.localStorage || {}).forEach(([key, value]) => localStorage.setItem(key, value));
    Object.entries(data.sessionStorage || {}).forEach(([key, value]) => sessionStorage.setItem(key, value));
  })()`);
  await mainWindow.loadURL('app://local/mode_selection');
}

function installMenu() {
  const safe = action => async () => {
    try { await action(); }
    catch (error) { dialog.showErrorBox('Engineering Calculator', error.message); }
  };
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      label: 'Fichier',
      submenu: [
        { label: 'Accueil / nouveau projet', accelerator: 'Ctrl+N', click: () => mainWindow.loadURL('app://local/') },
        { label: 'Ouvrir un projet JSON…', accelerator: 'Ctrl+O', click: safe(openJsonProject) },
        { label: 'Enregistrer le projet en JSON…', accelerator: 'Ctrl+S', click: safe(saveJsonProject) },
        { type: 'separator' },
        { label: 'Exporter la page en PDF…', accelerator: 'Ctrl+P', click: safe(async () => {
          const result = await dialog.showSaveDialog(mainWindow, {
            defaultPath: 'synthese.pdf',
            filters: [{ name: 'PDF', extensions: ['pdf'] }]
          });
          if (!result.canceled) fs.writeFileSync(result.filePath, await mainWindow.webContents.printToPDF({ printBackground: true }));
        }) },
        { type: 'separator' },
        { role: 'quit', label: 'Quitter' }
      ]
    },
    { label: 'Édition', submenu: [
      { role: 'undo', label: 'Annuler' }, { role: 'redo', label: 'Rétablir' },
      { type: 'separator' }, { role: 'cut', label: 'Couper' }, { role: 'copy', label: 'Copier' },
      { role: 'paste', label: 'Coller' }, { role: 'selectAll', label: 'Tout sélectionner' }
    ] },
    { label: 'Affichage', submenu: [
      { role: 'reload', label: 'Actualiser' }, { role: 'togglefullscreen', label: 'Plein écran' },
      { role: 'zoomIn', label: 'Agrandir' }, { role: 'zoomOut', label: 'Réduire' },
      { role: 'resetZoom', label: 'Taille réelle' }
    ] }
  ]));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 980,
    minHeight: 680,
    title: 'Engineering Calculator',
    backgroundColor: '#f3f6fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  const loadingPage = `<!doctype html><html lang="fr"><meta charset="utf-8">
    <title>Engineering Calculator — démarrage</title>
    <style>
      body{margin:0;min-height:100vh;display:grid;place-content:center;background:#0b0f10;color:#f4f1e8;
      font-family:Segoe UI,sans-serif;text-align:center}h1{font:700 2rem Georgia,serif}
      p{color:#b9c0c1}.bar{width:360px;height:8px;margin:24px auto;background:#252b2d;overflow:hidden}
      .bar:after{content:"";display:block;width:40%;height:100%;background:#e3b62c;animation:load 1.2s infinite}
      @keyframes load{from{transform:translateX(-100%)}to{transform:translateX(350%)}}</style>
    <h1>Démarrage de l’application</h1>
    <p>Chargement du moteur de calcul et de mesure…</p><div class="bar"></div></html>`;
  mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(loadingPage)}`);
  if (process.env.ENGINEERING_SMOKE_TEST === '1') {
    mainWindow.webContents.on('console-message', (_event, ...args) => {
      const details = typeof args[0] === 'object' ? args[0] : {level: args[0], message: args[1]};
      console.log(`[renderer:${details.level}] ${details.message}`);
    });
  }
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('app://')) {
      mainWindow.loadURL(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });
}

function waitForLoad(window, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Délai de chargement dépassé.')), timeoutMs);
    window.webContents.once('did-finish-load', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function runSmokeTest() {
  const loaded = waitForLoad(mainWindow);
  await mainWindow.loadURL('app://local/import_project');
  await loaded;

  const excelPath = process.env.ENGINEERING_SMOKE_EXCEL;
  if (excelPath) {
    mainWindow.webContents.debugger.attach('1.3');
    const documentNode = await mainWindow.webContents.debugger.sendCommand('DOM.getDocument');
    const inputNode = await mainWindow.webContents.debugger.sendCommand('DOM.querySelector', {
      nodeId: documentNode.root.nodeId,
      selector: '#file-input'
    });
    await mainWindow.webContents.debugger.sendCommand('DOM.setFileInputFiles', {
      nodeId: inputNode.nodeId,
      files: [path.resolve(excelPath)]
    });
    mainWindow.webContents.debugger.detach();
  }

  await mainWindow.webContents.executeJavaScript(`(() => {
    const values = {
      name: 'Smoke Test', powertrain: 'EV', eeArchitect: 'Architecture Test',
      applicationZone: 'Europe', milestone: 'TEST', date: '2026-07-27',
      pilotWattman: 'Test'
    };
    Object.entries(values).forEach(([name, value]) => {
      const input = document.querySelector('[name="' + name + '"]');
      input.value = value;
      input.dispatchEvent(new Event('input', {bubbles: true}));
    });
    document.querySelector('[name="projectType"][value="EV"]').click();
    document.querySelector('[name="evArchitecture"]').value = 'SDV';
    document.getElementById('project-form').requestSubmit();
  })()`);

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline && mainWindow.webContents.getURL().includes('/import_project')) {
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  const result = await mainWindow.webContents.executeJavaScript(`({
    url: location.href,
    error: document.getElementById('error-message')?.textContent || '',
    button: document.getElementById('submit-button')?.textContent || ''
  })`);
  console.log(`SMOKE_RESULT=${JSON.stringify(result)}`);
  if (process.env.ENGINEERING_SMOKE_CRAWL === '1') {
    const routes = [
      '/', '/import_project', '/select_components', '/mode_selection',
      '/homologation_configuration', '/edit_current', '/edit_alternator',
      '/edit_pao', '/edit_gmv', '/display', '/synthesis',
      '/export_synthesis_pdf', '/battery_configuration', '/battery_menu',
      '/edit_customer_mode', '/edit_dm_mode', '/fixed_consumption',
      '/sleep_consumption', '/battery_results_menu', '/dm_results',
      '/biberonnage', '/biberonnage/resultats',
      '/analyse_logs/', '/analyse_logs/measurement', '/analyse_logs/logs',
      '/analyse_logs/dashboard/import', '/analyse_logs/dashboard/setup', '/analyse_logs/dashboard'
    ];
    const crawl = [];
    for (const route of routes) {
      const routeLoaded = waitForLoad(mainWindow);
      await mainWindow.loadURL(`app://local${route}`);
      await routeLoaded;
      crawl.push(await mainWindow.webContents.executeJavaScript(`({
        requested: ${JSON.stringify(route)},
        url: location.pathname,
        title: document.title,
        buttons: document.querySelectorAll('button,a[href]').length,
        textLength: document.body?.innerText?.length || 0
      })`));
    }
    console.log(`SMOKE_CRAWL=${JSON.stringify(crawl)}`);
  }
  app.quit();
}

app.whenReady().then(async () => {
  protocol.handle('app', handleAppRequest);
  createWindow();
  installMenu();
  try {
    startBackend();
    await callBackend({ path: '/', method: 'GET', headers: {}, body: '' });
    await mainWindow.loadURL('app://local/');
  } catch (error) {
    const failure = `<!doctype html><html lang="fr"><meta charset="utf-8">
      <style>body{font-family:Segoe UI,sans-serif;padding:48px;background:#fff3f2;color:#7d2923}</style>
      <h1>Le moteur de l’application n’a pas démarré</h1><p>${String(error.message).replace(/[<>&]/g, '')}</p></html>`;
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(failure)}`);
    return;
  }
  if (process.env.ENGINEERING_SMOKE_TEST === '1') {
    runSmokeTest().catch(error => {
      console.error('SMOKE_ERROR', error);
      app.exit(2);
    });
  }
});

app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => {
  if (backend && !backend.killed) backend.kill();
});
