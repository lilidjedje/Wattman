const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http');
const root=path.resolve(__dirname,'..');
app.disableHardwareAcceleration();app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'wattman-units-')));
let server;
app.whenReady().then(async()=>{
    server=http.createServer((req,res)=>{
        const url=new URL(req.url,'http://localhost');
        if(url.pathname.startsWith('/static/')) {
            const file=path.join(root,url.pathname);
            if(!fs.existsSync(file))return res.writeHead(404).end();
            res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/css');
            return res.end(fs.readFileSync(file));
        }
        res.setHeader('Content-Type','text/html; charset=utf-8');
        if(url.pathname==='/fixture')return res.end(`<!doctype html><html><head><script src="/static/current_units.js"></script></head><body>
            <form><label>Courant<span data-unit="A"><input id="amps" name="amps" type="number" min="0" max="10" value="0.000045"></span></label></form>
            <table><thead><tr><th rowspan="2">ECU</th><th rowspan="2">Current<br><small>mA</small></th><th colspan="2">Profil</th></tr><tr><th>0</th><th>1</th></tr></thead><tbody><tr><td>ECU</td><td id="reading">0.72</td><td>0</td><td>1</td></tr></tbody></table>
            <div id="output">0.000045 A</div><div id="energy">1500 mAh — 1.234 Ah — 2.1234 Ah/j</div>
            <label>Fréquence du canal A<input id="frequency" type="number" value="1000"></label>
            <label>Durée du canal A<input id="duration" type="number" value="10"></label>
            </body></html>`);
        const names={'/setup':'autonomy_current_setup','/fixed':'fixed_consumption','/sleep':'sleep_consumption','/dm':'edit_dm_mode','/bib':'biberonnage'};
        const name=names[url.pathname];if(!name)return res.writeHead(404).end();
        return res.end(fs.readFileSync(path.join(root,'templates',name+'.html'),'utf8').replace(/\{\{ current_group \}\}/g,'dm').replace(/\{\{ duration_days(?: \| tojson)? \}\}/g,'30').replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g,'/static/$1'));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});
    const errors=[];win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
    const base=`http://127.0.0.1:${server.address().port}`,js=code=>win.webContents.executeJavaScript(code);
    await win.loadURL(base+'/fixture');
    const native=id=>js(`CurrentUnits.displayValue(document.getElementById('${id}'))`);
    assert.equal(await native('amps'),'45.00');
    assert.equal(await js("document.getElementById('amps').value"),'0.000045');
    assert.equal(await js("document.getElementById('frequency').dataset.currentBaseUnit"),undefined);
    assert.equal(await js("document.getElementById('duration').value"),'10');
    assert.match(await js("document.getElementById('reading').textContent"),/720,00 µA/);
    const energy=await js("document.getElementById('energy').textContent");assert.equal(energy,'1500 mAh — 1.234 Ah — 2.1234 Ah/j');
    const type=async value=>js(`(()=>{const input=document.getElementById('amps');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));return {canonical:input.value,unit:input.dataset.currentDisplayUnit,visible:CurrentUnits.displayValue(input)};})()`);
    for(const [value,canonical,unit,visible] of [['1000','.001','mA','1'],['1000','1','A','1'],['0.5','.5','mA','500'],['0.5','.0005','µA','500.00']]) {
        const result=await type(value);assert.equal(Number(result.canonical),Number(canonical));assert.equal(result.unit,unit);assert.equal(result.visible,visible);
    }
    await js("document.getElementById('amps').value='0.000045678901';");
    assert.equal(await native('amps'),'45.68');
    assert.equal(await js("new FormData(document.querySelector('form')).get('amps')"),'0.000045678901');
    await js("document.body.append(document.querySelector('form').cloneNode(true));CurrentUnits.refresh();");
    assert.equal(await js("[...document.querySelectorAll('#amps')][1].value"),'0.000045678901');
    // Actual setup and model: changing displayed mA updates canonical A.
    await js(`sessionStorage.clear();sessionStorage.setItem('batterySubMode','DM1');sessionStorage.setItem('excelData',JSON.stringify({'Device List':{data:[{'Device Name':'AIBS',current_category:'S','DM1 Current (mA)':5}]}}));`);
    await win.loadURL(base+'/setup');
    assert.equal(await js("document.querySelector('[data-field=technicalWakeupA]').dataset.currentDisplayUnit"),'\u00b5A');
    await js("(()=>{const input=document.querySelector('[data-field=technicalWakeupA]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'1000000');input.dispatchEvent(new Event('input',{bubbles:true}));})()");
    assert.equal(await js("SleepCurrent.devices('DM1')[0].technicalWakeupA"),1);
    assert.equal(await js("document.querySelector('[data-field=technicalWakeupA]').dataset.currentDisplayUnit"),'A');
    assert.match(await js("document.querySelector('[data-output=total-dark-current]').textContent"),/1 A/);
    await js("sessionStorage.setItem('fixedConsumptionDM1',JSON.stringify({baseLab:{entries:{pcuRam:{current:'0,000045',duration:192,unit:'h'}}}}))");
    await win.loadURL(base+'/fixed');
    assert.ok(await js("[...document.querySelectorAll('input[data-current-base-unit]')].length>0"));
    assert.ok(await js("[...document.querySelectorAll('input[data-current-base-unit]')].some(input=>input.value==='0.000045' && input.dataset.currentDisplayUnit==='µA' && CurrentUnits.displayValue(input)==='0.05')"));
    await win.loadURL(base+'/bib');
    assert.ok(await js("[...document.querySelectorAll('input[data-current-base-unit=mA]')].length>20"));
    fs.mkdirSync(path.join(root,'tmp/current-units'),{recursive:true});
    await win.loadURL(base+'/setup');await new Promise(resolve=>setTimeout(resolve,300));
    fs.writeFileSync(path.join(root,'tmp/current-units/setup.png'),(await win.webContents.capturePage()).toPNG());
    assert.deepEqual(errors,[]);
    console.log('Browser: live unit crossings, exact canonical values, form data, cloning/PDF, setup totals and biberonnage inputs verified.');
    win.destroy();server.close();app.quit();
}).catch(error=>{console.error(error.stack);server?.close();app.exit(1)});
