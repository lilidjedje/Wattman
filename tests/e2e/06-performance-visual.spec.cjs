// Performances sur des volumes représentatifs et captures visuelles de référence.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect, go, seedDemoData, openMeasuredDashboard, ROOT } = require('./fixtures.cjs');

test.describe.configure({ mode: 'serial' });
const SHOTS = path.join(ROOT, 'outputs', 'e2e-screens');

test('série de 200 000 points : rendu, zoom fluide et pics préservés par la décimation', async ({ page }) => {
  await go(page, '/');
  await seedDemoData(page);
  await go(page, '/biberonnage/resultats?days=30');
  const result = await page.evaluate(async () => {
    const N = 200000;
    const data = new Array(N);
    for (let i = 0; i < N; i++) data[i] = { x: i / 100, y: Math.sin(i / 500) * 2 + ((i * 7919) % 13) / 100 };
    data[123457] = { x: 1234.57, y: 99.5 };      // pic isolé de 1 échantillon
    data[45678] = { x: 456.78, y: -42.25 };      // creux isolé
    const host = document.createElement('div');
    host.style.cssText = 'position:relative;height:360px;width:1200px';
    host.innerHTML = '<h3>Perf E2E</h3><canvas id="perf-chart"></canvas>';
    document.body.prepend(host);
    const t0 = performance.now();
    const chart = new Chart(document.getElementById('perf-chart'), {
      type: 'line',
      data: { datasets: [{ label: 'Courant mesuré (A)', data, pointRadius: 0, borderWidth: 1, parsing: false }] },
      options: { animation: false, parsing: false, normalized: true, responsive: true, maintainAspectRatio: false,
        scales: { x: { type: 'linear', title: { display: true, text: 'Temps (s)' } }, y: { title: { display: true, text: 'Courant (A)' } } },
        plugins: { decimation: { enabled: true, algorithm: 'min-max' } } }
    });
    await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    const renderMs = performance.now() - t0;
    const shown = chart.data.datasets[0].data;
    const source = chart.data.datasets[0]._data || shown;
    const canvas = chart.canvas; const rect = canvas.getBoundingClientRect();
    const zoomTimes = [];
    for (let k = 0; k < 10; k++) {
      const s = performance.now();
      canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: k < 6 ? -120 : 120, clientX: rect.left + rect.width * 0.6, clientY: rect.top + rect.height / 2, bubbles: true, cancelable: true }));
      zoomTimes.push(performance.now() - s);
    }
    const res = {
      renderMs, zoomAvgMs: zoomTimes.reduce((a, b) => a + b, 0) / zoomTimes.length, zoomMaxMs: Math.max(...zoomTimes),
      sourceLength: source.length, shownLength: shown.length,
      maxShown: Math.max(...shown.map(p => p.y)), minShown: Math.min(...shown.map(p => p.y)),
      sourceIntact: source[123457].y === 99.5 && source[45678].y === -42.25
    };
    chart.destroy(); host.remove();
    return res;
  });
  console.log('PERF chart', JSON.stringify(result));
  expect(result.sourceLength).toBe(200000);               // données sources intactes
  expect(result.sourceIntact).toBe(true);
  expect(result.shownLength).toBeLessThan(20000);        // décimation effective
  expect(result.maxShown).toBe(99.5);                    // pic conservé
  expect(result.minShown).toBe(-42.25);                  // creux conservé
  expect(result.renderMs).toBeLessThan(3000);
  expect(result.zoomAvgMs).toBeLessThan(120);
});

test('tableau de 3 000 lignes : activation, tri et recherche rapides', async ({ page }) => {
  await go(page, '/synthesis');
  const timings = await page.evaluate(async () => {
    const rows = [];
    for (let i = 0; i < 3000; i++) rows.push(`<tr><td>ECU ${i}</td><td>${['Éclairage', 'Confort', 'Sécurité', 'Châssis'][i % 4]}</td><td>${((i * 37) % 997 / 10).toFixed(1).replace('.', ',')} A</td><td>${(i % 31)} j</td></tr>`);
    const table = document.createElement('table');
    table.id = 'perf-table';
    table.dataset.rgGrid = 'on';
    table.innerHTML = '<thead><tr><th>ECU</th><th>Famille</th><th>Courant</th><th>Autonomie</th></tr></thead><tbody>' + rows.join('') + '</tbody>';
    const t0 = performance.now();
    document.body.prepend(table);
    while (!table.classList.contains('rg-grid')) await new Promise(r => setTimeout(r, 10));
    const enhanceMs = performance.now() - t0;
    let s = performance.now();
    table.$rgGrid.sortBy('Courant');
    const sortMs = performance.now() - s;
    const values = Array.from(table.tBodies[0].rows).map(r => RGGrid.physical(r.cells[2].textContent.trim()).value); // valeur physique (A, mA, µA)
    const sorted = values.every((v, i) => i === 0 || values[i - 1] <= v);
    s = performance.now();
    table.$rgGrid.groupBy('Famille');
    const groupMs = performance.now() - s;
    const groups = table.querySelectorAll('tr.rg-group-row').length;
    table.remove();
    return { enhanceMs, sortMs, groupMs, sorted, groups };
  });
  console.log('PERF grid', JSON.stringify(timings));
  expect(timings.sorted).toBe(true);
  expect(timings.groups).toBe(4);
  expect(timings.enhanceMs).toBeLessThan(2500);
  expect(timings.sortMs).toBeLessThan(1500);
  expect(timings.groupMs).toBeLessThan(2000);
});

test('captures de référence des écrans principaux (clair et sombre)', async ({ page, app }) => {
  fs.mkdirSync(SHOTS, { recursive: true });
  await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1440, 900));
  const routes = [['home', '/'], ['mode-selection', '/mode_selection'], ['synthesis', '/synthesis'], ['biberonnage-resultats', '/biberonnage/resultats?days=30'],
    ['battery-results', '/battery_results_menu'], ['logs-home', '/analyse_logs/'], ['admin', '/admin']];
  for (const theme of ['light', 'dark']) {
    await page.evaluate(t => localStorage.setItem('rg-theme', t), theme);
    for (const [name, route] of routes) {
      await go(page, route);
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(SHOTS, `${name}-${theme}.png`) });
    }
  }
  await page.evaluate(() => localStorage.setItem('rg-theme', 'light'));
  await openMeasuredDashboard(page);
  // Captures par défilement (le mode fullPage d'Electron ne repeint pas tout le document).
  for (const [i, y] of [[1, 0], [2, 900], [3, 1800], [4, 2700]]) {
    await page.evaluate(top => window.scrollTo(0, top), y);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(SHOTS, `logs-dashboard-data-${i}-light.png`) });
  }
  expect(fs.readdirSync(SHOTS).filter(f => f.endsWith('.png')).length).toBeGreaterThanOrEqual(15);
});
