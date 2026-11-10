const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { FileMatcher } = require('app-builder-lib/out/fileMatcher');
const asar = require('@electron/asar');

(async () => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'wattman-build-deps-'));
    try {
        const input = path.join(temporary, 'app');
        await fs.mkdir(path.join(input, 'desktop'), { recursive: true });
        await fs.writeFile(path.join(input, 'desktop/main.js'), 'console.log("fixture");');
        await fs.writeFile(path.join(input, 'package.json'), '{"name":"fixture","main":"desktop/main.js"}');
        const patterns = require('../package.json').build.files;
        const matcher = new FileMatcher(input, path.join(temporary, 'out'), value => value, patterns);
        const filter = matcher.createFilter();
        const file = { isDirectory: () => false };
        assert.equal(filter(path.join(input, 'desktop/main.js'), file), true);
        assert.equal(filter(path.join(input, 'desktop/preload.js'), file), true);
        assert.equal(filter(path.join(input, 'package.json'), file), true);
        assert.equal(filter(path.join(input, 'secrets.env'), file), false);
        assert.equal(filter(path.join(input, 'tests/debug.js'), file), false);
        const archive = path.join(temporary, 'app.asar');
        await asar.createPackage(input, archive);
        assert.equal(asar.extractFile(archive, 'desktop/main.js').toString(), 'console.log("fixture");');
        // Load the macOS helper too: it shares the overridden minimatch dependency.
        assert.equal(typeof require('@electron/universal').makeUniversalApp, 'function');
        console.log('Build dependencies: file inclusion/exclusion, ASAR round trip and universal helper verified.');
    } finally {
        assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(temporary).startsWith('wattman-build-deps-'));
        await fs.rm(temporary, { recursive: true, force: true });
    }
})().catch(error => { console.error(error); process.exitCode = 1; });
