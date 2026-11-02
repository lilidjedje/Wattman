const {app} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-pages-'));
app.setPath('userData', profile);
process.env.ENGINEERING_APP_DATA = path.join(profile, 'data');
let started = false;
app.on('browser-window-created', (_, win) => win.webContents.on('did-finish-load', () => {
    if (!started && win.webContents.getURL() === 'app://local/') {
        started = true;
        setTimeout(() => run(win).then(() => {console.log('LOG_PAGINATION_OK'); app.quit();}).catch(error => {console.error(error.stack); app.exit(1);}), 1000);
    }
}));
require('../desktop/main.js');

async function run(win) {
    const js = script => win.webContents.executeJavaScript(script);
    const until = async expression => {
        const deadline = Date.now() + 120000;
        while (Date.now() < deadline) {
            if (await js(expression)) return;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        throw Error(`Timeout: ${expression}; ${await js("document.getElementById('logSearchStatus')?.textContent")}`);
    };
    const idle = () => until("!document.getElementById('logSearch').disabled");
    await js("location.href='/analyse_logs/dashboard/import'; true");
    await until("location.pathname === '/analyse_logs/dashboard/import' && !!document.getElementById('ascFiles')");
    const files = fs.readdirSync('test_asc').filter(name => name.endsWith('.asc')).sort().map(name => path.resolve('test_asc', name));
    win.webContents.debugger.attach('1.3');
    const dom = await win.webContents.debugger.sendCommand('DOM.getDocument');
    const input = await win.webContents.debugger.sendCommand('DOM.querySelector', {nodeId: dom.root.nodeId, selector: '#ascFiles'});
    await win.webContents.debugger.sendCommand('DOM.setFileInputFiles', {nodeId: input.nodeId, files});
    win.webContents.debugger.detach();
    console.log('PAGE_TEST import');
    await js("document.getElementById('uploadForm').requestSubmit()");
    await until("!document.getElementById('decodeResult').hidden && !document.getElementById('decodeButton').disabled");
    await until("document.getElementById('logSource').options.length === 4");
    console.log('PAGE_TEST search');
    await js("document.querySelector('#logFilterForm [name=graph]').checked = true; document.getElementById('logFilterForm').requestSubmit()");
    await idle();
    assert.match(await js("document.getElementById('logPageA').textContent"), /Page 1 sur 313/);
    assert.match(await js("document.getElementById('logPageB').textContent"), /Page 1 sur 612/);
    assert.equal(await js("document.getElementById('logPageInputA').max"), '313');
    assert.equal(await js("document.getElementById('logPageInputB').max"), '612');
    console.log('PAGE_TEST jump');
    await js("document.getElementById('logPageInputA').value = '250'; document.getElementById('logPageFormA').requestSubmit()");
    await idle();
    assert.match(await js("document.getElementById('logPageA').textContent"), /Page 250 sur 313/);
    assert.match(await js("document.getElementById('logPageB').textContent"), /Page 1 sur 612/);
    const firstOn250 = await js("document.querySelector('#logRowsA tr').innerText");
    await js("document.getElementById('logNextA').click()"); await idle();
    assert.match(await js("document.getElementById('logPageA').textContent"), /Page 251 sur 313/);
    await js("document.getElementById('logPreviousA').click()"); await idle();
    assert.equal(await js("document.querySelector('#logRowsA tr').innerText"), firstOn250);
    console.log('PAGE_TEST last');
    for (const [channel, pages, tail] of [['A', 313, 15], ['B', 612, 39]]) {
        await js(`document.getElementById('logLast${channel}').click()`); await idle();
        assert.match(await js(`document.getElementById('logPage${channel}').textContent`), new RegExp(`Page ${pages} sur ${pages}`));
        assert.equal(await js(`document.querySelectorAll('#logRows${channel} tr').length`), tail);
        assert.equal(await js(`document.getElementById('logNext${channel}').disabled`), true);
        assert.equal(await js(`document.getElementById('logLast${channel}').disabled`), true);
    }
    assert.equal(await js("document.querySelectorAll('#logCharts canvas').length"), 2);
    const output = path.resolve('outputs/log-pagination-validation');
    fs.mkdirSync(output, {recursive:true});
    await js("document.getElementById('logPageFormB').scrollIntoView({block:'center'})");
    await new Promise(resolve => setTimeout(resolve, 300));
    console.log('PAGE_TEST capture');
    win.webContents.debugger.attach('1.3');
    const capture = await win.webContents.debugger.sendCommand('Page.captureScreenshot', {format:'png', fromSurface:true});
    win.webContents.debugger.detach();
    fs.writeFileSync(path.join(output, 'last-page.png'), Buffer.from(capture.data, 'base64'));
    await js("document.querySelector('#logFilterForm [name=limit]').value='500'; document.getElementById('logFilterForm').requestSubmit()"); await idle();
    assert.match(await js("document.getElementById('logPageA').textContent"), /Page 1 sur 63/);
    assert.match(await js("document.getElementById('logPageB').textContent"), /Page 1 sur 123/);
    await js("document.getElementById('logSource').value = [...document.getElementById('logSource').options].find(o=>o.textContent.includes('L214')).value; document.getElementById('logFilterForm').requestSubmit()"); await idle();
    assert.match(await js("document.getElementById('logPageA').textContent"), /Page 1 sur 60/);
    assert.match(await js("document.getElementById('logPageB').textContent"), /Page 1 sur 120/);
    await js("document.querySelector('#logFilterForm [name=threshold]').value='1000000000'; document.getElementById('logFilterForm').requestSubmit()"); await idle();
    for (const channel of ['A','B']) {
        assert.match(await js(`document.getElementById('logPage${channel}').textContent`), /Page 0 sur 0/);
        assert.equal(await js(`document.getElementById('logGo${channel}').disabled`), true);
        assert.equal(await js(`document.getElementById('logLast${channel}').disabled`), true);
    }
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({aPages:313, bPages:612, directPage:250, independentChannels:true, filtersAndPageSize:true, emptyResults:true}, null, 2));
}
