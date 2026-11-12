const {app,BrowserWindow}=require('electron');
const assert=require('node:assert/strict'),fs=require('fs'),http=require('http'),path=require('path'),os=require('os');
const root=path.resolve(__dirname,'..');
app.disableHardwareAcceleration();app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'wattman-native-pdf-')));
let server;
app.whenReady().then(async()=>{
    server=http.createServer((request,response)=>{
        const url=new URL(request.url,'http://localhost');
        if(url.pathname==='/generate_synthesis_pdf' && request.method==='POST') {
            let body='';request.on('data',chunk=>body+=chunk);request.on('end',()=>{
                const file=path.join(root,'tmp/pdfs/native-button.json');fs.writeFileSync(file,body);
                const checked=require('node:child_process').spawnSync('python',[path.join(root,'tests/validate_native_pdf.py'),file],{cwd:root,encoding:'utf8',timeout:300000});
                if(checked.status!==0){response.writeHead(500,{'Content-Type':'application/json'});return response.end(JSON.stringify({error:checked.stdout+checked.stderr}));}
                response.writeHead(200,{'Content-Type':'application/pdf'});response.end(fs.readFileSync(file.replace(/\.json$/,'.pdf')));
            });return;
        }
        if(url.pathname.startsWith('/static/')){
            const file=path.join(root,url.pathname);if(!fs.existsSync(file))return response.writeHead(404).end();
            response.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/css');return response.end(fs.readFileSync(file));
        }
        const routes={'/export_synthesis_pdf':'export_synthesis_pdf','/synthesis':'synthesis','/dm_results':'dm_results','/battery_results_menu':'battery_results_menu','/biberonnage/resultats':'biberonnage_resultats'};
        const name=routes[url.pathname];if(!name)return response.writeHead(404).end();
        response.setHeader('Content-Type','text/html; charset=utf-8');
        response.end(fs.readFileSync(path.join(root,'templates',name+'.html'),'utf8').replace(/\{\{ duration_days(?: \| tojson)? \}\}/g,url.searchParams.get('days')||'30').replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g,'/static/$1'));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const base=`http://127.0.0.1:${server.address().port}`;
    const win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});
    const js=source=>win.webContents.executeJavaScript(source);
    await win.loadURL(base+'/export_synthesis_pdf');
    await js(`sessionStorage.setItem('excelData',JSON.stringify({'Device List':{data:[{'Device Name':'AIBS',current_category:'S','DM1 Current (mA)':50,'DM2 Current (mA)':70,'CM Current (mA)':.09}]}}));sessionStorage.setItem('homologationDevices',JSON.stringify([{key:'0_DRL',rowIndex:0,name:'DRL',current:.000045,lower:0,upper:1}]));sessionStorage.setItem('homologationConfiguration',JSON.stringify({dcdcOutputCurrentA:2.5}));`);
    fs.mkdirSync(path.join(root,'tmp/pdfs'),{recursive:true});
    for(const count of [0,2,1]){
        await js(`sessionStorage.setItem('dmBatteryProfiles',JSON.stringify(Array.from({length:${count}},(_,i)=>({id:'pdf-'+i,name:'Profil additionnel '+i+' avec un libelle long pour verifier la pagination',capacity:60+10*i}))));`);
        await win.loadURL(base+'/export_synthesis_pdf');
        await js(`document.querySelectorAll('#selection input[type=checkbox]').forEach(input=>{input.checked=${count===0} ? (input.name.startsWith('bib-profile') ? input.value==='base' : input.name==='customer-scenario' ? ['baseLab','alarmTachy'].includes(input.value) : true) : (input.name==='module' ? input.value==='dm1' : input.name.startsWith('dm1-'));});form.requestSubmit();`);
        const deadline=Date.now()+45000;
        while(await js('loadedReports!==expectedReports')){if(Date.now()>deadline)throw new Error(await js('status.textContent'));await new Promise(resolve=>setTimeout(resolve,100));}
        const payload=await js('JSON.parse(JSON.stringify(collectSynthesisPayload()))');
        payload.project={name:'Validation du rapport natif',date:'10/11/2026',pilotWattman:'Equipe ingenierie'};
        const file=path.join(root,`tmp/pdfs/native-${count}.json`);fs.writeFileSync(file,JSON.stringify(payload));
        const result=require('node:child_process').spawnSync('python',[path.join(root,'tests/validate_native_pdf.py'),file],{cwd:root,encoding:'utf8',timeout:300000});
        assert.equal(result.status,0,result.stdout+'\n'+result.stderr);console.log(result.stdout.trim());
        if(count===0)assert.ok(Math.abs(payload.reports.find(report=>report.module==='dm1').data.matrixRows[0].technicalWakeupA-1e-7)<1e-18);
        if(count===0){
            await js(`window.desktopEnvironment={generateSynthesisPdf:async(name,bytes)=>{window.nativeSaved={name,length:bytes.byteLength,signature:new TextDecoder().decode(bytes.slice(0,5))};return {canceled:false,filePath:'native-test.pdf'}}};window.prepareReportsForPrint=()=>{throw new Error('The screen capture path must not run')};document.getElementById('generate-pdf').click();`);
            const savedDeadline=Date.now()+60000;
            while(await js('!window.nativeSaved')){
                if(Date.now()>savedDeadline)throw new Error(await js('status.textContent'));
                await new Promise(resolve=>setTimeout(resolve,100));
            }
            assert.equal(await js('nativeSaved.signature'),'%PDF-');
            assert.ok(await js('nativeSaved.length>10000'));
            assert.equal(await js("document.querySelectorAll('.print-report-copy').length"),0);
            console.log('Generate PDF button: native API bytes reach desktop saving without screen capture.');
        }
    }
    win.destroy();server.close();app.quit();
}).catch(error=>{console.error(error.stack);server?.close();app.exit(1)});
