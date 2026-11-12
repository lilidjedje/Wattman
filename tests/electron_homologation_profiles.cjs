const {app,BrowserWindow}=require('electron');
const fs=require('fs'),http=require('http'),path=require('path'),os=require('os'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..');app.disableHardwareAcceleration();app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'wattman-profiles-')));
let server;
app.whenReady().then(async()=>{
 server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname.startsWith('/static/')){const file=path.join(root,url.pathname);if(!fs.existsSync(file))return res.writeHead(404).end();res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':'text/css');return res.end(fs.readFileSync(file));}
  const file=path.join(root,'templates',url.pathname.slice(1)+'.html');if(!fs.existsSync(file))return res.writeHead(404).end();
  res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(file,'utf8').replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g,'/static/$1'));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
 const win=new BrowserWindow({show:false,width:1400,height:1000,webPreferences:{backgroundThrottling:false}}),js=s=>win.webContents.executeJavaScript(s);
 const errors=[];win.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)});
 await win.loadURL(base+'/export_synthesis_pdf');
 await js(`sessionStorage.setItem('excelData',JSON.stringify({'Device List':{data:[{'Device Name':'DRL',current_category:'H','Current (A)':'200 mA',Lower:1,Upper:0}]}}));`);
 await win.loadURL(base+'/edit_current');
 assert.equal(await js("Number(document.querySelector('#table-body .homologation-input').value)"),.2);
 await js(`(()=>{const input=document.querySelector('#table-body .homologation-input');input.value='7.5';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 const navigate=async code=>{const loaded=new Promise(r=>win.webContents.once('did-finish-load',r));await js(code);await loaded;};
 await navigate("document.getElementById('add-homologation-profile').click()");
 assert.equal(await js("Number(document.querySelector('#table-body .homologation-input').value)"),.2);
 assert.equal(await js("document.querySelector('#table-body .bound-select').value"),'1');
 assert.equal(await js("JSON.parse(sessionStorage.getItem('homologationConfiguration')||'{}').dcdcOutputCurrentA"),undefined);
 await js("document.getElementById('homologation-profile-name').value='DCDC neuf';document.getElementById('homologation-profile-name').dispatchEvent(new Event('input'))");
 await win.loadURL(base+'/edit_alternator');
 assert.equal(await js("Number(document.querySelector('#table-body .homologation-input').value)"),.2);
 await navigate("document.getElementById('add-homologation-profile').click()");
 await js(`(()=>{const input=document.querySelector('#table-body .homologation-input');input.value='9';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await new Promise(r=>setTimeout(r,300));
 assert.ok(await js("document.querySelector('.homologation-profile-bar').getBoundingClientRect().height>50"));
 fs.mkdirSync(path.join(root,'tmp/profiles'),{recursive:true});fs.writeFileSync(path.join(root,'tmp/profiles/wltc.png'),(await win.webContents.capturePage()).toPNG());
 await win.loadURL(base+'/export_synthesis_pdf');
 await js(`document.querySelectorAll('#selection input[type=checkbox]').forEach(input=>input.checked=input.name==='module'?['dcdc','wltc'].includes(input.value):['dcdc-configuration','wltc-configuration'].includes(input.name));form.requestSubmit();`);
 const deadline=Date.now()+30000;while(await js('loadedReports!==expectedReports')){if(Date.now()>deadline)throw Error(await js('status.textContent'));await new Promise(r=>setTimeout(r,100));}
 const payload=await js('JSON.parse(JSON.stringify(collectSynthesisPayload()))');
 assert.equal(payload.reports.length,4);
 assert.deepEqual(payload.reports.map(r=>r.data.devices[0].current),[7.5,.2,.2,9]);
 assert.equal(payload.reports[1].data.configuration.name,'DCDC neuf');
 fs.writeFileSync(path.join(root,'tmp/profiles/report.json'),JSON.stringify(payload));
 await win.loadURL(base+'/edit_current');
 await js("window.confirm=()=>true;void 0");await navigate("document.getElementById('remove-homologation-profile').click()");
 assert.equal(await js("document.querySelectorAll('#homologation-profile-select option').length"),1);
 assert.equal(await js("Number(document.querySelector('#table-body .homologation-input').value)"),7.5);
 assert.deepEqual(errors,[]);
 console.log('DCDC/WLTC: independent profiles, source-unit conversion, initial values, automatic saving, rename, removal and four synthesis reports verified.');
 win.destroy();server.close();app.quit();
}).catch(e=>{console.error(e);server?.close();app.exit(1)});
