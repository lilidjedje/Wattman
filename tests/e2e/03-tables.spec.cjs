// Data grid : tri, filtres, colonnes, regroupement, extrêmes, sélection, copie,
// exports CSV — avec vérification systématique que les valeurs ne changent pas.
const fs = require('node:fs');
const { test, expect, go, seedDemoData, waitForFile } = require('./fixtures.cjs');

test.describe.configure({ mode: 'serial' });

const rowsText = table => table.evaluate(t => Array.from(t.tBodies[0].rows).filter(r => !r.classList.contains('rg-group-row')).map(r => Array.from(r.cells).map(c => c.textContent.trim())));
const multiset = rows => rows.map(r => r.slice().sort().join('|')).sort();

// Tableau catégoriel de démonstration (forcé en data grid) ajouté à une vraie page.
async function injectDemoTable(page) {
  await page.evaluate(() => {
    const rows = [
      ['ECU A', 'Éclairage', '2,000 mA', '0,048 Ah/j'], ['ECU B', 'Confort', '0,400 mA', '0,010 Ah/j'],
      ['ECU C', 'Éclairage', '1,250 mA', '0,030 Ah/j'], ['ECU D', 'Sécurité', '3,100 mA', '0,074 Ah/j'],
      ['ECU E', 'Confort', '0,050 mA', '0,001 Ah/j'], ['ECU F', 'Sécurité', '0,900 mA', '0,022 Ah/j']
    ];
    const table = document.createElement('table');
    table.id = 'e2e-demo-table';
    table.dataset.rgGrid = 'on';
    table.innerHTML = '<thead><tr><th>ECU</th><th>Famille</th><th>Courant</th><th>Énergie</th></tr></thead><tbody>' +
      rows.map(r => `<tr>${r.map((v, i) => `<td${i === 2 && v.startsWith('3') ? ' class="xl-limit"' : ''}>${v}</td>`).join('')}</tr>`).join('') + '</tbody>';
    const wrap = document.createElement('section');
    wrap.innerHTML = '<h2>Tableau E2E</h2>';
    wrap.append(table);
    document.querySelector('main, .container, body').prepend(wrap);
  });
  await expect(page.locator('#e2e-demo-table.rg-grid')).toBeVisible();
  return page.locator('#e2e-demo-table');
}

test('les tableaux de synthèse deviennent des data grids sans modifier les valeurs', async ({ page }) => {
  await go(page, '/');
  await seedDemoData(page);
  await go(page, '/synthesis');
  await expect(page.locator('table.rg-grid')).toHaveCount(6);
  const table = page.locator('table.rg-grid').first();
  const before = await rowsText(table);
  const header = table.locator('thead th').nth(3);
  await header.click();
  await expect(header).toHaveAttribute('aria-sort', 'ascending');
  await header.click();
  await expect(header).toHaveAttribute('aria-sort', 'descending');
  expect(multiset(await rowsText(table))).toEqual(multiset(before));
  await header.click();
  await expect(header).toHaveAttribute('aria-sort', 'none');
  expect(await rowsText(table)).toEqual(before);
});

test('tri numérique au format français et vides en bas', async ({ page }) => {
  const table = await injectDemoTable(page);
  await table.locator('th', { hasText: 'Courant' }).click();
  const currents = (await rowsText(table)).map(r => r[2]);
  // L'application reformate les courants (µA / mA) : le tri doit suivre la valeur physique.
  expect(currents).toEqual(['50,00 µA', '400,00 µA', '900,00 µA', '1,25 mA', '2 mA', '3,1 mA']);
});

test('recherche globale et compteur de lignes', async ({ page }) => {
  await go(page, '/synthesis');
  const table = await injectDemoTable(page);
  const toolbar = page.locator('.rg-grid-toolbar').first();
  await toolbar.locator('.rg-grid-search').fill('sécurité');
  await expect(table.locator('tbody tr:not([hidden])')).toHaveCount(2);
  await expect(toolbar.locator('.rg-grid-count')).toContainText('2 / 6');
  await toolbar.locator('.rg-grid-search').fill('');
  await expect(table.locator('tbody tr:not([hidden])')).toHaveCount(6);
});

