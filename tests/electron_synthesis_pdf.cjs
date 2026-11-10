const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
app.disableHardwareAcceleration();
app.setPath('userData', fs.mkdtempSync(path.join(os.tmpdir(), 'wattman-pdf-test-')));
let server;
app.whenReady().then(async () => {
    server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://localhost');
        if (url.pathname.startsWith('/static/')) {
            const file = path.join(root, url.pathname);
            if (!fs.existsSync(file)) return response.writeHead(404).end();
            response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
            return response.end(fs.readFileSync(file));
        }
        const templates = { '/export_synthesis_pdf': 'export_synthesis_pdf', '/synthesis': 'synthesis', '/dm_results': 'dm_results', '/battery_results_menu': 'battery_results_menu', '/biberonnage/resultats': 'biberonnage_resultats' };
        const template = templates[url.pathname];
        if (!template) return response.writeHead(404).end();
        response.setHeader('Content-Type', 'text/html; charset=utf-8');
        response.end(fs.readFileSync(path.join(root, 'templates', template + '.html'), 'utf8')
            .replace(/\{\{ duration_days(?: \| tojson)? \}\}/g, url.searchParams.get('days') || '30')
            .replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g, '/static/$1'));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const win = new BrowserWindow({ show: false, width: 1100, height: 900 });
    const base = `http://127.0.0.1:${server.address().port}`;
    await win.loadURL(base + '/export_synthesis_pdf');
    fs.mkdirSync(path.join(root, 'tmp/pdfs'), { recursive: true });
    for (const count of [0, 3, 1]) {
        await win.webContents.executeJavaScript(`sessionStorage.setItem('dmBatteryProfiles', JSON.stringify(Array.from({length:${count}}, (_,i) => ({id:'test-'+i,name:'Profil supplémentaire '+i,capacity:60+i*10}))));`);
        await win.reload();
        await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
        await win.webContents.executeJavaScript(`document.querySelectorAll('#selection input[type=checkbox]').forEach(input => input.checked = true); form.requestSubmit();`);
        const deadline = Date.now() + 30000;
        while (await win.webContents.executeJavaScript('loadedReports !== expectedReports')) {
            if (Date.now() > deadline) throw new Error(await win.webContents.executeJavaScript('status.textContent'));
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        const preview = await win.webContents.executeJavaScript(`({ cards:[...reportContent.querySelectorAll('[data-module="dcdc"] iframe,[data-module="wltc"] iframe')].map(frame => [...frame.contentDocument.querySelectorAll('.table-card')].map(card => card.id)), profiles:reportContent.querySelector('[data-module="dm1"] iframe').contentDocument.querySelectorAll('.profile').length })`);
        assert.deepEqual(preview.cards, [['card-dev-winter','card-dev-midseason','card-dev-summer'],['card-alt-winter','card-alt-midseason','card-alt-summer']]);
        assert.equal(preview.profiles, count + 1);
        await win.webContents.executeJavaScript('prepareReportsForPrint()');
        await win.webContents.debugger.attach('1.3');
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
        const layout = await win.webContents.executeJavaScript(`(() => {
            const copies=[...document.querySelectorAll('.print-report-copy')];
            return { images:copies.slice(0,2).map(copy => copy.querySelectorAll('img').length),
                width:document.querySelector('.page').getBoundingClientRect().width,
                colors:copies.flatMap(copy=>[...copy.querySelectorAll('h1,h2,h3,.section-title,.chart-peak')].map(h=>getComputedStyle(h).color)),
                menu:copies.some(copy=>!!copy.querySelector('.menu-grid')),
                headings:copies.flatMap(copy=>[...copy.querySelectorAll('h2')].map(h=>getComputedStyle(h).fontSize)),
                overflow:copies.flatMap(copy=>[...copy.querySelectorAll('table,.table-card,.profile')].filter(el=>el.getBoundingClientRect().width>copy.getBoundingClientRect().width+1).map(el=>el.className)) };
        })()`);
        assert.deepEqual(layout.images, [3,3]);
        assert.deepEqual(layout.overflow, []);
        assert.equal(layout.menu, false);
        assert.ok(layout.colors.every(color => ['rgb(31, 41, 55)', 'rgb(31, 78, 120)'].includes(color)), JSON.stringify(layout.colors));
        assert.ok(layout.headings.every(size => size === layout.headings[0]));
        fs.writeFileSync(path.join(root, `tmp/pdfs/synthesis-${count}.pdf`), await win.webContents.printToPDF({pageSize:'A4',preferCSSPageSize:true,printBackground:true}));
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { media: '' });
        win.webContents.debugger.detach();
        await win.webContents.executeJavaScript('removePrintReportCopies();setReportFramesVisible(true)');
        console.log(`PDF verified with ${count+1} DM profiles per mode; exactly 3 DCDC and 3 WLTC charts.`);
    }
    win.destroy(); server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
