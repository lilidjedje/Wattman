// Validation du design system Renault Engineering dans les vraies pages Electron.
// Usage : npx electron tests/electron_design_system.cjs
// Vérifie que les couches visuelles (thème, graphiques, data grid) sont non
// destructives : données des graphiques, contenu des tableaux et couleurs Excel
// identiques avant et après interaction.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-ds-'));
app.setPath('userData', profile);
process.env.ENGINEERING_APP_DATA = path.join(profile, 'backend');

const ROUTES = [
  '/', '/import_project', '/select_components', '/mode_selection', '/homologation_configuration',
  '/edit_current', '/edit_alternator', '/edit_pao', '/edit_gmv', '/synthesis', '/battery_configuration',
  '/battery_menu', '/edit_customer_mode', '/edit_dm_mode', '/fixed_consumption', '/sleep_consumption',
  '/battery_results_menu', '/dm_results?mode=DM1', '/biberonnage', '/biberonnage/resultats?days=30',
  '/biberonnage/resultats?days=90', '/admin', '/analyse_logs/', '/analyse_logs/dashboard/import',
  '/analyse_logs/dashboard/setup', '/analyse_logs/dashboard', '/analyse_logs/measurement'
];

let started = false;
app.on('browser-window-created', (_event, win) => {
  win.webContents.on('did-finish-load', () => {
    if (started || !win.webContents.getURL().startsWith('app://local/auth')) return;
    started = true;
    run(win).then(() => { console.log('DESIGN_SYSTEM_OK'); app.quit(); })
      .catch(error => { console.error(error.stack); app.exit(1); });
  });
});
require('../desktop/main.js');

