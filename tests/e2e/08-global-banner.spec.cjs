// Bannière globale : identité, utilisateur, administration, déconnexion et
// sommaire contextuel construit à partir des routes réelles.
const path = require('node:path');
const { test, expect, go, seedDemoData, ROOT } = require('./fixtures.cjs');

test.describe.configure({ mode: 'serial' });
const SHOTS = path.join(ROOT, 'outputs', 'e2e-screens');
const bar = page => page.locator('.rg-appbar');

test('hub : identité, utilisateur, administration, sans sommaire', async ({ page }) => {
  await go(page, '/');
  await expect(bar(page)).toHaveCount(1);
  await expect(bar(page).locator('.rg-brand-text strong')).toHaveText('Wattman Tool');
  await expect(bar(page).locator('.rg-brand-text small')).toHaveText('Engineering Calculator Hub');
  await expect(bar(page).locator('.rg-user-name')).toHaveText('Admin E2E');
  await expect(bar(page).locator('.rg-admin-link')).toBeVisible();
  await expect(bar(page).locator('.rg-logout')).toBeVisible();
  await expect(bar(page).locator('.rg-tab')).toHaveCount(0);
  await expect(page.locator('.home-account')).toHaveCount(0); // plus de doublon sur l'accueil
  await page.screenshot({ path: path.join(SHOTS, 'banner-hub.png'), clip: { x: 0, y: 0, width: 1440, height: 140 } });
});

test('projet ouvert : sommaire du projet puis du module DCDC / WLTC', async ({ page }) => {
  await seedDemoData(page);
  await go(page, '/mode_selection');
  await expect(bar(page).locator('.rg-nav-context')).toHaveText('Projet E2E');
  await expect(bar(page).locator('.rg-tab')).toHaveText(['Composants', "Modes d'analyse", 'DCDC / WLTC', 'Autonomie batterie', 'Analyse de logs']);
  await expect(bar(page).locator('.rg-tab[aria-current="page"]')).toHaveText("Modes d'analyse");

  await bar(page).locator('.rg-tab', { hasText: 'DCDC / WLTC' }).click();
  await page.waitForURL(/homologation_configuration/);
  await expect(bar(page).locator('.rg-nav-module')).toHaveText('DCDC / WLTC');
  await expect(bar(page).locator('.rg-tab')).toHaveText(['Configuration', 'DCDC Sizing', 'WLTC (-7 °C)', 'PAO', 'GMV', 'Synthèse']);
  await bar(page).locator('.rg-tab', { hasText: 'Synthèse' }).click();
  await page.waitForURL(/\/synthesis$/);
  const active = bar(page).locator('.rg-tab[aria-current="page"]');
  await expect(active).toHaveText('Synthèse');
  await expect(active).toBeInViewport({ ratio: 1 });
  // L'indicateur lumineux rejoint l'onglet actif.
  await expect.poll(async () => {
    const [tab, line] = await Promise.all([active.boundingBox(), bar(page).locator('.rg-tab-indicator').boundingBox()]);
    return Math.abs(tab.x - line.x) + Math.abs(tab.width - line.width);
  }).toBeLessThan(2);
  await page.screenshot({ path: path.join(SHOTS, 'banner-dcdc.png'), clip: { x: 0, y: 0, width: 1440, height: 140 } });
  // Le contexte projet ramène aux modes d'analyse.
  await bar(page).locator('.rg-nav-context').click();
  await page.waitForURL(/mode_selection/);
});

test('module Autonomie et module Analyse de logs : onglets réels, élément actif', async ({ page }) => {
  await go(page, '/biberonnage/resultats?days=30');
  await expect(bar(page).locator('.rg-nav-module')).toHaveText('Autonomie batterie');
  await expect(bar(page).locator('.rg-tab[aria-current="page"]')).toHaveText('Biberonnage');
  for (const tab of await bar(page).locator('.rg-tab').all()) {
    const status = await page.evaluate(async href => (await fetch(href)).status, await tab.getAttribute('href'));
    expect(status, await tab.textContent()).toBe(200); // chaque onglet pointe vers une route existante
  }
  await go(page, '/analyse_logs/dashboard/import');
  await expect(bar(page).locator('.rg-nav-module')).toHaveText('Analyse de logs');
  await expect(bar(page).locator('.rg-tab[aria-current="page"]')).toHaveText('Import des logs');
  await expect(bar(page).locator('.rg-tab', { hasText: /^Dashboard$/ })).toHaveCount(0); // visible seulement quand actif
  await page.screenshot({ path: path.join(SHOTS, 'banner-logs.png'), clip: { x: 0, y: 0, width: 1440, height: 140 } });
});

test('même bannière (dimensions, position) sur toutes les pages authentifiées', async ({ page }) => {
  const boxes = [];
  for (const route of ['/', '/mode_selection', '/synthesis', '/battery_menu', '/admin', '/analyse_logs/']) {
    await go(page, route);
    const box = await bar(page).boundingBox();
    boxes.push(`${box.x},${box.y},${box.height}`);
    // Le contenu commence sous la bannière.
    const first = await page.evaluate(() => {
      const el = [...document.body.children].find(n => !n.classList.contains('rg-appbar') && n.getBoundingClientRect().height > 0 && getComputedStyle(n).position !== 'fixed');
      return el ? el.getBoundingClientRect().top + window.scrollY : 999;
    });
    expect(first, route).toBeGreaterThanOrEqual(box.height - 1);
  }
  expect(new Set(boxes).size).toBe(1);
  await page.evaluate(() => window.scrollTo(0, 600));
  await expect(bar(page)).toBeInViewport();
});

test('fenêtre étroite : bannière compacte sans débordement', async ({ page, app }) => {
  await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1000, 700));
  await go(page, '/synthesis');
  const overflow = await bar(page).evaluate(el => el.scrollWidth - el.clientWidth);
  expect(overflow).toBeLessThanOrEqual(1);
  await expect(bar(page).locator('.rg-logout')).toBeInViewport();
  await expect(bar(page).locator('.rg-tab[aria-current="page"]')).toBeInViewport();
  await page.screenshot({ path: path.join(SHOTS, 'banner-narrow.png'), clip: { x: 0, y: 0, width: 1000, height: 120 } });
  await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
});

test('absente des pages publiques ; déconnexion depuis la bannière', async ({ page }) => {
  await go(page, '/synthesis');
  await bar(page).locator('.rg-logout').click();
  await page.waitForURL(/\/auth$/);
  for (const route of ['/auth', '/auth?page=login', '/auth?page=register']) {
    await go(page, route);
    await expect(bar(page), route).toHaveCount(0);
  }
});
