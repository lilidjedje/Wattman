// Accueil public Wattman Tool, pages Connexion et Inscription.
const { test, expect, go } = require('./fixtures.cjs');

test.describe.configure({ mode: 'serial' });

test('accueil public : sans barre, image de fond, statistiques réelles', async ({ page }) => {
  await page.evaluate(() => fetch('/api/auth/logout', { method: 'POST' }));
  await go(page, '/auth');
  await expect(page.locator('.rg-appbar')).toHaveCount(0);
  await expect(page.locator('#landing-title')).toHaveText('Wattman Tool');
  await expect(page.locator('.auth-lede')).toContainText('comparer les résultats théoriques aux données mesurées');
  const bg = await page.locator('.auth-bg').evaluate(el => ({ image: getComputedStyle(el).backgroundImage, filter: getComputedStyle(el).filter }));
  expect(bg.image).toContain('ampere-background.webp');
  expect(bg.filter).toContain('blur');
  // Compteurs = sources réelles (comptes en base, projets du magasin local).
  const stats = await page.evaluate(async () => ({
    api: await (await fetch('/api/auth/stats')).json(),
    projects: await window.desktopEnvironment.projectCount()
  }));
  expect(Object.keys(stats.api)).toEqual(['accounts']);
  expect(stats.api.accounts).toBeGreaterThanOrEqual(1);
  await expect(page.locator('[data-stat="accounts"]')).toHaveText(String(stats.api.accounts));
  await expect(page.locator('[data-stat="projects"]')).toHaveText(String(stats.projects));
  // Sans session, les pages internes restent inaccessibles.
  await go(page, '/mode_selection');
  await expect(page).toHaveURL(/\/auth$/);
});

test('navigation Accueil, Connexion et Inscription dans les deux sens', async ({ page }) => {
  await go(page, '/auth');
  await expect(page.locator('form')).toHaveCount(0); // aucun formulaire sur l'accueil
  await page.locator('#go-login').click();
  await expect(page).toHaveURL(/page=login/);
  await expect(page.locator('h1')).toHaveText('Connexion');
  await page.locator('.auth-switch a').click();
  await expect(page).toHaveURL(/page=register/);
  await expect(page.locator('h1')).toHaveText('Créer un compte');
  await page.locator('.auth-switch a').click();
  await expect(page).toHaveURL(/page=login/);
  await page.locator('.auth-back').click();
  await expect(page).toHaveURL(/\/auth$/);
  await page.locator('#go-register').click();
  await expect(page).toHaveURL(/page=register/);
  await page.locator('.auth-back').click();
  await expect(page.locator('#landing-title')).toBeVisible();
});

test('inscription : validations, confirmation, afficher le mot de passe, e-mail déjà utilisé', async ({ page, app }) => {
  await go(page, '/auth?page=register');
  const form = page.locator('#register-form');
  const error = text => form.locator('.field-error').filter({ hasText: text });
  await form.locator('button[type=submit]').click();
  await expect(error('Le nom est obligatoire.')).toBeVisible();
  await expect(error('Saisissez votre adresse e-mail.')).toBeVisible();
  await form.locator('[name=lastName]').fill('Testeur');
  await form.locator('[name=firstName]').fill('Auth');
  await form.locator('[name=email]').fill('pas-un-email');
  await form.locator('[name=password]').fill('court');
  await form.locator('[name=passwordConfirm]').fill('different');
  await form.locator('button[type=submit]').click();
  await expect(error('Adresse e-mail invalide.')).toBeVisible();
  await expect(error('Au moins 8 caractères.')).toBeVisible();
  await expect(error('Les mots de passe ne correspondent pas.')).toBeVisible();
  const toggle = form.locator('.auth-password').first().locator('.auth-toggle');
  await toggle.click();
  await expect(form.locator('[name=password]')).toHaveAttribute('type', 'text');
  await toggle.click();
  await expect(form.locator('[name=password]')).toHaveAttribute('type', 'password');
  // Règle serveur conservée : adresse déjà utilisée.
  await form.locator('[name=email]').fill(app.adminEmail);
  await form.locator('[name=password]').fill('auth-e2e-password');
  await form.locator('[name=passwordConfirm]').fill('auth-e2e-password');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('.auth-alert')).toHaveText('Un compte utilise déjà cette adresse e-mail.');
});

test('inscription réussie puis le compteur de Wattmen augmente', async ({ page }) => {
  await go(page, '/auth');
  await expect(page.locator('.auth-stat.is-loading')).toHaveCount(0);
  const before = Number(await page.locator('[data-stat="accounts"]').textContent());
  await go(page, '/auth?page=register');
  const form = page.locator('#register-form');
  await form.locator('[name=lastName]').fill('Testeur');
  await form.locator('[name=firstName]').fill('Auth');
  await form.locator('[name=email]').fill('auth.e2e@example.invalid');
  await form.locator('[name=password]').fill('auth-e2e-password');
  await form.locator('[name=passwordConfirm]').fill('auth-e2e-password');
  await form.locator('button[type=submit]').click();
  await page.waitForURL(url => new URL(url).pathname === '/');
  await expect(page.locator('#account-name')).toHaveText('Auth Testeur');
  await page.locator('#logout-button').click();
  await page.waitForURL(/\/auth$/);
  await expect(page.locator('[data-stat="accounts"]')).toHaveText(String(before + 1));
});

test('connexion : erreurs puis succès avec un compte existant', async ({ page, app }) => {
  await go(page, '/auth?page=login');
  const form = page.locator('#login-form');
  const error = text => form.locator('.field-error').filter({ hasText: text });
  await form.locator('button[type=submit]').click();
  await expect(error('Saisissez votre adresse e-mail.')).toBeVisible();
  await expect(error('Saisissez votre mot de passe.')).toBeVisible();
  await form.locator('[name=email]').fill(app.adminEmail);
  await form.locator('[name=password]').fill('mauvais-mot-de-passe');
  await form.locator('button[type=submit]').click();
  await expect(form.locator('.auth-alert')).toHaveText('Adresse e-mail ou mot de passe incorrect.');
  await form.locator('[name=password]').fill(app.password);
  await form.locator('button[type=submit]').click();
  await page.waitForURL(url => new URL(url).pathname === '/');
  await expect(page.locator('#admin-link')).toBeVisible();
});
