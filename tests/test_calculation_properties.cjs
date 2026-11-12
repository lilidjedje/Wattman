// Deterministic randomized checks against dimensional identities, not snapshots.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const iterations = Number(process.env.CALC_ITERATIONS || 250);
const seed = Number(process.env.CALC_SEED || 20261112);
let state = seed >>> 0, checks = 0;
function random(min = 0, max = 1) {
    state = (Math.imul(1664525, state) + 1013904223) >>> 0;
    return min + (max - min) * state / 2 ** 32;
}
function near(actual, expected, label) {
    checks++;
    assert.ok(Number.isFinite(actual) && Math.abs(actual - expected) <= 1e-9 * Math.max(1, Math.abs(expected)),
        `seed=${seed} check=${checks} ${label}: ${actual} != ${expected}`);
}
const context = vm.createContext({ window: {} });
for (const file of ['current_units', 'wattman_current', 'sleep_current', 'customer_reference',
    'customer_autonomy', 'biberonnage_reference', 'biberonnage_model']) {
    vm.runInContext(fs.readFileSync(path.join(root, `static/${file}.js`), 'utf8'), context);
    context[file === 'wattman_current' ? 'WattmanCurrent' : 'SleepCurrent'] =
        context.window[file === 'wattman_current' ? 'WattmanCurrent' : 'SleepCurrent'];
}
function storage(data) {
    const values = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, JSON.stringify(v)]));
    return { getItem: k => values[k] ?? null, setItem: (k, v) => { values[k] = v; } };
}
const dmHtml = fs.readFileSync(path.join(root, 'templates/dm_results.html'), 'utf8');
const dm = vm.createContext({ activeSubMode: 'DM1', sessionStorage: storage({}),
    SleepCurrent: { calculate: () => ({ instantaneousUa: 1234, dailyAh: 1234 * 24 / 1e6 }) } });
vm.runInContext(dmHtml.slice(dmHtml.indexOf('        const DEFAULT_FIXED'), dmHtml.indexOf('        function fixedEntryRows')), dm);

