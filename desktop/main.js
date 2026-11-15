const { app, BrowserWindow, Menu, dialog, protocol, session, safeStorage, ipcMain, shell } = require('electron');
const { createProjectStore } = require('./project_store');
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
let allowWindowClose = false;
let closeSavePending = false;
let rememberedSessionCookie = '';
// Session sans « Se souvenir de moi » : gardée en mémoire jusqu'à la fermeture.
// Chromium ne conserve pas les cookies du protocole app://, elle doit donc être
// réinjectée comme la session mémorisée.
let volatileSessionCookie = '';
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

function rememberedSessionPath() {
  return path.join(app.getPath('userData'), 'remembered-session');
}

function loadRememberedSession() {
  const file = rememberedSessionPath();
  if (!fs.existsSync(file)) return;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Le stockage sécurisé de Windows est indisponible : la session mémorisée ne peut pas être restaurée.');
  }
  rememberedSessionCookie = safeStorage.decryptString(fs.readFileSync(file));
}

function saveRememberedSession(cookie) {
  const file = rememberedSessionPath();
  if (!cookie) {
    rememberedSessionCookie = '';
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return;
  }
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Le stockage sécurisé de Windows est indisponible : la session ne peut pas être mémorisée.');
  }
  const encrypted = safeStorage.encryptString(cookie);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, encrypted);
  rememberedSessionCookie = cookie;
}

