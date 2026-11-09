// End-to-end desktop import and browsing in an isolated profile.
const {app} = require('electron');
app.disableHardwareAcceleration();
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-can-explorer-'));
app.setPath('userData', profile);
process.env.ENGINEERING_APP_DATA = path.join(profile, 'data');
const output = path.resolve(__dirname, '../outputs/log-explorer-validation');
fs.mkdirSync(output, {recursive: true});
let started = false;
app.on('browser-window-created', (_, win) => {
    win.webContents.on('did-finish-load', () => {
        if (!started && win.webContents.getURL() === 'app://local/') {
            started = true;
            setTimeout(() => run(win).then(() => {console.log('LOG_EXPLORER_OK'); app.quit();}).catch(error => {console.error(error); app.exit(1);}), 100);
        }
    });
});
require('../desktop/main.js');
async function run(win) {
    const js = script => win.webContents.executeJavaScript(script);
    const errors = [];
    win.webContents.on('console-message', (_, level, message) => {if (level === 3) errors.push(message);});
    const until = async expression => {
        const end = Date.now() + 90000;
        while (Date.now() < end) {
            if (await js(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw new Error(`Timeout: ${expression}; ${await js('document.body.innerText')}`);
    };
    const shot = async name => {
        win.webContents.debugger.attach('1.3');
        try {
            const capture = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {format: 'png', fromSurface: false});
            fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(capture.data, 'base64'));
        } finally {win.webContents.debugger.detach();}
    };
    const files = [];
    for (let day = 1; day <= 3; day++) {
        const file = path.join(profile, `Branche-A-et-B-jour-${day}.asc`);
        const lines = [`date 0${day}/11/2026 10:00:00`, '0.0 1 101 Rx d 4 B8 0B 00 00', '0.0 1 103 Rx d 4 B8 0B 00 00'];
        for (let i = 0; i < 6000; i++) {
            for (const [id, value] of [['100', i === 1234 ? 15 : .000020 + i / 60000000], ['102', .5 + i / 6000]]) {
                const bytes = Buffer.alloc(4); bytes.writeFloatLE(value);
                lines.push(`${(i / 3000).toFixed(6)} 1 ${id} Rx d 4 ${[...bytes].map(x => x.toString(16).padStart(2, '0')).join(' ')}`);
            }
        }
        fs.writeFileSync(file, lines.join('\n'));
        // Exceed the old 50 MB request limit, with memory bounded during import.
        if (day === 1) {
            const comment = '\n// ' + 'x'.repeat(1020);
            const fd = fs.openSync(file, 'a');
            for (let i = 0; i < 55; i++) fs.writeSync(fd, comment.repeat(1024));
            fs.closeSync(fd);
        }
        files.push(file);
    }
    await win.loadURL('app://local/analyse_logs/dashboard/import');
    await until("document.getElementById('logSearchStatus').textContent.includes('Importez')");
    win.webContents.debugger.attach('1.3');
    const document = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const input = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId: document.root.nodeId, selector: '#ascFiles'});
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {nodeId: input.nodeId, files});
    win.webContents.debugger.detach();
    await js("document.getElementById('uploadForm').requestSubmit()");
    await until("!document.getElementById('decodeResult').hidden && !document.getElementById('decodeButton').disabled");
    await until("document.getElementById('logDay').options.length === 4");
    assert.equal(await js("document.getElementById('decodedCount').textContent.replace(/\\D/g, '')"), '36000');
    await shot('import-results');
    await js("document.getElementById('decodeResult').scrollIntoView()");
    await shot('decode-summary');
    await js("document.querySelector('[name=graph]').checked=true; document.getElementById('logFilterForm').requestSubmit()");
    await until("document.querySelectorAll('#logCharts canvas').length === 2 && !document.getElementById('logSearch').disabled");
    assert.equal(await js("document.querySelectorAll('#logRows tr').length"), 100);
    assert.equal(await js("document.querySelector('#logRows tr td:nth-child(2)').textContent"), '10:00:00.000000');
    await js("document.getElementById('logExplorer').scrollIntoView()");
    await shot('explorer-two-branches');
    await js("document.getElementById('logGraphArea').scrollIntoView()");
    await shot('graphs-and-table');
    await js("document.getElementById('logNext').click()");
    await until("document.getElementById('logPage').textContent === 'Page 2'");
    await js("document.getElementById('logPrevious').click()");
    await until("document.getElementById('logPage').textContent === 'Page 1'");
    await js("document.querySelector('[name=channel]').value='A'; document.querySelector('[name=unit]').value='uA'; document.querySelector('[name=threshold]').value='4000000'; document.querySelector('[name=day]').value='2026-11-02'; document.getElementById('logFilterForm').requestSubmit()");
    await until("!document.getElementById('logSearch').disabled && document.querySelectorAll('#logCharts canvas').length === 1");
    assert.equal(await js("document.querySelectorAll('#logRows tr').length"), 1);
    assert.equal(await js("document.querySelector('#logRows tr td').textContent"), '02/11/2026');
    assert.match(await js("document.getElementById('logCurrentHeading').textContent"), /µA/);
    await shot('filtered-microamps');
    await js("document.getElementById('logReset').click()");
    await until("!document.getElementById('logSearch').disabled && document.querySelectorAll('#logRows tr').length===100");
    assert.equal(await js("document.querySelector('[name=threshold]').value"), '');
    assert.equal(await js("document.getElementById('logGraphArea').hidden"), true);
    // Responsive layout must not overflow the page.
    win.setSize(800, 900);
    await js("document.getElementById('logExplorer').scrollIntoView()");
    await shot('explorer-narrow');
    assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'), true);
    // DCDC/WLTC use minute ranges; hidden feeding/day fields must stay hidden.
    win.setSize(1280, 900);
    const sessionId = await js("fetch('/analyse_logs/api/measurement_sessions').then(r=>r.json()).then(data=>data.sessions[0].id)");
    await js("fetch('/analyse_logs/import-theory', {method:'POST', body: new URLSearchParams({theory_snapshot: JSON.stringify({devices:[{id:'d1',name:'ECU test',kind:'dcdc',nominal_A:5}],analysis_config:{dcdc_output_current_A:200}})})}).then(()=>true)");
    for (const mode of ['dcdc', 'wltc']) {
        await win.loadURL(`app://local/analyse_logs/dashboard/setup?session_id=${sessionId}`);
        await js(`document.querySelector('[data-mode="${mode}"]').click()`);
        const fields = await js("Object.fromEntries(['feedingAnalysisField','dayRangeField','minuteRangeField'].map(id=>[id,getComputedStyle(document.getElementById(id)).display]))");
        assert.equal(fields.feedingAnalysisField, 'none');
        assert.equal(fields.dayRangeField, 'none');
        assert.notEqual(fields.minuteRangeField, 'none');
        await js("document.getElementById('startMinute').value='0.01'; document.getElementById('endMinute').value='0.02'");
        await shot(`setup-${mode}-minutes`);
        await js("document.getElementById('setupForm').requestSubmit()");
        await until("location.pathname === '/analyse_logs/dashboard' && document.getElementById('measurementRange')?.textContent.includes('0,02')");
        assert.equal(await js("getComputedStyle(document.getElementById('feedingName')).display"), 'none');
        assert.equal(await js("getComputedStyle(document.getElementById('kpis')).display"), 'none');
        assert.equal(await js("getComputedStyle(document.getElementById('sizingMarginPanel')).display"), 'none');
        const report = await js(`fetch('/analyse_logs/api/dashboard_report?session_id=${sessionId}').then(r=>r.json())`);
        assert.equal(report.measurement.series[0].raw_samples, 1801);
        assert.equal(report.analysis.start_minute, .01);
        await shot(`dashboard-${mode}-minutes`);
    }
    await win.loadURL(`app://local/analyse_logs/dashboard/setup?session_id=${sessionId}`);
    await js("document.querySelector('[data-mode=dcdc]').click(); document.getElementById('startMinute').value='0'; document.getElementById('endMinute').value='0.05'; document.getElementById('setupForm').requestSubmit()");
    await until("location.pathname === '/analyse_logs/dashboard' && document.getElementById('deviceReports')?.innerText.includes('Minute manquante')");
    const checks = await js(`fetch('/analyse_logs/api/dashboard_report?session_id=${sessionId}').then(r=>r.json()).then(r=>r.analysis.intervals[0].sample_checks)`);
    assert.equal(checks.A.status, 'fail');
    assert.equal(checks.A.exceedances, 1);
    assert.equal(checks.B.status, 'missing');
    assert.equal(await js("document.getElementById('deviceReports').innerText.includes('PAS OK')"), true);
    await js("document.getElementById('deviceReports').scrollIntoView()");
    await shot('peak-and-missing-minutes');
    await js("fetch('/analyse_logs/import-theory', {method:'POST', body:new URLSearchParams({theory_snapshot:JSON.stringify({devices:['dm1','dm2','customer'].map(mode=>({id:mode,name:mode,mode,kind:'sleep',nominal_A:0.001,day_profiles:{'0':1}})),analysis_config:{battery_capacity_Ah:60,starting_soc_percent:90,minimum_soc_percent:70}})})}).then(()=>true)");
    for (const mode of ['dm1', 'dm2', 'customer']) {
        await win.loadURL(`app://local/analyse_logs/dashboard/setup?session_id=${sessionId}`);
        await js(`document.querySelector('[data-mode="${mode}"]').click()`);
        for (const id of ['temperatureField', 'feedingAnalysisField', 'minuteRangeField']) {
            assert.equal(await js(`getComputedStyle(document.getElementById('${id}')).display`), 'none');
        }
        assert.equal(await js("document.getElementById('temperature').disabled"), true);
        assert.equal(await js("document.getElementById('feedingAnalysis').disabled"), true);
        assert.doesNotMatch(await js("document.getElementById('configurationPanel').innerText"), /température|biberonnage/i);
        await js("document.getElementById('endDay').value='1'");
        await shot(`setup-${mode}-no-temperature`);
        await js("document.getElementById('setupForm').requestSubmit()");
        await until(`location.pathname === '/analyse_logs/dashboard' && /autonomie/i.test(document.getElementById('kpis')?.innerText || '')`);
        for (const id of ['temperature', 'feedingName', 'feedingSummaryPanel']) {
            assert.equal(await js(`getComputedStyle(document.getElementById('${id}')).display`), 'none');
        }
        assert.doesNotMatch(await js('document.body.innerText'), /température|biberonnage/i);
        await shot(`dashboard-${mode}-no-temperature`);
    }
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({measurements: 36000, days: 3, importOver50MB: true, errors, profile}, null, 2));
}
