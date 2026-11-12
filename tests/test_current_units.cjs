const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const context=vm.createContext({window:{}});
vm.runInContext(fs.readFileSync('static/current_units.js','utf8'),context);
const units=context.window.CurrentUnits;
const clean=value=>value.replace(/[\u00a0\u202f]/g,' ');
for(const [value,source,expected] of [
    [0,'A','0,00 µA'],[.000045,'A','45,00 µA'],[999,'µA','999,00 µA'],
    [1000,'µA','1 mA'],[.001,'A','1 mA'],[.72,'mA','720,00 µA'],
    [999,'mA','999 mA'],[1000,'mA','1 A'],[1,'A','1 A'],[1.23456,'A','1,23 A'],
    [-.000045,'A','-45,00 µA'],['1 234,56','mA','1,23 A'],['45','uA','45,00 µA'],
    [null,'A','—'],['','A','—']
]) assert.equal(clean(units.format(value,source)),expected,`${value} ${source}`);
for(const source of ['A','mA','µA']) {
    for(const value of [0,.000001,.001,.1,1,123,999,1000,1234567]) {
        const result=units.parts(value,source);
        const factor={A:1,mA:.001,'µA':.000001}[source];
        assert.ok(Math.abs(result.amps-value*factor)<1e-12);
    }
}
assert.equal(units.isUnit('Ah'),false);
assert.equal(units.isUnit('mAh'),false);
assert.equal(units.isUnit('µA'),true);
console.log('Current presentation: thresholds, zero, negative values, French decimals and two-digit formatting verified.');
