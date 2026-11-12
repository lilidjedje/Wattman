const {app,BrowserWindow}=require('electron');
const fs=require('fs'),http=require('http'),path=require('path'),assert=require('node:assert/strict'),os=require('os');
const root=path.resolve(__dirname,'..');app.disableHardwareAcceleration();app.setPath('userData',fs.mkdtempSync(path.join(os.tmpdir(),'wattman-currents-')));
let server;app.whenReady().then(async()=>{
 server=http.createServer((req,res)=>{let url=new URL(req.url,'http://localhost');if(url.pathname.startsWith('/static/')){let p=path.join(root,url.pathname);if(!fs.existsSync(p))return res.writeHead(404).end();res.setHeader('Content-Type',p.endsWith('.js')?'text/javascript':'text/css');return res.end(fs.readFileSync(p));}let group=url.pathname.includes('customer')?'customer':'dm';let name=url.pathname.startsWith('/configure_')?'autonomy_current_setup':url.pathname.slice(1);let p=path.join(root,'templates',name+'.html');if(!fs.existsSync(p))return res.writeHead(404).end();res.setHeader('Content-Type','text/html; charset=utf-8');res.end(fs.readFileSync(p,'utf8').replace(/\{\{ current_group \}\}/g,group).replace(/\{\{ url_for\('static', filename='([^']+)'\) \}\}/g,'/static/$1'));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));let base=`http://127.0.0.1:${server.address().port}`;let win=new BrowserWindow({show:false,width:1280,height:900,webPreferences:{backgroundThrottling:false}});const js=s=>win.webContents.executeJavaScript(s);
 await win.loadURL(base+'/configure_dm_currents');await js(`sessionStorage.clear();sessionStorage.setItem('batterySubMode','DM1');sessionStorage.setItem('excelData',JSON.stringify({'Device List':{data:['AIBS','PIU Master','DCDC','Smart Antenna'].map(name=>({'Device Name':name,current_category:'S','DM1 Current (mA)':1,'DM2 Current (mA)':2,'CM Current (mA)':3}))}}));`);await win.reload();await new Promise(r=>setTimeout(r,350));
 assert.equal(await js(`SleepCurrent.devices('DM1')[1].technicalWakeupA`),.35/1000000);assert.equal(await js(`document.querySelectorAll('#current-contributions tr').length`),3);
 await js(`(()=>{const row=document.querySelector('[data-device-key="0_AIBS"]');row.querySelector('.setup-remove').click();})()`);assert.equal(await js(`SleepCurrent.devices('DM1')[0].technicalWakeupA`),0);
 await js(`document.getElementById('contribution-device').value='0_AIBS';document.getElementById('add-contribution-form').requestSubmit()`);assert.equal(await js(`SleepCurrent.devices('DM1')[0].technicalWakeupA`),.1/1000000);
 await js(`(()=>{const input=document.querySelector('[data-device-key="0_AIBS"] input[type=number]');input.value='0.2';input.dispatchEvent(new Event('input',{bubbles:true}));})()`);assert.equal(await js(`SleepCurrent.devices('DM1')[0].technicalWakeupA`),.2);assert.equal(await js(`SleepCurrent.devices('DM2')[0].technicalWakeupA`),.2);
 await js(`document.getElementById('continue-configuration').click()`);await new Promise(r=>setTimeout(r,600));assert.ok(win.webContents.getURL().endsWith('/edit_dm_mode'));assert.equal(await js(`document.querySelectorAll('[data-output="total-dark-current"]').length`),4);assert.ok(await js(`Array.from(document.querySelectorAll('.profile-select')).every(select=>select.value==='1')`));
 fs.mkdirSync(path.join(root,'tmp/current-tests'),{recursive:true});fs.writeFileSync(path.join(root,'tmp/current-tests/dm.png'),(await win.webContents.capturePage()).toPNG());
 await win.loadURL(base+'/configure_customer_currents');assert.equal(await js(`SleepCurrent.devices('Customer Mode')[1].technicalWakeupA`),.44/1000000);assert.equal(await js(`SleepCurrent.devices('Customer Mode')[3].smartmosUa`),45);assert.equal(await js(`document.querySelectorAll('#current-contributions tr').length`),4);
 await new Promise(r=>setTimeout(r,500));fs.writeFileSync(path.join(root,'tmp/current-tests/customer.png'),(await win.webContents.capturePage()).toPNG());await js(`document.getElementById('continue-configuration').click()`);await new Promise(r=>setTimeout(r,500));assert.ok(win.webContents.getURL().endsWith('/edit_customer_mode'));assert.equal(await js(`document.querySelectorAll('[data-output="total-dark-current"]').length`),4);assert.ok(await js(`Array.from(document.querySelectorAll('.profile-select')).every(select=>select.value==='1')`));
 for(const mode of ['DM1','DM2','Customer Mode']) {
  await js(`sessionStorage.setItem('batterySubMode',${JSON.stringify(mode)});sessionStorage.setItem(${JSON.stringify(mode==='Customer Mode'?'autonomyCurrentSetupCustomerReady':'autonomyCurrentSetupDMReady')},'true')`);
  const route=mode==='Customer Mode'?'/configure_customer_currents':'/configure_dm_currents';
  for(const page of [mode==='Customer Mode'?'edit_customer_mode':'edit_dm_mode','fixed_consumption','sleep_consumption']) {
   await win.loadURL(base+'/'+page);
   assert.equal(await js("document.querySelectorAll('.stepper .step').length"),4);
   assert.ok((await js("document.querySelector('.stepper .step').getAttribute('onclick')")).includes(route));
   assert.equal(await js("document.querySelectorAll('.current-contribution-link').length"),0);
   if(!page.startsWith('edit_')) {
    const colors=await js(`Array.from(document.querySelectorAll('th,td,input')).map(el=>({bg:getComputedStyle(el).backgroundColor,text:el.textContent.slice(0,30)}))`);
    for(const color of colors) {
     const rgb=color.bg.match(/\d+/g)?.map(Number);
     if(rgb&&rgb.length>=3)assert.ok(rgb.slice(0,3).every(v=>v>200),JSON.stringify(color));
    }
    fs.writeFileSync(path.join(root,'tmp/current-tests',page+'-'+mode.replace(/ /g,'')+'.png'),(await win.webContents.capturePage()).toPNG());
   }
   const returned=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
   await js("document.querySelector('.stepper .step').click()");await returned;
   assert.ok(win.webContents.getURL().endsWith(route));
   assert.equal(await js("document.querySelectorAll('.setup-navigation .step').length"),4);
   assert.equal(await js("document.querySelector('.setup-navigation [aria-current=step]').textContent"),'Load Technical Wakeup et SmartMOS');
   assert.ok(await js("document.querySelector('.setup-navigation').getBoundingClientRect().height>0"));
   const reloaded=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
   win.reload();await reloaded;
   assert.equal(await js("document.querySelectorAll('.setup-navigation .step').length"),4);
   const continued=new Promise(resolve=>win.webContents.once('did-finish-load',resolve));
   await js("document.querySelector('[data-setup-step=fixed]').click()");await continued;
   assert.ok(win.webContents.getURL().endsWith('/fixed_consumption'));
  }
 }
 console.log('Browser flow: DM and Customer setup, defaults, Continue navigation and total columns verified.');win.destroy();server.close();app.quit();
}).catch(e=>{console.error(e);server?.close();app.exit(1)});
