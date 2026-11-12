(() => {
    const customer = document.body.dataset.currentGroup === 'customer';
    const mode = customer ? 'Customer Mode' : (sessionStorage.getItem('batterySubMode') === 'DM2' ? 'DM2' : 'DM1');
    sessionStorage.setItem('batterySubMode',mode);
    const key = SleepCurrent.contributionKey(mode);
    SleepCurrent.devices(mode,sessionStorage,{includeUnselected:true,includeDeleted:true});
    let settings = JSON.parse(sessionStorage.getItem(key) || '{}');
    const body = document.getElementById('current-contributions');
    const selector = document.getElementById('contribution-device');
    const status = document.getElementById('saved-status');
    document.getElementById('setup-title').textContent = customer
        ? 'Courants complémentaires · Customer Mode' : 'Courants complémentaires · DM1 / DM2';
    document.title = customer ? 'Courants Customer Mode' : 'Courants DM1 / DM2';
    const format = value => window.CurrentUnits ? window.CurrentUnits.format(value,'\u00b5A') : new Intl.NumberFormat('fr-FR',{maximumFractionDigits:3}).format(value);
    const persist = () => sessionStorage.setItem(key,JSON.stringify(settings));
    const catalog = () => SleepCurrent.devices(mode,sessionStorage,{includeUnselected:true,includeDeleted:true});

    function render() {
        body.replaceChildren();
        const active = SleepCurrent.devices(mode);
        const listed = new Set();
        active.forEach(device => {
            if (!device.listed) return;
            listed.add(device.key);
            const row = document.createElement('tr');
            row.dataset.deviceKey = device.key;
            const name = row.insertCell(); name.textContent=device.name;
            row.insertCell().textContent=format(device.currentUa);
            const total = document.createElement('td');
            total.dataset.output='total-dark-current';
            const fields = {};
            const defaults = SleepCurrent.defaultContributions(device.name,mode);
            const raw = {...defaults,...settings[device.key]};
            const update = () => {
                if (!fields.technicalWakeupA.input.checkValidity() || !fields.smartmosUa.input.checkValidity()) return;
                settings[device.key]={defaultsVersion:2,listed:true,
                    technicalEnabled:fields.technicalWakeupA.check.checked,
                    technicalWakeupA:Number(fields.technicalWakeupA.input.value)||0,
                    smartmosEnabled:fields.smartmosUa.check.checked,
                    smartmosUa:Number(fields.smartmosUa.input.value)||0};
                persist();
                total.textContent=format(SleepCurrent.totalCurrentMicroamps(mode,device.key,device.name,device.currentUa));
                status.textContent='Courants mis à jour.';
            };
            [['technicalWakeupA','technicalEnabled','Load Technical Wakeup 8h',0.000001],['smartmosUa','smartmosEnabled','SmartMOS Dark Current',0.01]].forEach(([field,enabled,label,step]) => {
                const cell = row.insertCell();
                const wrapper = document.createElement('span');wrapper.className='setup-contribution-field';
                const check = document.createElement('input');check.type='checkbox';check.checked=!!raw[enabled];
                check.setAttribute('aria-label',`Activer ${label} pour ${device.name}`);
                const input = document.createElement('input');input.type='number';input.min='0';input.step=String(step);
                const initial=raw[field] ?? (field==='smartmosUa'?45:0);
                input.value=window.CurrentUnits?.normalize(initial) ?? initial;input.disabled=!check.checked;
                input.dataset.field=field;input.setAttribute('aria-label',`${label} pour ${device.name}`);
                input.dataset.currentBaseUnit=field==='technicalWakeupA' ? 'A' : '\u00b5A';
                fields[field]={input,check};
                check.addEventListener('change',()=>{input.disabled=!check.checked;update();});
                input.addEventListener('input',update);
                wrapper.append(check,input);cell.append(wrapper);
            });
            total.textContent=format(device.totalDarkCurrentUa);row.append(total);
            const remove = document.createElement('button');remove.type='button';remove.className='setup-remove';remove.textContent='Retirer';
            remove.setAttribute('aria-label',`Retirer les compléments de ${device.name}`);
            remove.addEventListener('click',()=>{
                settings[device.key]={listed:false,technicalEnabled:false,technicalWakeupA:0,smartmosEnabled:false,smartmosUa:0};
                persist();render();status.textContent='Compléments retirés. Le courant de base est conservé.';
            });
            row.insertCell().append(remove);body.append(row);
        });
        document.getElementById('empty-contributions').hidden=listed.size>0;
        selector.replaceChildren();
        catalog().filter(device=>!listed.has(device.key)).forEach(device=>{
            const option=document.createElement('option');option.value=device.key;option.textContent=device.name;selector.append(option);
        });
        selector.disabled=selector.options.length===0;
        document.querySelector('#add-contribution-form button').disabled=selector.disabled;
    }
    document.getElementById('add-contribution-form').addEventListener('submit',event=>{
        event.preventDefault();
        const device=catalog().find(item=>item.key===selector.value);if(!device)return;
        const active=SleepCurrent.devices(mode);
        if(!device.key.startsWith('custom:')) {
            const selected=new Set(JSON.parse(sessionStorage.getItem('selectedEcuKeys') || JSON.stringify(active.filter(item=>!item.key.startsWith('custom:')).map(item=>item.key))));
            selected.add(device.key);sessionStorage.setItem('selectedEcuKeys',JSON.stringify([...selected]));
        }
        const deleted=JSON.parse(sessionStorage.getItem('deletedDarkDeviceKeys')||'[]').filter(item=>item!==device.key);
        sessionStorage.setItem('deletedDarkDeviceKeys',JSON.stringify(deleted));
        settings[device.key]={...SleepCurrent.defaultContributions(device.name,mode),listed:true};persist();render();
    });
    document.getElementById('restore-current-defaults').addEventListener('click',()=>{
        settings={};persist();render();status.textContent='Valeurs initiales rétablies pour ce groupe de modes.';
    });
    const currentPage=customer?'/edit_customer_mode':'/edit_dm_mode';
    document.querySelector('[data-setup-step="currents"]').textContent=customer?'1. Courants Customer':`1. Courants ${mode}`;
    function continueTo(destination) {
        if([...body.querySelectorAll('input')].some(input=>!input.reportValidity()))return;
        persist();sessionStorage.setItem(SleepCurrent.setupKey(mode),'true');
        window.location.href=destination;
    }
    const destinations={currents:currentPage,fixed:'/fixed_consumption',sleep:'/sleep_consumption'};
    document.querySelectorAll('[data-setup-step]').forEach(button=>{
        button.addEventListener('click',()=>continueTo(destinations[button.dataset.setupStep]));
    });
    document.getElementById('continue-configuration').addEventListener('click',()=>continueTo(currentPage));
    render();
})();
