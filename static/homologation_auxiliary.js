/* PAO/GMV catalogue for the two active, independently calculated profiles. */
(() => {
    const model=HomologationProfiles,defaults=HomologationDefaults;
    const kind=location.pathname==='/edit_pao'?'pao':'gmv',key=`${kind}Data`,title=kind.toUpperCase();
    const groups=['dcdc','wltc'];
    const read=group=>model.readValue(group,key,[]);
    const write=(group,items)=>model.update(group,values=>{values[key]=JSON.stringify(items);});
    groups.forEach(prepare);
    const setup=document.querySelector('.setup-box');setup.classList.add('auxiliary-toolbar');
    const selectorBar=document.createElement('section');selectorBar.className='homologation-profile-bar auxiliary-profile-selectors';
    selectorBar.setAttribute('aria-label',`Profils à modifier pour les ${title}`);
    groups.forEach(group=>{
        const label=document.createElement('label');label.textContent=`Profil ${group.toUpperCase()} à modifier`;
        const select=document.createElement('select');select.id=`auxiliary-profile-${group}`;
        model.list(group).forEach(profile=>select.add(new Option(profile.name,profile.id)));
        select.value=model.active(group).id;
        select.onchange=()=>{if(model.select(group,select.value)){prepare(group);render();}};
        label.append(select);selectorBar.append(label);
    });
    const explanation=document.createElement('small');explanation.textContent='Choisissez les profils DCDC et WLTC à modifier sur cette page. Les ajouts, modifications et suppressions concernent uniquement les profils choisis et actualisent automatiquement la synthèse.';selectorBar.append(explanation);
    setup.before(selectorBar);
    setup.innerHTML=`<label>Nom du ${title}<input id="auxiliary-name" maxlength="120" placeholder="${title}"></label><label>Ajouter à<select id="auxiliary-target"><option value="${model.mode}">${model.mode.toUpperCase()}</option><option value="${model.mode==='dcdc'?'wltc':'dcdc'}">${model.mode==='dcdc'?'WLTC':'DCDC'}</option><option value="both">DCDC et WLTC</option></select></label><button type="button" id="add-auxiliary">Ajouter un ${title}</button>`;
    document.getElementById('add-auxiliary').onclick=()=>{
        const destination=document.getElementById('auxiliary-target').value;
        const targets=destination==='both'?groups:[destination];
        const name=document.getElementById('auxiliary-name').value.trim()||`${title} ${Math.max(...groups.map(group=>read(group).length))+1}`;
        const item={id:crypto.randomUUID(),name,current:0,lower:1,upper:0,devProfiles:{},altProfiles:{},wltcProfileVersion:2};
        targets.forEach(group=>write(group,[...read(group),structuredClone(item)]));
        document.getElementById('auxiliary-name').value='';render();
    };
    function prepare(group) {
        const items=read(group),before=JSON.stringify(items);defaults.migrateAuxiliary(items);
        items.forEach((item,index)=>{item.id??=`legacy-${kind}-${index}-${defaults.normalize(item.name)}`;});
        if(before!==JSON.stringify(items))write(group,items);
    }
    function field(value,unit,onChange) {
        const input=document.createElement('input');input.type='number';input.min='0';input.step='any';input.value=value??0;
        if(unit)input.dataset.currentBaseUnit=unit;
        input.addEventListener('input',()=>{if(input.checkValidity())onChange(Number(input.value)||0);});
        if(!unit)return input;
        const wrapper=document.createElement('span');wrapper.className='cell-unit-input';wrapper.dataset.unit=unit;wrapper.append(input);return wrapper;
    }
    function patch(group,id,change) {const items=read(group),item=items.find(item=>item.id===id);if(item){change(item);write(group,items);}}
    function render() {
        const table=document.querySelector('#table-wrapper table'),head=table.tHead;head.replaceChildren();
        const row=head.insertRow(),sub=head.insertRow();
        const name=document.createElement('th');name.textContent=`${title} / Affectation`;name.rowSpan=2;row.append(name);
        groups.forEach(group=>{
            const profiles=group==='dcdc'?defaults.dcdcProfiles:defaults.wltcProfiles;
            const count=profiles.reduce((sum,p)=>sum+defaults.intervalsFor(group,p).length,0);
            const header=document.createElement('th');header.colSpan=3+count;header.textContent=`${group.toUpperCase()} — ${model.active(group).name}`;row.append(header);
            ['Courant','Base','Upper',...profiles.flatMap(profile=>defaults.intervalsFor(group,profile).map(interval=>`${profile} · ${interval}`))].forEach(label=>{
                const cell=document.createElement('th');cell.textContent=label;sub.append(cell);
            });
        });
        const actions=document.createElement('th');actions.rowSpan=2;actions.textContent='Affectation / suppression';row.append(actions);
        const body=table.tBodies[0];body.replaceChildren();
        const catalogue=new Map();groups.forEach(group=>read(group).forEach(item=>{
            if(!catalogue.has(item.id))catalogue.set(item.id,{});catalogue.get(item.id)[group]=item;
        }));
        catalogue.forEach((variants,id)=>{
            const tr=body.insertRow(),nameCell=tr.insertCell();tr.dataset.auxiliaryId=id;nameCell.className='auxiliary-row-name';
            const nameInput=document.createElement('input');nameInput.type='text';nameInput.value=(variants.dcdc||variants.wltc).name;
            nameInput.oninput=()=>groups.filter(group=>variants[group]).forEach(group=>patch(group,id,item=>{item.name=nameInput.value;}));
            const assignment=document.createElement('p');assignment.className='auxiliary-assignment';assignment.textContent=groups.filter(group=>variants[group]).map(group=>group.toUpperCase()).join(' + ');
            nameCell.append(nameInput,assignment);
            groups.forEach(group=>{
                const item=variants[group],profiles=group==='dcdc'?defaults.dcdcProfiles:defaults.wltcProfiles;
                const count=3+profiles.reduce((sum,p)=>sum+defaults.intervalsFor(group,p).length,0);
                if(!item){const cell=tr.insertCell();cell.colSpan=count;cell.textContent='Non affecté à ce mode';return;}
                const current=field(item.current,'A',value=>patch(group,id,item=>{item.current=value;}));
                const currentInput=current.querySelector('input');currentInput.dataset.group=group;currentInput.dataset.field='current';
                currentInput.setAttribute('aria-label',`Courant ${title} ${group.toUpperCase()} — ${model.active(group).name}`);
                tr.insertCell().append(current);
                ['lower','upper'].forEach((bound,index)=>{
                    const select=document.createElement('select');select.innerHTML='<option value="0">0</option><option value="1">1</option>';select.value=String(item[bound]??(index===0?1:0));
                    select.onchange=()=>patch(group,id,item=>{item[bound]=Number(select.value);});tr.insertCell().append(select);
                });
                profiles.forEach(profile=>defaults.intervalsFor(group,profile).forEach(interval=>{
                    const fieldKey=group==='dcdc'?'devProfiles':'altProfiles',coefficientKey=`${profile}_${interval}`;
                    const input=field(parseFloat(String(item[fieldKey]?.[coefficientKey]??100).replace(',','.')),null,value=>patch(group,id,item=>{
                        item[fieldKey]??={};item[fieldKey][coefficientKey]=`${value}%`;
                    }));input.max='100';input.dataset.group=group;input.dataset.field=coefficientKey;tr.insertCell().append(input);
                }));
            });
            const cell=tr.insertCell();
            const add=document.createElement('button');add.type='button';add.textContent='Ajouter à un mode';
            const missing=groups.filter(group=>!variants[group]);add.disabled=!missing.length;
            add.onclick=async()=>{const targets=await HomologationTargets.choose(`Affecter ${nameInput.value}`,missing);targets.forEach(group=>write(group,[...read(group),structuredClone(variants.dcdc||variants.wltc)]));render();};
            const deletion=document.createElement('button');deletion.type='button';deletion.className='danger';deletion.textContent='Supprimer';
            deletion.onclick=async()=>{const targets=await HomologationTargets.choose(`Supprimer ${nameInput.value}`,groups.filter(group=>variants[group]));targets.forEach(group=>write(group,read(group).filter(item=>item.id!==id)));render();};
            cell.append(add,deletion);
        });
        document.getElementById('table-wrapper').classList.add('show');document.getElementById('button-group').classList.add('show');
        window.CurrentUnits?.refresh();
    }
    window.navigateTo=path=>{location.href=path==='/synthesis'?'/export_synthesis_pdf?auto=1':path;};
    window.returnToMenu=()=>{location.href='/mode_selection';};
    render();
})();
