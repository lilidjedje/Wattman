(function () {
    const normalizedName = value => String(value || '').trim().replace(/\s+/g, ' ').toUpperCase();
    const technicalDefaults = {
        AIBS: 0.10, 'PIU MASTER': 0.35, 'PIU SUB CABIN': 0.30, 'PIU HOOD': 0.30,
        DCDC: 0.97, 'BMS MAIN MONITORING TRACTION BATTERY HIGH VOLTAGE': 0.21,
        'PCU PHYSICAL COMPUTING UNIT': 1.80, HEVC: 0.23
    };
    const dmSmartmos = new Set([
        'DCDC', 'BMS MAIN MONITORING TRACTION BATTERY HIGH VOLTAGE',
        'PCU PHYSICAL COMPUTING UNIT', 'STOP LIGHT SWITCH (Normally closed for Stop Lamp)',
        'IVC TELEMATIC ECU', 'BLUETOOTH LOW ENERGY MODULE', 'HANDS-FREE ACCESS ECU',
        'COCKPIT DOMAIN CONTROLLER - Power 1', 'MULTIFONCTIONNAL ELECTRIC CONTROL',
        'UNDER STEERING WHEEL CONTROLS', 'DASHBOARD EXTERNAL LIGHT CONTROL BUTTONS',
        'DIAGNOSTIC SOCKET', 'LEFT HAND FRONT SEAT MEMORY ECU', 'RIGHT HAND FRONT SEAT MEMORY ECU',
        'RIGHT SLIDING DOOR', 'LEFT SLIDING DOOR', 'ECDO TAILGATE ECU', 'HEVC / PDC',
        'ALCOHOL INTERLOCK DEVICE ECU', 'VOLUMETRIC ALARM ECU', 'CHRONOTACHYGRAPHE', 'BMS LIB 12V'
    ].map(normalizedName));
    const customerSmartmos = new Set([
        'PCU PHYSICAL COMPUTING UNIT', 'Smart Antenna', 'COCKPIT DOMAIN CONTROLLER - Power 1',
        'DIAGNOSTIC SOCKET', 'HANDS-FREE ACCESS ECU', 'STOP LIGHT SWITCH (Normally closed for Stop Lamp)',
        'ECDO TAILGATE ECU', 'ALCOHOL INTERLOCK DEVICE ECU', 'VOLUMETRIC ALARM ECU',
        'CHRONOTACHYGRAPHE', 'BMS LIB 12V'
    ].map(normalizedName));
    const contributionKey = mode => mode === 'Customer Mode'
        ? 'autonomyCurrentContributionsCustomer' : 'autonomyCurrentContributionsDM';
    const setupKey = mode => mode === 'Customer Mode'
        ? 'autonomyCurrentSetupCustomerReady' : 'autonomyCurrentSetupDMReady';

    function defaultContributions(name, mode) {
        const key = normalizedName(name);
        const technical = {...technicalDefaults};
        if (mode === 'Customer Mode') Object.assign(technical, {
            'PIU MASTER':0.44, 'PIU SUB CABIN':0.31, 'PIU HOOD':0.31
        });
        // User-supplied initial values are microamperes. The internal field is A.
        const technicalWakeupA = (technical[key] || 0) / 1000000;
        const smartmosUa = (mode === 'Customer Mode' ? customerSmartmos : dmSmartmos).has(key) ? 45 : 0;
        return {defaultsVersion:2, technicalEnabled:technicalWakeupA > 0, technicalWakeupA,
            smartmosEnabled:smartmosUa > 0, smartmosUa,
            listed:technicalWakeupA > 0 || smartmosUa > 0};
    }

    function contributions(mode, key, name, storage = sessionStorage) {
        const saved = JSON.parse(storage.getItem(contributionKey(mode)) || '{}');
        const defaults = defaultContributions(name, mode);
        const previous = saved[key];
        if (previous && previous.defaultsVersion !== 2) {
            // Repair the old automatically seeded value, retaining explicit edits.
            if (Math.abs(number(previous.technicalWakeupA,-1) - defaults.technicalWakeupA * 1000000) < 1e-12) {
                previous.technicalWakeupA = defaults.technicalWakeupA;
            }
            previous.defaultsVersion = 2;
            storage.setItem(contributionKey(mode),JSON.stringify(saved));
        }
        const settings = {...defaults, ...previous};
        return {...settings,
            technicalWakeupA:settings.technicalEnabled ? Math.max(0,number(settings.technicalWakeupA)) : 0,
            smartmosUa:settings.smartmosEnabled ? Math.max(0,number(settings.smartmosUa)) : 0};
    }

    function totalCurrentMicroamps(mode, key, name, baseUa, storage = sessionStorage) {
        const extra = contributions(mode, key, name, storage);
        return number(baseUa) + extra.technicalWakeupA * 1000000 + extra.smartmosUa;
    }

    function number(value, fallback = 0) {
        if (value === null || value === undefined || String(value).trim() === '') return fallback;
        const parsed = Number(String(value).replace(/\s/g, '').replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function sourceCurrent(row, mode) {
        const column = mode === 'Customer Mode' ? 'CM Current (mA)' : `${mode} Current (mA)`;
        if (mode === 'Customer Mode') {
            // The source column is mA; legacy Device List sleep values are µA.
            if (row[column] !== null && row[column] !== undefined) return row[column];
            return number(row['Current (A)'] ?? row['Sleep Current (mA)'] ?? row['Homologation Current (mA)']) / 1000;
        }
        return row[column] ?? row['Current (A)'] ?? row['Sleep Current (mA)'] ?? row['Homologation Current (mA)'] ?? 0;
    }

    function sourceCurrentMicroamps(row, mode) {
        if (window.WattmanCurrent) {
            const column = mode === 'Customer Mode' ? 'CM Current (mA)' : `${mode} Current (mA)`;
            if (row[column] !== null && row[column] !== undefined) {
                // DM legacy mode columns contain µA despite their historical label.
                const source = mode === 'Customer Mode' ? column : 'Mode Current (uA)';
                return WattmanCurrent.read({...row,[source]:row[column]},source,'S').microamps || 0;
            }
            const fallback = ['Current (A)','Sleep Current (mA)','Homologation Current (mA)'].find(key=>row[key]!==null && row[key]!==undefined);
            if (fallback) return WattmanCurrent.read(row,fallback,'S').microamps || 0;
        }
        return number(sourceCurrent(row, mode)) * (mode === 'Customer Mode' ? 1000 : 1);
    }

    function migrateEditorCurrentsToMicroamps(storage, mode) {
        function migrate(key, marker) {
            if (storage.getItem(marker) === 'uA') return;

            const values = JSON.parse(storage.getItem(key) || '{}');
            Object.keys(values).forEach(itemKey => {
                values[itemKey] = number(values[itemKey]) * 1000;
            });
            storage.setItem(key, JSON.stringify(values));
            storage.setItem(marker, 'uA');
        }

        if (mode === 'Customer Mode') {
            migrate('modifiedCustomerCurrents', 'modifiedCustomerCurrentsUnit');
        }

        if (storage.getItem('customDarkDevicesCurrentUnit') !== 'uA') {
            const devices = JSON.parse(storage.getItem('customDarkDevices') || '[]');
            devices.forEach(device => {
                device.current = number(device.current) * 1000;
            });
            storage.setItem('customDarkDevices', JSON.stringify(devices));
            storage.setItem('customDarkDevicesCurrentUnit', 'uA');
        }
    }

    function oneDayProfile(matrix, deviceKey, day = 1) {
        const prefix = `${deviceKey}_`;
        const entry = Object.entries(matrix).find(([key]) => key.startsWith(prefix)
            && number(key.slice(prefix.length).replace(/\s*jours?$/i, ''), NaN) === day);
        return entry ? number(entry[1], 1) : 1;
    }

    function devices(mode, storage = sessionStorage, options = {}) {
        migrateEditorCurrentsToMicroamps(storage, mode);
        const read = (key, fallback) => JSON.parse(storage.getItem(key) || JSON.stringify(fallback));
        const excel = read('excelData', {});
        const sheet = excel['Device List'] || excel['ECU List'] || Object.values(excel)[0];
        const currentKey = mode === 'Customer Mode' ? 'modifiedCustomerCurrents' : `modified${mode}Currents`;
        const currents = read(currentKey, {});
        const selection = storage.getItem('selectedEcuKeys');
        const selected = new Set(read('selectedEcuKeys', []));
        const deleted = new Set(read('deletedDarkDeviceKeys', []));
        const result = [];
        const add = (key, matrixKey, name, baseUa) => {
            const extra = contributions(mode,key,name,storage);
            result.push({key,matrixKey,name,currentUa:number(baseUa),...extra,
                totalDarkCurrentUa:totalCurrentMicroamps(mode,key,name,baseUa,storage)});
        };
        (sheet?.data || []).forEach((row, rowIndex) => {
            const name = String(row['Device Name'] || row['ECU Name'] || `Item ${rowIndex + 1}`).trim();
            const key = `${rowIndex}_${name}`;
            const category = String(row['current_category'] || row['Current Category'] || '').trim().toUpperCase();
            if (deleted.has(key) && !options.includeDeleted) return;
            if (!options.includeUnselected && ((selection !== null && !selected.has(key))
                || (selection === null && category && category !== 'S'))) return;
            const hasModifiedCurrent = currents[key] !== undefined;
            const current = hasModifiedCurrent ? number(currents[key]) : sourceCurrentMicroamps(row,mode);
            add(key,String(rowIndex),name,current);
        });
        read('customDarkDevices', []).forEach(device => {
            const key = `custom:${device.id}`;
            if (!deleted.has(key) || options.includeDeleted) add(key,key,device.name || 'ECU personnalisé',currents[key] ?? device.current);
        });
        return result;
    }

    function calculate(mode, storage = sessionStorage, day = 1) {
        const matrixKey = mode === 'Customer Mode' ? 'customerModeMatrix' : `${mode.toLowerCase()}ModeMatrix`;
        const matrix = JSON.parse(storage.getItem(matrixKey) || '{}');
        const instantaneousUa = devices(mode,storage).reduce((sum,device) =>
            sum + device.totalDarkCurrentUa * oneDayProfile(matrix,device.matrixKey,day),0);
        return { instantaneousUa, dailyAh: instantaneousUa * 24 / 1000000 };
    }

    window.SleepCurrent = {
        sourceCurrent,
        sourceCurrentMicroamps,
        defaultContributions, contributions, contributionKey, setupKey,
        totalCurrentMicroamps, devices, oneDayProfile,
        calculate,
        migrateEditorCurrentsToMicroamps
    };
}());