test('réorganisation des colonnes par glisser-déposer, cohérente ligne par ligne', async ({ page }) => {
  await go(page, '/synthesis');
  const table = await injectDemoTable(page);
  await table.locator('th', { hasText: 'Énergie' }).dragTo(table.locator('th', { hasText: 'ECU' }), { targetPosition: { x: 4, y: 10 } });
  const headers = await table.locator('thead th').evaluateAll(ths => ths.map(th => th.dataset.rgName));
  expect(headers[0]).toBe('Énergie');
  const rows = await rowsText(table);
  rows.forEach(r => { expect(r[0]).toMatch(/Ah\/j$/); expect(r[1]).toMatch(/^ECU /); });
  // Réorganisation au clavier (Alt + flèche) et retour à l'ordre d'origine.
  await table.locator('th', { hasText: 'Énergie' }).focus();
  await page.keyboard.press('Alt+ArrowRight');
  expect(await table.locator('thead th').evaluateAll(ths => ths[1].dataset.rgName)).toBe('Énergie');
  await page.locator('.rg-grid-toolbar').first().locator('summary', { hasText: 'Colonnes' }).click();
  await page.getByRole('button', { name: 'Ordre des colonnes d’origine' }).click();
  expect(await table.locator('thead th').evaluateAll(ths => ths.map(th => th.dataset.rgName))).toEqual(['ECU', 'Famille', 'Courant', 'Énergie']);
});

test('masquage de colonne, densité et préférences conservées après rechargement', async ({ page }) => {
  await go(page, '/synthesis');
  let table = page.locator('table.rg-grid').first();
  const toolbar = page.locator('.rg-grid-toolbar').first();
  const hiddenName = await table.locator('thead th').nth(2).evaluate(th => th.dataset.rgName);
  await toolbar.locator('summary', { hasText: 'Colonnes' }).click();
  await toolbar.locator('.rg-pop label', { hasText: hiddenName }).locator('input').uncheck();
  await expect(table.locator('thead th').nth(2)).toBeHidden();
  await toolbar.locator('button', { hasText: 'Densité' }).click();
  await expect(table).toHaveAttribute('data-density', 'comfortable');
  await go(page, '/synthesis');
  table = page.locator('table.rg-grid').first();
  await expect(table.locator('thead th').nth(2)).toBeHidden();
  await expect(table).toHaveAttribute('data-density', 'comfortable');
  await page.locator('.rg-grid-toolbar').first().locator('summary', { hasText: 'Colonnes' }).click();
  await page.locator('.rg-grid-toolbar').first().getByRole('button', { name: 'Tout afficher' }).click();
  await expect(table.locator('thead th').nth(2)).toBeVisible();
});

test('regroupement par famille avec effectifs et statistiques marquées dérivées', async ({ page }) => {
  await go(page, '/synthesis');
  const table = await injectDemoTable(page);
  const toolbar = page.locator('.rg-grid-toolbar').first();
  await toolbar.locator('.rg-grid-group').selectOption('Famille');
  const groups = table.locator('tr.rg-group-row');
  await expect(groups).toHaveCount(3);
  const eclairage = groups.filter({ hasText: 'Éclairage' });
  await expect(eclairage).toContainText('2 lignes');
  await expect(eclairage.locator('.rg-derived-badge')).toHaveText('dérivé');
  await expect(eclairage.locator('.rg-group-stats')).toContainText('Courant min 1,25 mA · max 2 mA');
  await eclairage.locator('.rg-group-toggle').click();
  await expect(table.locator('tbody tr[data-rg-group="Éclairage"]:not(.rg-group-row):not([hidden])')).toHaveCount(0);
  // Les lignes de groupe ne sont jamais exportées.
  const matrix = await table.evaluate(t => t.$rgGrid.matrix('all'));
  expect(matrix).toHaveLength(7);
  await toolbar.locator('.rg-grid-group').selectOption('');
  await expect(groups).toHaveCount(0);
});

