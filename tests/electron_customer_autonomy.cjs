// Render the real Customer report page in an isolated, hidden Chromium window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-customer-test-')));
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
            response.end(fs.readFileSync(path.join(root, 'templates/battery_results_menu.html'), 'utf8')
                .replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g, '/static/$1'));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({ show: false, width: 1600, height: 1000 });
    const failures = [];
    win.webContents.on('console-message', (_event, level, message) => { if (level === 3) failures.push(message); });
    await win.loadURL(`http://127.0.0.1:${server.address().port}/battery_results_menu`);
    const expected = require('./fixtures/customer_autonomy_reference.json');
    for (const report of Object.keys(expected)) {
        const result = await win.webContents.executeJavaScript(`(() => {
            openReportModal('${report}');
            return {
                durations: [...document.querySelectorAll('#modal-body-target .kpi-row td')].slice(1).map(cell => cell.textContent),
                title: document.getElementById('m-title').textContent,
                width: document.getElementById('modal-body-target').getBoundingClientRect().width
            };
        })()`);
        assert.equal(result.durations.length, expected[report].length);
        expected[report].forEach((column, index) => {
            const duration = Number(result.durations[index].replace(' jours', '').replace(',', '.'));
            assert.ok(Math.abs(duration - column['6']) < 0.000051, `${report}/${index}`);
        });
        assert.ok(result.width > 500);
    }
    assert.deepEqual(failures, []);
    console.log('Chromium: all three Customer reports render the 13 Excel durations without script errors.');
    win.destroy();
    server.close();
    app.quit();
}).catch(error => {
    console.error(error.stack);
    server?.close();
    app.exit(1);
});
