const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context=vm.createContext({window:{}});
vm.runInContext(fs.readFileSync('static/sleep_current.js','utf8'),context);
const api=context.window.SleepCurrent;
function storage(initial={}) {
    const values=new Map(Object.entries(initial).map(([key,value])=>[key,typeof value==='string'?value:JSON.stringify(value)]));
    return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),removeItem:key=>values.delete(key)};
}
const technical=[['AIBS',.1,.1],['PIU Master',.35,.44],['PIU Sub Cabin',.3,.31],['PIU Hood',.3,.31],
    ['DCDC',.97,.97],['BMS MAIN MONITORING TRACTION BATTERY HIGH VOLTAGE',.21,.21],
    ['PCU PHYSICAL COMPUTING UNIT',1.8,1.8],['HEVC',.23,.23]];
for(const [name,dm,customer] of technical) {
    assert.equal(api.defaultContributions(name,'DM1').technicalWakeupA,dm/1000000,name);
    assert.equal(api.defaultContributions(name,'DM2').technicalWakeupA,dm/1000000,name);
    assert.equal(api.defaultContributions(name,'Customer Mode').technicalWakeupA,customer/1000000,name);
}
const smartDM=['DCDC','BMS MAIN MONITORING TRACTION BATTERY HIGH VOLTAGE','PCU PHYSICAL COMPUTING UNIT',
    'STOP LIGHT SWITCH (Normally closed for Stop Lamp)','IVC TELEMATIC ECU','BLUETOOTH LOW ENERGY MODULE',
    'HANDS-FREE ACCESS ECU','COCKPIT DOMAIN CONTROLLER - Power 1','MULTIFONCTIONNAL ELECTRIC CONTROL',
    'UNDER STEERING WHEEL CONTROLS','DASHBOARD EXTERNAL LIGHT CONTROL BUTTONS','DIAGNOSTIC SOCKET',
    'LEFT HAND FRONT SEAT MEMORY ECU','RIGHT HAND FRONT SEAT MEMORY ECU','RIGHT SLIDING DOOR','LEFT SLIDING DOOR',
    'ECDO TAILGATE ECU','HEVC / PDC','ALCOHOL INTERLOCK DEVICE ECU','VOLUMETRIC ALARM ECU','CHRONOTACHYGRAPHE','BMS LIB 12V'];
const smartCustomer=['PCU PHYSICAL COMPUTING UNIT','Smart Antenna','COCKPIT DOMAIN CONTROLLER - Power 1',
    'DIAGNOSTIC SOCKET','HANDS-FREE ACCESS ECU','STOP LIGHT SWITCH (Normally closed for Stop Lamp)',
    'ECDO TAILGATE ECU','ALCOHOL INTERLOCK DEVICE ECU','VOLUMETRIC ALARM ECU','CHRONOTACHYGRAPHE','BMS LIB 12V'];
for(const name of smartDM)assert.equal(api.defaultContributions(name,'DM1').smartmosUa,45,name);
for(const name of smartCustomer)assert.equal(api.defaultContributions(name,'Customer Mode').smartmosUa,45,name);
assert.equal(api.defaultContributions('DCDC','Customer Mode').smartmosUa,0);
assert.equal(api.defaultContributions('Smart Antenna','DM1').smartmosUa,0);
assert.equal(api.defaultContributions('AIBS extended','DM1').technicalWakeupA,0);
assert.equal(api.defaultContributions('HEVC / PDC','DM1').technicalWakeupA,0);
assert.equal(api.defaultContributions('HEVC','DM1').smartmosUa,0);
assert.equal(api.defaultContributions('BMS MAIN MONITORING TRACTION   BATTERY HIGH VOLTAGE','DM1').smartmosUa,45);
const saved=storage({
    excelData:{'Device List':{data:[{'Device Name':'AIBS','DM1 Current (mA)':10,'DM2 Current (mA)':20,'CM Current (mA)':.03},
        {'Device Name':'DCDC','DM1 Current (mA)':20,'DM2 Current (mA)':30,'CM Current (mA)':.04}]}},
    customDarkDevicesCurrentUnit:'uA',modifiedCustomerCurrentsUnit:'uA',
    dm1ModeMatrix:{'0_1,0 jours':1,'1_1,0 jours':.5},
    dm2ModeMatrix:{'0_1,0 jours':1,'1_1,0 jours':1}
});
assert.equal(api.calculate('DM1',saved).instantaneousUa,10.1+65.97*.5);
assert.equal(api.calculate('DM1',saved).dailyAh,(10.1+65.97*.5)*24/1000000);
assert.equal(api.calculate('Customer Mode',saved).instantaneousUa,30.1+40.97);
saved.setItem(api.contributionKey('DM1'),JSON.stringify({'0_AIBS':{technicalEnabled:false},'1_DCDC':{technicalEnabled:true,technicalWakeupA:'0,25',smartmosEnabled:false}}));
assert.equal(api.calculate('DM1',saved).instantaneousUa,10+250020*.5);
assert.equal(api.calculate('DM2',saved).instantaneousUa,20+250030);
assert.equal(api.calculate('Customer Mode',saved).instantaneousUa,30.1+40.97);
saved.setItem('modifiedDM1Currents',JSON.stringify({'0_AIBS':100}));
assert.equal(api.calculate('DM1',saved).instantaneousUa,100+250020*.5);
saved.setItem('selectedEcuKeys',JSON.stringify(['0_AIBS']));
assert.equal(api.calculate('DM1',saved).instantaneousUa,100);
saved.setItem('deletedDarkDeviceKeys',JSON.stringify(['0_AIBS']));
assert.equal(api.calculate('DM1',saved).instantaneousUa,0);
const duplicates=storage({excelData:{'ECU List':{data:Array.from({length:3},()=>({'ECU Name':'HANDS-FREE ACCESS ECU','CM Current (mA)':0}))}}});
assert.equal(api.calculate('Customer Mode',duplicates).instantaneousUa,135);
console.log('Autonomy contributions: all requested defaults, exact names, unit conversion, shared DM settings, isolated Customer settings, profiles and exclusions verified.');

const migrated=storage({autonomyCurrentContributionsDM:{'0_AIBS':{technicalEnabled:true,technicalWakeupA:.1},'1_DCDC':{technicalEnabled:true,technicalWakeupA:.25}}});
assert.equal(api.contributions('DM1','0_AIBS','AIBS',migrated).technicalWakeupA,.1/1000000);
assert.equal(api.contributions('DM1','1_DCDC','DCDC',migrated).technicalWakeupA,.25);
assert.equal(api.totalCurrentMicroamps('DM1','0_AIBS','AIBS',10,migrated),10.1);
assert.equal(api.contributions('DM2','0_AIBS','AIBS',migrated).technicalWakeupA,.1/1000000);
