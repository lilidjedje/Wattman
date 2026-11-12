// End-to-end complete profiles through actual forms, reports and project snapshots.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('node:fs'),http=require('node:http'),os=require('node:os'),path=require('node:path');
const root=path.resolve(__dirname,'..');app.disableHardwareAcceleration();
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'wattman-full-autonomy-')));
let server,win;const timeout=setTimeout(()=>{console.error('Complete autonomy profiles test timed out');app.exit(1);},180000);
app.whenReady().then(async()=>{
    server=http.createServer((request,response)=>{
        const url=new URL(request.url,'http://localhost');
        const name=url.pathname.startsWith('/configure_')?'autonomy_current_setup':url.pathname.slice(1);
        const file=url.pathname.startsWith('/static/')?path.join(root,url.pathname):path.join(root,'templates',name+'.html');
        if(!fs.existsSync(file))return response.writeHead(404).end();
        response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');
        response.end(fs.readFileSync(file,'utf8').replace(/\{\{ current_group \}\}/g,url.pathname.includes('customer')?'customer':'dm')
            .replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g,'/static/$1'));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${server.address().port}`;
    win=new BrowserWindow({show:false,width:1400,height:1000,webPreferences:{backgroundThrottling:false}});
    const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
    const js=source=>win.webContents.executeJavaScript(source);
    const go=route=>win.loadURL(base+route);
    async function navigate(source){const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));await js(source);await loaded;}
    const input=async(selector,value)=>js(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});input.value=${JSON.stringify(String(value))};input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await go('/battery_menu');
    await js(`sessionStorage.clear();sessionStorage.setItem('excelData',JSON.stringify({'Device List':{data:[{'Device Name':'AIBS',current_category:'S','DM1 Current (mA)':1,'DM2 Current (mA)':2,'CM Current (mA)':.003}]}}));`);
    const ids={};
    for(const [index,mode] of ['DM1','DM2','Customer Mode'].entries()){
        const group=mode==='Customer Mode'?'customer':mode.toLowerCase();
        await go('/battery_configuration?mode='+encodeURIComponent(mode));
        assert.equal(await js('document.getElementById("autonomy-profile-mode").value'),group);
        await input('#battery-capacity',60+index*10);
        await navigate(`document.getElementById('add-autonomy-profile').click()`);
        assert.equal(await js('Number(document.getElementById("battery-capacity").value)'),60);
        ids[group]=await js('AutonomyProfiles.selected.id');
        await input('#autonomy-profile-name',mode+' complet');
        await input('#battery-capacity',90+index*10);
        await input('#starting-soc',95);
        await input('#minimum-soc',60);
        const setup=group==='customer'?'/configure_customer_currents':'/configure_dm_currents';
        await go(setup);
        assert.equal(await js('document.getElementById("autonomy-profile-select").value'),ids[group]);
        await input('#current-contributions input[data-field="technicalWakeupA"]',.000002);
        await navigate(`document.getElementById('continue-configuration').click()`);
        await input('#table-body .homologation-input',100+index*10);
        await go('/fixed_consumption');
        assert.equal(await js('AutonomyProfiles.selected.id'),ids[group]);
        await input('#modeVehicleSleepEnergyAh',.5+index*.1);
        await go('/sleep_consumption');await input('#wakePeriodHours',0);
        const page=group==='customer'?'/battery_results_menu':'/dm_results';
        await go(page);
        assert.equal(await js('document.getElementById("autonomy-profile-name").value'),mode+' complet');
        if(group!=='customer'){
            const column=await js('getSynthesisExcelData().profiles[0].columns[0]');
            assert.equal(column.capacity,90+index*10);assert.equal(column.technicalWake,0);
            assert.equal(column.vehicleUnit,.5+index*.1);assert.equal(column.instantaneous,102+index*10);
        }
        // Return to main on the battery page, then back to the complete profile.
        await go('/battery_configuration');
        await navigate(`document.getElementById('autonomy-profile-select').value='main';document.getElementById('autonomy-profile-select').dispatchEvent(new Event('change'));`);
        assert.equal(await js('Number(document.getElementById("battery-capacity").value)'),60+index*10);
        await navigate(`document.getElementById('autonomy-profile-select').value=${JSON.stringify(ids[group])};document.getElementById('autonomy-profile-select').dispatchEvent(new Event('change'));`);
        assert.equal(await js('Number(document.getElementById("battery-capacity").value)'),90+index*10);
    }
    fs.mkdirSync(path.join(root,'tmp/autonomy-profiles'),{recursive:true});
    fs.writeFileSync(path.join(root,'tmp/autonomy-profiles/battery.png'),(await win.webContents.capturePage()).toPNG());
    // Simulate closing/reopening a saved project's session snapshot.
    const snapshot=await js(`Object.fromEntries(Object.keys(sessionStorage).map(key=>[key,sessionStorage.getItem(key)]))`);
    await go('/battery_menu');await js(`sessionStorage.clear();for(const [key,value] of Object.entries(${JSON.stringify(snapshot)}))sessionStorage.setItem(key,value);`);
    await go('/export_synthesis_pdf');
    const limit=Date.now()+45000;
    while(!await js('loadedReports===expectedReports&&loadedReports===6')){
        if(Date.now()>limit)throw Error(await js('JSON.stringify({loadedReports,expectedReports,status:status.textContent})'));
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    await js(`document.getElementById('back-to-selection').click();
        document.querySelectorAll('[name="customer-profile"]').forEach(input=>input.checked=input.value==='Customer');
        document.querySelectorAll('[name$="-scenario"]').forEach(input=>input.checked=input.value==='baseLab');form.requestSubmit();`);
    while(!await js('loadedReports===expectedReports&&loadedReports===6'))await new Promise(resolve=>setTimeout(resolve,100));
    const payload=await js('collectSynthesisPayload()');
    assert.equal(payload.reports.length,6);
    for(const [index,group] of ['dm1','dm2','customer'].entries()){
        const reports=payload.reports.filter(report=>report.module===group);assert.equal(reports.length,2);
        const custom=reports.find(report=>report.data.configuration.id===ids[group]);
        const main=reports.find(report=>report.data.configuration.id==='main');
        assert.ok(custom);assert.ok(main);
        if(group==='customer'){
            assert.equal(custom.data.profiles[0].columns[0].rows['8'],110);
            assert.equal(main.data.profiles[0].columns[0].rows['8'],80);
            assert.equal(custom.data.profiles[0].columns[0].rows['96'],0);
        }else{
            assert.equal(custom.data.profiles[0].columns[0].capacity,90+index*10);
            assert.equal(main.data.profiles[0].columns[0].capacity,60+index*10);
        }
        assert.ok(custom.data.matrixRows[0].currentUa>=100);
        assert.equal(main.data.matrixRows[0].currentUa,index+1);
    }
    fs.writeFileSync(path.join(root,'tmp/autonomy-profiles/payload.json'),JSON.stringify(payload));
    // Removal affects only the selected group's profile and synthesis selection.
    await go('/battery_configuration?mode=DM1');await js('window.confirm=()=>true;void 0');
    await navigate(`document.getElementById('remove-autonomy-profile').click()`);
    assert.equal(await js('AutonomyProfiles.list().length'),1);
    assert.equal(await js('AutonomyProfiles.list("dm2").length'),2);
    assert.equal(await js('AutonomyProfiles.list("customer").length'),2);
    await go('/export_synthesis_pdf');
    const end=Date.now()+30000;
    while(!await js('loadedReports===expectedReports&&loadedReports===5')){
        if(Date.now()>end)throw Error(await js('status.textContent'));
        await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.deepEqual(errors,[]);
    console.log('Complete autonomy profiles: actual battery/current/wake/consumption forms, mode isolation, save/reopen, six independent synthesis reports and deletion verified.');
    clearTimeout(timeout);win.destroy();server.close();app.quit();
}).catch(error=>{console.error(error);clearTimeout(timeout);win?.destroy();server?.close();app.exit(1);});