test('encadrement des extrêmes sans toucher aux couleurs Excel', async ({ page }) => {
  await go(page, '/synthesis');
  const table = await injectDemoTable(page);
  const xlBefore = await table.locator('td.xl-limit').evaluate(td => getComputedStyle(td).backgroundColor);
  await page.locator('.rg-grid-toolbar').first().locator('button', { hasText: 'Min / Max' }).click();
  await expect(table.locator('td.rg-max', { hasText: '3,1 mA' })).toHaveCount(1);
  await expect(table.locator('td.rg-min', { hasText: '50,00 µA' })).toHaveCount(1);
  expect(await table.locator('td.xl-limit').evaluate(td => getComputedStyle(td).backgroundColor)).toBe(xlBefore);
  expect(xlBefore).toBe('rgb(255, 255, 0)');
  await page.locator('.rg-grid-toolbar').first().locator('button', { hasText: 'Min / Max' }).click();
});

test('sélection Ctrl/Maj + clic, copie et exports CSV (complet, filtré, sélection)', async ({ page, app }) => {
  await go(page, '/synthesis');
  const table = await injectDemoTable(page);
  const rows = table.locator('tbody tr');
  await rows.nth(0).click({ modifiers: ['Control'] });
  await rows.nth(2).click({ modifiers: ['Shift'] });
  await expect(table.locator('tr.rg-selected')).toHaveCount(3);
  const toolbar = page.locator('.rg-grid-toolbar').first();
  await toolbar.locator('button', { hasText: 'Copier' }).click();
  const clip = await app.electronApp.evaluate(({ clipboard }) => clipboard.readText());
  expect(clip.split(/\r?\n/)).toEqual(['ECU\tFamille\tCourant\tÉnergie', 'ECU A\tÉclairage\t2 mA\t0,048 Ah/j', 'ECU B\tConfort\t400,00 µA\t0,010 Ah/j', 'ECU C\tÉclairage\t1,25 mA\t0,030 Ah/j']);

  for (const [scope, expectedRows] of [['selected', 3], ['all', 6]]) {
    await toolbar.locator('summary', { hasText: 'Exporter' }).click();
    await toolbar.locator(`.rg-export button[data-scope="${scope}"]`).click();
    const file = await waitForFile(app.downloads, name => name.endsWith(`_${scope}.csv`));
    const lines = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').trim().split(/\r\n/);
    expect(lines[0]).toBe('ECU;Famille;Courant;Énergie');
    expect(lines).toHaveLength(expectedRows + 1);
    expect(lines[1]).toBe('ECU A;Éclairage;2 mA;0,048 Ah/j');
    if (scope === 'all') expect(lines).toContain('ECU D;Sécurité;3,1 mA;0,074 Ah/j');
    fs.unlinkSync(file);
  }
  await toolbar.locator('.rg-grid-search').fill('confort');
  await page.waitForTimeout(250);
  await toolbar.locator('summary', { hasText: 'Exporter' }).click();
  await toolbar.locator('.rg-export button[data-scope="filtered"]').click();
  const filtered = fs.readFileSync(await waitForFile(app.downloads, name => name.endsWith('_filtered.csv')), 'utf8').replace(/^﻿/, '').trim().split(/\r\n/);
  expect(filtered).toEqual(['ECU;Famille;Courant;Énergie', 'ECU B;Confort;400,00 µA;0,010 Ah/j', 'ECU E;Confort;50,00 µA;0,001 Ah/j']);
});

test('les tableaux de saisie ne sont jamais transformés', async ({ page }) => {
  await go(page, '/biberonnage?days=30');
  await expect(page.locator('table.rg-grid')).toHaveCount(0);
  await go(page, '/edit_current');
  expect(await page.locator('table.rg-grid tbody input').count()).toBe(0);
});
