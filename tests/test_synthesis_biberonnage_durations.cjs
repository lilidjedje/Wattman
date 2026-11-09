const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('templates/export_synthesis_pdf.html', 'utf8');
const match = html.match(/function getBiberonnageReportSelections\(days, getProfiles\) \{([\s\S]*?)\n        \}/);
assert.ok(match, 'independent biberonnage duration selection exists');
const getSelections = new Function('days', 'getProfiles', match[1]);
const profilesByDuration = {
    30: ['base'],
    90: ['tt-opt', 'custom-1']
};
const selected = getSelections(['30', '90'], days => profilesByDuration[days]);

assert.deepEqual(selected, [
    { days: '30', profiles: ['base'] },
    { days: '90', profiles: ['tt-opt', 'custom-1'] }
]);
assert.deepEqual(
    getSelections(['90'], days => profilesByDuration[days]),
    [{ days: '90', profiles: ['tt-opt', 'custom-1'] }]
);
assert.match(html, /type="checkbox" name="bib-days" value="30"/);
assert.match(html, /type="checkbox" name="bib-days" value="90"/);
assert.match(html, /data-profiles="biberonnage-30"/);
assert.match(html, /data-profiles="biberonnage-90"/);
assert.match(html, /selectedBibReports\.forEach\(\(\{ days, profiles \}\)/);

console.log('Biberonnage summaries independently include 30-day and/or 90-day reports with their own profiles.');
