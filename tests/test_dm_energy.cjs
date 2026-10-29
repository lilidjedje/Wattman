const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const dm = fs.readFileSync(path.join(root, 'templates/dm_results.html'), 'utf8');
const legacy = fs.readFileSync(path.join(root, 'templates/battery_results_menu.html'), 'utf8');
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);

for (const mode of ['DM1', 'DM2']) {
    // Consoveille - Test Calcul.xlsx, Delivery!E44 / G44.
    const entries = {
        cellBalancing: { current: 0, duration: 15, extra: { periodMin: 480, balancingDays: 90 } },
        pcuRam: { current: 1, duration: 100, unit: 'h' },
        cdcRam: { current: 4, duration: 100, unit: 'h' },
        ivc3: { current: 0.37, duration: 100, unit: 'h' },
        transport: { current: 0.72, duration: 10, unit: 'jours' },
        // Customer entries must never reduce DM energy, even in saved projects.
        handFree3: { current: 9, duration: 3, unit: 'jours' },
        handFree48: { current: 4.2, duration: 5, unit: 'jours' },
        first8: { current: 50, duration: 8, unit: 'h' },
        blm: { current: 1, duration: 10, unit: 'jours' }
    };
    const fixed = { baseLab: { entries, custom: [] }, withoutAlarmTachy: { entries, custom: [] } };
    const storage = {
        batteryConfiguration: JSON.stringify({ startingSoc: 90, minimumSoc: 70 }),
        [`vehicleSleep_${mode}`]: JSON.stringify({ energyAh: 0.17 }),
        [`fixedConsumption${mode}`]: JSON.stringify(fixed)
    };
    const context = vm.createContext({
        activeSubMode: mode,
        sessionStorage: { getItem: key => storage[key] ?? null },
        SleepCurrent: { calculate: () => ({ instantaneousUa: 1000, dailyAh: 0.024 }) }
    });
    vm.runInContext(dm.slice(dm.indexOf('        const DEFAULT_FIXED'), dm.indexOf('        function fixedEntryRows')), context);
    const compute = key => vm.runInContext(`computeColumn('${mode}', { key: '${key}', capacityOffset: 0 }, 60)`, context);
    const legacyContext = vm.createContext({
        fixedConsumption: fixed, isDmMode: true, batterySubMode: mode,
        sessionStorage: { getItem: key => storage[key] ?? null }
    });
    vm.runInContext(legacy.slice(legacy.indexOf('        function durationInHours'), legacy.indexOf('        function reportValue')), legacyContext);
    for (const [key, expected] of [['baseLab', 11.5572], ['withoutAlarmTachy', 11.1202]]) {
        const result = compute(key);
        near(result.available, expected);
        near(result.autonomy, expected / result.dailyTotal);
        near(vm.runInContext(`fixedConsumptionEnergy('${key}')`, legacyContext), result.fixedTotal);
        near(vm.runInContext(`computeColumn('${mode}', { key: '${key}', capacityOffset: 0 }, 50).available`, context), expected - 2);
    }
    // Nonzero balancing, custom functions and removals must affect both scenarios.
    entries.cellBalancing.current = 200;
    fixed.baseLab.custom.push({ current: 100, duration: 30, unit: 'min' });
    storage[`fixedConsumption${mode}`] = JSON.stringify(fixed);
    near(compute('baseLab').available, 11.5572 - 0.225 - 0.05);
    near(compute('withoutAlarmTachy').available, 11.1202 - 0.225);
    storage[`deletedFixedFunctionIds_${mode}`] = JSON.stringify(['pcuRam', 'cdcRam', 'cellBalancing']);
    near(compute('baseLab').available, 11.5572 + 0.1 - 0.05);
    near(compute('withoutAlarmTachy').available, 11.1202 + 0.1 + 0.4);
}
console.log('DM1/DM2: Excel reference values, scenarios, profiles, custom functions and removals verified.');