for (let i = 0; i < iterations; i++) {
    const amps = random(0, 1000);
    for (const [unit, factor] of [['A', 1], ['mA', 1e-3], ['µA', 1e-6]]) {
        const raw = String(amps / factor).replace('.', ',');
        near(context.window.CurrentUnits.parts(raw, unit).amps, amps, 'display conversion');
        near(context.window.WattmanCurrent.read({ x: raw + unit }, 'x', 'H').amperes, amps, 'source conversion');
    }
    for (const mode of ['DM1', 'DM2', 'Customer Mode']) {
        const currents = Array.from({ length: 12 }, () => random(0, 5000));
        const coefficients = currents.map(() => random());
        const matrixKey = mode === 'Customer Mode' ? 'customerModeMatrix' : `${mode.toLowerCase()}ModeMatrix`;
        const store = storage({ excelData: { 'Device List': { data: currents.map((value, index) => ({
            'Device Name': `ECU ${index}`, [mode === 'Customer Mode' ? 'CM Current (mA)' : `${mode} Current (mA)`]:
                mode === 'Customer Mode' ? value / 1000 : value })) } },
            [matrixKey]: Object.fromEntries(coefficients.map((value, index) => [`${index}_1,0 jours`, value])) });
        const result = context.window.SleepCurrent.calculate(mode, store);
        const total = currents.reduce((sum, current, index) => sum + current * coefficients[index], 0);
        near(result.instantaneousUa, total, `${mode} sumproduct`);
        near(result.dailyAh, total * 24 / 1e6, `${mode} microamps to Ah/day`);
    }
    const ma = random(0, 3000), hours = random(0, 96);
    for (const [unit, factor] of [['h', 1], ['min', 60], ['s', 3600], ['jours', 1 / 24]]) {
        dm.entry = { current: ma, duration: hours * factor, unit };
        near(vm.runInContext('entryEnergy(entry)', dm), ma / 1000 * hours, 'fixed energy unit invariance');
        const baseline = context.window.CustomerAutonomy.calculate('Customer')[0];
        const custom = context.window.CustomerAutonomy.calculate('Customer', {
            fixed: { baseLab: { custom: [dm.entry] } } })[0];
        near(custom.available, baseline.available - ma / 1000 * hours, 'customer fixed custom energy');
    }
    const wake = { wakePeriodHours: i % 5 === 0 ? 0 : random(0.1, 48),
        wakeCurrentMa: random(0, 5000), wakeDurationSeconds: random(0, 180),
        wakeCellBalancingCurrentMa: random(0, 5000), wakeCellBalancingDurationSeconds: random(0, 180) };
    const expectedWake = wake.wakePeriodHours > 0 ? (wake.wakeCurrentMa * wake.wakeDurationSeconds
        + wake.wakeCellBalancingCurrentMa * wake.wakeCellBalancingDurationSeconds) / 1000 / 3600 * 24 / wake.wakePeriodHours : 0;
    dm.sessionStorage = storage({ wakeParams_DM1: wake });
    near(vm.runInContext("computeColumn('DM1', {key:'baseLab', capacityOffset:0}, 60).technicalWake", dm), expectedWake, 'DM wake energy');
    for (const report of ['Customer', 'CustomerWO', 'CustomerPIE']) {
        for (const result of context.window.CustomerAutonomy.calculate(report, { wake })) {
            near(result.value(96), expectedWake, `${report} wake energy`);
        }
    }
    // Independently assemble the DM budget from physical inputs and all daily terms.
    const capacityAh = random(40, 120), startingSoc = random(80, 100), minimumSoc = random(20, 70);
    const dailyAh = random(0, .5), fixedCurrent = random(0, 10), fixedHours = random(0, 100);
    const sleep = {alarm: random(0, 15), sansEbdu: random(0, 3), agingSoc: random(0, .15),
        twt: {single: {ivcCurrent: random(0, 200), powerlatchCurrent: random(0, 200), durationSeconds: random(0, 600)}}};
    const fixed = {entries: {
        cellBalancing: {current: fixedCurrent, duration: 15, extra: {periodMin: 480, balancingDays: 90}},
        pcuRam: {current: fixedCurrent, duration: fixedHours, unit: 'h'},
        cdcRam: {current: fixedCurrent, duration: fixedHours, unit: 'h'},
        ivc3: {current: fixedCurrent, duration: fixedHours, unit: 'h'},
        transport: {current: fixedCurrent, duration: 10, unit: 'jours'}},
        custom: [{current: fixedCurrent, duration: 30, unit: 'min'}]};
    const vehicleEnergy = random(0, 1), customMa = random(0, 10);
    for (const mode of ['DM1', 'DM2']) {
        dm.activeSubMode = mode;
        dm.SleepCurrent = {calculate: () => ({instantaneousUa: dailyAh / 24 * 1e6, dailyAh})};
        dm.sessionStorage = storage({ batteryConfiguration: {capacityAh, startingSoc, minimumSoc},
            [`vehicleSleep_${mode}`]: {energyAh: vehicleEnergy}, [`wakeParams_${mode}`]: wake,
            [`fixedConsumption${mode}`]: {baseLab: fixed, withoutAlarmTachy: fixed},
            [`sleepConsumption${mode}`]: {baseLab: sleep, withoutAlarmTachy: sleep},
            [`customSleepFunctions_${mode}`]: [{current: customMa}] });
        for (const key of ['baseLab', 'withoutAlarmTachy']) {
            dm.capacity = capacityAh;
            const result = vm.runInContext(`computeColumn('${mode}', {key:'${key}', capacityOffset:0}, capacity)`, dm);
            const fixedAh = fixedCurrent / 1000 * (15 / 3600 * 3 * 90 + fixedHours * (key === 'baseLab' ? 1 : 3) + 240 + .5);
            const available = capacityAh * (startingSoc - minimumSoc) / 100 - vehicleEnergy - fixedAh;
            const twt = sleep.twt.single;
            const daily = dailyAh + expectedWake + (sleep.alarm + sleep.sansEbdu + customMa) * 24 / 1000
                + capacityAh * sleep.agingSoc / 100 + (twt.ivcCurrent + twt.powerlatchCurrent) / 1000 * twt.durationSeconds / 3600 / 24;
            near(result.fixedTotal, fixedAh, `${mode}/${key} fixed total`);
            near(result.available, available, `${mode}/${key} available Ah`);
            near(result.dailyTotal, daily, `${mode}/${key} daily Ah`);
            near(result.autonomy, Math.max(0, available) / daily, `${mode}/${key} autonomy`);
        }
    }
    // Pure constant-current discharge with all charging disabled: Q = I * t.
    const model = context.window.BiberonnageModel;
    const days = i % 2 ? 90 : 30, currentMa = random(0, 5), capacity = random(40, 100);
    const columns = model.columns(days);
    const result = model.calculate({ days, timeColumns: columns, selectedRows: [17, 17],
        currentFor: id => id === 17 ? currentMa : 0,
        config: { capacityAh: capacity, startingSoc: 92, frequencyDays: 0, acceptanceL1: 0, acceptanceL2: 0 } });
    // Excel uses epsilon-width phase separators, which do not enter daily totals.
    const excludedHours = columns.reduce((sum, column, index) => sum + (column.phaseChange
        ? (column.daysElapsed - columns[index - 1].daysElapsed) * 24 : 0), 0);
    const ah = currentMa / 1000 * (days * 24 - excludedHours);
    near(result.sumVeilleAh, ah, 'biberonnage integral and duplicate selection');
    near(result.socCurrent.at(-1), 92 - ah / capacity * 100, 'SOC conservation');
    near(result.totalCost, ah * 14.5, 'Ah to Wh');
    near(result.totalRechargeAh, 0, 'disabled recharge');
    const charging = model.calculate({days, timeColumns: columns, selectedRows: [], currentFor: () => 0,
        config: {frequencyDays: 7, startingSoc: 70, targetSoc: 90, efDemandSoc: 0,
            consoL1: ma / 1000, durationL1: hours * 60, acceptanceL1: 3} });
    near(charging.bibCount, Math.floor(days / 7), 'periodic event count');
    near(charging.totalLossL1, ma / 1000 * hours * charging.bibCount, 'charging auxiliary consumption');
    near(charging.totalRechargeAh, 3 * hours * charging.bibCount, 'charging acceptance');
}
// Missing values must retain defaults, whereas explicit zeros disable a function.
dm.sessionStorage = storage({});
near(vm.runInContext("computeColumn('DM1', {key:'baseLab', capacityOffset:0}, 60).technicalWake", dm),
    (536 * 2 + 4359 * 60) / 1000 / 3600 * 3, 'default wake when settings absent');
dm.sessionStorage = storage({wakeParams_DM1: {wakePeriodHours: -1}});
near(vm.runInContext("computeColumn('DM1', {key:'baseLab', capacityOffset:0}, 60).technicalWake", dm), 0, 'nonpositive wake disabled');
dm.entry = {current: '1\u202f500,5', duration: 2, unit: 'h'};
near(vm.runInContext('entryEnergy(entry)', dm), 3.001, 'French grouped number');
for (const period of [0, -1]) {
    dm.entry = {current: 200, duration: 15, calculation: 'cell', extra: {periodMin: period, balancingDays: 90}};
    near(vm.runInContext('entryEnergy(entry)', dm), 0, 'nonpositive balancing period disabled');
    for (const report of ['Customer', 'CustomerWO', 'CustomerPIE']) {
        const options = {fixed: {baseLab: {entries: {cellBalancing: dm.entry}}}};
        near(context.window.CustomerAutonomy.calculate(report, options)[0].value(24), 0, 'customer balancing disabled');
    }
}
console.log(`Calculation properties: ${iterations} iterations, ${checks} checks, seed=${seed}`);
