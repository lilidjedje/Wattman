// Accueil, création et sélection de projets, thème, animations réduites.
const path = require('node:path');
const { test, expect, go, ROOT } = require('./fixtures.cjs');

test.describe.configure({ mode: 'serial' });

test('l’accueil affiche la scène 3D, les outils et le compte connecté', async ({ page }) => {
  await go(page, '/');
  await expect(page.locator('.rg-appbar')).toBeVisible();
  await expect(page.locator('#home-title')).toHaveText('Engineering Calculator Hub');
  await expect(page.locator('.rg-user-name')).toHaveText('Admin E2E');
  await expect(page.locator('.rg-admin-link')).toBeVisible();
  await expect(page.locator('.home-modules li')).toHaveCount(4);
  await expect(page.locator('canvas[data-rg-hero3d]')).toBeVisible();
  await expect(page.locator('.recent-empty')).toContainText('Aucun projet');
});

test('la scène 3D tient au moins 30 images/s et se fige en mouvement réduit', async ({ page }) => {
  await go(page, '/');
  const fps = await page.evaluate(() => new Promise(resolve => {
    let frames = 0; const start = performance.now();
    const tick = now => { frames += 1; if (now - start < 1000) requestAnimationFrame(tick); else resolve(frames * 1000 / (now - start)); };
    requestAnimationFrame(tick);
  }));
  expect(fps).toBeGreaterThan(30);
  await page.locator('.rg-appbar .rg-icon-btn[aria-label="Animations réduites"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
  await go(page, '/');
  const duration = await page.locator('.home-actions .action').first().evaluate(el => getComputedStyle(el).transitionDuration);
  expect(duration.split(',').every(d => parseFloat(d) === 0)).toBe(true);
  await expect(page.locator('.rg-reveal')).toHaveCount(0);
  await page.locator('.rg-appbar .rg-icon-btn[aria-label="Animations réduites"]').click();
  await expect(page.locator('html')).not.toHaveAttribute('data-motion', 'reduced');
});

test('le thème sombre est persistant entre les pages', async ({ page }) => {
  await go(page, '/');
  await page.locator('.rg-appbar .rg-icon-btn[aria-label*="sombre"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await go(page, '/mode_selection');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  expect(bg).toBe('rgb(12, 11, 10)');
  await page.locator('.rg-appbar .rg-icon-btn[aria-label*="clair"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
});

test('création d’un projet depuis un classeur Excel de référence', async ({ page }) => {
  await go(page, '/');
  await page.locator('.home-actions .action.primary').click();
  await page.waitForURL(/import_project/);
  await expect(page.locator('[name="pilotWattman"]')).toHaveValue(/Admin E2E/);
  await page.locator('#file-input').setInputFiles(path.join(ROOT, 'DCDC - Test calcul.xlsx'));
  const values = { name: 'Projet E2E Playwright', eeArchitect: 'Architecture E2E', applicationZone: 'Europe', milestone: 'E2E' };
  for (const [name, value] of Object.entries(values)) await page.locator(`[name="${name}"]`).fill(value);
  await page.locator('.type-option:has(input[value="EV"])').click();
  await expect(page.locator('[name="projectType"][value="EV"]')).toBeChecked();
  await page.locator('[name="evArchitecture"]').selectOption('SUV');
  await page.locator('#project-form').evaluate(form => form.requestSubmit());
  await page.waitForURL(/select_components|mode_selection/, { timeout: 60000 });
  await expect(page.locator('.rg-nav-context')).toHaveText('Projet E2E Playwright');
});

test('le projet apparaît dans les récents et s’ouvre depuis la sélection', async ({ page }) => {
  await go(page, '/');
  await expect(page.locator('.recent-item').first()).toContainText('Projet E2E Playwright');
  await expect(page.locator('#project-count')).toContainText('1 projet');
  await page.locator('#load-project').click();
  await expect(page.locator('#project-dialog')).toBeVisible();
  await page.locator('#search-input').fill('inexistant');
  await expect(page.locator('#projects .empty')).toBeVisible();
  await page.locator('#search-input').fill('playwright');
  await page.locator('#type-filter').selectOption('SUV');
  await expect(page.locator('#projects .project-card')).toHaveCount(1);
  await page.locator('#projects .project-info').first().click();
  await page.waitForURL(/select_components|mode_selection/, { timeout: 60000 });
});

test('l’écran de mode propose trois outils accessibles au clavier', async ({ page }) => {
  await go(page, '/mode_selection');
  await expect(page.locator('.mode-card')).toHaveCount(3);
  await expect(page.locator('.mode-card .mode-icon svg')).toHaveCount(3);
  await page.locator('.mode-card[role="link"]').first().focus();
  await page.keyboard.press('Enter');
  await page.waitForURL(/homologation_configuration/);
});