async function run(win) {
  const errors = [];
  win.webContents.on('console-message', (_e, ...args) => {
    const d = typeof args[0] === 'object' ? args[0] : { level: args[0], message: args[1] };
    if (d.level === 'error' || d.level === 3) errors.push(`${win.webContents.getURL()} :: ${d.message}`);
  });
  const js = script => win.webContents.executeJavaScript(script);
  const go = async route => {
    const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await win.loadURL(`app://local${route}`);
    await loaded;
    await new Promise(resolve => setTimeout(resolve, 600));
  };

  // Compte de test local (profil temporaire) + jeu de données de démonstration.
  await js(`(async () => {
    const setup = document.getElementById('setup-form');
    const response = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: setup ? setup.querySelector('[name=email]').value : 'x@example.invalid', password: 'design-system-test', firstName: 'DS', lastName: 'Test' }) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    localStorage.setItem('engineeringAuthUser', JSON.stringify(result.user));
    sessionStorage.setItem('excelData', JSON.stringify({ 'Device List': { data: [
      { 'Device Name': 'ECU A', 'DM1 Current (mA)': 2, 'DM2 Current (mA)': 1.5, 'CM Current (mA)': 0.8 },
      { 'Device Name': 'ECU B', 'DM1 Current (mA)': 0.4, 'DM2 Current (mA)': 0.3, 'CM Current (mA)': 0.2 } ] } }));
    sessionStorage.setItem('selectedEcuKeys', JSON.stringify(['0_ECU A', '1_ECU B']));
  })()`);

  // 1. Toutes les pages : barre d'application, tokens, aucune erreur console.
  for (const route of ROUTES) {
    await go(route);
    const info = await js(`({
      appbar: !!document.querySelector('.rg-appbar'),
      token: getComputedStyle(document.documentElement).getPropertyValue('--rg-ink').trim(),
      overflow: document.documentElement.scrollWidth - window.innerWidth
    })`);
    assert.ok(info.appbar, `barre d'application absente sur ${route}`);
    assert.ok(info.token, `tokens absents sur ${route}`);
  }
  assert.deepEqual(errors, [], `Erreurs console :\n${errors.join('\n')}`);

  // 2. Thème : bascule persistée, tableaux toujours en « feuille » claire.
  await go('/biberonnage/resultats?days=30');
  await js(`document.querySelector('.rg-appbar .rg-icon-btn[aria-label*="sombre"]').click()`);
  assert.equal(await js(`document.documentElement.dataset.theme`), 'dark');
  await go('/biberonnage/resultats?days=30');
  assert.equal(await js(`document.documentElement.dataset.theme`), 'dark', 'thème non persisté');
  const sheet = await js(`getComputedStyle(document.querySelector('table')).colorScheme`);
  assert.equal(sheet, 'light');

  // 3. Couleurs Excel inchangées (thème sombre inclus).
  for (const route of ['/biberonnage/resultats?days=30', '/synthesis']) {
  await go(route);
  const xl = await js(`(() => {
    const out = {};
    for (const [cls, expected] of [['xl-limit','rgb(255, 255, 0)'], ['xl-dcdc-over','rgb(255, 192, 0)'], ['xl-input','rgb(204, 255, 255)'], ['xl-dcdc-under','rgb(0, 176, 80)'], ['xl-autonomy','rgb(0, 0, 0)']]) {
      const el = document.querySelector('td.' + cls);
      if (el) out[cls] = [getComputedStyle(el).backgroundColor, expected];
    }
    return out;
  })()`);
  for (const [cls, [actual, expected]] of Object.entries(xl)) assert.equal(actual, expected, `couleur Excel ${cls} modifiée`);
  console.log(`Couleurs Excel vérifiées sur ${route} (thème sombre) : ${Object.keys(xl).join(', ') || 'aucune cellule .xl-*'}`);
  }
  await js(`localStorage.setItem('rg-theme','light')`);

  // 4. Graphiques : zoom non destructif + réinitialisation.
  await go('/biberonnage/resultats?days=30');
  const chartCheck = await js(`(async () => {
    const charts = Object.values(Chart.instances);
    const line = charts.find(c => c.config.type === 'line');
    if (!line) return { skipped: true };
    const before = JSON.stringify(line.data.datasets.map(d => d.data));
    const toolbar = !!line.canvas.parentNode.querySelector('.rg-chart-toolbar');
    const xs = line.scales.x; const range0 = xs.max - xs.min;
    const rect = line.canvas.getBoundingClientRect();
    line.canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
    await new Promise(r => setTimeout(r, 50));
    const range1 = line.scales.x.max - line.scales.x.min;
    const after = JSON.stringify(line.data.datasets.map(d => d.data));
    line.canvas.parentNode.querySelector('[data-rg="reset"]').click();
    await new Promise(r => setTimeout(r, 50));
    const range2 = line.scales.x.max - line.scales.x.min;
    return { toolbar, zoomed: range1 < range0, dataSame: before === after, restored: Math.abs(range2 - range0) < 1e-9, count: charts.length };
  })()`);
  if (!chartCheck.skipped) {
    assert.ok(chartCheck.toolbar, 'barre d’outils graphique absente');
    assert.ok(chartCheck.zoomed, 'le zoom molette ne réduit pas la plage');
    assert.ok(chartCheck.dataSame, 'le zoom a modifié les données du graphique');
    assert.ok(chartCheck.restored, 'la vue initiale n’est pas restaurée');
  }
  console.log('Graphiques :', JSON.stringify(chartCheck));

  // 5. Data grid : tri / filtre / ordre d'origine non destructifs.
  await go('/synthesis');
  const gridCheck = await js(`(async () => {
    const table = document.querySelector('table.rg-grid');
    if (!table) return { skipped: true };
    const rows = () => Array.from(table.tBodies[0].rows);
    const snapshot = () => rows().map(r => r.outerHTML.replace(/ class="[^"]*rg-selected[^"]*"/, '')).join('');
    const multiset = () => rows().map(r => r.innerText).sort().join('|');
    const original = snapshot(); const set0 = multiset();
    const th = table.tHead.rows[0].cells[1];
    th.click(); th.click();
    const sortedDesc = th.getAttribute('aria-sort');
    const setSorted = multiset();
    const toolbar = table.closest('*').parentElement.querySelector('.rg-grid-toolbar') || document.querySelector('.rg-grid-toolbar');
    const search = toolbar.querySelector('.rg-grid-search');
    search.value = 'zzz-aucun-resultat'; search.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    const hiddenAll = rows().every(r => r.hidden);
    search.value = ''; search.dispatchEvent(new Event('input'));
    await new Promise(r => setTimeout(r, 200));
    th.click(); // 3e clic = ordre d'origine
    return { sortedDesc, sameValues: set0 === setSorted, hiddenAll, restored: snapshot() === original, grids: document.querySelectorAll('table.rg-grid').length };
  })()`);
  if (!gridCheck.skipped) {
    assert.equal(gridCheck.sortedDesc, 'descending');
    assert.ok(gridCheck.sameValues, 'le tri a modifié les valeurs');
    assert.ok(gridCheck.hiddenAll, 'le filtre ne masque pas les lignes');
    assert.ok(gridCheck.restored, 'l’ordre d’origine n’est pas restauré à l’identique');
  }
  console.log('Data grid :', JSON.stringify(gridCheck));

  // 6. Tableaux éditables jamais transformés en grid.
  await go('/biberonnage?days=30');
  assert.equal(await js(`document.querySelectorAll('table.rg-grid tbody input').length`), 0);

  // 7. Préférence « animations réduites ».
  await js(`document.querySelector('.rg-appbar .rg-icon-btn[aria-label="Animations réduites"]').click()`);
  assert.equal(await js(`document.documentElement.dataset.motion`), 'reduced');

  // 8. Fenêtre redimensionnée : pas de défilement horizontal sur l'accueil.
  win.setSize(1000, 700);
  await go('/');
  assert.ok(await js(`document.documentElement.scrollWidth <= window.innerWidth + 1`), 'débordement horizontal à 1000 px');
  win.setSize(1440, 920);
}
