// Biberonnage profiles managed like DM/Customer profiles: per-profile data, 30/90/both durations, summary placement.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-bib-profiles-test-')));
let server;
const page = (file, days) => fs.readFileSync(path.join(root, 'templates', file), 'utf8')
    .replace(/\{\{ duration_days(?: \| tojson)? \}\}/g, days)
    .replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g, '/static/$1');
app.whenReady().then(async () => {
    server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname === '/static/project_storage.js') {
            response.setHeader('Content-Type', 'text/javascript');
            response.end('window.ProjectStorage = { bindSaveButton() {}, getActiveProject() { return {}; }, saveActiveProject() { return Promise.resolve(null); } };');
        } else if (url.pathname.startsWith('/static/')) {
            const file = path.join(root, url.pathname);
            if (!fs.existsSync(file)) { response.writeHead(404).end(); return; }
            response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
            response.end(fs.readFileSync(file));
        } else {
            response.setHeader('Content-Type', 'text/html; charset=utf-8');
            const days = url.searchParams.get('days');
            response.end(url.pathname === '/biberonnage/resultats' ? page('biberonnage_resultats.html', days || '30')
                : days ? page('biberonnage.html', days) : page('biberonnage_selection.html', '30'));
        }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({ show: false, width: 1300, height: 900 });
    const failures = [];
    win.webContents.on('console-message', details => { if (details.level === 'error') failures.push(details.message); });
    const base = `http://127.0.0.1:${server.address().port}`;
    const js = code => win.webContents.executeJavaScript(`try { ${code.trim().startsWith('(') || code.trim().startsWith('[') || code.trim().startsWith('sessionStorage') || code.trim().startsWith('document.querySelectorAll') ? 'JSON.stringify(' + code + ')' : code} } catch (e) { 'ERR ' + e.message }`).then(v => { if (typeof v === 'string' && v.startsWith('ERR ')) throw new Error(code.slice(0, 80) + ' -> ' + v); try { return typeof v === 'string' ? JSON.parse(v) : v; } catch { return v; } });
    const settle = () => new Promise(resolve => setTimeout(resolve, 150));
    try {
        await win.loadURL(`${base}/biberonnage`);
        const selection = await js(`({
            bar: !!document.querySelector('.biberonnage-profile-bar'),
            summaryInHeader: !!document.querySelector('header.page-header .app-summary'),
            summaryTop: document.querySelector('.app-summary').getBoundingClientRect().top,
            cards: [...document.querySelectorAll('.choice')].filter(card => !card.hidden).length
        })`);
        assert.equal(selection.bar, true);
        assert.equal(selection.summaryInHeader, true);
        assert.ok(selection.summaryTop < 120, `summary top ${selection.summaryTop}`);
        assert.equal(selection.cards, 2);

        // Profile 1 keeps its value; profile 2 (30 days only) has independent data.
        await js(`sessionStorage.setItem('biberonnage30Days', JSON.stringify({ '1:d1': 5 }))`);
        await js(`document.getElementById('add-biberonnage-profile').click()`);
        await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await settle();
        const second = await js(`({
            count: BiberonnageProfiles.list().length,
            data: sessionStorage.getItem('biberonnage30Days')
        })`);
        assert.equal(second.count, 2);
        assert.equal(second.data, null);
        await js(`const s = document.getElementById('biberonnage-profile-days'); s.value = '30'; s.dispatchEvent(new Event('change'));`);
        const cards = await js(`[...document.querySelectorAll('.choice')].filter(card => !card.hidden).map(card => card.dataset.days)`);
        assert.deepEqual(cards, ['30']);

        await js(`const s = document.getElementById('biberonnage-profile-select'); s.value = 'main'; s.dispatchEvent(new Event('change'));`);
        await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        assert.equal(await js(`sessionStorage.getItem('biberonnage30Days')`), JSON.stringify({ '1:d1': 5 }));

        await win.loadURL(`${base}/biberonnage/resultats?days=30`);
        await settle();
        const results = await js(`({
            creatorHidden: document.getElementById('analysis-creator').hidden && document.getElementById('show-creator').hidden,
            days: [...document.querySelectorAll('#view-days a')].map(a => a.textContent),
            analyses: document.querySelectorAll('#view-analyses input').length,
            sections: document.querySelectorAll('.analysis').length
        })`);
        assert.equal(results.creatorHidden, true);
        assert.deepEqual(results.days, ['30 jours', '90 jours']);
        assert.equal(results.sections, results.analyses);
        await js(`const box = document.querySelector('#view-analyses input'); box.checked = false; box.dispatchEvent(new Event('change', { bubbles: true }));`);
        await settle();
        assert.equal(await js(`document.querySelectorAll('.analysis').length`), results.sections - 1);
        await js(`localStorage.clear()`);
        assert.deepEqual(failures, []);
        console.log('Chromium: biberonnage profiles keep separate data, choose 30/90/both days, results view is selectable and summary sits top-right.');
    } catch (error) {
        console.error(error, failures);
        process.exitCode = 1;
    } finally {
        server.close();
        app.quit();
    }
});
