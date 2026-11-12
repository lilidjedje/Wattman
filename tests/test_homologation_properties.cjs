// Random SUMPRODUCT oracles for all DCDC/WLTC periods, overrides and auxiliaries.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'templates/synthesis.html'), 'utf8');
const script = html.slice(html.indexOf('        const devTimeline'), html.indexOf('        function buildExcelExportDevices'));
const defaults = fs.readFileSync(path.join(root, 'static/homologation_defaults.js'), 'utf8');
const iterations = Number(process.env.CALC_ITERATIONS || 250), seed = Number(process.env.CALC_SEED || 20261112);
let state = seed >>> 0, checks = 0;
const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 2 ** 32; };
for (let iteration = 0; iteration < iterations; iteration++) {
    const values = {};
    const context = vm.createContext({window: {}, sessionStorage: {
        getItem: key => values[key] ?? null, setItem: (key, value) => { values[key] = value; }},
        document: {getElementById: () => ({appendChild() {}, getContext() {}}), createElement: () => ({}), querySelectorAll: () => []},
        Chart: function () {}});
    vm.runInContext(defaults, context);
    context.HomologationDefaults = context.window.HomologationDefaults;
    const definitions = context.HomologationDefaults;
    const devices = Array.from({length: 8}, (_, index) => ({key: `ecu-${index}`, rowIndex: index,
        name: `Property ECU ${index}`, current: random() * 800, lower: Math.round(random()), upper: Math.round(random())}));
    const modified = Object.fromEntries(devices.map(d => [d.key, iteration % 7 === 0 ? 0 : random() * 1000]));
    const removed = devices.filter(() => random() < .2).map(d => d.key);
    const auxiliaries = [{current: random() * 40, lower: 1, upper: 0, devProfiles: {}, altProfiles: {}, wltcProfileVersion: 2},
                         {current: random() * 40, lower: 0, upper: 1, devProfiles: {}, altProfiles: {}, wltcProfileVersion: 2}];
    const matrices = {dcdc: {}, wltc: {}}, expected = {dcdc: {}, wltc: {}};
    for (const [mode, profiles] of [['dcdc', ['winter', 'midseason', 'summer']], ['wltc', ['cycle1', 'cycle2', 'cycle3']]]) {
        for (const profile of profiles) {
            expected[mode][profile] = [];
            definitions.intervalsFor(mode, profile).forEach((label, index) => {
                let base = 0, upper = 0;
                for (const device of devices) {
                    const coefficient = Math.round(random() * 10000) / 100;
                    matrices[mode][`${device.rowIndex}_${profile}_${label}`] = `${String(coefficient).replace('.', ',')}%`;
                    if (removed.includes(device.key)) continue;
                    base += device.lower * modified[device.key] * coefficient / 100;
                    upper += device.upper * modified[device.key] * coefficient / 100;
                }
                for (const auxiliary of auxiliaries) {
                    const percent = Math.round(random() * 100);
                    auxiliary[mode === 'dcdc' ? 'devProfiles' : 'altProfiles'][`${profile}_${label}`] = `${percent}%`;
                    base += auxiliary.current * auxiliary.lower * percent / 100;
                    upper += auxiliary.current * auxiliary.upper * percent / 100;
                }
                expected[mode][profile].push({base, upper});
            });
        }
    }
    for (const [key, value] of Object.entries({homologationDevices: devices, modifiedCurrents: modified,
        deletedHomologationDeviceKeys: removed, profileMatrix: matrices.dcdc, alternatorMatrix: matrices.wltc,
        paoData: [auxiliaries[0]], gmvData: [auxiliaries[1]],
        homologationProfileVersion_dcdc: 2, homologationProfileVersion_wltc: 2})) values[key] = JSON.stringify(value);
    vm.runInContext(script, context);
    const actual = vm.runInContext('synthesisExportData', context);
    for (const mode of ['dcdc', 'wltc']) for (const [profile, periods] of Object.entries(expected[mode])) {
        assert.equal(actual[mode][profile].length, periods.length * 2);
        periods.forEach((period, index) => {
            for (const field of ['base', 'upper']) for (const edge of [0, 1]) {
                const value = actual[mode][profile][index * 2 + edge][field];
                checks++;
                assert.ok(Math.abs(value - period[field]) < 1e-8, `seed=${seed} iteration=${iteration} ${mode}/${profile}/${index}/${field}: ${value} != ${period[field]}`);
            }
        });
    }
}
console.log(`Homologation properties: ${iterations} iterations; ${checks} checks; seed=${seed}`);
