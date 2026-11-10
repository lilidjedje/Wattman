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
    const win = new BrowserWindow({ show: false, width: 1100, height: 900, webPreferences:{backgroundThrottling:false} });
    win.webContents.on('console-message', details => { if(details.level==='error') console.error(details.message); });
    const base = `http://127.0.0.1:${server.address().port}`;
    await win.loadURL(base + '/export_synthesis_pdf');
    const cases = [
        {modules:['dm1','dm2','customer','biberonnage'], dm1:['baseLab'], dm2:['withoutAlarmTachy'], customer:['Customer','CustomerWO'], scenarios:['baseLab','withAlarm','withoutAlarmTachy','alarmTachy','baseLib'], days:['30','90']},
        {modules:['customer'], customer:['CustomerPIE'], scenarios:['baseLib'], days:[]},
        {modules:['biberonnage'], days:['90']},
        {modules:['dm2'],dm2:['baseLab','withoutAlarmTachy'],days:[]}
    ];
    await win.webContents.executeJavaScript(`sessionStorage.setItem('batteryConfiguration',JSON.stringify({capacityAh:72,startingSoc:92,minimumSoc:68}));sessionStorage.setItem('dmBatteryProfiles',JSON.stringify([{id:'custom',name:'Profil avec un nom tres long pour verifier les collisions',capacity:86}]));`);
    await win.webContents.executeJavaScript(`sessionStorage.setItem('excelData',JSON.stringify({'Device List':{data:[{'Device Name':'ECU selectionne','DM1 Current (mA)':1500,'DM2 Current (mA)':2300,'CM Current (mA)':2}]}}));sessionStorage.setItem('dm1ModeMatrix',JSON.stringify({'0_1 jours':0.5}));sessionStorage.setItem('dm2ModeMatrix',JSON.stringify({'0_1 jours':0.25}));`);
    // Reproduce values saved by HTML inputs, including decimal commas and a
    // balancing duration that previously caused float / str in the backend.
    await win.webContents.executeJavaScript(`(() => {
        const fixed={entries:{
            cellBalancing:{current:'200',duration:'15',extra:{periodMin:'480',balancingDays:'90'}},
            pcuRam:{current:'1,5',duration:'192'},
            transport:{current:'0,72',duration:'10'}
        }};
        ['DM1','DM2'].forEach(mode=>sessionStorage.setItem('fixedConsumption'+mode,JSON.stringify({baseLab:fixed,withoutAlarmTachy:fixed})));
        const customer={entries:{fota:{current:'1511',duration:'10',unit:'min'}}};
        sessionStorage.setItem('fixedConsumption',JSON.stringify({baseLab:customer,withAlarm:customer,withoutAlarmTachy:customer,alarmTachy:customer,baseLib:customer}));
    })()`);
    const indices=process.argv[2]===undefined?cases.map((_choice,index)=>index):[Number(process.argv[2])];
    for (const index of indices) {
        console.log('Preparing Excel selection '+index);
        await win.loadURL(base + '/export_synthesis_pdf');
        await win.webContents.executeJavaScript(`(() => {
            const choice=${JSON.stringify(cases)}[${index}];
            document.querySelectorAll('#selection input[type=checkbox]').forEach(input => {
                const name=input.name;
                input.checked=name==='module'?choice.modules.includes(input.value)
                    :name==='dm1-scenario'?!!choice.dm1?.includes(input.value)
                    :name==='dm2-scenario'?!!choice.dm2?.includes(input.value)
                    :name==='customer-profile'?!!choice.customer?.includes(input.value)
                    :name==='customer-scenario'?!!choice.scenarios?.includes(input.value)
                    :name==='bib-days'?choice.days.includes(input.value)
                    :name.startsWith('bib-profile')?input.value===(name.endsWith('90')?'tt-opt':'base')
                    :name==='dm1-profile'?true:name==='dm2-profile'?input.value==='custom':false;
            });
            form.requestSubmit();
        })()`);
        const deadline = Date.now() + 45000;
        while (await win.webContents.executeJavaScript('loadedReports !== expectedReports')) {
            if (Date.now()>deadline) throw new Error(await win.webContents.executeJavaScript('status.textContent'));
            await new Promise(resolve=>setTimeout(resolve,100));
        }
        console.log('Extracting calculated Excel data '+index);
        const payload=await win.webContents.executeJavaScript(`JSON.parse(JSON.stringify({modules:selectedSynthesisModules,project:{name:'Test s?lection'},reports:[...reportContent.querySelectorAll('.report')].map(getExcelReportData)}))`);
        fs.mkdirSync(path.join(root,'tmp/excel-tests'),{recursive:true});
        fs.writeFileSync(path.join(root,`tmp/excel-tests/case-${index}.json`),JSON.stringify(payload));
        console.log('Checking exported workbook '+index);
        const checked=require('node:child_process').spawnSync('python',[path.join(root,'tests/validate_synthesis_excel.py'),String(index)],{cwd:root,encoding:'utf8',timeout:300000});
        assert.equal(checked.status,0,checked.stdout+'\n'+checked.stderr);
        console.log(checked.stdout.trim());
    }
    win.destroy(); server.close(); app.quit();
}).catch(error => { console.error(error.stack); server?.close(); app.exit(1); });
