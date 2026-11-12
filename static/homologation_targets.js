/* Destination choices always identify the two active configurations. */
(() => {
    const profiles=window.HomologationProfiles;
    function choose(title,available=['dcdc','wltc']) {
        return new Promise(resolve=>{
            const dialog=document.createElement('dialog');dialog.className='homologation-target-dialog';
            const heading=document.createElement('h2');heading.textContent=title;dialog.append(heading);
            const text=document.createElement('p');text.textContent='Choisissez les modes concernés dans leurs profils actifs.';dialog.append(text);
            available.forEach(group=>{
                const label=document.createElement('label'),input=document.createElement('input');
                input.type='checkbox';input.value=group;input.checked=group===profiles.mode;
                label.append(input,document.createTextNode(` ${group.toUpperCase()} — ${profiles.active(group).name}`));dialog.append(label);
            });
            const actions=document.createElement('div');actions.className='actions';
            const cancel=document.createElement('button');cancel.type='button';cancel.className='secondary';cancel.textContent='Annuler';
            const apply=document.createElement('button');apply.type='button';apply.textContent='Appliquer';
            actions.append(cancel,apply);dialog.append(actions);
            const finish=value=>{dialog.close();dialog.remove();resolve(value);};
            cancel.onclick=()=>finish([]);dialog.oncancel=event=>{event.preventDefault();finish([]);};
            apply.onclick=()=>{const selected=[...dialog.querySelectorAll('input:checked')].map(input=>input.value);if(selected.length)finish(selected);};
            document.body.append(dialog);dialog.showModal();
        });
    }
    function hasDevice(group,device) {
        const deleted=profiles.readValue(group,'deletedHomologationDeviceKeys',[]);
        if(deleted.includes(device.key))return false;
        if(device.custom)return profiles.readValue(group,'customHomologationDevices',[]).some(item=>`custom_${item.id}`===device.key);
        const selection=profiles.readValue(group,'selectedDeviceKeys',null);
        return selection===null?device.category!=='S':selection.includes(device.key);
    }
    function mutateDevice(groups,device,adding) {
        groups.forEach(group=>profiles.update(group,values=>{
            const read=(key,fallback)=>{try{return JSON.parse(values[key])??fallback}catch{return fallback}};
            let deleted=read('deletedHomologationDeviceKeys',[]),custom=read('customHomologationDevices',[]);
            if(adding) {
                deleted=deleted.filter(key=>key!==device.key);
                if(device.custom&&!custom.some(item=>item.id===device.id))custom.push({...device});
            } else {
                if(!deleted.includes(device.key))deleted.push(device.key);
                custom=custom.filter(item=>`custom_${item.id}`!==device.key);
                ['modifiedCurrents','modifiedLowers','modifiedUppers'].forEach(key=>{const data=read(key,{});delete data[device.key];values[key]=JSON.stringify(data);});
                ['profileMatrix','alternatorMatrix'].forEach(key=>{const data=read(key,{});Object.keys(data).filter(key=>key.startsWith(`${device.rowIndex}_`)).forEach(key=>delete data[key]);values[key]=JSON.stringify(data);});
            }
            values.deletedHomologationDeviceKeys=JSON.stringify(deleted);values.customHomologationDevices=JSON.stringify(custom);
            delete values.homologationDevices;
        }));
    }
    window.HomologationTargets={choose,hasDevice,mutateDevice};
})();
