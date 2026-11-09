// End-to-end calculation audit through the production Electron entry point and real WSGI bridge.
// A separate userData/application-data directory protects the user's projects.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs', 'verification-consoveille-2026-10-29');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-consoveille-audit-'));
app.setPath('userData', profile);
process.env.ENGINEERING_APP_DATA = path.join(profile, 'application-data');
app.disableHardwareAcceleration();
const results = [], errors = [];
let started = false;
app.on('browser-window-created', (_event, win) => {
    win.webContents.on('console-message', details => {
        if (details.level === 'error' && !/ERR_ABORTED|fonts.googleapis|fonts.gstatic/.test(details.message)) errors.push(details.message);
    });
    win.webContents.on('did-finish-load', () => {
        if (!started && win.webContents.getURL() === 'app://local/') {
            started = true;
            run(win).catch(error => { console.error(error.stack); finish(error); });
        }
    });
});
require('../desktop/main.js');

function near(actual, expected, label, tolerance = 1e-8) {
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`);
}
function finish(fatal = null) {
    const report = { date: '2026-10-29', application: 'Production desktop/main.js + desktop/bridge.py',
        profile, results, rendererErrors: errors, fatal: fatal?.message || null };
    fs.writeFileSync(path.join(output, 'rapport.json'), JSON.stringify(report, null, 2));
    console.log('AUDIT_DONE=' + JSON.stringify({ output, passed: results.filter(item => item.status === 'pass').length,
        failed: results.filter(item => item.status === 'fail').length, unavailable: results.filter(item => item.status === 'source-error').length, fatal: report.fatal }));
}
async function run(win) {
    const js = script => win.webContents.executeJavaScript(script);
    const go = route => win.loadURL('app://local' + route);
    const shot = async name => fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    const seed = async values => js(`(() => {
        sessionStorage.clear();
        for (const [key, value] of Object.entries(${JSON.stringify(values)})) sessionStorage.setItem(key, JSON.stringify(value));
    })()`);
    const check = async (name, action) => {
        try { const detail = await action(); results.push({ name, status: 'pass', ...detail }); console.log('PASS ' + name); }
        catch (error) { results.push({ name, status: 'fail', error: error.message }); console.log('FAIL ' + name + ': ' + error.message); }
    };

    for (const mode of ['DM1', 'DM2', 'Customer Mode']) {
        await check('Durée initiale Cell Balancing ' + mode, async () => {
            await seed({ batterySubMode: mode });
            // Mode is stored as a plain string by the application, rather than JSON.
            await js(`sessionStorage.setItem('batterySubMode', ${JSON.stringify(mode)})`);
            await go('/fixed_consumption');
            const value = await js('activeData().entries.cellBalancing.extra.balancingDays');
            assert.equal(value, mode === 'Customer Mode' ? 30 : 90);
            return { actual: value, expected: mode === 'Customer Mode' ? 30 : 90 };
        });
    }

    const dm = require('./fixtures/consoveille_dm_audit.json');
    for (const mode of ['DM1', 'DM2']) for (const fixture of dm) {
        await check(`${mode} / ${fixture.file} / ${fixture.key}`, async () => {
            const fixed = { baseLab: { entries: fixture.entries, custom: [] }, withoutAlarmTachy: { entries: fixture.entries, custom: [] } };
            const values = {
                batteryConfiguration: fixture.battery,
                [`fixedConsumption${mode}`]: fixed,
                [`vehicleSleep_${mode}`]: fixture.vehicle,
                [`wakeParams_${mode}`]: fixture.wake,
                [`sleepConsumption${mode}`]: { baseLab: fixture.sleep, withoutAlarmTachy: fixture.sleep },
                // Consoveille has 3 TWT events. The single standard TWT input represents the first;
                // the supported custom-consumption mechanism includes the remaining two explicitly.
                [`customSleepFunctions_${mode}`]: fixture.additionalTwtMa ? [{ name: 'TWT complémentaires Consoveille', current: fixture.additionalTwtMa }] : [],
                excelData: { 'Device List': { data: [{ 'Device Name': 'Courant de référence', [`${mode} Current (mA)`]: fixture.currentUa }] } }
            };
            await seed(values);
            await go('/dm_results?mode=' + mode);
            const result = await js(`(() => {
                const scenario = SCENARIOS.find(item => item.key === '${fixture.key}');
                const col = computeColumn('${mode}', scenario, ${fixture.battery.capacityAh});
                return { available: col.available, dailyAh: col.dailyTotal, autonomy: col.autonomy,
                    currentUa: col.instantaneous, body: document.querySelector('.mode-block').innerText };
            })()`);
            for (const field of ['available', 'dailyAh', 'autonomy']) near(result[field], fixture.expected[field], mode + '/' + field);
            near(result.currentUa, fixture.currentUa, mode + '/current');
            assert.ok(result.body.includes('Énergie disponible en début de veille'));
            if (fixture.file === 'Consoveille - Test Calcul.xlsx') await shot(`${mode}-${fixture.key}`);
            delete result.body;
            return { actual: result, expected: fixture.expected, reference: fixture.file + '/Delivery' };
        });
    }

    const customer = require('./fixtures/customer_autonomy_reference.json');
    await seed({});
    await go('/battery_results_menu?mode=Customer%20Mode');
    for (const [report, expected] of Object.entries(customer)) {
        await check('Customer / ' + report, async () => {
            const actual = await js(`(() => {
                openReportModal('${report}');
                const cols = CustomerAutonomy.calculate('${report}');
                return { values: cols.map(col => ({ available: col.available, dailyAh: col.dailyAh, autonomy: col.autonomy })),
                    durations: [...document.querySelectorAll('#modal-body-target .kpi-row td')].slice(1).map(cell => cell.textContent) };
            })()`);
            assert.equal(actual.values.length, expected.length);
            expected.forEach((column, index) => {
                near(actual.values[index].available, column['86'], `${report}/${index}/available`);
                near(actual.values[index].dailyAh, column['121'], `${report}/${index}/daily`);
                near(actual.values[index].autonomy, column['6'], `${report}/${index}/autonomy`);
                near(Number(actual.durations[index].replace(' jours', '').replace(',', '.')), column['6'], 'visible duration', 0.000051);
            });
            await shot(report);
            return { actual: actual.values, reference: 'Consoveille.xlsx/' + report };
        });
    }

    await check('Customer / courant de veille depuis les composants Excel', async () => {
        const fixture = require('./fixtures/customer_sleep_reference.json');
        await seed({ excelData: { 'ECU List': { data: fixture.rows.map(row => ({ 'ECU Name': row.name, 'CM Current (mA)': row.currentUa / 1000 })) } },
            customerModeMatrix: Object.fromEntries(fixture.rows.map((row, index) => [`${index}_1,0 jours`, row.oneDay])) });
        await js("sessionStorage.setItem('batterySubMode', 'Customer Mode')");
        await go('/sleep_consumption');
        const result = await js(`({ ...SleepCurrent.calculate('Customer Mode'),
            displayedCurrent: document.getElementById('instant-current-value').textContent,
            displayedEnergy: document.getElementById('sleep-current-energy').textContent })`);
        near(result.instantaneousUa, fixture.expectedUa, 'Customer µA');
        near(result.dailyAh, fixture.expectedDailyAh, 'Customer Ah/j');
        assert.match(result.displayedCurrent, /3,0482.*mA/);
        assert.match(result.displayedEnergy, /0,0731568/);
        await shot('Customer-courant');
        return { actual: result, expected: { currentMa: fixture.expectedMa, dailyAh: fixture.expectedDailyAh } };
    });

    const bib = require('./fixtures/consoveille_biberonnage_audit.json');
    for (const fixture of bib) {
        if (fixture.sourceErrors) {
            results.push({ name: `Biberonnage / ${fixture.file} / ${fixture.days} jours`, status: 'source-error', errors: fixture.sourceErrors });
            continue;
        }
        await check(`Biberonnage / ${fixture.file} / ${fixture.days} jours`, async () => {
            const builtins = Object.fromEntries(Object.entries(fixture.expected).map(([key, value]) => [key, value.config]));
            await seed({ [`biberonnage${fixture.days}Days`]: fixture.stored,
                [fixture.days === 30 ? 'biberonnageBuiltinAnalyses' : 'biberonnageBuiltinAnalyses90Days']: builtins });
            await go(`/biberonnage?days=${fixture.days}`);
            const first = await js("document.querySelector('#body tr:not(.section) input').value");
            assert.ok(Number(first) >= 0);
            await go(`/biberonnage/resultats?days=${fixture.days}`);
            const actual = await js(`(() => {
                return analyses.map(analysis => {
                    const result = calculateAnalysis(analysis), soc = chartInstances.get(analysis.id + '-soc'), pie = chartInstances.get(analysis.id + '-pie');
                    return { id: analysis.id, sumAh: result.sumVeilleAh, cost: result.totalCost, count: result.bibCount,
                        days: timeColumns.map((col, index) => ({ key: col.key, ah: result.ahSpent[index], soc: result.socCurrent[index] })),
                        rises: soc.data.datasets[0].data.filter((point, i, points) => i > 0 && point.x === points[i - 1].x && point.y > points[i - 1].y).length,
                        pieSum: pie.data.datasets[0].data.reduce((sum, value) => sum + value, 0) };
                });
            })()`);
            for (const [key, expected] of Object.entries(fixture.expected)) {
                const value = actual.find(item => item.id === key);
                near(value.sumAh, expected.sumAh, key + '/Ah', 1e-6);
                near(value.cost, expected.totalCost, key + '/Wh', 1e-5);
                assert.equal(value.count, Math.floor(fixture.days / 7));
                assert.equal(value.rises, value.count);
                near(value.pieSum, value.cost, key + '/pie');
                expected.points.forEach(point => {
                    const day = value.days.find(item => item.key === point.key);
                    near(day.ah, point.ah, key + '/' + point.key + '/Ah', 1e-6);
                    near(day.soc, point.soc, key + '/' + point.key + '/SOC', 1e-6);
                });
            }
            await js("document.querySelector('.dashboard').scrollIntoView(); chartInstances.forEach(chart => { chart.stop(); chart.update('none'); });");
            await shot(`biberonnage-${fixture.days}-${fixture.file.startsWith('Consoveille -') ? 'test' : 'original'}`);
            return { actual: actual.map(({ days, ...summary }) => summary), checkedDays: Object.values(fixture.expected).reduce((sum, value) => sum + value.points.length, 0) };
        });
    }
    await check('Modifications de durée et recalcul des événements dans le bilan ouvert', async () => {
        const value = await js(`(() => {
            const analysis = analyses[0];
            analysis.config.frequencyDays = 0; analysis.config.efDemandSoc = 89; analysis.config.durationL2 = 30;
            renderAnalysis(analysis);
            const result = calculateAnalysis(analysis);
            return { count: result.bibCount, losses: result.totalLossL2, each: result.ahL2, recharge: result.totalRechargeAh };
        })()`);
        assert.ok(value.count > 0);
        near(value.losses, value.count * value.each, 'threshold losses');
        near(value.recharge, value.count * 1.5, 'threshold recharge');
        return { actual: value };
    });
    // Leave the real application open on a reference project with the expected sawtooth.
    const final = bib.find(item => item.days === 30 && item.file === 'Consoveille - Test Calcul.xlsx');
    await seed({ biberonnage30Days: final.stored,
        biberonnageBuiltinAnalyses: Object.fromEntries(Object.entries(final.expected).map(([key, value]) => [key, value.config])) });
    await go('/biberonnage/resultats?days=30');
    await js(`ProjectStorage.saveProject({ name: 'Vérification Consoveille - projet de contrôle', projectType: 'EV', date: '2026-10-29' })`);
    await js("document.querySelector('.dashboard').scrollIntoView(); chartInstances.forEach(chart => { chart.stop(); chart.update('none'); });");
    await shot('application-verifiee');
    win.show(); win.focus();
    finish();
}
