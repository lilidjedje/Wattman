// Hub : illustration 3D du véhicule, cartes outils interactives, cartes projets.
const path = require('node:path');
const { test, expect, go, ROOT } = require('./fixtures.cjs');

test.describe.configure({ mode: 'serial' });
const SHOTS = path.join(ROOT, 'outputs', 'e2e-screens');

test('illustration 3D : véhicule éclaté animé, fluide, figé en mouvement réduit', async ({ page, app }) => {
  // Les specs précédentes du même worker peuvent se terminer déconnectées.
  await page.evaluate(async ({ email, password }) => {
    if ((await (await fetch('/api/auth/me')).json()).user) return;
    const response = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    localStorage.setItem('engineeringAuthUser', JSON.stringify((await response.json()).user));
  }, { email: app.adminEmail, password: app.password });
  await go(page, '/');
  await expect(page.locator('.stage-caption, .stage-legend')).toHaveCount(0); // ni titre ni légende
  const canvas = page.locator('canvas[data-rg-hero3d]');
  await expect(canvas).toBeVisible();
  const sample = () => canvas.evaluate(c => c.toDataURL('image/png').length);
  const a = await sample();
  await page.waitForTimeout(400);
  expect(await sample()).not.toBe(a); // l'illustration est animée
  const fps = await page.evaluate(() => new Promise(resolve => {
    let n = 0; const s = performance.now();
    const f = now => { n += 1; if (now - s < 1000) requestAnimationFrame(f); else resolve(n * 1000 / (now - s)); };
    requestAnimationFrame(f);
  }));
  expect(fps).toBeGreaterThan(30);
  await page.screenshot({ path: path.join(SHOTS, 'hub-light.png') });
});

test('cartes outils : dépliage animé des sections réelles, une seule ouverte', async ({ page }) => {
  await go(page, '/');
  const tools = page.locator('.hub-tool');
  await expect(tools).toHaveCount(4);
  // Les quatre cartes ont exactement la même taille.
  const sizes = await tools.evaluateAll(els => els.map(e => { const r = e.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }));
  expect(new Set(sizes).size).toBe(1);
  await tools.nth(0).click();
  await expect(tools.nth(0)).toHaveAttribute('aria-expanded', 'true');
  await expect(tools.nth(0).locator('.hub-tool-detail li')).toHaveText(['Configuration', 'DCDC Sizing', 'WLTC (-7 °C)', 'PAO', 'GMV', 'Synthèse']);
  await expect(tools.nth(0).locator('.hub-tool-detail li').first()).toBeVisible();
  await tools.nth(3).click();
  await expect(tools.nth(3)).toHaveAttribute('aria-expanded', 'true');
  // La carte ouverte n'agrandit pas les autres : les trois cartes fermées restent identiques.
  const closed = await tools.evaluateAll(els => els.filter(e => e.getAttribute('aria-expanded') !== 'true').map(e => { const r = e.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }));
  expect(new Set(closed).size).toBe(1);
  await expect(tools.nth(0)).toHaveAttribute('aria-expanded', 'false');
  const accent = await tools.nth(3).evaluate(el => getComputedStyle(el).getPropertyValue('--acc').trim());
  expect(accent).not.toBe('');
  await tools.nth(3).click();
  await expect(tools.nth(3)).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Tab');
});

test('cartes projets : couleur par type, puces, badge, animation d’ouverture', async ({ page }) => {
  await page.evaluate(() => {
    const now = new Date().toISOString();
    localStorage.setItem('engineeringProjects', JSON.stringify([
      { id: 'hub-ev', name: 'Projet EV démo', projectType: 'EV', evArchitecture: 'SUV', milestone: 'A', pilotWattman: 'Pilote A', updatedAt: now, ownerId: JSON.parse(localStorage.getItem('engineeringAuthUser')).id },
      { id: 'hub-ice', name: 'Projet ICE démo', projectType: 'ICE', iceProject: 'VU', iceSubproject: 'XDD', milestone: 'B', pilotWattman: 'Pilote B', updatedAt: now, ownerId: JSON.parse(localStorage.getItem('engineeringAuthUser')).id }
    ]));
  });
  await go(page, '/');
  const ev = page.locator('.hub-project', { hasText: 'Projet EV démo' });
  const ice = page.locator('.hub-project', { hasText: 'Projet ICE démo' });
  await expect(ev).toHaveAttribute('data-type', 'ev');
  await expect(ice).toHaveAttribute('data-type', 'ice');
  await expect(ev.locator('.hub-badge')).toHaveAttribute('title', 'EV (SUV)');
  await expect(ice.locator('.hub-badge')).toHaveAttribute('title', 'ICE (VU - XDD)');
  await expect(ev.locator('.hub-chip')).toHaveText(['JalonA', 'PilotePilote A', /^Modifié\d{2}\/\d{2}\/\d{4}$/]);
  // Néon jaune Renault sur toutes les cartes projets.
  const accents = await Promise.all([ev, ice].map(l => l.evaluate(el => getComputedStyle(el).borderLeftColor + '|' + getComputedStyle(el, '::before').backgroundColor)));
  accents.forEach(a => expect(a.split('|')[1]).toBe('rgb(239, 223, 0)'));
  await page.locator('.rg-appbar .rg-icon-btn[aria-label*="sombre"]').click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, 'hub-dark.png') });
  await page.locator('.hub-tool').first().click();
  await page.waitForTimeout(450);
  await page.screenshot({ path: path.join(SHOTS, 'hub-dark-tool-open.png') });
  await page.locator('.rg-appbar .rg-icon-btn[aria-label*="clair"]').click();
  // Clic : état « ouverture » (bordure active + barre de chargement) puis ouverture du projet.
  page.once('dialog', dialog => dialog.dismiss());
  expect(await ev.evaluate(el => { el.click(); return el.classList.contains('is-opening'); })).toBe(true);
  await page.waitForURL(/select_components|mode_selection|\/$/, { timeout: 30000 });
  await page.evaluate(() => { localStorage.removeItem('engineeringProjects'); localStorage.removeItem('activeProject'); });
});
