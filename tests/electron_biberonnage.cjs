// Render the biberonnage input/result pages and real Chart.js in an isolated, hidden window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-biberonnage-test-')));
let server;
app.whenReady().then(async () => {
    server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/static/project_storage.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end('window.ProjectStorage = { bindSaveButton() {}, getActiveProject() { return {}; } };');
        } else if (url.pathname.startsWith('/static/')) {
            const file = path.join(root, url.pathname);
            if (!fs.existsSync(file)) { response.writeHead(404).end(); return; }
            response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
            response.end(fs.readFileSync(file));
        } else {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            response.end(fs.readFileSync(path.join(root, url.pathname === '/biberonnage' ? 'templates/biberonnage.html' : 'templates/biberonnage_resultats.html'), 'utf8')
                .replace(/\{\{ duration_days(?: \| tojson)? \}\}/g, url.searchParams.get('days') || '30')
                .replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g, '/static/$1'));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({ show: false, width: 1600, height: 1000 });
    const failures = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') failures.push(details.message); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const fixtures = require('./fixtures/biberonnage_reference.json');
    for (const days of [30, 90]) {
        await win.loadURL(`${baseUrl}/biberonnage?days=${days}`);
        const configured = await win.webContents.executeJavaScript(`({
            first: document.querySelector('#body tr:not(.section) input').value,
            day1: defaultValue(rows[8], timeColumns.find(col => col.key === 'day-1'))
        })`);
        assert.ok(Number(configured.first) > 0, '30-second input');
        assert.equal(configured.day1, 5, 'day 1 must preserve the reference CDC current');
        await win.loadURL(`${baseUrl}/biberonnage/resultats?days=${days}`);
        const result = await win.webContents.executeJavaScript(`(() => {
            const result = calculateAnalysis(analyses[0]);
            const soc = chartInstances.get('base-soc');
            const pie = chartInstances.get('base-pie');
            return {
                sumAh: result.sumVeilleAh, events: result.events.length,
                charts: chartInstances.size, points: soc.data.datasets[0].data,
                pie: pie.data.datasets[0].data, cost: result.totalCost,
                total: document.querySelector('[data-output="total-cost"]').textContent,
                canvas: document.querySelector('[data-chart="soc"]').getBoundingClientRect().width
            };
        })()`);
        assert.ok(Math.abs(result.sumAh - fixtures[days === 30 ? 'base30' : 'delivery90'].sumAh) < 1e-6);
        assert.equal(result.events, Math.floor(days / 7));
        assert.equal(result.charts, 4);
        assert.ok(result.canvas > 200);
        assert.ok(Math.abs(result.pie.reduce((a, b) => a + b, 0) - result.cost) < 1e-8);
        const rises = result.points.filter((point, i, points) => i > 0 && point.x === points[i - 1].x && point.y > points[i - 1].y).length;
        assert.equal(rises, result.events, 'real sawtooth chart, one rise per recharge');
        if (days === 30) {
            await win.webContents.executeJavaScript(`document.querySelector('.dashboard').scrollIntoView(); chartInstances.forEach(chart => { chart.stop(); chart.update('none'); });`);
            const screenshot = path.join(app.getPath('userData'), 'biberonnage-dashboard.png');
            fs.writeFileSync(screenshot, (await win.webContents.capturePage()).toPNG());
            console.log('SCREENSHOT ' + screenshot);
        }
        const changed = await win.webContents.executeJavaScript(`(() => {
            analyses[0].config.frequencyDays = 0;
            analyses[0].config.efDemandSoc = 89;
            analyses[0].config.durationL2 = 30;
            renderAnalysis(analyses[0]);
            const result = calculateAnalysis(analyses[0]);
            return { count: result.events.length, lost: result.totalLossL2, each: result.ahL2 };
        })()`);
        assert.ok(changed.count > 0);
        assert.ok(Math.abs(changed.lost - changed.count * changed.each) < 1e-8);
    }
    assert.deepEqual(failures, []);
    console.log('Chromium: preparation and result pages render over 30/90 days; real Chart.js sawtooth/pie and interactive threshold recalculation verified.');
    win.destroy();
    server.close();
    app.quit();
}).catch(error => {
    console.error(error.stack);
    server?.close();
    app.exit(1);
});
