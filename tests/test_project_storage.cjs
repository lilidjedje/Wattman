const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createProjectStore } = require('../desktop/project_store');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-projects-'));
const store = createProjectStore(directory);
const localValues = new Map();
const indexedValues = new Map();
const script = fs.readFileSync(path.join(__dirname, '../static/project_storage.js'), 'utf8');

function renderer({ desktop = true, recovery } = {}) {
    class Storage {
        constructor(values = new Map()) { this.values = values; }
        get length() { return this.values.size; }
        key(index) { return [...this.values.keys()][index] ?? null; }
        getItem(key) { return this.values.get(key) ?? null; }
        setItem(key, value) { this.values.set(key, String(value)); }
        removeItem(key) { this.values.delete(key); }
        clear() { this.values.clear(); }
    }
    const localStorage = new Storage(localValues);
    const sessionStorage = new Storage();
    const indexedDB = { open() {
        const request = {};
        setTimeout(() => {
            request.result = {
                objectStoreNames: { contains: () => true }, close() {},
                transaction() {
                    const transaction = { objectStore: () => ({
                        put(record) { indexedValues.set(record.id, structuredClone(record)); },
                        get(id) {
                            const result = {};
                            setTimeout(() => { result.result = structuredClone(indexedValues.get(id)); result.onsuccess?.(); }, 0);
                            return result;
                        },
                        delete(id) { indexedValues.delete(id); }
                    }) };
                    setTimeout(() => transaction.oncomplete?.(), 0);
                    return transaction;
                }
            };
            request.onsuccess?.();
        }, 0);
        return request;
    } };
    const listeners = {};
    const window = {
        desktopEnvironment: desktop ? { projectStore: (operation, payload) => store[operation](payload) } : undefined,
        addEventListener: (name, callback) => { listeners[name] = callback; }
    };
    const context = vm.createContext({ window, Storage, localStorage, sessionStorage, indexedDB,
        document: { getElementById: () => null, addEventListener() {} },
        setTimeout: callback => { listeners.timer = callback; return 1; }, clearTimeout() {},
        console, fetch: recovery
    });
    vm.runInContext(script, context);
    return { api: window.ProjectStorage, sessionStorage, localStorage, listeners };
}

async function run() {
    const first = renderer();
    first.sessionStorage.setItem('excelData', JSON.stringify({ 'Device List': { data: [{ 'Device Name': 'ECU' }] } }));
    first.sessionStorage.setItem('selectedDeviceKeys', '["0_ECU"]');
    await first.api.saveProject({ id: 'first', name: 'Same name' });
    first.sessionStorage.setItem('modifiedCurrents', '{"0_ECU":42}');
    first.sessionStorage.setItem('batteryConfiguration', '{"capacityAh":80}');
    first.listeners.pagehide();
    await first.api.saveActiveProject();
    const restarted = renderer();
    assert.equal(restarted.sessionStorage.getItem('modifiedCurrents'), '{"0_ECU":42}');
    assert.equal(restarted.sessionStorage.getItem('batteryConfiguration'), '{"capacityAh":80}');
    restarted.api.clearWorkingData();
    restarted.sessionStorage.setItem('customDarkDevices', '[{"id":"custom","current":5}]');
    await restarted.api.saveProject({ id: 'second', name: 'Same name' });
    assert.equal(restarted.api.getProjects().length, 2);
    await restarted.api.restoreProject({ id: 'first', name: 'Same name' });
    assert.equal(restarted.sessionStorage.getItem('selectedDeviceKeys'), '["0_ECU"]');
    assert.equal(restarted.sessionStorage.getItem('customDarkDevices'), null);
    restarted.sessionStorage.setItem('modifiedCurrents', '{"0_ECU":99}');
    const abruptRestart = renderer();
    assert.equal(abruptRestart.sessionStorage.getItem('modifiedCurrents'), '{"0_ECU":99}');
    assert.throws(() => store.write({ metadata: { id: 'first' }, snapshot: { sessionStorage: {} } }), /vide/);
    const before = store.read('first');
    assert.ok(before.snapshot.sessionStorage.excelData);
    const filename = fs.readdirSync(directory).find(name => name.endsWith('.json') && JSON.parse(fs.readFileSync(path.join(directory, name))).metadata.id === 'first');
    fs.writeFileSync(path.join(directory, filename), 'invalid');
    assert.ok(store.read('first').snapshot.sessionStorage.excelData);
    assert.equal(store.list().length, 2);

    localValues.clear();
    localValues.set('activeProject', JSON.stringify({ id: 'legacy', name: 'Legacy' }));
    const legacySnapshot = { sessionStorage: { excelData: '{"Device List":{"data":[{"Device Name":"Legacy ECU"}]}}', modifiedCurrents: '{"legacy":10}' } };
    indexedValues.set('legacy', { id: 'legacy', snapshot: legacySnapshot });
    const legacy = renderer({ desktop: false });
    await legacy.api.saveActiveProject();
    assert.equal(indexedValues.get('legacy').snapshot.sessionStorage.modifiedCurrents, '{"legacy":10}');
    await legacy.api.restoreProject({ id: 'legacy', name: 'Legacy' });
    assert.equal(legacy.sessionStorage.getItem('modifiedCurrents'), '{"legacy":10}');
    const recovery = renderer({ desktop: false, recovery: async () => ({ ok: true, json: async () => ({ sheets: { 'Device List': { data: [{ 'Device Name': 'Recovered' }] } }, serverFileUrl: '/uploads/legacy.xlsx' }) }) });
    await recovery.api.restoreProject({ id: 'missing', name: 'Recovered', filename: 'legacy.xlsx' });
    assert.match(recovery.sessionStorage.getItem('excelData'), /Recovered/);
    await restarted.api.deleteProject({ id: 'first', name: 'Same name' });
    assert.equal(store.read('first'), null);
    assert.ok(store.read('second'));
    console.log('Projets : sauvegarde immediate, redemarrage, isolation, anciens projets, recuperation et secours valides.');
}

run().finally(() => fs.rmSync(directory, { recursive: true, force: true })).catch(error => { console.error(error); process.exitCode = 1; });
