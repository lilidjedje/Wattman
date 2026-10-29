// Test des vraies pages Electron dans un profil temporaire indépendant.
const { app } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-validation-'));
app.setPath('userData', profile);
process.env.ENGINEERING_APP_DATA = path.join(profile, 'backend');
let started = false;
app.on('browser-window-created', (_event, win) => {
    win.webContents.on('did-finish-load', () => {
        if (!started && win.webContents.getURL() === 'app://local/') {
            started = true;
            run(win).then(() => app.quit()).catch(error => {
                console.error(error.stack);
                app.exit(1);
            });
        }
    });
});
require('../desktop/main.js');

async function run(win) {
    const js = script => win.webContents.executeJavaScript(script);
    const go = route => win.loadURL(`app://local${route}`);
    const clickNavigation = async selector => {
        const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
        await loaded;
    };
    const shot = async name => fs.writeFileSync(path.join(profile, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    const report = [];
    await js(`sessionStorage.setItem('excelData', JSON.stringify({'Device List': {data: [{'Device Name':'Test 2000 µA','DM1 Current (mA)':2000,'DM2 Current (mA)':2000,'CM Current (mA)':2000}]}})); sessionStorage.setItem('selectedEcuKeys', JSON.stringify(['0_Test 2000 µA']));`);
    await go('/biberonnage');
    assert.equal(await js(`document.querySelectorAll('.choice').length`), 2);
    await shot('biberonnage-selection');
    for (const days of [30, 90]) {
        await go('/biberonnage');
        await clickNavigation(`a[href='/biberonnage?days=${days}']`);
        assert.equal(await js(`document.querySelectorAll('#header-row th').length`), days + 8);
        // Saisie réelle via un événement input, puis navigation avec le bouton de résultat.
        await js(`(() => { const input = document.querySelectorAll('#body tr')[18].querySelectorAll('input')[7 + ${days} - 1]; input.value='1000'; input.dispatchEvent(new Event('input',{bubbles:true})); })()`);
        await clickNavigation('.results-button');
        assert.equal(await js(`document.querySelectorAll('.analysis').length`), 2);
        const before = await js(`({days: timeColumns.length - 8, last: timeColumns.at(-1).dayNum, count: document.querySelector('[data-output="bib-count"]').textContent, energy:calculateAnalysis(analyses[0]).sumVeilleAh, cost:calculateAnalysis(analyses[0]).totalCost, label:document.querySelector('.cell-ef').textContent, charts:chartInstances.size})`);
        assert.equal(before.days, days);
        assert.equal(before.last, days);
        assert.equal(Number(before.count), Math.floor(days / 7));
        assert.equal(before.label, `EF sur ${days} jrs`);
        assert.equal(before.charts, 4);
        await shot(`biberonnage-${days}`);
        await clickNavigation('#previous-step');
        assert.ok(win.webContents.getURL().endsWith(`?days=${days}`));
        assert.equal(await js(`document.querySelectorAll('#body tr')[18].querySelectorAll('input')[7 + ${days} - 1].value`), '1000');
        report.push({biberonnage:days, ...before});
    }
    // Une saisie au jour 90 augmente la consommation du bilan 90 jours seulement.
    await go('/biberonnage/resultats?days=30');
    assert.equal(await js(`timeColumns.at(-1).dayNum`), 30);
    assert.equal(await js(`sessionStorage.getItem('biberonnage30Days') !== sessionStorage.getItem('biberonnage90Days')`), true);
    for (const mode of ['DM1', 'DM2', 'Customer Mode']) {
        await js(`sessionStorage.setItem('batterySubMode', ${JSON.stringify(mode)})`);
        await go('/sleep_consumption');
        const displayed = await js(`({current:document.getElementById('instant-current-value').textContent, energy:document.getElementById('sleep-current-energy').textContent, dailyAh:SleepCurrent.calculate(batterySubMode).dailyAh})`);
        assert.match(displayed.current, /2\s?000.*µA/);
        assert.equal(displayed.dailyAh, 0.048);
        assert.match(displayed.energy, /0,048/);
        await shot(`veille-${mode.replaceAll(' ', '-')}`);
        await go(`/battery_results_menu?mode=${encodeURIComponent(mode)}`);
        await js(`document.querySelector('.action-card').click()`);
        const synthesis = await js(`({current:sleepValue('curr_veille_conso','baseLab'),energy:sleepValue('curr_veille','baseLab')})`);
        assert.match(synthesis.current, /2000.*µA/);
        assert.equal(synthesis.energy, '0,048 Ah/j');
        assert.equal(await js(`document.getElementById('modal-body-target').innerText.includes('2000 µA') && document.getElementById('modal-body-target').innerText.includes('0,048 Ah/j')`), true);
        await shot(`bilan-${mode.replaceAll(' ', '-')}`);
        if (mode !== 'Customer Mode') {
            await go(`/dm_results?mode=${mode}`);
            assert.equal(await js(`document.body.innerText.includes('µA') && document.body.innerText.includes('0,048')`), true);
            await shot(`synthese-${mode}`);
        }
        report.push({mode, ...displayed, synthesis});
    }
    fs.writeFileSync(path.join(profile, 'results.json'), JSON.stringify(report, null, 2));
    console.log('VALIDATION_PROFILE=' + profile);
    console.log('VALIDATION_RESULTS=' + JSON.stringify(report));
}
