const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'templates/synthesis.html'), 'utf8');
const script = html.slice(html.indexOf('        const devTimeline'), html.indexOf('        function buildExcelExportDevices'));

for (const current of [10, 800]) {
    const storage = {
        homologationDevices: JSON.stringify([{ key: '0_DRL', name: 'DRL', rowIndex: 0, current: 999, lower: 0, upper: 0 }]),
        modifiedCurrents: JSON.stringify({ '0_DRL': current }),
        modifiedLowers: JSON.stringify({ '0_DRL': 1 }),
        modifiedUppers: JSON.stringify({ '0_DRL': 1 }),
        profileMatrix: JSON.stringify({ '0_winter_0 - 5 min': '12,5%' }),
        alternatorMatrix: JSON.stringify({ '0_cycle1_0 - 1,67 min': '25%' }),
        paoData: JSON.stringify([{ current: 4, lower: 1, upper: 0, devProfiles: {}, altProfiles: {} }]),
        gmvData: JSON.stringify([{ current: 8, lower: 0, upper: 1, devProfiles: {}, altProfiles: {} }])
    };
    const charts = [];
    const context = vm.createContext({
        window: {},
        sessionStorage: { getItem: key => storage[key] ?? null, setItem: (key, value) => { storage[key] = value; } },
        document: {
            getElementById: () => ({ appendChild() {}, getContext() {} }),
            createElement: () => ({}),
            querySelectorAll: () => []
        },
        Chart: function (_canvas, config) { charts.push(config); }
    });
    vm.runInContext(fs.readFileSync(path.join(root, 'static/homologation_defaults.js'), 'utf8'), context);
    context.HomologationDefaults = context.window.HomologationDefaults;
    vm.runInContext(script, context);
    const result = vm.runInContext('synthesisExportData', context);
    vm.runInContext(html.slice(html.indexOf('        function buildExcelExportDevices'),html.indexOf('        window.getSynthesisExcelData')),context);
    const exported=vm.runInContext('buildExcelExportDevices()',context);
    assert.equal(exported.find(device=>device.name==='DRL').current,current);
    assert.equal(exported.filter(device=>device.name==='ADAPTATIONS').length,1);
    assert.equal(exported.find(device=>device.name==='ADAPTATIONS').current,0);

    for (const [mode, profiles] of Object.entries(result)) {
        for (const [profile, records] of Object.entries(profiles)) {
            records.forEach((record, index) => {
                const factor = mode === 'dcdc'
                    ? (profile === 'summer' ? 1 : profile === 'winter' && index < 2 ? 0.125 : 0)
                    : (profile === 'cycle1' && index < 2 ? 0.25 : 0);
                assert.equal(record.base, current * factor + 4, `${mode}/${profile}/${index}/base`);
                assert.equal(record.upper, current * factor + 8, `${mode}/${profile}/${index}/upper`);
            });
        }
    }
    assert.equal(charts.length, 6);
    charts.forEach(chart => assert.match(chart.data.datasets[0].label, /^Base/));
}
console.log('Six tableaux verifies : sommes, profils, virgules, modifications et absence de corrections fixes.');

{
    const storage = {};
    const context = vm.createContext({ window: {}, sessionStorage: {
        getItem: key => storage[key] ?? null,
        setItem: (key, value) => { storage[key] = value; }
    } });
    vm.runInContext(fs.readFileSync(path.join(root, 'static/homologation_defaults.js'), 'utf8'), context);
    const defaults = context.window.HomologationDefaults;
    const devices = [{ rowIndex: 0, name: 'pompe électrique 650W / 12 volts' }];
    const matrix = { '0_winter_0 - 5 min': '100%', '0_winter_5 - 10 min': '17%' };
    defaults.migrateMatrix('dcdc', devices, matrix);
    assert.equal(matrix['0_winter_0 - 5 min'], '10%');
    assert.equal(matrix['0_winter_5 - 10 min'], '17%');
    const saved = JSON.stringify(matrix);
    defaults.migrateMatrix('dcdc', devices, matrix);
    assert.equal(JSON.stringify(matrix), saved);
    assert.ok(storage.homologationProfileVersion_dcdc_backup);
    const auxiliary = [{ altProfiles: { 'cycle2_4 - 7 min': '17%', 'cycle1_12,25 - 25 min': '25%' } }];
    defaults.migrateAuxiliary(auxiliary);
    assert.equal(auxiliary[0].altProfiles['cycle2_7 - 8,16 min'], '17%');
    assert.equal(auxiliary[0].altProfiles['cycle1_8,16 - 12,25 min'], '100%');
    assert.equal(auxiliary[0].altProfiles['cycle1_12,25 - 25 min'], '25%');
}

