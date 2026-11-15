// Exports existants de l'application (inchangés) : Excel DCDC, synthèse globale
// PDF et Excel. Les fichiers produits sont relus et contrôlés.
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { test, expect, go, seedDemoData, waitForFile, ROOT } = require('./fixtures.cjs');

test.describe.configure({ mode: 'serial' });

/** Lit un classeur avec openpyxl (Python du projet) : feuilles et nombre de cellules remplies. */
function inspectWorkbook(file) {
  const script = 'import json,sys\nfrom openpyxl import load_workbook\nwb=load_workbook(sys.argv[1],data_only=False)\nprint(json.dumps({ws.title: sum(1 for r in ws.iter_rows() for c in r if c.value is not None) for ws in wb.worksheets}))';
  return JSON.parse(execFileSync('python', ['-c', script, file], { cwd: ROOT, encoding: 'utf8' }));
}

test('export Excel de la synthèse DCDC (classeur lisible, données présentes)', async ({ page, app }) => {
  await go(page, '/');
  await seedDemoData(page);
  await go(page, '/synthesis');
  await page.locator('#export-excel').click();
  const file = await waitForFile(app.downloads, n => n.endsWith('.xlsx'), 60000);
  const bytes = fs.readFileSync(file);
  expect(bytes.subarray(0, 2).toString('ascii')).toBe('PK');
  const sheets = inspectWorkbook(file);
  expect(Object.keys(sheets).length).toBeGreaterThan(0);
  expect(Object.values(sheets).reduce((a, b) => a + b, 0)).toBeGreaterThan(20);
});

async function prepareGlobalSynthesis(page) {
  await page.evaluate(() => {
    sessionStorage.setItem('excelData', JSON.stringify({ 'Device List': { data: [{ 'Device Name': 'AIBS', current_category: 'S', 'DM1 Current (mA)': 50, 'DM2 Current (mA)': 70, 'CM Current (mA)': 0.09 }] } }));
    sessionStorage.setItem('homologationDevices', JSON.stringify([{ key: '0_DRL', rowIndex: 0, name: 'DRL', current: 0.000045, lower: 0, upper: 1 }]));
    sessionStorage.setItem('homologationConfiguration', JSON.stringify({ dcdcOutputCurrentA: 2.5 }));
  });
  await go(page, '/export_synthesis_pdf');
  await page.evaluate(() => {
    document.querySelectorAll('#selection input[type=checkbox]').forEach(input => {
      input.checked = input.name.startsWith('bib-profile') ? input.value === 'base'
        : input.name === 'customer-scenario' ? ['baseLab', 'alarmTachy'].includes(input.value) : true;
    });
    document.getElementById('selection-form').requestSubmit();
  });
  await page.waitForFunction(() => loadedReports > 0 && loadedReports === expectedReports, null, { timeout: 90000 });
  await expect(page.locator('#generate-pdf')).toBeEnabled();
}

test('synthèse globale : génération du PDF natif', async ({ page, app }) => {
  await prepareGlobalSynthesis(page);
  await page.locator('#generate-pdf').click();
  const file = await waitForFile(app.downloads, n => n.endsWith('-synthese.pdf'), 120000);
  const pdf = fs.readFileSync(file);
  expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  expect(pdf.length).toBeGreaterThan(10000);
});

test('synthèse globale : génération du fichier Excel', async ({ page, app }) => {
  await page.locator('#generate-excel').click();
  const file = await waitForFile(app.downloads, n => /\.(xlsx|zip)$/.test(n) && !n.startsWith('Synthese_Homologation_DCDC'), 120000);
  expect(fs.readFileSync(file).subarray(0, 2).toString('ascii')).toBe('PK');
});
