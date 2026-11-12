const assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),crypto=require('node:crypto');
const source=fs.readFileSync('static/autonomy_profiles.js','utf8');
function page(values,pathname='/battery_configuration',search=''){
    const context=vm.createContext({values,URLSearchParams,URL,crypto,
        location:{pathname,search,href:'http://localhost'+pathname+search},
        document:{addEventListener(){}},CustomEvent:class{constructor(type,options){this.type=type;this.detail=options.detail;}},dispatchEvent(){}});
    vm.runInContext(`class Storage {
        getItem(key){return values[key]??null;}setItem(key,value){values[key]=String(value);}
        removeItem(key){delete values[key];}clear(){for(const key of Object.keys(values))delete values[key];}
        get length(){return Object.keys(values).length;}key(index){return Object.keys(values)[index]??null;}
    };this.Storage=Storage;this.sessionStorage=new Storage();this.window=this;`,context);
    vm.runInContext(source,context);
    return {model:context.AutonomyProfiles,storage:context.sessionStorage};
}
const values={batteryConfiguration:JSON.stringify({capacityAh:80,startingSoc:95,minimumSoc:60}),
    batterySubMode:'DM1',fixedConsumptionDM1:JSON.stringify({baseLab:{entries:{pcuRam:{current:3}}}}),
    selectedEcuKeys:JSON.stringify(['0_AIBS']),autonomyCurrentContributionsDM:JSON.stringify({'0_AIBS':{technicalWakeupA:.000001}})};
let dm1=page(values);
assert.equal(dm1.model.group,'dm1');
dm1.storage.setItem('batteryConfiguration',JSON.stringify({capacityAh:100,startingSoc:92,minimumSoc:70}));
dm1.storage.setItem('customSleepFunctions_DM1',JSON.stringify([{current:2}]));
dm1.storage.setItem('selectedEcuKeys','[]');
const second=dm1.model.create('DM1 essai');
assert.equal(JSON.parse(dm1.storage.getItem('batteryConfiguration')).capacityAh,60);
assert.equal(dm1.storage.getItem('customSleepFunctions_DM1'),null);
assert.equal(dm1.storage.getItem('selectedEcuKeys'),null);
dm1.storage.setItem('batteryConfiguration',JSON.stringify({capacityAh:75,startingSoc:88,minimumSoc:65}));
dm1.storage.setItem('dm1ModeMatrix',JSON.stringify({'0_1,0 jours':0}));
dm1.model.rename('DM1 complet');
assert.equal(dm1.model.selected.name,'DM1 complet');
dm1=page(JSON.parse(JSON.stringify(values)),'/edit_dm_mode');
assert.equal(dm1.model.selected.id,second.id);
assert.equal(JSON.parse(dm1.storage.getItem('batteryConfiguration')).capacityAh,75);
assert.equal(JSON.parse(dm1.storage.getItem('dm1ModeMatrix'))['0_1,0 jours'],0);
dm1.model.activate('main');
assert.equal(JSON.parse(dm1.storage.getItem('batteryConfiguration')).capacityAh,100);
assert.equal(JSON.parse(dm1.storage.getItem('customSleepFunctions_DM1'))[0].current,2);
assert.deepEqual(JSON.parse(dm1.storage.getItem('selectedEcuKeys')),[]);
const dm2=page(values,'/battery_configuration','?mode=DM2');
assert.equal(JSON.parse(dm2.storage.getItem('batteryConfiguration')).capacityAh,80);
assert.equal(dm2.storage.getItem('customSleepFunctions_DM1'),null);
assert.deepEqual(JSON.parse(dm2.storage.getItem('selectedEcuKeys')),['0_AIBS']);
const customer=page(values,'/configure_customer_currents');
assert.equal(customer.model.group,'customer');
assert.equal(JSON.parse(customer.storage.getItem('batteryConfiguration')).capacityAh,80);
customer.storage.setItem('autonomyCurrentContributionsCustomer','{"edited":true}');
assert.equal(dm2.storage.getItem('autonomyCurrentContributionsDM'),values.autonomyCurrentContributionsDM);
const rawMode=values.batterySubMode;
const report=page(values,'/dm_results',`?mode=DM1&summary=1&configuration=${second.id}`);
assert.equal(report.model.selected.id,second.id);
assert.equal(report.storage.getItem('batterySubMode'),'DM1');
report.storage.setItem('batterySubMode','DM1');
assert.equal(values.batterySubMode,rawMode);
assert.equal(JSON.parse(report.storage.getItem('batteryConfiguration')).capacityAh,75);
assert.equal(values.activeAutonomyProfile_dm1,second.id); // The earlier editor's active selection.
const migrated={batteryConfiguration:'{"capacityAh":60}',dmBatteryProfiles:'[{"id":"old","name":"Ancien 90 Ah","capacity":90}]'};
for(const mode of ['DM1','DM2']){
    const old=page(migrated,'/battery_configuration','?mode='+mode);
    assert.equal(old.model.list().length,2);
    old.model.activate('old');assert.equal(JSON.parse(old.storage.getItem('batteryConfiguration')).capacityAh,90);
}
const remove=page(values,'/battery_configuration','?mode=DM1');
assert.ok(remove.model.remove(second.id));
assert.equal(remove.model.list().length,1);
assert.equal(remove.model.remove('main'),false);
assert.equal(remove.model.selected.id,'main');
console.log('Full autonomy profiles: independent modes and fields, defaults, legacy capacity migration, saved snapshots, report isolation, rename and removal verified.');
