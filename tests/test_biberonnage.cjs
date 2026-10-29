const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ window: {} });
for (const file of ['sleep_current', 'biberonnage_reference', 'biberonnage_model']) {
    vm.runInContext(fs.readFileSync(path.join(root, `static/${file}.js`), 'utf8'), context);
}
const model = context.window.BiberonnageModel;
const fixtures = require('./fixtures/biberonnage_reference.json');
const near = (actual, expected, message, tolerance = 1e-6) => assert.ok(Math.abs(actual - expected) < tolerance, `${message}: ${actual} != ${expected}`);
function run(days, selectedRows, config = {}, overrides = {}) {
    const timeColumns = model.columns(days);
    const result = model.calculate({ days, timeColumns, selectedRows,
        config: { capacityAh: 60, startingSoc: days === 30 ? 92 : 90, efDemandSoc: 80, targetSoc: 90, ...config },
        currentFor: (id, column) => overrides[`${id}:${column.key}`] ?? model.defaultValue({ rowIndex: id }, column, null, days)
    });
    return { result, timeColumns };
}
const baseRows = model.rows.filter(row => row.label && row.rowIndex <= 17).map(row => row.rowIndex);
const ttRows = model.rows.filter(row => row.label && row.rowIndex <= 21).map(row => row.rowIndex);
const deliveryRows = [1, 13, 22, 24, 25, 26, 28, 29];
for (const [key, selectedRows, days, config] of [
    ['base30', baseRows, 30, {}], ['tt30', ttRows, 30, { efDemandSoc: 76 }], ['delivery90', deliveryRows, 90, {}]
]) {
    const { result, timeColumns } = run(days, selectedRows, config);
    near(result.sumVeilleAh, fixtures[key].sumAh, `${key}/total`);
    fixtures[key].checkpoints.forEach(check => {
        const index = timeColumns.findIndex(column => column.key === check.key);
        near(result.ahSpent[index], check.ah, `${key}/${check.key}/Ah`);
        near(result.socCurrent[index], check.soc, `${key}/${check.key}/SOC`);
    });
    assert.equal(result.bibCount, Math.floor(days / 7));
    near(result.totalLossL1, 7.971 * 2 * result.bibCount, 'periodic losses');
    assert.equal(result.totalLossL2, 0);
    near(result.totalRechargeAh, result.bibCount * 6, 'nominal charge');
    near(result.totalCost, result.sumVeilleWh + result.sumLossL1Wh + result.sumLossL2Wh, 'no double counting charge');
    near(result.ahSpent.reduce((sum, value) => sum + value, 0), result.sumVeilleAh, 'daily table total');
    for (const event of result.events) {
        const points = result.socPoints.filter(point => point.x === event.day);
        assert.ok(points.some(point => Math.abs(point.y - event.beforeSoc) < 1e-9));
        assert.ok(points.some(point => point.y === event.afterSoc));
        assert.ok(event.afterSoc > event.beforeSoc, 'zigzag recharge');
        near(result.losses[event.index], event.lossAh, 'event/table losses');
        near(result.recharges[event.index], event.rechargeAh, 'event/table charge');
    }
}
// An isolated 1 mA load consumes 0.024 Ah/day, never the cumulative total each day.
const isolated = run(30, [18], { efDemandSoc: 0, frequencyDays: 0 }, Object.fromEntries(model.columns(30).flatMap(column => [[`18:${column.key}`, 1], [`28:${column.key}`, 0]])));
near(isolated.result.sumVeilleAh, 0.72, 'constant load integration');
near(isolated.result.socCurrent.at(-1), 90.8, 'incremental SOC');
assert.equal(isolated.result.bibCount, 0);
// Threshold charges use line 2 and are counted in losses, table and charts together.
const high = run(30, [18], { frequencyDays: 0, efDemandSoc: 80, consoL2: 4, durationL2: 30 }, Object.fromEntries(model.columns(30).map(column => [`18:${column.key}`, 100]))).result;
assert.ok(high.bibCount > 0);
assert.ok(high.events.every(event => event.kind === 2));
near(high.totalLossL2, high.bibCount * 2, 'line 2 duration and current');
near(high.totalRechargeAh, high.bibCount * 1.5, 'line 2 acceptance and duration');
const zeroCharge = run(30, [18], { acceptanceL1: 0, acceptanceL2: 0, efDemandSoc: 95 }).result;
assert.equal(zeroCharge.bibCount, 0);
assert.equal(zeroCharge.totalLossL1 + zeroCharge.totalLossL2, 0);
// Late edits and explicit zeros must survive the 30/90-day separation.
for (const day of [31, 90]) {
    const baseline = run(90, deliveryRows).result;
    const modified = run(90, deliveryRows, {}, { [`25:day-${day}`]: 1000 }).result;
    near(modified.sumVeilleAh - baseline.sumVeilleAh, (1000 - 3.458) / 1000 * 24, `day ${day} override`);
}
const noTwt = run(90, deliveryRows.filter(id => id !== 29)).result;
assert.ok(run(90, deliveryRows).result.sumVeilleAh > noTwt.sumVeilleAh);
// Verify the live matrix at each day, not only the day-1 column.
const storeValues = {
    excelData: { 'Device List': { data: [{ 'Device Name': 'ECU', 'CM Current (mA)': 2 }] } },
    customerModeMatrix: { '0_1,0 jours': 1, '0_2,0 jours': 0, '0_90,0 jours': 1 }
};
const storage = { getItem: key => key in storeValues ? JSON.stringify(storeValues[key]) : null };
near(model.defaultValue({ rowIndex: 17 }, model.columns(90).find(col => col.key === 'day-2'), storage, 90), 0, 'day 2 profile');
near(model.defaultValue({ rowIndex: 17 }, model.columns(90).find(col => col.key === 'day-90'), storage, 90), 2, 'day 90 profile');

const html = fs.readFileSync(path.join(root, 'templates/biberonnage_resultats.html'), 'utf8');
const source = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)].map(match => match[1]).find(script => script.includes('const DURATION_DAYS'));
for (const days of [30, 90]) {
    const values = new Map();
    const ctx = vm.createContext({ window: context.window, BiberonnageModel: model,
        sessionStorage: { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) } });
    const script = source.replace('{{ duration_days | tojson }}', String(days));
    new vm.Script(script);
    vm.runInContext(script.slice(0, script.indexOf('        const chartInstances')), ctx);
    vm.runInContext(script.slice(script.indexOf('        function calculateAnalysis('), script.indexOf('        function updateCharts(')), ctx);
    const result = vm.runInContext('calculateAnalysis(analyses[0])', ctx);
    near(result.sumVeilleAh, fixtures[days === 30 ? 'base30' : 'delivery90'].sumAh, 'page result');
    const table = vm.runInContext('tableBodyHtml(analyses[0], calculateAnalysis(analyses[0]))', ctx);
    assert.ok(table.includes(`EF sur ${days} jrs`));
    assert.equal(vm.runInContext('analyses.length', ctx), 2);
    assert.equal(vm.runInContext('CALCULATED_KEY', ctx), days === 30 ? 'biberonnageCalculatedAnalyses' : 'biberonnageCalculatedAnalyses90Days');
}
console.log('Biberonnage: Excel daily Ah/SOC and totals verified over 30/90 days; events, both loss lines, recharge accounting, sawtooth points, live profiles, late edits and report table verified.');
