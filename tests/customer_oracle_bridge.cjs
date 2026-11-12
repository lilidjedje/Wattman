// Batched interface for the independent Python Excel-formula oracle.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const context = vm.createContext({ window: {} });
for (const file of ['customer_reference', 'customer_autonomy']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'static', `${file}.js`), 'utf8'), context);
}
const input = JSON.parse(fs.readFileSync(0, 'utf8'));
console.log(JSON.stringify(input.cases.map(({ report, options }) =>
    context.window.CustomerAutonomy.calculate(report, options).map(result => ({
        available: result.available, dailyAh: result.dailyAh, autonomy: result.autonomy,
        values: Object.fromEntries(input.rows.map(row => [row, result.value(row)]))
    })))));
