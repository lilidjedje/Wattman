const {app} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-pages-'));
app.setPath('userData', profile);
process.env.ENGINEERING_APP_DATA = path.join(profile, 'data');
// GUI tests may outlive their launching shell; keep diagnostics off its pipes.
const testLog = (...values) => fs.appendFileSync(path.join(profile, 'archive-test.log'), values.map(String).join(' ') + '\n');
console.log = testLog;
console.error = testLog;
let started = false;
app.on('browser-window-created', (_, win) => win.webContents.on('did-finish-load', () => {
    if (!started && win.webContents.getURL() === 'app://local/') {
        started = true;
        setTimeout(() => run(win).then(() => {console.log('DASHBOARD_ARCHIVE_OK'); app.quit();}).catch(error => {console.error(error.stack); app.exit(1);}), 1000);
    }
}));
require('../desktop/main.js');

async function run(win) {
    const js = script => win.webContents.executeJavaScript(script);
    const until = async expression => {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            if (await js(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw Error(`Timeout: ${expression}; ${await js("document.getElementById('logSearchStatus')?.textContent")}`);
    };
    const idle = () => until("!document.getElementById('logSearch').disabled");
    await js("location.href='/analyse_logs/dashboard/import'; true");
    await until("location.pathname === '/analyse_logs/dashboard/import' && !!document.getElementById('ascFiles')");
    const files = fs.readdirSync('test_asc').filter(name => name.endsWith('.asc')).sort().map(name => path.resolve('test_asc', name));
    win.webContents.debugger.attach('1.3');
    const dom = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const input = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId: dom.root.nodeId, selector: '#ascFiles'});
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {nodeId: input.nodeId, files});
    win.webContents.debugger.detach();
    console.log('PAGE_TEST import');
    await js("document.getElementById('uploadForm').requestSubmit()");
    await until("!document.getElementById('decodeResult').hidden && !document.getElementById('decodeButton').disabled");
    await until("document.getElementById('logSource').options.length === 4");
    console.log('PAGE_TEST search');
    await js("document.querySelector('#logFilterForm [name=graph]').checked = true; document.getElementById('logFilterForm').requestSubmit()");
    await idle();
    assert.match(await js("document.getElementById('logPageA').textContent"), /Page 1 sur 313/);
    assert.match(await js("document.getElementById('logPageB').textContent"), /Page 1 sur 612/);
    assert.equal(await js("document.getElementById('logPageInputA').max"), '313');
    assert.equal(await js("document.getElementById('logPageInputB').max"), '612');
    await js("document.getElementById('logPageInputA').value='5'; document.getElementById('logPageFormA').requestSubmit()");
    await idle();
    const expectedA = await js("document.getElementById('logRowsA').innerText");
    await js("document.querySelector('.dashboard-summary-menu').open=true; document.getElementById('saveExplorerDashboard').click(); document.getElementById('explorerDashboardName').value='Archive UI validation'; document.getElementById('saveExplorerForm').requestSubmit()");
    await until("!document.getElementById('saveExplorerDialog').open");
    await js("location.href='/analyse_logs/'; true");
    await until("!!document.querySelector('.dashboard-history a')");
    const href = await js("document.querySelector('.dashboard-history a').href");
    assert.match(href, /dashboard\/import\?saved_dashboard_id=/);
    await js(`location.href=${JSON.stringify(href)}; true`);
    await until("!!window.dashboardArchive && document.getElementById('logPageA')?.textContent.includes('Page 5 sur 313')");
    await idle();
    assert.equal(await js("document.getElementById('logRowsA').innerText"), expectedA);
    assert.match(await js("document.getElementById('logPageB').textContent"), /Page 1 sur 612/);
    assert.equal(await js("document.querySelectorAll('#logCharts canvas').length"), 2);
    assert.equal(await js("document.querySelector('.import-layout').hidden"), true);
    assert.equal(await js("document.querySelector('.workflow-next').hidden"), true);
    fs.mkdirSync('outputs/dashboard-archive-validation', {recursive:true});
    fs.writeFileSync('outputs/dashboard-archive-validation/result.json', JSON.stringify({href, pageA: await js("document.getElementById('logPageA').textContent"), pageB: await js("document.getElementById('logPageB').textContent"), fullDatabase:true, restoredFilters:true}, null, 2));
}
