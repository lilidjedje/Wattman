/* Keep synthesis choices and rebuild calculated reports after profile edits. */
(() => {
    const form=document.getElementById('selection-form');
    const stateKey='synthesisSelection';
    const read=(key,fallback)=>{try{return JSON.parse(sessionStorage.getItem(key))??fallback;}catch{return fallback;}};
    const fields=()=>[...form.querySelectorAll('input[type="checkbox"]')];
    const signature=()=>JSON.stringify([
        ...['dcdc','wltc'].map(mode=>HomologationProfiles.list(mode)),
        ...(window.AutonomyProfiles?AutonomyProfiles.groups.map(mode=>AutonomyProfiles.list(mode)):[])]);
    let version=signature(),timer;
    const preview=()=>document.getElementById('selection').classList.contains('compact');
    function save() {
        sessionStorage.setItem(stateKey,JSON.stringify({preview:preview(),
            fields:fields().map(input=>({name:input.name,value:input.value,checked:input.checked}))}));
    }
    const saved=read(stateKey,null);
    if(saved?.fields){
        const previous=new Map(saved.fields.map(input=>[`${input.name}:${input.value}`,input.checked]));
        fields().forEach(input=>{const key=`${input.name}:${input.value}`;if(previous.has(key))input.checked=previous.get(key);});
    }
    function includeEdits() {
        const pending=read('homologationSynthesisPendingModes',[]);
        pending.filter(mode=>['dcdc','wltc'].includes(mode)).forEach(mode=>{
            form.querySelector(`input[name="module"][value="${mode}"]`).checked=true;
        });
        const autonomy=read('autonomySynthesisPendingModes',[]);
        autonomy.filter(mode=>['dm1','dm2','customer'].includes(mode)).forEach(mode=>{
            form.querySelector(`input[name="module"][value="${mode}"]`).checked=true;
        });
        return pending.length>0||autonomy.length>0;
    }
    function refresh() {
        const current=signature();
        if(current===version)return;
        version=current;
        populateHomologationProfiles();
        populateAutonomyProfiles();
        includeEdits();updateOptions();
        if(preview())form.requestSubmit();else save();
    }
    form.addEventListener('change',save);
    form.addEventListener('submit',()=>{
        if(!preview())return;
        version=signature();
        sessionStorage.removeItem('homologationSynthesisPendingModes');
        sessionStorage.removeItem('autonomySynthesisPendingModes');
        save();
    });
    document.getElementById('back-to-selection').addEventListener('click',save);
    window.addEventListener('pageshow',refresh);
    window.addEventListener('focus',refresh);
    window.addEventListener('homologation-profiles-changed',()=>{clearTimeout(timer);timer=setTimeout(refresh,200);});
    window.addEventListener('autonomy-profiles-changed',()=>{clearTimeout(timer);timer=setTimeout(refresh,200);});
    window.addEventListener('storage',event=>{
        if(event.storageArea===sessionStorage && /^(homologationProfiles_(dcdc|wltc)|autonomyProfiles_(dm1|dm2|customer))$/.test(event.key||'')){
            clearTimeout(timer);timer=setTimeout(refresh,200);
        }
    });
    const edited=includeEdits();updateOptions();
    if(saved?.preview||edited||new URLSearchParams(location.search).get('auto')==='1'){
        if(!form.querySelector('input[name="module"]:checked')){
            ['dcdc','wltc'].forEach(mode=>{
                if(sessionStorage.getItem(`homologationProfiles_${mode}`))form.querySelector(`input[name="module"][value="${mode}"]`).checked=true;
            });
            ['dm1','dm2','customer'].forEach(mode=>{
                if(sessionStorage.getItem(`activeAutonomyProfile_${mode}`))form.querySelector(`input[name="module"][value="${mode}"]`).checked=true;
            });
        }
        updateOptions();
        if(form.querySelector('input[name="module"]:checked'))form.requestSubmit();
    }
})();
