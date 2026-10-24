(function () {
    const mode = document.body.classList.contains('alternator-profile-page') ? 'wltc' : 'dcdc';
    const defaults = window.HomologationDefaults;
    if (!defaults) return;

    const config = mode === 'wltc'
        ? {
            matrixKey: 'alternatorMatrix',
            profiles: defaults.wltcProfiles,
            intervals: defaults.wltcIntervals.filter((interval) => !/conso.*max/i.test(interval)),
            profileTitles: ['Cycle 1', 'Cycle 2', 'Cycle 3']
        }
        : {
            matrixKey: 'profileMatrix',
            profiles: defaults.dcdcProfiles,
            intervals: defaults.dcdcIntervals.filter((interval) => !/conso.*max/i.test(interval)),
            profileTitles: ['Profile : Winter (<5°C)', 'Profile : Mid-season (5°C<T<15°C)', 'Profile : Summer (T>15°C)']
        };

    const excelData = JSON.parse(sessionStorage.getItem('excelData') || '{}');
    const sheet = excelData['Device List'] || Object.values(excelData)[0];
    const storedSelection = sessionStorage.getItem('selectedDeviceKeys');
    const selectedKeys = new Set(JSON.parse(storedSelection || '[]'));
    const deletedKeys = new Set(JSON.parse(sessionStorage.getItem('deletedHomologationDeviceKeys') || '[]'));
    let customDevices = JSON.parse(sessionStorage.getItem('customHomologationDevices') || '[]');
    let matrix = JSON.parse(sessionStorage.getItem(config.matrixKey) || '{}');
    let currents = JSON.parse(sessionStorage.getItem('modifiedCurrents') || '{}');
    let lowers = JSON.parse(sessionStorage.getItem('modifiedLowers') || '{}');
    let uppers = JSON.parse(sessionStorage.getItem('modifiedUppers') || '{}');

    const tbody = document.getElementById('table-body');
    const subHeaders = document.getElementById('sub-headers');
    const mainHeaderRow = document.querySelector('#table-wrapper thead tr:first-child');
    const dialog = document.getElementById('delete-device-dialog');
    let pendingDeletion = null;

    function normalizePercentage(value) {
        const number = Math.max(0, Math.min(100, Number.parseFloat(String(value).replace(',', '.')) || 0));
        return `${number}%`;
    }

    function percentageNumber(value) {
        const number = Number.parseFloat(String(value ?? '100').replace(',', '.'));
        return Number.isFinite(number) ? number : 100;
    }

    function save() {
        sessionStorage.setItem(config.matrixKey, JSON.stringify(matrix));
        sessionStorage.setItem('modifiedCurrents', JSON.stringify(currents));
        sessionStorage.setItem('modifiedLowers', JSON.stringify(lowers));
        sessionStorage.setItem('modifiedUppers', JSON.stringify(uppers));
        sessionStorage.setItem('customHomologationDevices', JSON.stringify(customDevices));
        sessionStorage.setItem('deletedHomologationDeviceKeys', JSON.stringify(Array.from(deletedKeys)));
    }

    function createUnitInput(input, unit) {
        const wrapper = document.createElement('span');
        wrapper.className = 'cell-unit-input';
        wrapper.dataset.unit = unit;
        wrapper.appendChild(input);
        return wrapper;
    }

    function createBoundSelect(value, onChange) {
        const select = document.createElement('select');
        select.className = 'bound-select';
        select.innerHTML = '<option value="0">0</option><option value="1">1</option>';
        select.value = String(value);
        select.addEventListener('change', () => onChange(select.value));
        return select;
    }

    function isCoolingGmv(name) {
        return defaults.normalize(name).includes('GMV REFROIDISSEMENT FACE AVANT');
    }

    function sourceDevices() {
        const devices = [];
        const occurrenceCounts = {};
        if (sheet?.data) {
            sheet.data.forEach((row, rowIndex) => {
                const name = row['Device Name'] || row['ECU Name'] || `Device ${rowIndex + 1}`;
                const key = `${rowIndex}_${name}`;
                const category = String(row['current_category'] || row['Current Category'] || '').trim().toUpperCase();
                if (isCoolingGmv(name) || deletedKeys.has(key)) return;
                if (storedSelection !== null ? !selectedKeys.has(key) : category !== 'H') return;
                const normalizedName = defaults.normalize(name);
                const occurrence = occurrenceCounts[normalizedName] || 0;
                occurrenceCounts[normalizedName] = occurrence + 1;
                devices.push({
                    key,
                    name,
                    rowIndex,
                    occurrence,
                    custom: false,
                    originalCurrent: row['Current (A)'] ?? row['Homologation Current (A)'] ?? '',
                    lower: row['Lower'] ?? 1,
                    upper: row['Upper'] ?? 0
                });
            });
        }
        customDevices.forEach((device) => {
            const key = `custom_${device.id}`;
            if (!deletedKeys.has(key)) {
                devices.push({
                    key,
                    name: device.name,
                    rowIndex: key,
                    occurrence: 0,
                    custom: true,
                    originalCurrent: device.current,
                    lower: device.lower ?? 1,
                    upper: device.upper ?? 0
                });
            }
        });
        return devices;
    }

    function matrixKey(device, profile, interval) {
        return `${device.rowIndex}_${profile}_${interval}`;
    }

    function initialValues(device) {
        return device.custom ? null : defaults.valuesFor(mode, device.name, device.occurrence);
    }

    function renderHeaders() {
        subHeaders.innerHTML = '';
        config.profileTitles.forEach((title, index) => {
            const header = mainHeaderRow.children[index + 4];
            if (header) {
                header.colSpan = config.intervals.length;
                header.textContent = title;
            }
            config.intervals.forEach((interval) => {
                const th = document.createElement('th');
                th.textContent = interval;
                subHeaders.appendChild(th);
            });
        });
        if (!mainHeaderRow.querySelector('.delete-column-header')) {
            const th = document.createElement('th');
            th.className = 'delete-column-header';
            th.rowSpan = 2;
            th.textContent = 'Suppression';
            mainHeaderRow.appendChild(th);
        }
    }

    function renderRow(device) {
        const tr = document.createElement('tr');
        tr.dataset.deviceKey = device.key;
        const values = initialValues(device);

        const nameCell = document.createElement('td');
        nameCell.className = 'device-name';
        nameCell.textContent = device.name;
        tr.appendChild(nameCell);

        const currentCell = document.createElement('td');
        const currentInput = document.createElement('input');
        currentInput.type = 'number';
        currentInput.step = '0.01';
        currentInput.className = 'homologation-input';
        currentInput.value = currents[device.key] ?? device.originalCurrent;
        currentInput.addEventListener('change', () => {
            const value = currentInput.value.trim();
            if (device.custom) {
                const target = customDevices.find((item) => `custom_${item.id}` === device.key);
                if (target) target.current = value;
            }
            currents[device.key] = value === '' ? 0 : Number(value);
            save();
        });
        currentCell.appendChild(createUnitInput(currentInput, 'A'));
        tr.appendChild(currentCell);

        const lowerCell = document.createElement('td');
        lowerCell.appendChild(createBoundSelect(lowers[device.key] ?? device.lower, (value) => {
            lowers[device.key] = value;
            save();
        }));
        tr.appendChild(lowerCell);

        const upperCell = document.createElement('td');
        upperCell.appendChild(createBoundSelect(uppers[device.key] ?? device.upper, (value) => {
            uppers[device.key] = value;
            save();
        }));
        tr.appendChild(upperCell);

        config.profiles.forEach((profile, profileIndex) => {
            config.intervals.forEach((interval, intervalIndex) => {
                const key = matrixKey(device, profile, interval);
                const initial = values?.[profileIndex * config.intervals.length + intervalIndex] ?? 100;
                if (matrix[key] === undefined) matrix[key] = `${initial}%`;
                const saved = matrix[key];
                const cell = document.createElement('td');
                const input = document.createElement('input');
                input.type = 'number';
                input.min = '0';
                input.max = '100';
                input.step = '1';
                input.className = 'profile-input';
                input.value = percentageNumber(saved);
                if (percentageNumber(saved) !== 100) input.classList.add('initial-emphasis');
                input.addEventListener('change', () => {
                    const normalized = normalizePercentage(input.value === '' ? 100 : input.value);
                    input.value = percentageNumber(normalized);
                    matrix[key] = normalized;
                    input.classList.toggle('initial-emphasis', percentageNumber(normalized) !== 100);
                    save();
                });
                cell.appendChild(createUnitInput(input, '%'));
                tr.appendChild(cell);
            });
        });

        const deleteCell = document.createElement('td');
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'delete-device';
        deleteButton.textContent = '×';
        deleteButton.title = `Supprimer ${device.name}`;
        deleteButton.addEventListener('click', () => {
            pendingDeletion = device;
            document.getElementById('delete-device-name').textContent = device.name;
            dialog.showModal();
        });
        deleteCell.appendChild(deleteButton);
        tr.appendChild(deleteCell);
        tbody.appendChild(tr);
    }

    function render() {
        renderHeaders();
        tbody.innerHTML = '';
        const devices = sourceDevices();
        devices.forEach(renderRow);
        if (!devices.length) {
            const tr = document.createElement('tr');
            const td = document.createElement('td');
            td.colSpan = 5 + config.profiles.length * config.intervals.length;
            td.className = 'empty-state';
            td.textContent = 'Aucun équipement sélectionné.';
            tr.appendChild(td);
            tbody.appendChild(tr);
        }
    }

    document.getElementById('confirm-device-delete').addEventListener('click', () => {
        if (!pendingDeletion) return;
        if (pendingDeletion.custom) {
            customDevices = customDevices.filter((item) => `custom_${item.id}` !== pendingDeletion.key);
        } else {
            deletedKeys.add(pendingDeletion.key);
        }
        delete currents[pendingDeletion.key];
        delete lowers[pendingDeletion.key];
        delete uppers[pendingDeletion.key];
        Object.keys(matrix).filter((key) => key.startsWith(`${pendingDeletion.rowIndex}_`)).forEach((key) => delete matrix[key]);
        save();
        dialog.close();
        pendingDeletion = null;
        render();
    });
    document.getElementById('cancel-device-delete').addEventListener('click', () => {
        pendingDeletion = null;
        dialog.close();
    });

    document.getElementById('add-device-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        customDevices.push({
            id: globalThis.crypto?.randomUUID?.() || `device-${Date.now()}`,
            name: String(form.get('name') || '').trim(),
            current: Number(form.get('current') || 0),
            lower: String(form.get('lower') || '1'),
            upper: String(form.get('upper') || '0')
        });
        event.currentTarget.reset();
        event.currentTarget.querySelector('[name="lower"]').value = '1';
        event.currentTarget.querySelector('[name="upper"]').value = '0';
        save();
        render();
    });

    window.navigateTo = function (path) {
        save();
        window.location.href = path;
    };
    window.returnToMenu = function () {
        window.navigateTo('/mode_selection');
    };

    render();
    save();
}());
