// Fixtures Playwright partagées : une instance Electron par fichier de test,
// profil temporaire, compte administrateur local de test, boîtes « Enregistrer
// sous » et téléchargements redirigés vers un dossier de sortie inspectable.
const base = require('@playwright/test');
const { _electron: electron } = base;
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const PASSWORD = 'e2e-password-only';

/** Attend un fichier produit APRÈS l'appel (les anciens exports du dossier sont ignorés). */
async function waitForFile(dir, predicate, timeout = 30000) {
  const since = Date.now() - 1000;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const hit = fs.existsSync(dir) && fs.readdirSync(dir).find(name => predicate(name) && !name.endsWith('.crdownload')
      && fs.statSync(path.join(dir, name)).mtimeMs >= since);
    if (hit) {
      const file = path.join(dir, hit);
      // Attendre que l'écriture soit terminée (taille stable).
      let size = -1;
      while (size !== fs.statSync(file).size) { size = fs.statSync(file).size; await new Promise(r => setTimeout(r, 250)); }
      return file;
    }
    await new Promise(r => setTimeout(r, 200));
  }
  throw new Error(`Fichier attendu absent dans ${dir}`);
}

const test = base.test.extend({
  // Une application par worker (fichier) : démarrage du backend Python coûteux.
  app: [async ({}, use, workerInfo) => {
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-e2e-'));
    const downloads = path.join(profile, 'downloads');
    fs.mkdirSync(downloads, { recursive: true });
    const env = { ...process.env, WATTMAN_E2E_PROFILE: profile };
    delete env.ELECTRON_RUN_AS_NODE;
    const electronApp = await electron.launch({ args: [path.join(__dirname, 'launcher.cjs')], cwd: ROOT, env, timeout: 90000 });
    const window = await electronApp.firstWindow();
    await window.waitForURL(/app:\/\/local\/auth/, { timeout: 90000 });

    // Boîtes de dialogue et téléchargements → dossier de sortie.
    await electronApp.evaluate(({ dialog, session }, dir) => {
      const target = name => `${dir}\\${String(name || 'export').split(/[\\/]/).pop()}`;
      dialog.showSaveDialog = async (_window, options) => ({ canceled: false, filePath: target((options || _window || {}).defaultPath) });
      session.fromPartition('persist:wattman').on('will-download', (_event, item) => item.setSavePath(target(item.getFilename())));
    }, downloads);

    // Compte administrateur local de test (profil jetable).
    const adminEmail = await window.evaluate(async password => {
      const setup = document.getElementById('setup-form');
      const response = await fetch(setup ? '/api/auth/setup' : '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: setup ? setup.querySelector('[name=email]').value : '', password, firstName: 'Admin', lastName: 'E2E' })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      localStorage.setItem('engineeringAuthUser', JSON.stringify(result.user));
      return result.user.email;
    }, PASSWORD);

    const errors = [];
    // 502 = ESP32 / écran OLED injoignables : comportement attendu sans matériel.
    const expected = text => /Failed to load resource: .*status of 502/.test(text);
    window.on('console', message => { if (message.type() === 'error' && !expected(message.text())) errors.push(`${window.url()} :: ${message.text()}`); });
    window.on('pageerror', error => errors.push(`${window.url()} :: ${error.message} @ ${String(error.stack || '').split(/\r?\n/).slice(1, 3).join(' ')}`));
    await use({ electronApp, window, adminEmail, password: PASSWORD, profile, downloads, errors, root: ROOT, workerIndex: workerInfo.workerIndex });
    await electronApp.close().catch(() => {});
  }, { scope: 'worker', timeout: 180000 }],

  page: async ({ app }, use) => { await use(app.window); },
});

/** Navigue vers une route interne et attend la fin du chargement. */
async function go(page, route) {
  await page.goto(`app://local${route}`);
  await page.waitForLoadState('load');
  await page.waitForTimeout(400);
}

/** Jeu de données de démonstration (même format que l'import Excel). */
async function seedDemoData(page) {
  await page.evaluate(() => {
    localStorage.setItem('activeProject', JSON.stringify({ id: 'e2e-demo', name: 'Projet E2E', projectType: 'EV', evArchitecture: 'SDV', milestone: 'E2E', pilotWattman: 'Equipe test', updatedAt: new Date().toISOString() }));
    sessionStorage.setItem('excelData', JSON.stringify({ 'Device List': { data: [
      { 'Device Name': 'ECU A', 'DM1 Current (mA)': 2, 'DM2 Current (mA)': 1.5, 'CM Current (mA)': 0.8 },
      { 'Device Name': 'ECU B', 'DM1 Current (mA)': 0.4, 'DM2 Current (mA)': 0.3, 'CM Current (mA)': 0.2 }
    ] } }));
    sessionStorage.setItem('selectedEcuKeys', JSON.stringify(['0_ECU A', '1_ECU B']));
  });
}

/** Importe un vrai fichier ASC versionné puis ouvre le dashboard DCDC (canaux A et B). */
async function openMeasuredDashboard(page, ascName = 'mesures_courant_%Date%_%Time%_L213.asc') {
  await go(page, '/analyse_logs/');
  const b64 = fs.readFileSync(path.join(ROOT, 'test_asc', ascName)).toString('base64');
  const status = await page.evaluate(async data => {
    const bytes = Uint8Array.from(atob(data), c => c.charCodeAt(0));
    const body = new FormData();
    body.append('files', new File([bytes], 'e2e.asc'));
    return (await fetch('/analyse_logs/api/upload_and_ingest_measures', { method: 'POST', body })).status;
  }, b64);
  base.expect(status).toBe(200);
  await go(page, '/analyse_logs/dashboard/import');
  await page.locator('#continueButton:not([disabled])').click();
  await page.waitForURL(/dashboard\/setup/);
  await page.locator('[data-mode=dcdc]').click();
  await page.locator('input[name=dashboardChannelMode][value=AB]').check();
  for (const box of await page.locator('#deviceList input[type=checkbox]').all()) if (!(await box.isChecked())) await box.check();
  await page.locator('#setupForm button[type=submit]').click();
  await page.waitForURL(/\/analyse_logs\/dashboard\?/);
  await page.locator('#dashboardContent').waitFor({ state: 'visible', timeout: 60000 });
  await page.waitForFunction(() => Object.values(Chart.instances).filter(c => c.canvas.id.startsWith('currentChart')).length === 2);
}

module.exports = { test, expect: base.expect, go, seedDemoData, openMeasuredDashboard, waitForFile, ROOT };
