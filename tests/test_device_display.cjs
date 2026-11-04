const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('can_server/static/js/device-display.js', 'utf8');
(async () => {
    const calls = [], timers = new Map();
    let nextTimer = 0, offline = true;
    const context = { window: {}, AbortController,
        setTimeout: (fn, delay) => { const id = ++nextTimer; timers.set(id, {fn, delay}); return id; },
        clearTimeout: id => timers.delete(id),
        fetch: async (url, options) => {
            calls.push({url, body: JSON.parse(options.body)});
            if (offline) throw new Error('offline');
            return {ok: true};
        }
    };
    vm.runInNewContext(source, context);
    const display = context.window.DeviceDisplay;
    await assert.rejects(display.show('/display', {state: 'project_welcome', pilot: 'Léa'}));
    assert.equal([...timers.values()].filter(t => t.delay === 3000).length, 1);
    offline = false;
    await display.show('/display', {state: 'can_ready'});
    assert.equal(timers.size, 0); // New navigation cancels obsolete retry.
    assert.equal(calls.at(-1).body.state, 'can_ready');
    assert.equal(calls[0].body.pilot, 'Léa');
    offline = true;
    await assert.rejects(display.show('/display', {state: 'digital_ready'}));
    display.cancel();
    assert.equal(timers.size, 0); // Starting a measurement cancels navigation retry.
    console.log('Device display: offline retry, latest navigation and UTF-8 metadata OK.');
})().catch(error => { console.error(error); process.exitCode = 1; });
