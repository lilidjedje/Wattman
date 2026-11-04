// Exercise the real Flask page with an isolated, hidden Electron window.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-gmv-'));
app.setPath('userData', profile);
const logPath = process.env.GMV_TEST_LOG || path.join(profile, 'result.log');
const log = message => fs.appendFileSync(logPath, `${message}\n`);
const deadline = setTimeout(() => {
    log('FAIL: test timeout');
    backend.kill();
    app.exit(1);
}, 60000);
const backend = spawn(process.env.PYTHON || 'python', ['-u', '-c',
    "from werkzeug.serving import make_server; from app import app; s=make_server('127.0.0.1',0,app); print(s.server_port,flush=True); s.serve_forever()"],
    { cwd: root, windowsHide: true, env: { ...process.env, ENGINEERING_APP_DATA: path.join(profile, 'data') } });
const ready = new Promise((resolve, reject) => {
    backend.once('error', reject);
    backend.stdout.once('data', data => resolve(`http://127.0.0.1:${Number(data.toString().trim())}`));
    backend.once('exit', code => reject(new Error(`Backend exited: ${code}`)));
});
backend.stderr.on('data', data => fs.appendFileSync(logPath, data));
app.whenReady().then(async () => {
    const base = await ready;
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true, nodeIntegration: false } });
    const errors = [];
    win.webContents.on('console-message', event => {
        if (event.level === 'error') errors.push(event.message);
    });
    const js = code => win.webContents.executeJavaScript(code);
    const navigate = async route => {
        const response = await fetch(base + route);
        assert.equal(response.status, 200, route);
        await response.arrayBuffer();
        await win.loadURL(base + route);
    };
    await navigate('/edit_gmv');
    assert.equal(await js("document.querySelectorAll('#table-body tr').length"), 0);
    await js("document.getElementById('gmv-count').value='2'; generateGMVTable();");
    assert.equal(await js("document.querySelectorAll('#table-body tr').length"), 2);
    // 4 identification/bound columns + 15 DCDC + 19 WLTC profile columns.
    assert.equal(await js("document.querySelector('#table-body tr').children.length"), 38);
    await js(`(() => {
        const inputs = document.querySelector('#table-body tr').querySelectorAll('input');
        for (const [index, value] of [[0, 'GMV test'], [1, '12.5'], [2, '35']]) {
            inputs[index].value = value;
            inputs[index].dispatchEvent(new Event('change', { bubbles: true }));
        }
    })()`);
    await navigate('/edit_gmv');
    assert.equal(await js("document.querySelector('.gmv-name-input').value"), 'GMV test');
    assert.equal(await js("gmvData[0].current"), '12.5');
    assert.equal(await js("Object.values(gmvData[0].devProfiles)[0]"), '35%');
    // The synthesis needs an imported Excel project; check its HTTP route
    // without opening its missing-project dialog in this isolated fixture.
    const synthesis = await fetch(base + '/synthesis');
    assert.equal(synthesis.status, 200);
    await synthesis.arrayBuffer();
    await navigate('/edit_gmv');
    assert.equal(await js("document.querySelectorAll('#table-body tr').length"), 2);
    await js("document.getElementById('gmv-count').value='1'; generateGMVTable();");
    assert.equal(await js("gmvData[0].name"), 'GMV test');
    await js("document.getElementById('gmv-count').value='0'; generateGMVTable();");
    assert.equal(await js("document.querySelectorAll('#table-body tr').length"), 0);
    assert.deepEqual(errors, []);
    log('GMV OK: HTTP 200, creation, edition, persistence, synthesis route, removal.');
    win.destroy();
}).then(() => { clearTimeout(deadline); backend.kill(); app.exit(0); }).catch(error => {
    clearTimeout(deadline);
    log(error.stack || String(error));
    backend.kill();
    app.exit(1);
});