{
    const exportHtml = fs.readFileSync(path.join(root, 'templates/export_synthesis_pdf.html'), 'utf8');
    const helperStart = exportHtml.indexOf('        function getChartPeakMetrics');
    const helperEnd = exportHtml.indexOf('        function addReport', helperStart);
    const helperContext = vm.createContext({});
    vm.runInContext(exportHtml.slice(helperStart, helperEnd), helperContext);
    const metrics = JSON.parse(JSON.stringify(vm.runInContext(`getChartPeakMetrics([
        { label: 'Base Vehicle', data: [2, 12, 8] },
        { label: 'Upper Vehicle', data: ['3', '9'] },
        { label: 'Empty', data: [] }
    ])`, helperContext)));
    assert.deepEqual(metrics, [
        { label: 'Base Vehicle', value: 12 },
        { label: 'Upper Vehicle', value: 9 }
    ]);
    const height = vm.runInContext(`getReportContentHeight({
        defaultView: { scrollY: 0, getComputedStyle: () => ({ display: 'block', visibility: 'visible', position: 'static' }) },
        body: {
            scrollHeight: 1800, offsetHeight: 900,
            getBoundingClientRect: () => ({ top: 0, height: 900 }),
            querySelectorAll: () => [{ getBoundingClientRect: () => ({ bottom: 2200 }) }]
        },
        documentElement: { scrollHeight: 1200, offsetHeight: 1200, getBoundingClientRect: () => ({ height: 1200 }) }
    })`, helperContext);
    assert.equal(height, 2200);
    assert.match(exportHtml, /\.card-tabs, \.data-tab[\s\S]*?element\.remove\(\)/);
    assert.match(exportHtml, /grid-template-columns:minmax\(0,1fr\)/);
    assert.match(exportHtml, /const seenCards = new Set\(\)/);
    assert.match(exportHtml, /const seenCanvases = new Set\(\)/);
    assert.match(exportHtml, /Le graphique du rapport/);
    assert.match(exportHtml, /container\.style\.height = '460px'/);
    assert.match(html, /filename='vendor\/chart\.umd\.js'/);
    assert.match(exportHtml, /body :is\(\.topbar, \.profile, \.profile-heading[\s\S]*?background:#fff !important/);
    assert.match(exportHtml, /chart\.options\.animation = false/);
    assert.match(exportHtml, /fetch\('\/generate_synthesis_pdf'/);
    assert.doesNotMatch(exportHtml, /canvas\.toDataURL|createPrintReportCopies|window\.print\(/);
    assert.match(exportHtml, /frame\.scrolling = 'no'/);
    assert.match(exportHtml, /body \*::-webkit-scrollbar/);
    assert.doesNotMatch(exportHtml, /section\.append\(heading, frame\)/);
}

console.log('Synthesis summary: chart peaks, chart-only report styling and local Chart.js loading verified.');

{
    const page = fs.readFileSync(path.join(root, 'templates/export_synthesis_pdf.html'), 'utf8');
    const storage = {
        excelData: JSON.stringify({ 'Device List': { data: [{ 'Device Name': 'ECU' }] } }),
        modifiedDM1Currents: JSON.stringify({ '0_ECU': '1,5' }),
        dm1ModeMatrix: JSON.stringify({ '0_1 jours': '0,25' })
    };
    const context = vm.createContext({ frame: { contentWindow: {
        sessionStorage: { getItem: key => storage[key] ?? null, setItem:(key,value)=>{storage[key]=value;} }
    } } });
    vm.runInContext(fs.readFileSync(path.join(root,'static/sleep_current.js'),'utf8'),vm.createContext({window:context.frame.contentWindow}));
    vm.runInContext(page.slice(page.indexOf('        function getExcelMatrixRows'), page.indexOf('        function getExcelReportData')), context);
    const rows = vm.runInContext("getExcelMatrixRows(frame, 'DM1')", context);
    assert.equal(rows[0].currentUa, 1.5);
    assert.equal(rows[0].coefficients[0], 0.25);
    assert.equal(rows[0].coefficients[1], 1);
}
console.log('Excel matrices: French decimals and selected daily coefficients verified.');
