// Navigation complète, fenêtres redimensionnées, administration et permissions.
const { test, expect, go, seedDemoData } = require('./fixtures.cjs');

test.describe.configure({ mode: 'serial' });

const ROUTES = [
  '/', '/import_project', '/select_components', '/mode_selection', '/homologation_configuration',
  '/edit_current', '/edit_alternator', '/edit_pao', '/edit_gmv', '/synthesis', '/battery_configuration',
  '/battery_menu', '/edit_customer_mode', '/edit_dm_mode', '/fixed_consumption', '/sleep_consumption',
  '/battery_results_menu', '/dm_results?mode=DM1', '/biberonnage', '/biberonnage/resultats?days=30',
  '/biberonnage/resultats?days=90', '/admin', '/analyse_logs/', '/analyse_logs/dashboard/import',
  '/analyse_logs/dashboard/setup', '/analyse_logs/measurement'
];

test('toutes les pages se chargent avec la barre d’application et sans erreur console', async ({ page, app }) => {
  await go(page, '/');
  await seedDemoData(page);
  app.errors.length = 0;
  for (const route of ROUTES) {
    await go(page, route);
    await expect(page.locator('.rg-appbar'), route).toHaveCount(1);
    const crumb = page.locator('.rg-crumb strong');
    if (await crumb.count()) {
      const h1 = (await page.locator('h1').first().textContent() || '').replace(/\s+/g, ' ').trim();
      await expect(crumb, route).toHaveText(h1.slice(0, 90));
    }
  }
  expect(app.errors, app.errors.join('\n')).toEqual([]);
});

test('le logo de la barre ramène à l’accueil', async ({ page }) => {
  await go(page, '/battery_menu');
  await page.locator('.rg-brand').click();
  await page.waitForURL(url => new URL(url).pathname === '/');
});

for (const [width, height] of [[1000, 700], [1280, 800], [1920, 1080]]) {
  test(`pas de défilement horizontal parasite à ${width}×${height}`, async ({ page, app }) => {
    await app.electronApp.evaluate(({ BrowserWindow }, size) => BrowserWindow.getAllWindows()[0].setContentSize(size[0], size[1]), [width, height]);
    for (const route of ['/', '/mode_selection', '/battery_menu', '/analyse_logs/', '/admin', '/import_project']) {
      await go(page, route);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${route} à ${width}px`).toBeLessThanOrEqual(1);
      await expect(page.locator('.rg-appbar')).toBeInViewport();
    }
  });
}

test('l’administrateur voit et gère les comptes', async ({ page, app }) => {
  await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const registered = await page.evaluate(async () => (await fetch('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ firstName: 'Utilisateur', lastName: 'Standard', email: 'user.e2e@example.invalid', password: 'user-e2e-password' })
  })).status);
  expect([200, 201]).toContain(registered);
  // L'inscription ouvre une session pour le nouveau compte : on reconnecte l'administrateur.
  await page.evaluate(async ({ email, password }) => {
    await fetch('/api/auth/logout', { method: 'POST' });
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (!response.ok) throw new Error('reconnexion admin impossible');
  }, { email: app.adminEmail, password: app.password });
  await go(page, '/admin');
  await expect(page).toHaveURL(/\/admin$/);
  await expect(page.locator('body')).toContainText('user.e2e@example.invalid');
  const accounts = await page.evaluate(async () => (await fetch('/api/admin/accounts')).json());
  expect(JSON.stringify(accounts)).toContain('user.e2e@example.invalid');
});

test('un compte standard n’a pas accès à l’administration', async ({ page }) => {
  await page.evaluate(async () => {
    await fetch('/api/auth/logout', { method: 'POST' });
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'user.e2e@example.invalid', password: 'user-e2e-password' }) });
    if (!response.ok) throw new Error('connexion utilisateur impossible');
    localStorage.setItem('engineeringAuthUser', JSON.stringify((await response.json()).user));
  });
  await go(page, '/admin');
  await expect(page).toHaveURL(url => new URL(url).pathname === '/');
  await expect(page.locator('#admin-link')).toBeHidden();
  const status = await page.evaluate(async () => (await fetch('/api/admin/accounts')).status);
  expect(status).toBe(403);
});

test('une session déconnectée renvoie vers l’authentification', async ({ page }) => {
  await go(page, '/');
  await page.locator('#logout-button').click();
  await page.waitForURL(/\/auth/);
  await go(page, '/mode_selection');
  await expect(page).toHaveURL(/\/auth/);
});

test('connexion sans « Se souvenir de moi » : la session reste ouverte jusqu’à la fermeture', async ({ page, app }) => {
  await go(page, '/auth?page=login');
  const form = page.locator('#login-form');
  await form.locator('[name=email]').fill(app.adminEmail);
  await form.locator('[name=password]').fill(app.password);
  await expect(form.locator('[name=rememberMe]')).not.toBeChecked();
  await form.locator('button[type=submit]').click();
  await page.waitForURL(url => new URL(url).pathname === '/');
  await go(page, '/mode_selection');
  await expect(page).toHaveURL(/mode_selection/);
  const remembered = await app.electronApp.evaluate(({ app: electronApp }) => process.getBuiltinModule('node:fs').existsSync(process.getBuiltinModule('node:path').join(electronApp.getPath('userData'), 'remembered-session')));
  expect(remembered).toBe(false);
});
