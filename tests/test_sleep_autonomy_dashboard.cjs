const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const heading = { textContent: '' };
const elements = {
    autonomyScope: {},
    autonomySummary: {},
    autonomyComparisonChart: { parentElement: { style: {} } },
    autonomyCoverage: {},
    deviceReports: {
        previousElementSibling: {
            querySelector: () => heading
        }
    }
};
const charts = [];
class Chart {
    constructor(canvas, config) {
        this.canvas = canvas;
        this.config = config;
        charts.push(this);
    }
    destroy() {}
}
const context = vm.createContext({
    window: {},
    document: {
        body: { classList: { add() {} } },
        getElementById: id => elements[id],
        createElement: () => ({
            set textContent(value) { this.innerHTML = String(value ?? ''); },
            innerHTML: ''
        })
    },
    Chart
});

vm.runInContext(
    fs.readFileSync(path.join(root, 'can_server/static/js/sleep-autonomy.js'), 'utf8'),
    context
);
const autonomy = {
    origin_timestamp: 1_700_000_000,
    channels: [{
        channel: 'A',
        status: 'worse',
        days: 12,
        theoretical_days: 14,
        difference_days: -2,
        covered_s: 86400,
        coverage_percent: 100,
        first_timestamp: 1_700_000_000,
        last_timestamp: 1_700_086_400,
        intervals: [
            {start_day: 0, end_day: 0.5, expected_A: 0, average_A: 0.002},
            {start_day: 0.5, end_day: 1, expected_A: 0.006, average_A: 0.004}
        ],
        anomalies: [{
            start_day: 0,
            end_day: 0.5,
            expected_A: 0,
            average_A: 0.002,
            peak_A: 0.002,
            excess_peak_A: 0.002,
            exceedances: 1,
            covered_s: 43200,
            started_at: 1_700_000_000,
            ended_at: 1_700_043_200,
            first_anomaly_at: 1_700_000_000,
            devices: [{name: 'ECU veille', profile: 0, expected_A: 0}]
        }]
    }]
};

context.window.renderSleepAutonomy(autonomy, 0, 1);
assert.match(elements.autonomySummary.innerHTML, /Autonomie moins bonne de 2 jours/);
assert.doesNotMatch(elements.autonomySummary.innerHTML, /<table/);
assert.equal(charts[0].config.type, 'line');
assert.deepEqual(Array.from(charts[0].config.data.datasets[0].data), [0, 6]);
assert.deepEqual(Array.from(charts[0].config.data.datasets[1].data), [2, 4]);
assert.deepEqual(Array.from(charts[0].config.data.labels), ['Jour 0 – 0,5', 'Jour 0,5 – 1']);

context.window.renderSleepAnomalies(autonomy);
assert.equal(heading.textContent, 'Anomalies de consommation en veille');
assert.equal((elements.deviceReports.innerHTML.match(/<tr class="fail">/g) || []).length, 1);
assert.match(elements.deviceReports.innerHTML, /Courant attendu selon profils/);
assert.match(elements.deviceReports.innerHTML, /2 mA/);
console.log('Comparaison d’autonomie, courbes par profil et tableau limité aux anomalies vérifiés.');
