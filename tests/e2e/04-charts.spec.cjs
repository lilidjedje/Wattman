// Graphiques interactifs : zoom, plage, curseurs A/B, seuils, synchronisation,
// exports PNG / SVG / PDF / CSV — sur des calculs réels et des mesures ASC réelles.
const fs = require('node:fs');
const { test, expect, go, seedDemoData, openMeasuredDashboard, waitForFile } = require('./fixtures.cjs');

test.describe.configure({ mode: 'serial' });

const soc = page => page.locator('[data-chart="soc"]').first();
const chartState = (canvas, expr) => canvas.evaluate((c, e) => { const chart = Chart.getChart(c); return new Function('chart', `return (${e});`)(chart); }, expr);
const dataSnapshot = canvas => chartState(canvas, 'JSON.stringify(chart.data.datasets.map(d => d._data || d.data))');

test('graphique SOC : barre d’outils, zoom molette X/Y et vue initiale non destructifs', async ({ page }) => {
  await go(page, '/');
  await seedDemoData(page);
  await go(page, '/biberonnage/resultats?days=30');
  const canvas = soc(page);
  await expect(canvas).toBeVisible();
  const host = canvas.locator('xpath=..');
  for (const key of ['reset', 'cross', 'png', 'svg', 'pdf', 'csv']) await expect(host.locator(`.rg-chart-toolbar [data-rg="${key}"]`)).toHaveCount(1);
  const data0 = await dataSnapshot(canvas);
  const range0 = await chartState(canvas, 'chart.scales.x.max - chart.scales.x.min');
  const yRange0 = await chartState(canvas, 'chart.scales.y.max - chart.scales.y.min');
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -240);
  await expect.poll(() => chartState(canvas, 'chart.scales.x.max - chart.scales.x.min')).toBeLessThan(range0);
  await page.keyboard.down('Alt');
  await page.mouse.wheel(0, -240);
  await page.keyboard.up('Alt');
  await expect.poll(() => chartState(canvas, 'chart.scales.y.max - chart.scales.y.min')).toBeLessThan(yRange0);
  expect(await dataSnapshot(canvas)).toBe(data0);
  await host.locator('[data-rg="reset"]').click();
  await expect.poll(() => chartState(canvas, 'chart.scales.x.max - chart.scales.x.min')).toBeCloseTo(range0, 6);
  expect(await chartState(canvas, 'chart.scales.y.max - chart.scales.y.min')).toBeCloseTo(yRange0, 6);
});

test('sélection d’une plage (Maj + glisser) puis déplacement et double-clic', async ({ page }) => {
  const canvas = soc(page);
  await canvas.scrollIntoViewIfNeeded();
  const box = await canvas.boundingBox();
  const area = await chartState(canvas, '({ left: chart.chartArea.left, right: chart.chartArea.right, top: chart.chartArea.top, bottom: chart.chartArea.bottom })');
  const y = box.y + (area.top + area.bottom) / 2;
  const x1 = box.x + area.left + (area.right - area.left) * 0.25;
  const x2 = box.x + area.left + (area.right - area.left) * 0.5;
  await page.keyboard.down('Shift');
  await page.mouse.move(x1, y); await page.mouse.down(); await page.mouse.move(x2, y, { steps: 6 }); await page.mouse.up();
  await page.keyboard.up('Shift');
  const zoomed = await chartState(canvas, '[chart.scales.x.min, chart.scales.x.max]');
  const full = await chartState(canvas, '[chart.$rgInitial.x.dataMin, chart.$rgInitial.x.dataMax]');
  const span = full[1] - full[0];
  expect(zoomed[0]).toBeGreaterThan(full[0] + span * 0.2);
  expect(zoomed[1]).toBeLessThan(full[0] + span * 0.55);
  // Déplacement : la largeur de la vue est conservée.
  await page.mouse.move(x2, y); await page.mouse.down(); await page.mouse.move(x1, y, { steps: 6 }); await page.mouse.up();
  const panned = await chartState(canvas, '[chart.scales.x.min, chart.scales.x.max]');
  expect(panned[1] - panned[0]).toBeCloseTo(zoomed[1] - zoomed[0], 6);
  expect(panned[0]).toBeGreaterThan(zoomed[0]);
  await canvas.dblclick({ position: { x: (area.left + area.right) / 2, y: (area.top + area.bottom) / 2 } });
  await expect.poll(() => chartState(canvas, 'chart.$rgZoomed')).toBe(false);
});

