const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const context = vm.createContext({ window: {} });
for (const file of ['customer_reference', 'customer_autonomy']) {
    vm.runInContext(fs.readFileSync(path.join(root, `static/${file}.js`), 'utf8'), context);
}
const calculate = context.window.CustomerAutonomy.calculate;
const expected = require('./fixtures/customer_autonomy_reference.json');
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < 1e-10, `${message}: ${actual} != ${expected}`);

for (const [report, columns] of Object.entries(expected)) {
    const actual = calculate(report);
    assert.equal(actual.length, columns.length);
    columns.forEach((column, index) => {
        for (const [row, value] of Object.entries(column)) near(actual[index].value(Number(row)), value, `${report}/${index}/${row}`);
        near(actual[index].autonomy, column['6'], `${report}/${index}/autonomy`);
    });
}

// Saved mode-specific wake settings must feed both the detail rows and duration.
const disabledWake = { wakeDurationSeconds: 0, wakeCellBalancingDurationSeconds: 0 };
for (const report of Object.keys(expected)) {
    const baseline = calculate(report);
    const modified = calculate(report, { wake: disabledWake, vehicle: { energyAh: 0.18 } });
    modified.forEach((column, index) => {
        near(column.available, baseline[index].available - 0.1, `${report}/vehicle`);
        near(column.dailyAh, baseline[index].dailyAh - baseline[index].value(96), `${report}/wake`);
        near(column.autonomy, column.available / column.dailyAh, `${report}/changed autonomy`);
    });
}
const fixed = { baseLab: { entries: {
    pcuRam: { current: 2, duration: 100, unit: 'h' },
    cdcRam: { current: 5, duration: 100, unit: 'h' },
    smartAntenna: { current: 7, duration: 8, unit: 'jours' }
}, custom: [{ current: 100, duration: 30, unit: 'min' }] } };
const standard = calculate('Customer', { fixed })[0];
const unplugged = calculate('CustomerWO', { fixed })[0];
near(standard.value(28), 0.2, 'Standard PCU fixed energy');
near(unplugged.value(28), 0, 'WO PCU fixed energy');
near(unplugged.value(36), 0, 'WO CDC fixed energy');
near(unplugged.value(55), 0, 'WO MQTT fixed energy');
near(unplugged.value(107), 14 / 1000 * 24, 'WO continuous PCU+CDC+IVC');
near(unplugged.available, calculate('CustomerWO')[0].available - 0.05, 'custom fixed consumption');
const battery = calculate('CustomerPIE', { battery: { capacityAh: '70', startingSoc: '92', minimumSoc: '70' } });
assert.equal(battery[4].value(8), 60);
near(battery[1].value(10), 0.9, 'PIE case start SOC');
near(battery[1].value(11), 0.6, 'PIE case minimum SOC');
near(battery[4].value(119), 60 * 0.00083, 'PIE aging uses case capacity');
near(calculate('Customer', { dailyAh: 0.048 })[0].value(89), 0.048, 'live sleep current');
near(calculate('Customer', { customSleep: [{ values: { baseLab: '1,5' } }] })[0].dailyAh,
    calculate('Customer')[0].dailyAh + 0.036, 'custom daily current');
near(calculate('Customer', { deletedFixed: ['cellBalancing'] })[0].available,
    calculate('Customer')[0].available + 0.075, 'deleted balancing');
near(calculate('Customer', { sleep: { baseLab: { agingSoc: 0 } } })[0].value(119), 0, 'explicit zero aging');
// Accessory edits must not replace the technical case currents in PIE.
near(calculate('CustomerPIE', { sleep: { withAlarm: { alarm: 0 } } })[1].value(109), 9.71, 'PIE case current');
const empty = calculate('Customer', { dailyAh: 0, wake: disabledWake, sleep: { baseLab: { sansEbdu: 0, alarm: 0, aid: 0, tachy: 0, agingSoc: 0 } } });
assert.equal(empty[0].autonomy, null);
near(calculate('Customer', { wake: { wakePeriodHours: 0 } })[0].value(96), 0, 'disabled wake periodicity');

// Exercise the actual report rendering, not just the calculation module.
const elements = new Map();
context.document = { getElementById: id => {
    if (!elements.has(id)) elements.set(id, { innerHTML: '', textContent: '', classList: { add() {} } });
    return elements.get(id);
} };
context.sessionStorage = { getItem: () => null };
context.window.location = { search: '' };
context.URLSearchParams = URLSearchParams;
context.CustomerAutonomy = context.window.CustomerAutonomy;
context.SleepCurrent = { calculate: () => { throw new Error('No live workbook loaded'); } };
const html = fs.readFileSync(path.join(root, 'templates/battery_results_menu.html'), 'utf8');
vm.runInContext(html.slice(html.indexOf('        function cells('), html.indexOf("        document.getElementById('export-customer-excel')")), context);
for (const report of Object.keys(expected)) {
    vm.runInContext(`openReportModal('${report}')`, context);
    const rendered = elements.get('modal-body-target').innerHTML;
    for (const column of expected[report]) assert.ok(rendered.includes(column['6'].toFixed(4).replace(/\.?0+$/, '').replace('.', ',') + ' jours'), `${report} rendered duration`);
}
const saved = {
    'wakeParams_Customer Mode': disabledWake,
    'vehicleSleep_Customer Mode': { energyAh: 0.18 },
    batteryConfiguration: { startingSoc: '92', minimumSoc: '70', capacityAh: 60 }
};
context.sessionStorage.getItem = key => key in saved ? JSON.stringify(saved[key]) : null;
for (const report of Object.keys(expected)) {
    vm.runInContext(`openReportModal('${report}')`, context);
    const rendered = elements.get('modal-body-target').innerHTML;
    const actual = calculate(report, { wake: disabledWake, vehicle: saved['vehicleSleep_Customer Mode'], battery: saved.batteryConfiguration });
    for (const column of actual) assert.ok(rendered.includes(column.autonomy.toFixed(4).replace(/\.?0+$/, '').replace('.', ',') + ' jours'), `${report} saved settings rendered duration`);
}
console.log('Customer: 13 Excel cases and their intermediate totals match; saved settings, scenario differences, boundaries and actual report rendering verified.');
