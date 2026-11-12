/* Complete, independently saved autonomy configurations, including legacy imports. */
(() => {
    const groups=['dm1','dm2','customer'];
    const labels={dm1:'DM1',dm2:'DM2',customer:'Customer Mode'};
    const query=new URLSearchParams(location.search);
    const nativeRead=Storage.prototype.getItem,nativeWrite=Storage.prototype.setItem,nativeRemove=Storage.prototype.removeItem;
    const raw=key=>nativeRead.call(sessionStorage,key);
    const parse=(text,fallback=null)=>{try{return JSON.parse(text)??fallback;}catch{return fallback;}};
    const normalize=value=>groups.find(group=>labels[group]===value||group===String(value).toLowerCase());
    const route=location.pathname;
    const pages=['/battery_configuration','/configure_dm_currents','/configure_customer_currents',
        '/edit_dm_mode','/edit_customer_mode','/fixed_consumption','/sleep_consumption','/dm_results','/battery_results_menu'];
    const scoped=pages.includes(route);
    const group=route.includes('customer')?'customer':normalize(query.get('mode'))
        ||(route==='/configure_dm_currents'||route==='/edit_dm_mode'||route==='/dm_results'
            ? (raw('batterySubMode')==='DM2'?'dm2':'dm1') :normalize(raw('batterySubMode'))||'customer');
    const report=query.get('summary')==='1'||query.get('export')==='1';
    function keysFor(id){
        const mode=labels[id];
        return new Set(['batteryConfiguration','selectedEcuKeys','customDarkDevices','customDarkDevicesCurrentUnit',
            'deletedDarkDeviceKeys','fixedConsumption','sleepConsumption',
            `modified${id==='customer'?'Customer':mode}Currents`,
            ...(id==='customer'?['modifiedCustomerCurrentsUnit']:[]),
            `${id==='customer'?'customer':id}ModeMatrix`,
            `vehicleSleep_${mode}`,`wakeParams_${mode}`,`fixedConsumption${mode}`,`sleepConsumption${mode}`,
            `deletedFixedFunctionIds_${mode}`,`deletedSleepFunctionIds_${mode}`,`customSleepFunctions_${mode}`,
            id==='customer'?'autonomyCurrentContributionsCustomer':'autonomyCurrentContributionsDM',
            id==='customer'?'autonomyCurrentSetupCustomerReady':'autonomyCurrentSetupDMReady']);
    }
    function list(id=group){
        if(!groups.includes(id))return [];
        const key=`autonomyProfiles_${id}`,saved=parse(raw(key));
        if(Array.isArray(saved)&&saved.length)return saved;
        const values=Object.fromEntries([...keysFor(id)].map(key=>[key,raw(key)]).filter(([,value])=>value!==null));
        const profiles=[{id:'main',name:'Profil principal',values}];
        if(id!=='customer'){
            for(const old of parse(raw('dmBatteryProfiles'),[])){
                if(!old.id||profiles.some(profile=>profile.id===String(old.id)))continue;
                const config=parse(values.batteryConfiguration,{});
                profiles.push({id:String(old.id),name:old.name||'Profil batterie',values:{...values,
                    batteryConfiguration:JSON.stringify({...config,capacityAh:old.capacity})}});
            }
        }
        sessionStorage.setItem(key,JSON.stringify(profiles));
        return profiles;
    }
    let selected=scoped?(list().find(profile=>profile.id===(query.get('configuration')||raw(`activeAutonomyProfile_${group}`)))||list()[0]):null;
    function changed(){
        if(report)return;
        const pending=new Set(parse(raw('autonomySynthesisPendingModes'),[]));pending.add(group);
        sessionStorage.setItem('autonomySynthesisPendingModes',JSON.stringify([...pending]));
        window.dispatchEvent(new CustomEvent('autonomy-profiles-changed',{detail:{group}}));
    }
    function persist(){
        const profiles=list(),index=profiles.findIndex(profile=>profile.id===selected.id);
        if(index<0)return;
        profiles[index]={...profiles[index],values:selected.values};selected=profiles[index];
        sessionStorage.setItem(`autonomyProfiles_${group}`,JSON.stringify(profiles));changed();
    }
    if(scoped){
        if(!report){
            nativeWrite.call(sessionStorage,'batterySubMode',labels[group]);
            nativeWrite.call(sessionStorage,`activeAutonomyProfile_${group}`,selected.id);
        }
        const keys=keysFor(group);
        Storage.prototype.getItem=function(key){
            if(this===sessionStorage&&key==='batterySubMode')return labels[group];
            return this===sessionStorage&&keys.has(String(key))?selected.values[key]??null:nativeRead.call(this,key);
        };
        Storage.prototype.setItem=function(key,value){
            if(this===sessionStorage&&key==='batterySubMode'&&report)return;
            if(this===sessionStorage&&keys.has(String(key))){
                if(selected.values[key]!==String(value)){selected.values[key]=String(value);persist();}return;
            }
            return nativeWrite.call(this,key,value);
        };
        Storage.prototype.removeItem=function(key){
            if(this===sessionStorage&&keys.has(String(key))){if(key in selected.values){delete selected.values[key];persist();}return;}
            return nativeRemove.call(this,key);
        };
    }
    function activate(id){
        const profile=list().find(profile=>profile.id===id);if(!profile)return false;
        sessionStorage.setItem(`activeAutonomyProfile_${group}`,id);
        selected=profile;return true;
    }
    function reload(id=selected.id,mode=group){
        sessionStorage.setItem('batterySubMode',labels[mode]);
        sessionStorage.setItem(`activeAutonomyProfile_${mode}`,id);
        const url=new URL(location.href);url.searchParams.delete('configuration');url.searchParams.delete('profiles');
        url.searchParams.set('mode',labels[mode]);location.href=url.pathname+url.search;
    }
    function create(name){
        const profiles=list();
        const profile={id:crypto.randomUUID(),name:name||`Profil ${profiles.length+1}`,
            values:{batteryConfiguration:JSON.stringify({capacityAh:60,startingSoc:90,minimumSoc:70})}};
        profiles.push(profile);sessionStorage.setItem(`autonomyProfiles_${group}`,JSON.stringify(profiles));
        activate(profile.id);changed();return profile;
    }
    function rename(name){
        const profiles=list(),profile=profiles.find(item=>item.id===selected.id);if(!profile)return;
        profile.name=name.trim()||'Profil sans nom';selected.name=profile.name;
        sessionStorage.setItem(`autonomyProfiles_${group}`,JSON.stringify(profiles));changed();
    }
    function remove(id){
        const profiles=list();if(profiles.length<=1||!profiles.some(profile=>profile.id===id))return false;
        const remaining=profiles.filter(profile=>profile.id!==id);
        sessionStorage.setItem(`autonomyProfiles_${group}`,JSON.stringify(remaining));
        if(selected.id===id)activate(remaining[0].id);changed();return true;
    }
    window.AutonomyProfiles={groups,labels,group,list,get selected(){return selected;},activate,create,rename,remove};
    if(scoped&&!report)document.addEventListener('DOMContentLoaded',()=>{
        const bar=document.createElement('section');bar.className='autonomy-profile-bar';bar.setAttribute('aria-label','Profils complets d’autonomie');
        if(route==='/battery_configuration'){
            const label=document.createElement('label');label.textContent='Mode d’autonomie';
            const mode=document.createElement('select');mode.id='autonomy-profile-mode';
            groups.forEach(id=>mode.add(new Option(labels[id],id)));mode.value=group;
            mode.onchange=()=>{const profiles=list(mode.value);reload(raw(`activeAutonomyProfile_${mode.value}`)||profiles[0].id,mode.value);};
            label.append(mode);bar.append(label);
        }
        const label=document.createElement('label');label.textContent=`Profil ${labels[group]}`;
        const select=document.createElement('select');select.id='autonomy-profile-select';
        list().forEach(profile=>select.add(new Option(profile.name,profile.id)));select.value=selected.id;
        select.onchange=()=>reload(select.value);label.append(select);bar.append(label);
        const nameLabel=document.createElement('label');nameLabel.textContent='Nom du profil';
        const name=document.createElement('input');name.id='autonomy-profile-name';name.maxLength=80;name.value=selected.name;
        name.oninput=()=>{rename(name.value);select.selectedOptions[0].textContent=selected.name;};nameLabel.append(name);bar.append(nameLabel);
        const add=document.createElement('button');add.id='add-autonomy-profile';add.type='button';add.textContent='Ajouter un profil';
        add.onclick=()=>reload(create().id);bar.append(add);
        const deletion=document.createElement('button');deletion.id='remove-autonomy-profile';deletion.type='button';deletion.className='danger';deletion.textContent='Supprimer ce profil';deletion.disabled=list().length===1;
        deletion.onclick=()=>{if(confirm(`Supprimer le profil « ${selected.name} » et tous ses paramètres ${labels[group]} ?`)&&remove(selected.id))reload();};bar.append(deletion);
        const help=document.createElement('small');help.textContent='Batterie, courants et consommations sont enregistrés automatiquement dans ce profil et disponibles dans la synthèse.';bar.append(help);
        const anchor=document.querySelector('.stepper, .setup-intro, .topbar, main.page > header, .container > .header');
        if(anchor)anchor.after(bar);else document.body.prepend(bar);
        document.querySelectorAll('#addProfileButton,#bottomAddProfile,#profileDialog').forEach(element=>element.hidden=true);
    });
})();