test('curseurs A/B accrochés aux points mesurés et écarts ΔX / ΔY', async ({ page }) => {
  const canvas = soc(page);
  await canvas.scrollIntoViewIfNeeded();
  const area = await chartState(canvas, '({ left: chart.chartArea.left, right: chart.chartArea.right, top: chart.chartArea.top, bottom: chart.chartArea.bottom })');
  const yMid = (area.top + area.bottom) / 2;
  await canvas.click({ modifiers: ['Control'], position: { x: area.left + (area.right - area.left) * 0.2, y: yMid } });
  await canvas.click({ modifiers: ['Control'], position: { x: area.left + (area.right - area.left) * 0.7, y: yMid } });
  const markers = await chartState(canvas, 'chart.$rgMarkers.map(m => ({ name: m.name, x: m.x, y: m.y }))');
  expect(markers.map(m => m.name)).toEqual(['A', 'B']);
  // Chaque curseur correspond exactement à un point de la série (pas d'interpolation).
  const points = await chartState(canvas, 'chart.data.datasets[0].data.map(p => [p.x, p.y])');
  for (const m of markers) expect(points.some(([x, y]) => x === m.x && y === m.y)).toBe(true);
  expect(markers[1].x).toBeGreaterThan(markers[0].x);
  const host = canvas.locator('xpath=..');
  await expect(host.locator('[data-rg="marker"]')).toBeVisible();
  await host.locator('[data-rg="marker"]').click();
  expect(await chartState(canvas, 'chart.$rgMarkers.length')).toBe(0);
});

test('réticule activable et désactivable', async ({ page }) => {
  const host = soc(page).locator('xpath=..');
  const cross = host.locator('[data-rg="cross"]');
  await host.hover();
  await expect(cross).toHaveAttribute('aria-pressed', 'true');
  await cross.click();
  await expect(cross).toHaveAttribute('aria-pressed', 'false');
  await cross.click();
  await expect(cross).toHaveAttribute('aria-pressed', 'true');
});

test('exports PNG, SVG vectoriel, PDF et CSV des valeurs sources', async ({ page, app }) => {
  const canvas = soc(page);
  const host = canvas.locator('xpath=..');
  await host.hover();
  await host.locator('[data-rg="png"]').click();
  const png = fs.readFileSync(await waitForFile(app.downloads, n => n.endsWith('.png')));
  expect(png.subarray(1, 4).toString('ascii')).toBe('PNG');
  await host.locator('[data-rg="svg"]').click();
  const svg = fs.readFileSync(await waitForFile(app.downloads, n => n.endsWith('.svg')), 'utf8');
  expect(svg.startsWith('<svg')).toBe(true);
  expect((svg.match(/<path/g) || []).length).toBeGreaterThan(10);
  expect(svg).toContain('<title>');
  await host.locator('[data-rg="pdf"]').click();
  const pdf = fs.readFileSync(await waitForFile(app.downloads, n => n.endsWith('.pdf')));
  expect(pdf.subarray(0, 5).toString('ascii')).toBe('%PDF-');
  await host.locator('[data-rg="csv"]').click();
  const csv = fs.readFileSync(await waitForFile(app.downloads, n => n.endsWith('.csv')), 'utf8').replace(/^﻿/, '').trim().split(/\r\n/);
  const points = await chartState(canvas, 'chart.data.datasets.reduce((n, d) => n + (d._data || d.data).length, 0)');
  expect(csv).toHaveLength(points + 1);
  const first = await chartState(canvas, 'chart.data.datasets[0].data[0]');
  expect(csv[1]).toBe(`${await chartState(canvas, 'chart.data.datasets[0].label')};${first.x};${first.y}`);
});

test('dashboard de mesures réelles : seuils masquables et axes synchronisés A/B', async ({ page }) => {
  await openMeasuredDashboard(page);
  const a = page.locator('#currentChartA');
  const b = page.locator('#currentChartB');
  const hostA = a.locator('xpath=..');
  await hostA.hover();
  const threshold = hostA.locator('[data-rg="threshold"]');
  await expect(threshold).toHaveAttribute('aria-pressed', 'true');
  await threshold.click();
  expect(await chartState(a, "chart.data.datasets.filter((d, i) => /seuil|limite/i.test(d.label) && chart.isDatasetVisible(i)).length")).toBe(0);
  expect(await chartState(a, "chart.isDatasetVisible(0)")).toBe(true);
  await threshold.click();
  expect(await chartState(a, "chart.data.datasets.filter((d, i) => /seuil|limite/i.test(d.label) && chart.isDatasetVisible(i)).length")).toBeGreaterThan(0);

  await hostA.locator('[data-rg="sync"]').click();
  await expect(hostA.locator('[data-rg="sync"]')).toHaveAttribute('aria-pressed', 'true');
  await a.scrollIntoViewIfNeeded();
  const box = await a.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -480);
  await expect.poll(async () => {
    const [ra, rb] = [await chartState(a, '[chart.scales.x.min, chart.scales.x.max]'), await chartState(b, '[chart.scales.x.min, chart.scales.x.max]')];
    return Math.abs(ra[0] - rb[0]) + Math.abs(ra[1] - rb[1]);
  }).toBeLessThan(1e-9);
  const full = await chartState(b, 'chart.$dataBounds.max - chart.$dataBounds.min');
  expect(await chartState(b, 'chart.scales.x.max - chart.scales.x.min')).toBeLessThan(full);
  // Export SVG : les seuils en pointillés restent des tirets vectoriels.
  await hostA.locator('[data-rg="svg"]').click();
});
