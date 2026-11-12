const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const unitsContext=vm.createContext({window:{}});
vm.runInContext(fs.readFileSync('static/current_units.js','utf8'),unitsContext);

const html = fs.readFileSync('templates/select_components.html', 'utf8');
const match = html.match(/function formatCurrent\(value, sourceUnit\) \{([\s\S]*?)\n        \}/);
assert.ok(match, 'component current formatter exists');
const formatCurrent = new Function('window', 'value', 'sourceUnit', match[1]).bind(null,unitsContext.window);
const darkMatch = html.match(/function formatDarkCurrent\(milliampValue, ampValue\) \{([\s\S]*?)\n        \}/);
assert.ok(darkMatch, 'Dark Current formatter exists');
const formatDarkCurrent = new Function('formatCurrent', 'milliampValue', 'ampValue', darkMatch[1]);
const updateMatch = html.match(/function updateCurrentCell\(currentCell, checkbox\) \{([\s\S]*?)\n        \}/);
assert.ok(updateMatch, 'live current-cell updater exists');
const updateCurrentCell = new Function('currentCell', 'checkbox', updateMatch[1]);
const restoreMatch = html.match(/function restoreDefaultSelections\(checkboxes\) \{([\s\S]*?)\n        \}/);
assert.ok(restoreMatch, 'base configuration restorer exists');
const restoreDefaultSelections = new Function('checkboxes', restoreMatch[1]);

assert.equal(formatCurrent(1.23456, 'A'), '1,23 A');
assert.equal(formatCurrent(0.54, 'A'), '540 mA');
assert.equal(formatCurrent(0.000456, 'A'), '456,00 µA');
assert.equal(formatCurrent(245.678, 'mA'), '245,68 mA');
assert.equal(formatCurrent(0.35, 'mA'), '350,00 µA');
assert.equal(formatCurrent(1200, 'mA'), '1,2 A');
assert.equal(formatCurrent(0, 'mA'), '0,00 µA');
assert.equal(formatCurrent('-', 'A'), '-');
assert.equal(formatDarkCurrent(formatCurrent, '245.678', '53'), '245,68 mA');
assert.equal(formatDarkCurrent(formatCurrent, '', '53'), '53 A');
const darkCell = { dataset: { value: '53 A' }, textContent: '' };
updateCurrentCell(darkCell, { checked: true });
assert.equal(darkCell.textContent, '53 A');
updateCurrentCell(darkCell, { checked: false });
assert.equal(darkCell.textContent, '-');
const homologationCell = { dataset: { value: '53 A' }, textContent: '' };
updateCurrentCell(homologationCell, { checked: false });
assert.equal(homologationCell.textContent, '-');
const defaults = [
    { dataset: { defaultChecked: 'true' }, checked: false },
    { dataset: { defaultChecked: 'false' }, checked: true },
    { dataset: { defaultChecked: 'true' }, checked: false }
];
restoreDefaultSelections(defaults);
assert.deepEqual(defaults.map(checkbox => checkbox.checked), [true, false, true]);
assert.match(html, /id="restore-defaults">Restaurer la configuration de base<\/button>/);
assert.match(html, /restoreDefaultSelections\(tbody\.querySelectorAll\('input\[data-selection\]'\)\)/);
assert.match(html, /class="selection-column"[^>]*>H<\/th>/);
assert.match(html, /class="current-column"[^>]*>Homologation Current<\/th>/);
assert.match(html, /class="selection-column"[^>]*>S<\/th>/);
assert.match(html, /class="current-column"[^>]*>Dark Current<\/th>/);

console.log('Component current formatting and dedicated selection/current columns verified.');
