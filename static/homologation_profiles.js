/* Independent, automatically saved configurations, shared by editors and reports. */
(() => {
    const query = new URLSearchParams(location.search);
    const read = Storage.prototype.getItem;
    const write = Storage.prototype.setItem;
    const remove = Storage.prototype.removeItem;
    const raw = key => read.call(sessionStorage, key);
    const keys = new Set(['profileMatrix','alternatorMatrix','modifiedCurrents','modifiedLowers',
        'modifiedUppers','homologationDevices','homologationConfiguration','paoData','gmvData',
        'customHomologationDevices','deletedHomologationDeviceKeys','selectedDeviceKeys']);
    const parse = value => { try { return JSON.parse(value); } catch { return null; } };
    const mode = query.get('module') === 'wltc' || location.pathname === '/edit_alternator'
        ? 'wltc' : query.get('module') === 'dcdc' || location.pathname === '/edit_current'
        ? 'dcdc' : raw('activeHomologationMode') || 'dcdc';
    const storeKey = `homologationProfiles_${mode}`;
    const selectedKey = `activeHomologationProfile_${mode}`;
    const report = location.pathname === '/synthesis';
    const auxiliary = ['/edit_pao','/edit_gmv'].includes(location.pathname);
    const editor = ['/homologation_configuration','/edit_current','/edit_alternator','/edit_pao','/edit_gmv'].includes(location.pathname);
    function list(group = mode) {
        const saved = parse(raw(`homologationProfiles_${group}`));
        return Array.isArray(saved) && saved.length ? saved : [{id:'main',name:'Profil principal',values:{}}];
    }
    let profiles = list();
    if (!raw(storeKey) && (editor || report)) {
        profiles[0].values = Object.fromEntries([...keys].map(key => [key,raw(key)]).filter(([,value])=>value!==null));
        write.call(sessionStorage,storeKey,JSON.stringify(profiles));
    }
    let selected = profiles.find(profile=>profile.id === (query.get('configuration') || raw(selectedKey))) || profiles[0];
    function changed(group) {
        if (!editor) return;
        const pending = new Set(parse(raw('homologationSynthesisPendingModes')) || []);
        pending.add(group);
        sessionStorage.setItem('homologationSynthesisPendingModes',JSON.stringify([...pending]));
        window.dispatchEvent(new CustomEvent('homologation-profiles-changed',{detail:{group}}));
    }
    function persistValues() {
        const latest=list(mode),entry=latest.find(profile=>profile.id===selected.id);
        if(!entry)return;
        entry.values=selected.values;
        profiles=latest;selected=entry;
        sessionStorage.setItem(storeKey,JSON.stringify(profiles));changed(mode);
    }
    if (editor || report) {
        if (!report) { write.call(sessionStorage,'activeHomologationMode',mode);write.call(sessionStorage,selectedKey,selected.id); }
        const persist = () => {sessionStorage.setItem(storeKey,JSON.stringify(profiles));changed(mode);};
        Storage.prototype.getItem = function(key) {
            return this===sessionStorage && keys.has(String(key)) ? selected.values[key] ?? null : read.call(this,key);
        };
        Storage.prototype.setItem = function(key,value) {
            if(this===sessionStorage && keys.has(String(key))) {
                if (selected.values[key] === String(value)) return;
                selected.values[key]=String(value);persistValues();return;
            }
            return write.call(this,key,value);
        };
        Storage.prototype.removeItem = function(key) {
            if(this===sessionStorage && keys.has(String(key))) { if(key in selected.values){delete selected.values[key];persistValues();}return; }
            return remove.call(this,key);
        };
        if(editor && !auxiliary) document.addEventListener('DOMContentLoaded',()=>{
            const bar=document.createElement('section');bar.className='homologation-profile-bar';
            bar.setAttribute('aria-label','Profils de configuration');
            bar.innerHTML='<label>Profil '+mode.toUpperCase()+' <select id="homologation-profile-select"></select></label><label>Nom du profil <input id="homologation-profile-name" maxlength="80"></label><button type="button" id="add-homologation-profile">Ajouter un profil</button><button type="button" class="danger" id="remove-homologation-profile">Supprimer ce profil</button><small>Profils et modifications enregistrés et pris en compte automatiquement dans la synthèse. Un nouveau profil reprend les valeurs initiales.</small>';
            const header=document.querySelector('nav.stepper') || document.querySelector('header');header?.after(bar);
            const select=bar.querySelector('select');profiles.forEach(profile=>select.add(new Option(profile.name,profile.id)));
            select.value=selected.id;
            select.onchange=()=>{sessionStorage.setItem(selectedKey,select.value);location.reload();};
            const name=bar.querySelector('input');name.value=selected.name;
            name.oninput=()=>{selected.name=name.value.trim()||'Profil sans nom';select.selectedOptions[0].textContent=selected.name;persist();};
            bar.querySelector('#add-homologation-profile').onclick=()=>{
                const profile={id:crypto.randomUUID(),name:`Profil ${profiles.length+1}`,values:{}};
                profiles.push(profile);persist();sessionStorage.setItem(selectedKey,profile.id);location.reload();
            };
            const deletion=bar.querySelector('#remove-homologation-profile');deletion.disabled=profiles.length===1;
            deletion.onclick=()=>{
                if(!confirm(`Supprimer le profil « ${selected.name} » ?`))return;
                profiles=profiles.filter(profile=>profile.id!==selected.id);persist();sessionStorage.setItem(selectedKey,profiles[0].id);location.reload();
            };
        });
    }
    function active(group) {
        if(group===mode)return selected;
        const items=list(group);
        if(!raw(`homologationProfiles_${group}`)) {
            items[0].values=Object.fromEntries([...keys].map(key=>[key,raw(key)]).filter(([,value])=>value!==null));
            sessionStorage.setItem(`homologationProfiles_${group}`,JSON.stringify(items));
        }
        return items.find(item=>item.id===raw(`activeHomologationProfile_${group}`))||items[0];
    }
    function update(group,change) {
        if(group===mode) {
            const before=JSON.stringify(selected.values);
            change(selected.values);
            if(before!==JSON.stringify(selected.values)){
                persistValues();
            }
        } else {
            const target=active(group),items=list(group);
            const item=items.find(item=>item.id===target.id),before=JSON.stringify(item.values);change(item.values);
            if(before!==JSON.stringify(item.values)){
                sessionStorage.setItem(`homologationProfiles_${group}`,JSON.stringify(items));changed(group);
            }
        }
    }
    function select(group,id) {
        const items=list(group),profile=items.find(item=>item.id===id);
        if(!profile)return false;
        if(group===mode){profiles=items;selected=profile;}
        sessionStorage.setItem(`activeHomologationProfile_${group}`,id);
        return true;
    }
    function readValue(group,key,fallback) {return parse(active(group).values[key])??fallback;}
    window.HomologationProfiles={list,mode,get selected(){return selected;},active,select,update,readValue};
})();
