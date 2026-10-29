const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const context = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(__dirname, '../static/sleep_current.js'), 'utf8'), context);
const calculator = context.window.SleepCurrent;
for (const page of ['sleep_consumption', 'dm_results', 'edit_dm_mode', 'edit_customer_mode', 'battery_results_menu']) {
    const html = fs.readFileSync(path.join(__dirname, `../templates/${page}.html`), 'utf8');
    for (const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g)) {
        new vm.Script(match[1], { filename: page });
    }
}

for (const mode of ['DM1', 'DM2', 'Customer Mode']) {
    const currentKey = mode === 'Customer Mode' ? 'modifiedCustomerCurrents' : `modified${mode}Currents`;
    const matrixKey = mode === 'Customer Mode' ? 'customerModeMatrix' : `${mode.toLowerCase()}ModeMatrix`;
    const modeColumn = mode === 'Customer Mode' ? 'CM Current (mA)' : `${mode} Current (mA)`;
    const values = {
        excelData: { 'Device List': { data: [
            { 'Device Name': 'Legacy', 'Current (A)': '12,5' },
            { 'Device Name': 'Disabled', 'Sleep Current (mA)': 100 },
            { 'Device Name': 'Modified', [modeColumn]: 80 },
            { 'Device Name': 'Deleted', [modeColumn]: 1000 },
            { 'Device Name': 'Not selected', [modeColumn]: 1000 },
            { 'Device Name': 'Fallback', 'Homologation Current (mA)': 2.5 }
        ] } },
        selectedEcuKeys: ['0_Legacy', '1_Disabled', '2_Modified', '3_Deleted', '5_Fallback'],
        deletedDarkDeviceKeys: ['3_Deleted', 'custom:removed'],
        customDarkDevices: [{ id: 'added', current: 5 }, { id: 'removed', current: 1000 }],
        [currentKey]: { '2_Modified': '20', 'custom:added': '7,5' },
        [matrixKey]: { '1_1.0 jour': 0, '2_1,0 jours': 1, '0_1,0 jours': 1, '0_0,3 jours': 0 }
    };
    const storage = { getItem: key => key in values ? JSON.stringify(values[key]) : null };
    if (mode === 'Customer Mode') {
        // Customer fields are mA; legacy source fallback values remain µA.
        values[currentKey]['2_Modified'] = '0,02';
        values[currentKey]['custom:added'] = '0,0075';
    }
    const result = calculator.calculate(mode, storage);
    assert.equal(result.instantaneousUa, 42.5, mode);
    assert.equal(result.dailyAh, 0.00102, mode);
    values[currentKey]['2_Modified'] = 0;
    assert.equal(calculator.calculate(mode, storage).instantaneousUa, 22.5);
    values.selectedEcuKeys = [];
    assert.equal(calculator.calculate(mode, storage).instantaneousUa, 7.5);
    values.customDarkDevices = [];
    assert.equal(calculator.calculate(mode, storage).dailyAh, 0);
    values.customDarkDevices = [{ id: 'large', current: mode === 'Customer Mode' ? 2 : 2000 }];
    const largeCurrent = calculator.calculate(mode, storage);
    assert.equal(largeCurrent.instantaneousUa, 2000);
    assert.equal(largeCurrent.dailyAh, 0.048);
    context.sessionStorage = storage;
    context.SleepCurrent = calculator;
    context.batterySubMode = mode;
    context.isDmMode = mode !== 'Customer Mode';
    context.sleepConsumption = { baseLab: {} };
    context.batteryConfiguration = { capacityAh: 60 };
    const resultsHtml = fs.readFileSync(path.join(__dirname, '../templates/battery_results_menu.html'), 'utf8');
    for (const [start, end] of [
        ['formatConfigurationNumber', 'readBatteryConfiguration'],
        ['homologationCurrent', 'sleepValue'],
        ['sleepValue', 'customConsumptionRows']
    ]) {
        vm.runInContext(resultsHtml.slice(resultsHtml.indexOf(`        function ${start}(`), resultsHtml.indexOf(`        function ${end}(`)), context);
    }
    assert.equal(vm.runInContext("sleepValue('curr_veille_conso', 'baseLab')", context), mode === 'Customer Mode' ? '2 mA' : '2000 µA');
    assert.equal(vm.runInContext("sleepValue('curr_veille', 'baseLab')", context), '0,048 Ah/j');
}
console.log('DM1, DM2 et Customer : somme a 1 jour et conversion µA/Ah par jour validees.');

{
    const reference = require('./fixtures/customer_sleep_reference.json');
    const values = {
        excelData: { 'ECU List': { data: reference.rows.map(row => ({
            'ECU Name': row.name, 'CM Current (mA)': row.currentUa / 1000
        })) } },
        customerModeMatrix: Object.fromEntries(reference.rows.map((row, index) => [`${index}_1,0 jours`, row.oneDay]))
    };
    const storage = { getItem: key => key in values ? JSON.stringify(values[key]) : null };
    const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
    const result = calculator.calculate('Customer Mode', storage);
    near(result.instantaneousUa, reference.expectedUa);
    near(result.dailyAh, reference.expectedDailyAh);
    // The same imported legacy values use µA, rather than the editor's mA.
    values.excelData['ECU List'].data = reference.rows.map(row => ({
        'ECU Name': row.name, 'Current (A)': row.currentUa
    }));
    near(calculator.calculate('Customer Mode', storage).dailyAh, reference.expectedDailyAh);
    values.modifiedCustomerCurrents = { [`0_${reference.rows[0].name}`]: '0,42' };
    near(calculator.calculate('Customer Mode', storage).instantaneousUa, reference.expectedUa + 210);
    console.log('Consoveille Customer!E88:E89: 3.0482 mA -> 0.0731568 Ah/j verified from Customer Mode!M54:M55.');
}
