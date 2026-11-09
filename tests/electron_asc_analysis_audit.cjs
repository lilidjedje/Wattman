// Exercise the actual desktop pages against the supplied CANalyzer logs.
const {app} = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const output = path.resolve('outputs/asc-analysis-audit');
fs.mkdirSync(output, {recursive:true});
const profile = fs.mkdtempSync(path.join(os.tmpdir(),'wattman-asc-audit-'));
app.setPath('userData',profile);
process.env.ENGINEERING_APP_DATA=path.join(profile,'data');
const theoryPath=path.join(process.env.APPDATA,'engineering-calculator-desktop/application-data/can_data/theory_snapshot.json');
const theory=JSON.parse(fs.readFileSync(theoryPath,'utf8'));
fs.mkdirSync(path.join(profile,'data/can_data'),{recursive:true});
fs.writeFileSync(path.join(profile,'data/can_data/theory_snapshot.json'),JSON.stringify(theory));
let started=false;
app.on('browser-window-created',(_,win)=>win.webContents.on('did-finish-load',()=>{
 if(!started && win.webContents.getURL()==='app://local/'){
  started=true;
  setTimeout(()=>run(win).then(()=>{console.log('ASC_ANALYSIS_AUDIT_OK');app.exit(0);}).catch(e=>{console.error(e.stack);app.exit(1);}),150);
 }
}));
require('../desktop/main.js');
async function run(win){
 const js=code=>win.webContents.executeJavaScript(code);
 const errors=[];win.webContents.on('console-message',(_,level,message)=>{if(level===3)errors.push(message);});
 const until=async expr=>{const end=Date.now()+90000;while(Date.now()<end){if(await js(expr))return;await new Promise(r=>setTimeout(r,200));}throw Error('Timeout '+expr+' '+await js('document.body.innerText.slice(0,1500)'));};
 const shot=async name=>{
  await new Promise(r=>setTimeout(r,250));
  win.webContents.debugger.attach('1.3');
  try {
   const image=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png',fromSurface:true});
   fs.writeFileSync(path.join(output,name+'.png'),Buffer.from(image.data,'base64'));
  } finally {win.webContents.debugger.detach();}
 };
 const files=fs.readdirSync('test_asc').filter(f=>f.endsWith('.asc')).sort().map(f=>path.resolve('test_asc',f));
 await win.loadURL('app://local/analyse_logs/dashboard/import');
 await until("document.getElementById('logSearchStatus').textContent.includes('Importez')");
 win.webContents.debugger.attach('1.3');
 const dom=await win.webContents.debugger.sendCommand('DOM.getDocument');
 const input=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#ascFiles'});
 await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:input.nodeId,files});
 win.webContents.debugger.detach();
 await js("document.getElementById('uploadForm').requestSubmit()");
 await until("!document.getElementById('decodeResult').hidden && !document.getElementById('decodeButton').disabled");
 assert.equal(await js("document.getElementById('decodedCount').textContent.replace(/\\D/g,'')"),'92354');
 assert.equal(await js("document.querySelectorAll('#fileResultsA tr').length"),4);
 await js("document.getElementById('decodeResult').scrollIntoView()");await shot('import-real-files');
 const sessionId=await js("fetch('/analyse_logs/api/measurement_sessions').then(r=>r.json()).then(d=>d.sessions[0].id)");
 await until("document.getElementById('logSource').options.length===4");
 // Beyond the A endpoint of L214, only B has real samples.
 const lastA=new Date(2026,10,2,11,6,40,141).getTime()/1000+437.576582;
 await js(`document.querySelector('#logFilterForm [name=source]').value=[...document.getElementById('logSource').options].find(o=>o.textContent.includes('L214')).value;document.querySelector('#logFilterForm [name=start]').value='2026-11-02T11:13:58';document.getElementById('logFilterForm').requestSubmit()`);
 await until("!document.getElementById('logSearch').disabled && document.getElementById('logPeriodB').textContent.includes('mesures')");
 assert.match(await js("document.getElementById('logRowsA').innerText"),/Aucune mesure/);
 assert.doesNotMatch(await js("document.getElementById('logRowsB').innerText"),/Aucune mesure/);
 await js("document.getElementById('logExplorer').scrollIntoView()");await shot('after-channel-a-stops');
 const results=[];
 for(const mode of ['dcdc','wltc','dm1','dm2','customer','biberonnage']){
  await win.loadURL(`app://local/analyse_logs/dashboard/setup?session_id=${sessionId}`);
  await js(`document.querySelector('[data-mode=${mode}]').click();document.querySelectorAll('#deviceList input').forEach((e,i)=>e.checked=i===0);document.querySelector('[name=dashboardChannelMode][value=AB]').checked=true`);
  if(['dcdc','wltc'].includes(mode))await js("document.getElementById('startMinute').value='0';document.getElementById('endMinute').value=''");
  if(['dm1','dm2','customer'].includes(mode))await js("document.getElementById('endDay').value='1'");
  await js("document.getElementById('setupForm').requestSubmit()");
  await until("location.pathname==='/analyse_logs/dashboard' && !document.getElementById('dashboardContent').hidden && document.getElementById('measurementProvenance').innerText.includes('61')");
  assert.match(await js("document.getElementById('measurementProvenance').innerText"),/02\/11\/2026/);
  const report=await js(`fetch('/analyse_logs/api/dashboard_report?session_id=${sessionId}').then(r=>r.json())`);
  const summary={mode,channels:report.measurement.channels,charts:[]};
  for(const [channel,count] of [['A',31215],['B',61139]]){
   const metric=report.measurement.channels.find(c=>c.channel===channel);
   assert.equal(metric.samples,count);
   assert.equal(report.measurement.series.find(s=>s.channel===channel).raw_samples,count);
   assert.ok(Math.abs(metric.actual_duration_s-(channel==='A'?312.108452:612.093945))<.001);
   if(['dcdc','wltc'].includes(mode)){
    const state=await js(`(()=>{const chart=Chart.getChart(document.getElementById('currentChart${channel}'));const points=chart.data.datasets[0].data.filter(p=>p.y!==null);return {last:points.at(-1).x,max:chart.scales.x.max,subtitle:chart.options.plugins.subtitle.text,gaps:chart.data.datasets[0].data.filter(p=>p.y===null).length};})()`);
    assert.ok(state.last>(channel==='A'?1500:1800),JSON.stringify(state));assert.ok(state.max>=state.last);assert.ok(state.gaps>0);
    const tooltip=await js(`Chart.getChart(document.getElementById('currentChart${channel}')).options.plugins.tooltip.callbacks.title([{parsed:{x:0}}])`);assert.match(tooltip,/02\/11\/2026/);
    summary.charts.push({channel,...state});
    await js(`document.getElementById('chartPanel${channel}').scrollIntoView()`);await shot(`${mode}-channel-${channel}`);
   }
  }
  if(['dm1','dm2','customer','biberonnage'].includes(mode)){
   assert.equal(await js("document.getElementById('analysisDurationWarning').hidden"),false);
   if(mode!=='biberonnage')assert.match(await js("document.getElementById('autonomyScope').innerText"),/02\/11\/2026/);
   await js(`document.getElementById('${mode==='biberonnage'?'feedingSummaryPanel':'autonomyPanel'}').scrollIntoView()`);await shot(`${mode}-summary`);
  }
  await js("document.getElementById('measurementProvenance').scrollIntoView()");await shot(`${mode}-provenance`);
  results.push(summary);console.log('CHECKED',mode);
 }
 // Reimport only the actual 5/10-minute test: no prior logs or pauses.
 await win.loadURL('app://local/analyse_logs/dashboard/import');
 win.webContents.debugger.attach('1.3');
 const singleDom=await win.webContents.debugger.sendCommand('DOM.getDocument');
 const singleInput=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:singleDom.root.nodeId,selector:'#ascFiles'});
 await win.webContents.debugger.sendCommand('DOM.setFileInputFiles',{nodeId:singleInput.nodeId,files:[files[3]]});
 win.webContents.debugger.detach();
 await js("document.getElementById('uploadForm').requestSubmit()");
 await until("!document.getElementById('decodeResult').hidden && !document.getElementById('decodeButton').disabled");
 const singleId=await js("fetch('/analyse_logs/api/measurement_sessions').then(r=>r.json()).then(d=>d.sessions[0].id)");
 for(const mode of ['dcdc','wltc']){
  await win.loadURL(`app://local/analyse_logs/dashboard/setup?session_id=${singleId}`);
  await js(`document.querySelector('[data-mode=${mode}]').click();document.querySelectorAll('#deviceList input').forEach((e,i)=>e.checked=i===0);document.getElementById('startMinute').value='0';document.getElementById('endMinute').value='';document.getElementById('setupForm').requestSubmit()`);
  await until("location.pathname==='/analyse_logs/dashboard' && !document.getElementById('dashboardContent').hidden && !!Chart.getChart(document.getElementById('currentChartB'))");
  const ending=await js("['A','B'].map(ch=>{const c=Chart.getChart(document.getElementById('currentChart'+ch));return c.data.datasets[0].data.filter(p=>p.y!==null).at(-1).x})");
  assert.ok(Math.abs(ending[0]-300)<.1);assert.ok(Math.abs(ending[1]-600)<.1);
  await js("document.getElementById('chartPanelA').scrollIntoView()");await shot(`${mode}-single-file-5min-A`);
  await js("document.getElementById('chartPanelB').scrollIntoView()");await shot(`${mode}-single-file-10min-B`);
  results.push({mode,singleFile:true,endings_s:ending});
 }
 assert.deepEqual(errors,[]);
 fs.writeFileSync(path.join(output,'desktop-results.json'),JSON.stringify({results,errors,profile},null,2));
}