async function handleAppRequest(request) {
  const url = new URL(request.url);
  const body = ['GET', 'HEAD'].includes(request.method)
    ? Buffer.alloc(0)
    : Buffer.from(await request.arrayBuffer());
  const headers = Object.fromEntries(request.headers.entries());
  const sessionCookie = rememberedSessionCookie || volatileSessionCookie;
  if (sessionCookie) {
    for (const name of Object.keys(headers)) {
      if (name.toLowerCase() === 'cookie') delete headers[name];
    }
    headers.cookie = sessionCookie;
  }
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
    if (lower === 'set-cookie' && rawValue.startsWith('wattman_session=')) {
      try {
        const cookieValue = rawValue.split(';', 1)[0];
        const expires = /(?:^|;)\s*Expires=/i.test(rawValue);
        const expired = /(?:^|;)\s*Max-Age=0(?:;|$)/i.test(rawValue);
        saveRememberedSession(expires && !expired ? cookieValue : '');
        volatileSessionCookie = !expires && !expired ? cookieValue : '';
      } catch (error) {
        console.error('Impossible de mettre à jour la session mémorisée :', error);
      }
    }
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
      const key = storage.key(i);
      if (storage === localStorage && key === 'engineeringAuthUser') return null;
      return [key, storage.getItem(key)];
    }).filter(Boolean));
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
    const authenticatedUser = localStorage.getItem('engineeringAuthUser');
    localStorage.clear(); sessionStorage.clear();
    const data = ${JSON.stringify(snapshot)};
    Object.entries(data.localStorage || {}).forEach(([key, value]) => {
      if (key !== 'engineeringAuthUser') localStorage.setItem(key, value);
    });
    if (authenticatedUser) localStorage.setItem('engineeringAuthUser', authenticatedUser);
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
          if (mainWindow.webContents.getURL().startsWith('app://local/export_synthesis_pdf')) {
            const started = await mainWindow.webContents.executeJavaScript(`(() => {
              const button=document.getElementById('generate-pdf');
              if (!button || button.disabled) return false;
              button.click();return true;
            })()`);
            if (!started) throw new Error('Affichez la synthèse sélectionnée avant de générer le PDF.');
            return;
          }
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
      partition: 'persist:wattman',
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  mainWindow.on('close', event => {
    if (allowWindowClose) return;
    event.preventDefault();
    if (closeSavePending) return;
    closeSavePending = true;
    mainWindow.webContents.executeJavaScript(`(async () => {
      const active = document.activeElement;
      if (active?.matches('input,textarea,select')) active.dispatchEvent(new Event('change', { bubbles: true }));
      return window.ProjectStorage?.saveActiveProject();
    })()`)
      .then(() => {
        allowWindowClose = true;
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
      })
      .catch(async error => {
        console.error('Échec de la sauvegarde avant fermeture :', error);
        const result = await dialog.showMessageBox(mainWindow, {
          type: 'error',
          title: 'Sauvegarde du projet',
          message: 'Impossible d’enregistrer les dernières modifications.',
          detail: error.message,
          buttons: ['Réessayer', 'Annuler la fermeture', 'Fermer sans enregistrer'],
          defaultId: 0,
          cancelId: 1,
          noLink: true
        });
        closeSavePending = false;
        if (result.response === 0) {
          mainWindow.close();
        } else if (result.response === 2) {
          allowWindowClose = true;
          if (mainWindow && !mainWindow.isDestroyed()) mainWindow.close();
        }
      });
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
  const smokeEmail = process.env.ENGINEERING_SMOKE_EMAIL;
  const smokePassword = process.env.ENGINEERING_SMOKE_PASSWORD;
  if (!smokeEmail || !smokePassword) {
    throw new Error('Définissez ENGINEERING_SMOKE_EMAIL et ENGINEERING_SMOKE_PASSWORD pour le smoke test.');
  }
  await mainWindow.webContents.executeJavaScript(`(async () => {
    const email = ${JSON.stringify(smokeEmail)};
    const password = ${JSON.stringify(smokePassword)};
    const setup = document.getElementById('setup-form');
    const endpoint = setup ? '/api/auth/setup' : '/api/auth/login';
    const payload = setup
      ? {email, password, firstName: 'Smoke', lastName: 'Test'}
      : {email, password};
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(payload)
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Échec de la connexion du smoke test.');
    localStorage.setItem('engineeringAuthUser', JSON.stringify(result.user));
  })()`);
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
  try {
    loadRememberedSession();
  } catch (error) {
    dialog.showErrorBox('Session Wattman', error.message);
    app.quit();
    return;
  }
  ipcMain.handle('import-can-files', async (event, paths) => {
    if (!event.senderFrame.url.startsWith('app://local/analyse_logs/')) throw new Error('Origine non autorisée.');
    if (!Array.isArray(paths) || !paths.length || paths.some(file => typeof file !== 'string' || !path.isAbsolute(file) || path.extname(file).toLowerCase() !== '.asc')) {
      throw new Error('Sélectionnez des fichiers ASC locaux.');
    }
    const result = await callBackend({operation: 'import-can-files', paths});
    const data = JSON.parse(Buffer.from(result.body, 'base64').toString('utf8'));
    if (result.status !== 200) throw new Error(data.message || data.error || 'Import impossible.');
    return data;
  });
  ipcMain.handle('open-measurement-exports', async (event, sessionId) => {
    if (!event.senderFrame.url.startsWith('app://local/analyse_logs/') || !/^[a-f0-9]{32}$/.test(sessionId)) throw new Error('Session invalide.');
    const dataRoot = process.env.ENGINEERING_APP_DATA || path.join(app.getPath('userData'), 'application-data');
    const folder = path.join(dataRoot, 'can_data', 'exports_numeriques', sessionId);
    if (!fs.existsSync(folder)) throw new Error('Les fichiers Excel ne sont pas encore disponibles.');
    const error = await shell.openPath(folder);
    if (error) throw new Error(error);
    return true;
  });
  ipcMain.handle('generate-synthesis-pdf', async (event, projectName, bytes) => {
    if (!event.senderFrame.url.startsWith('app://local/export_synthesis_pdf')) throw new Error('Origine non autorisée.');
    if (!ArrayBuffer.isView(bytes) || bytes.byteLength > 50 * 1024 * 1024) throw new Error('Le document PDF est invalide.');
    const pdf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (pdf.subarray(0, 5).toString('ascii') !== '%PDF-') throw new Error('Le document PDF est invalide.');
    const safeName = String(projectName || 'synthese')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
      .trim()
      .slice(0, 100) || 'synthese';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Enregistrer la synthèse PDF',
      defaultPath: `${safeName}-synthese.pdf`,
      filters: [{ name: 'Document PDF', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, pdf);
    return { canceled: false, filePath: result.filePath };
  });
  // Excel de synthèse : boîte « Enregistrer sous » à chaque génération (pas de téléchargement
  // automatique, que Chromium bloque après le premier).
  ipcMain.handle('save-synthesis-excel', async (event, fileName, bytes) => {
    if (!event.senderFrame.url.startsWith('app://local/export_synthesis_pdf')) throw new Error('Origine non autorisée.');
    if (!ArrayBuffer.isView(bytes) || bytes.byteLength > 200 * 1024 * 1024) throw new Error('Le fichier Excel est invalide.');
    const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (data.subarray(0, 2).toString('ascii') !== 'PK') throw new Error('Le fichier Excel est invalide.');
    const requested = Array.from(String(fileName || 'Synthese_Wattman.zip'), character => (character.charCodeAt(0) < 32 || '<>:"/|?*'.includes(character) || character.charCodeAt(0) === 92 ? '-' : character)).join('').trim().slice(0, 140);
    const extension = requested.toLowerCase().endsWith('.xlsx') ? 'xlsx' : 'zip';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Enregistrer la synthèse Excel',
      defaultPath: requested || `Synthese_Wattman.${extension}`,
      filters: [extension === 'xlsx' ? { name: 'Classeur Excel', extensions: ['xlsx'] } : { name: 'Archive des classeurs Excel', extensions: ['zip'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    fs.writeFileSync(result.filePath, data);
    return { canceled: false, filePath: result.filePath };
  });
  // Export PDF d'un graphique : SVG vectoriel produit par la page, rendu dans une
  // fenêtre cachée isolée (JavaScript désactivé), puis « Enregistrer sous ».
  ipcMain.handle('export-chart-pdf', async (event, meta, svg) => {
    if (!event.senderFrame.url.startsWith('app://local/')) throw new Error('Origine non autorisée.');
    if (typeof svg !== 'string' || svg.length > 20 * 1024 * 1024 || !/^<svg[\s>]/.test(svg.trimStart())) throw new Error('Graphique SVG invalide.');
    if (/<script|<foreignObject|\son\w+\s*=|javascript:/i.test(svg)) throw new Error('Graphique SVG refusé.');
    const text = value => String(value ?? '').slice(0, 300).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
    const info = meta && typeof meta === 'object' ? meta : {};
    const safeName = String(info.title || 'graphique').replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').trim().slice(0, 100) || 'graphique';
    const result = await dialog.showSaveDialog(mainWindow, {
      title: 'Exporter le graphique en PDF',
      defaultPath: `${safeName}.pdf`,
      filters: [{ name: 'Document PDF', extensions: ['pdf'] }]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const html = `<!doctype html><html lang="fr"><meta charset="utf-8">
      <style>@page{size:A4 landscape;margin:14mm}body{margin:0;font-family:"Segoe UI",Arial,sans-serif;color:#0b0c0e}
      header{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #0b0c0e;padding-bottom:8px;margin-bottom:10px}
      h1{font-size:18px;margin:0}small{color:#555;font-size:10px}svg{width:100%;height:auto;max-height:150mm}
      dl{display:grid;grid-template-columns:auto 1fr;gap:2px 12px;font-size:10px;margin:10px 0 0}dt{color:#555}dd{margin:0}</style>
      <header><h1>${text(info.title)}</h1><small>Wattman Engineering · ${text(info.exportedAt)}</small></header>
      ${svg}
      <dl>${[['Projet', info.project], ['Axes', info.axes], ['Vue', info.view], ['Séries', info.series], ['Page', info.page]]
        .filter(([, v]) => v).map(([k, v]) => `<dt>${k}</dt><dd>${text(v)}</dd>`).join('')}</dl></html>`;
    const printer = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } });
    try {
      await printer.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await printer.webContents.printToPDF({ printBackground: true, landscape: true, pageSize: 'A4' });
      fs.writeFileSync(result.filePath, pdf);
    } finally {
      printer.destroy();
    }
    return { canceled: false, filePath: result.filePath };
  });
  const projectStore = createProjectStore(path.join(app.getPath('userData'), 'projects'));
  // Compteur public de l'accueil : renvoie uniquement un nombre, jamais les métadonnées.
  ipcMain.handle('project-count', event => {
    if (!event.senderFrame.url.startsWith('app://local/')) throw new Error('Origine non autorisée.');
    return projectStore.list().length;
  });
  ipcMain.on('project-store', (event, operation, payload) => {
    try {
      if (!event.senderFrame.url.startsWith('app://local/')) throw new Error('Origine non autorisée.');
      if (!['read', 'list', 'write', 'delete'].includes(operation)) throw new Error('Opération inconnue.');
      event.returnValue = { value: projectStore[operation](payload) };
    } catch (error) { event.returnValue = { error: error.message }; }
  });
  session.fromPartition('persist:wattman').protocol.handle('app', handleAppRequest);
  createWindow();
  installMenu();
  try {
    startBackend();
    await callBackend({ path: '/auth', method: 'GET', headers: {}, body: '' });
    await mainWindow.loadURL('app://local/auth');
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
let backendShutdownStarted = false;
let backendShutdownComplete = false;
app.on('before-quit', event => {
  if (backendShutdownComplete || !backend || backend.killed) return;
  event.preventDefault();
  if (backendShutdownStarted) return;
  backendShutdownStarted = true;
  callBackend({operation: 'shutdown'}).catch(error => console.error('Sauvegarde de fermeture :', error)).finally(() => {
    backendShutdownComplete = true;
    if (backend && !backend.killed) backend.kill();
    app.quit();
  });
});
