// Captures visuelles des écrans réels dans un profil Electron temporaire.
// Usage : npx electron tests/visual/capture_screens.cjs <dossier-sortie> [light|dark]
// Aucun compte réel ni donnée utilisateur : un compte de test est créé dans le
// profil temporaire, puis supprimé avec lui.
const { app } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const outDir = path.resolve(process.argv.find(arg => arg.startsWith('--out='))?.slice(6) || 'outputs/screens');
const theme = process.argv.find(arg => arg.startsWith('--theme='))?.slice(8) || 'light';
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7)?.split(',');
fs.mkdirSync(outDir, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-visual-'));
app.setPath('userData', profile);
process.env.ENGINEERING_APP_DATA = path.join(profile, 'backend');
// Référentiel théorique de démonstration (même principe que electron_offline_dashboard.cjs).
const canData = path.join(profile, 'backend', 'can_data');
fs.mkdirSync(canData, { recursive: true });
fs.writeFileSync(path.join(canData, 'esp32_connection.json'), JSON.stringify({ base_url: 'http://127.0.0.1:9' }));
fs.writeFileSync(path.join(canData, 'theory_snapshot.json'), JSON.stringify({ project: { id: 'visual', name: 'Projet démonstration' },
  devices: [{ id: 'd1', name: 'ECU démonstration A', kind: 'dcdc', nominal_A: 1 }, { id: 'd2', name: 'ECU démonstration B', kind: 'dcdc', nominal_A: 0.5 }] }));

const ROUTES = [
  ['auth', '/auth'],
  ['home', '/'],
  ['import-project', '/import_project'],
  ['select-components', '/select_components'],
  ['mode-selection', '/mode_selection'],
  ['homologation-configuration', '/homologation_configuration'],
  ['edit-current', '/edit_current'],
  ['synthesis', '/synthesis'],
  ['battery-menu', '/battery_menu'],
  ['sleep-consumption', '/sleep_consumption'],
  ['battery-results', '/battery_results_menu'],
  ['dm-results', '/dm_results?mode=DM1'],
  ['biberonnage', '/biberonnage'],
  ['biberonnage-resultats', '/biberonnage/resultats?days=30'],
  ['admin', '/admin'],
  ['logs-home', '/analyse_logs/'],
  ['logs-dashboard-import', '/analyse_logs/dashboard/import'],
  ['logs-dashboard', '/analyse_logs/dashboard']
];

let started = false;
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => {
    if (started || !win.webContents.getURL().startsWith('app://local/auth')) return;
    started = true;
    run(win).then(() => app.quit()).catch(error => { console.error(error.stack); app.exit(1); });
  });
});
require('../../desktop/main.js');

async function run(win) {
  win.setSize(1440, 920);
  const js = script => win.webContents.executeJavaScript(script);
  const settle = () => new Promise(resolve => setTimeout(resolve, 900));
  const go = async route => {
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await win.loadURL(`app://local${route}`);
    await loaded;
    if (theme === 'dark') await js(`document.documentElement.dataset.theme='dark'`);
    await settle();
  };
  const shot = async name => {
    const file = path.join(outDir, `${name}${theme === 'dark' ? '-dark' : ''}.png`);
    fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
    console.log(`SHOT ${file}`);
  };

  if (!only || only.includes('auth')) await shot('auth');
  await js(`(async () => {
    const setup = document.getElementById('setup-form');
    const endpoint = setup ? '/api/auth/setup' : '/api/auth/login';
    const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: setup ? setup.querySelector('[name=email]').value : 'visual.test@example.invalid', password: 'visual-test-only', firstName: 'Visual', lastName: 'Test' }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'login failed');
    localStorage.setItem('engineeringAuthUser', JSON.stringify(result.user));
    localStorage.setItem('activeProject', JSON.stringify({ id: 'visual-demo', name: 'Projet démonstration', powertrain: 'EV', milestone: 'TEST' }));
    sessionStorage.setItem('excelData', JSON.stringify({ 'Device List': { data: [
      { 'Device Name': 'ECU démonstration A', 'DM1 Current (mA)': 2, 'DM2 Current (mA)': 1.5, 'CM Current (mA)': 0.8 },
      { 'Device Name': 'ECU démonstration B', 'DM1 Current (mA)': 0.4, 'DM2 Current (mA)': 0.3, 'CM Current (mA)': 0.2 }
    ] } }));
    sessionStorage.setItem('selectedEcuKeys', JSON.stringify(['0_ECU démonstration A', '1_ECU démonstration B']));
  })()`);
  for (const [name, route] of ROUTES) {
    if (name === 'auth' || (only && !only.includes(name))) continue;
    try { await go(route); await shot(name); }
    catch (error) { console.error(`FAIL ${name}: ${error.message}`); }
  }
  if (!only || only.includes('logs-dashboard-data')) {
    try {
      await openMeasuredDashboard(win, js, go);
      await shot('logs-dashboard-data');
      for (const [i, y] of [[2, 1100], [3, 2200], [4, 3300]]) {
        await js(`window.scrollTo(0, ${y})`); await new Promise(r => setTimeout(r, 500)); await shot(`logs-dashboard-data-${i}`);
      }
    }
    catch (error) { console.error(`FAIL logs-dashboard-data: ${error.message}`); }
  }
}

// Importe un vrai fichier ASC versionné (test_asc) puis ouvre le dashboard DCDC.
async function openMeasuredDashboard(win, js, go) {
  const until = async (expression, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (await js(expression)) return; await new Promise(r => setTimeout(r, 150)); }
    const page = await js("location.pathname + ' | ' + document.body.innerText.slice(0, 700).replace(/\\s+/g, ' ')");
    throw new Error(`Timeout : ${expression} :: ${page}`);
  };
  const file = path.join(__dirname, '..', '..', 'test_asc', 'mesures_courant_%Date%_%Time%_L213.asc');
  const b64 = fs.readFileSync(file).toString('base64');
  await go('/analyse_logs/');
  const status = await js(`(async () => {
    const bytes = Uint8Array.from(atob(${JSON.stringify(b64)}), c => c.charCodeAt(0));
    const body = new FormData();
    body.append('files', new File([bytes], 'L213.asc'));
    const response = await fetch('/analyse_logs/api/upload_and_ingest_measures', { method: 'POST', body });
    return response.status;
  })()`);
  if (status !== 200) throw new Error(`import ASC ${status}`);
  await go('/analyse_logs/dashboard/import');
  await until("document.getElementById('continueButton') && !document.getElementById('continueButton').disabled");
  await js("document.getElementById('continueButton').click()");
  await until("location.pathname === '/analyse_logs/dashboard/setup'");
  await js(`document.querySelector('[data-mode=dcdc]').click();
    document.querySelector('input[name=dashboardChannelMode][value=AB]').click();
    document.querySelectorAll('#deviceList input[type=checkbox], [id*=device] input[type=checkbox]').forEach(i => { if (!i.checked) i.click(); });
    document.getElementById('setupForm').requestSubmit()`);
  await until("location.pathname === '/analyse_logs/dashboard' && !document.getElementById('dashboardContent').hidden");
  await new Promise(r => setTimeout(r, 1500));
}
module.exports = { openMeasuredDashboard };
