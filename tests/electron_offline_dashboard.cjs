// Verify the real desktop workflow with neither ESP32 nor OLED available.
const {app} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-offline-'));
app.setPath('userData', profile);
process.env.ENGINEERING_APP_DATA = path.join(profile, 'data');
delete process.env.ESP32_SIMULATOR;
const data = path.join(profile, 'data', 'can_data');
fs.mkdirSync(data, {recursive: true});
// Closed localhost port: every optional hardware request must fail promptly.
fs.writeFileSync(path.join(data, 'esp32_connection.json'), JSON.stringify({base_url: 'http://127.0.0.1:9'}));
fs.writeFileSync(path.join(data, 'theory_snapshot.json'), JSON.stringify({project: {id: 'offline', name: 'Validation hors ligne'}, devices: [{id: 'd1', name: 'ECU test', kind: 'dcdc', nominal_A: 1}]}));
let started = false;
app.on('browser-window-created', (_, win) => win.webContents.on('did-finish-load', () => {
    if (!started && win.webContents.getURL() === 'app://local/') {
        started = true;
        setTimeout(() => run(win).then(() => {console.log('OFFLINE_DASHBOARD_OK'); app.quit();}).catch(error => {console.error(error.stack); app.exit(1);}), 150);
    }
}));
require('../desktop/main.js');

async function run(win) {
    const js = script => win.webContents.executeJavaScript(script);
    const until = async expression => {
        const deadline = Date.now() + 30000;
        while (Date.now() < deadline) {
            if (await js(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw Error(`Timeout: ${expression}: ${await js('document.body.innerText.slice(0,1000)')}`);
    };
    await js("sessionStorage.removeItem('measurementSourceMode')");
    await win.loadURL('app://local/analyse_logs/');
    assert.equal(await js("document.getElementById('dashboardButton').getAttribute('aria-disabled')"), null);
    assert.equal(await js("document.getElementById('dashboardButton').classList.contains('disabled-link')"), false);
    assert.equal(await js("document.getElementById('acquisitionButton').getAttribute('aria-disabled')"), 'true');
    // Even an empty database is available for consultation and import offline.
    await js("document.getElementById('dashboardButton').click()");
    await until("location.pathname === '/analyse_logs/dashboard/import' && document.getElementById('databaseState').textContent.includes('vide')");
    const result = await js(`(async () => {
        const body = new FormData();
        body.append('files', new File(['date 02/11/2026 10:00:00\\n0.0 1 100 Rx d 4 00 00 80 3F\\n1.0 1 100 Rx d 4 00 00 80 3F\\n'.replaceAll('\\\\n','\\n')], 'offline.asc'));
        const response = await fetch('/analyse_logs/api/upload_and_ingest_measures', {method:'POST', body});
        return {status:response.status, data:await response.json()};
    })()`);
    assert.equal(result.status, 200, JSON.stringify(result));
    assert.equal(result.data.measurements_count, 2);
    await win.loadURL('app://local/analyse_logs/');
    await until("document.getElementById('modeMessage').textContent.includes('indisponible')");
    assert.equal(await js("document.getElementById('dashboardButton').classList.contains('disabled-link')"), false);
    for (const mode of ['can', 'digital']) {
        await js(`document.querySelector('[data-measurement-mode=${mode}]').click()`);
        assert.equal(await js("document.getElementById('dashboardButton').getAttribute('href')"), '/analyse_logs/dashboard/open');
    }
    await js("document.getElementById('dashboardButton').click()");
    await until("location.pathname === '/analyse_logs/dashboard/import' && document.getElementById('measurementCount').textContent === '2'");
    await js("document.getElementById('continueButton').click()");
    await until("location.pathname === '/analyse_logs/dashboard/setup'");
    await js("document.querySelector('[data-mode=dcdc]').click(); document.getElementById('setupForm').requestSubmit()");
    await until("location.pathname === '/analyse_logs/dashboard' && !document.getElementById('dashboardContent').hidden");
    const sessionId = await js("new URLSearchParams(location.search).get('session_id')");
    const report = await js(`fetch('/analyse_logs/api/dashboard_report?session_id=${sessionId}').then(r=>r.json())`);
    assert.equal(report.measurement.channels[0].samples, 2);
    const saved = await js(`fetch('/analyse_logs/api/save_dashboard', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({session_id:${JSON.stringify(sessionId)},name:'Archive hors ligne'})}).then(r=>r.json())`);
    assert.equal(saved.status, 'success');
    await win.loadURL('app://local/analyse_logs/');
    await js("[...document.querySelectorAll('.history-card')].find(node=>node.innerText.includes('Archive hors ligne')).click()");
    await until("location.pathname === '/analyse_logs/dashboard' && !document.getElementById('dashboardContent').hidden");
    const archiveId = await js("new URLSearchParams(location.search).get('saved_dashboard_id')");
    const archived = await js(`fetch('/analyse_logs/api/dashboard_report?saved_dashboard_id=${archiveId}').then(r=>r.json())`);
    assert.equal(archived.measurement.channels[0].samples, 2);
    const output = path.resolve('outputs/offline-dashboard-validation');
    fs.mkdirSync(output, {recursive:true});
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({emptyDatabase:true, modeSelectionNotRequired:true, oledUnavailable:true, existingMeasurements:2, savedArchiveReadable:true}, null, 2));
}
