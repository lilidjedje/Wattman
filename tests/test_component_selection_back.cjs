const assert = require('node:assert/strict');
const fs = require('node:fs');

const selectionHtml = fs.readFileSync('templates/select_components.html', 'utf8');
const indexHtml = fs.readFileSync('templates/index.html', 'utf8');
const match = selectionHtml.match(/function componentSelectionBackTarget\(openedExistingProject\) \{([\s\S]*?)\n        \}/);
assert.ok(match, 'component-selection back destination helper exists');
const backTarget = new Function('openedExistingProject', match[1]);

assert.equal(backTarget(true), '/', 'existing projects return to project selection');
assert.equal(backTarget(false), null, 'new projects retain the previous navigation behavior');
assert.match(selectionHtml, /sessionStorage\.removeItem\('openedExistingProject'\)/);
assert.match(indexHtml, /sessionStorage\.setItem\('openedExistingProject', '1'\)/);
assert.match(selectionHtml, /if \(target\)[\s\S]*?window\.location\.href = target;[\s\S]*?history\.back\(\);/);

console.log('Component-selection back navigation distinguishes opened projects from new projects.');
