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
