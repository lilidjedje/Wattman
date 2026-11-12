// Real pages and calculations, in a separate Electron profile without user data.
const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict');
const fs=require('node:fs'),http=require('node:http'),path=require('node:path'),os=require('node:os');
const root=path.resolve(__dirname,'..');
app.disableHardwareAcceleration();
app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'wattman-auxiliary-profiles-')));
let server,win;
const timeout=setTimeout(()=>{console.error('Auxiliary profiles test timed out');app.exit(1);},120000);
app.whenReady().then(async()=>{
    server=http.createServer((request,response)=>{
        const url=new URL(request.url,'http://localhost');
        const file=url.pathname.startsWith('/static/')?path.join(root,url.pathname):path.join(root,'templates',url.pathname.slice(1)+'.html');
        if(!fs.existsSync(file))return response.writeHead(404).end();
        response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript; charset=utf-8':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');
        response.end(fs.readFileSync(file,'utf8').replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g,'/static/$1'));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    win=new BrowserWindow({show:false,width:1500,height:1100,webPreferences:{backgroundThrottling:false}});
    const errors=[];win.webContents.on('console-message',event=>{if(event.level==='error')errors.push(event.message);});
    const js=source=>win.webContents.executeJavaScript(source);
    const go=route=>win.loadURL(base+route);
    async function readyReports(count){
        const limit=Date.now()+30000;
        while(!await js(`loadedReports===expectedReports && loadedReports===${count}`)){
            if(Date.now()>limit)throw Error(await js(`JSON.stringify({loadedReports,expectedReports,status:status.textContent})`));
            await new Promise(resolve=>setTimeout(resolve,100));
        }
    }
    const select=async(group,id)=>js(`(()=>{const input=document.getElementById('auxiliary-profile-${group}');input.value='${id}';input.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    const add=async(name,target)=>js(`document.getElementById('auxiliary-name').value=${JSON.stringify(name)};document.getElementById('auxiliary-target').value='${target}';document.getElementById('add-auxiliary').click();`);
    const stored=async(group,id,key)=>js(`JSON.parse(JSON.parse(sessionStorage.getItem('homologationProfiles_${group}')).find(p=>p.id==='${id}').values['${key}']||'[]')`);
    await go('/export_synthesis_pdf');
    await js(`sessionStorage.setItem('excelData',JSON.stringify({'Device List':{data:[{'Device Name':'DRL',current_category:'H','Current (A)':1,Lower:1,Upper:0}]}}));
        for(const mode of ['dcdc','wltc']){
            const entry=kind=>({id:kind+'-main',name:kind.toUpperCase()+' principal',current:mode==='dcdc'?1:2,lower:1,upper:0,devProfiles:{},altProfiles:{},wltcProfileVersion:2});
            sessionStorage.setItem('homologationProfiles_'+mode,JSON.stringify([
                {id:'main',name:'Profil principal',values:{paoData:JSON.stringify([entry('pao')]),gmvData:JSON.stringify([entry('gmv')])}},
                {id:mode+'-2',name:mode.toUpperCase()+' deuxième',values:{}}]));
            sessionStorage.setItem('activeHomologationProfile_'+mode,'main');
        }`);
    for(const kind of ['pao','gmv']){
        await go('/edit_'+kind);
        assert.equal(await js(`document.querySelectorAll('.auxiliary-profile-selectors select').length`),2);
        assert.equal(await js(`document.getElementById('homologation-profile-select')===null`),true);
        await select('dcdc','main');await select('wltc','main');
        assert.equal(await js(`document.getElementById('auxiliary-profile-dcdc').value`),'main');
        assert.equal(await js(`document.getElementById('auxiliary-profile-wltc').value`),'main');
        await select('dcdc','dcdc-2');await select('wltc','wltc-2');
        assert.equal(await js(`document.querySelectorAll('#table-body tr').length`),0);
        await add(kind.toUpperCase()+' personnalisé','both');
        await js(`for(const [group,value] of [['dcdc',5],['wltc',7]]){
            const input=document.querySelector('input[data-group="'+group+'"][data-field="current"]');
            input.value=value;input.dispatchEvent(new Event('input',{bubbles:true}));
        }
        const coefficient=document.querySelector('input[data-group="dcdc"][data-field="winter_0 - 5 min"]');
        coefficient.value=50;coefficient.dispatchEvent(new Event('input',{bubbles:true}));`);
        assert.equal((await stored('dcdc','main',kind+'Data'))[0].current,1);
        assert.equal((await stored('wltc','main',kind+'Data'))[0].current,2);
        assert.equal((await stored('dcdc','dcdc-2',kind+'Data'))[0].current,5);
        assert.equal((await stored('wltc','wltc-2',kind+'Data'))[0].current,7);
        await select('dcdc','main');
        assert.equal(await js(`Number(document.querySelector('input[data-group="dcdc"][data-field="current"]').value)`),1);
        await select('dcdc','dcdc-2');
        await add(kind.toUpperCase()+' DCDC seul','dcdc');
        assert.equal((await stored('dcdc','dcdc-2',kind+'Data')).length,2);
        assert.equal((await stored('wltc','wltc-2',kind+'Data')).length,1);
        const extraId=(await stored('dcdc','dcdc-2',kind+'Data'))[1].id;
        await js(`document.querySelector('tr[data-auxiliary-id="${extraId}"] button.danger').click();`);
        await js(`const dialog=document.querySelector('dialog[open]');dialog.querySelector('input[value="dcdc"]').checked=true;dialog.querySelector('.actions button:last-child').click();`);
        assert.equal((await stored('dcdc','dcdc-2',kind+'Data')).length,1);
        await go('/edit_'+kind);
        assert.equal(await js(`document.getElementById('auxiliary-profile-dcdc').value`),'dcdc-2');
        assert.equal(await js(`Number(document.querySelector('input[data-group="wltc"][data-field="current"]').value)`),7);
    }
    fs.mkdirSync(path.join(root,'tmp/auxiliary-profiles'),{recursive:true});
    fs.writeFileSync(path.join(root,'tmp/auxiliary-profiles/gmv.png'),(await win.webContents.capturePage()).toPNG());
    await go('/export_synthesis_pdf');await readyReports(4);
    let payload=await js('collectSynthesisPayload()');
    for(const report of payload.reports){
        const current=report.data.configuration.id==='main'?(report.module==='dcdc'?1:2):(report.module==='dcdc'?5:7);
        for(const kind of ['PAO','GMV'])assert.equal(report.data.devices.find(d=>d.name.startsWith(kind)).current,current);
    }
    // Keep deliberate exclusions; newly created profiles are included automatically.
    await js(`document.getElementById('back-to-selection').click();document.querySelector('input[name="dcdc-configuration"][value="main"]').checked=false;form.requestSubmit();`);
    await readyReports(3);
    await go('/edit_current');
    const loaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
    await js(`document.getElementById('add-homologation-profile').click()`);await loaded;
    await js(`document.getElementById('homologation-profile-name').value='DCDC troisième';document.getElementById('homologation-profile-name').dispatchEvent(new Event('input'));`);
    await go('/export_synthesis_pdf');await readyReports(4);
    payload=await js('collectSynthesisPayload()');
    assert.ok(payload.reports.some(r=>r.data.configuration.name==='DCDC troisième'));
    assert.ok(!payload.reports.some(r=>r.module==='dcdc'&&r.data.configuration.id==='main'));
    // A catalogue change in a same-session frame refreshes an already open synthesis.
    await js(`(()=>{const frame=document.querySelector('#report-content iframe');const storage=frame.contentWindow.sessionStorage;
        const items=JSON.parse(storage.getItem('homologationProfiles_wltc'));items.push({id:'wltc-live',name:'WLTC ajouté',values:{}});
        storage.setItem('homologationProfiles_wltc',JSON.stringify(items));})()`);
    await readyReports(5);
    assert.ok((await js('collectSynthesisPayload()')).reports.some(r=>r.data.configuration.id==='wltc-live'));
    assert.deepEqual(errors,[]);
    console.log('PAO/GMV: same-page DCDC/WLTC selectors, main/profile isolation, both-mode edits, deletion, persistence, automatic synthesis, preserved exclusions and live updates verified.');
    clearTimeout(timeout);win.destroy();server.close();app.quit();
}).catch(error=>{console.error(error);clearTimeout(timeout);win?.destroy();server?.close();app.exit(1);});
