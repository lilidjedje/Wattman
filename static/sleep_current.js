(function () {
    function number(value, fallback = 0) {
        if (value === null || value === undefined || String(value).trim() === '') return fallback;
        const parsed = Number(String(value).replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : fallback;
    }

    function sourceCurrent(row, mode) {
        const column = mode === 'Customer Mode' ? 'CM Current (mA)' : `${mode} Current (mA)`;
        if (mode === 'Customer Mode') {
            // Customer inputs are mA. Legacy Device List sleep values are µA.
            if (row[column] !== null && row[column] !== undefined) return row[column];
            return number(row['Current (A)'] ?? row['Sleep Current (mA)'] ?? row['Homologation Current (mA)']) / 1000;
        }
        return row[column] ?? row['Current (A)'] ?? row['Sleep Current (mA)'] ?? row['Homologation Current (mA)'] ?? 0;
    }

    function oneDayProfile(matrix, deviceKey, day = 1) {
        const prefix = `${deviceKey}_`;
        const entry = Object.entries(matrix).find(([key]) => key.startsWith(prefix)
            && number(key.slice(prefix.length).replace(/\s*jours?$/i, ''), NaN) === day);
        return entry ? number(entry[1], 1) : 1;
    }

    function calculate(mode, storage = sessionStorage, day = 1) {
        const read = (key, fallback) => JSON.parse(storage.getItem(key) || JSON.stringify(fallback));
        const excel = read('excelData', {});
        const sheet = excel['Device List'] || excel['ECU List'] || Object.values(excel)[0];
        const currentKey = mode === 'Customer Mode' ? 'modifiedCustomerCurrents' : `modified${mode}Currents`;
        const matrixKey = mode === 'Customer Mode' ? 'customerModeMatrix' : `${mode.toLowerCase()}ModeMatrix`;
        const currents = read(currentKey, {});
        const matrix = read(matrixKey, {});
        const selection = storage.getItem('selectedEcuKeys');
        const selected = new Set(read('selectedEcuKeys', []));
        const deleted = new Set(read('deletedDarkDeviceKeys', []));
        let instantaneousUa = 0;
        (sheet?.data || []).forEach((row, rowIndex) => {
            const name = row['Device Name'] || row['ECU Name'] || `Item ${rowIndex + 1}`;
            const key = `${rowIndex}_${name}`;
            if (deleted.has(key) || (selection !== null && !selected.has(key))) return;
            const current = number(currents[key] ?? sourceCurrent(row, mode));
            instantaneousUa += current * (mode === 'Customer Mode' ? 1000 : 1) * oneDayProfile(matrix, String(rowIndex), day);
        });
        read('customDarkDevices', []).forEach(device => {
            const key = `custom:${device.id}`;
            if (!deleted.has(key)) instantaneousUa += number(currents[key] ?? device.current) * (mode === 'Customer Mode' ? 1000 : 1) * oneDayProfile(matrix, key, day);
        });
        // Normalize to µA; Customer editor values are mA, DM values retain legacy µA.
        return { instantaneousUa, dailyAh: instantaneousUa * 24 / 1000000 };
    }

    window.SleepCurrent = { sourceCurrent, calculate };
}());
