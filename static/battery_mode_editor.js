(() => {
    const table = document.querySelector('.dm-matrix-page table');
    const tbody = document.getElementById('table-body');
    if (!table || !tbody || typeof daysColumns === 'undefined') return;

    const mode = sessionStorage.getItem('batterySubMode') || 'DM1';
    const currentKey = mode === 'Customer Mode' ? 'modifiedCustomerCurrents' : `modified${mode}Currents`;
    const matrixKey = mode === 'Customer Mode' ? 'customerModeMatrix' : `${mode.toLowerCase()}ModeMatrix`;
    const customStorageKey = 'customDarkDevices';
    const deletedStorageKey = 'deletedDarkDeviceKeys';
    let customDevices = JSON.parse(sessionStorage.getItem(customStorageKey) || '[]');
    let deletedKeys = new Set(JSON.parse(sessionStorage.getItem(deletedStorageKey) || '[]'));
    let currents = JSON.parse(sessionStorage.getItem(currentKey) || '{}');
    let matrix = JSON.parse(sessionStorage.getItem(matrixKey) || '{}');

    const currentHeader = document.querySelector('th.sticky-col2');
    if (currentHeader) currentHeader.textContent = 'Current';

    function unitField(input, unit) {
        if (input.parentElement?.classList.contains('battery-unit-field')) return;
        const wrapper = document.createElement('span');
        wrapper.className = 'battery-unit-field';
        input.before(wrapper);
        wrapper.append(input);
        const suffix = document.createElement('span');
        suffix.className = 'battery-unit-suffix';
        suffix.textContent = unit;
        wrapper.append(suffix);
    }

    const sourceSheet = (() => {
        const data = JSON.parse(sessionStorage.getItem('excelData') || '{}');
        return data['Device List'] || data['ECU List'] || Object.values(data)[0];
    })();
    const selectedRaw = sessionStorage.getItem('selectedEcuKeys');
    const selected = selectedRaw === null ? null : new Set(JSON.parse(selectedRaw || '[]'));
    const available = [];
    (sourceSheet?.data || []).forEach((row, index) => {
        const name = row['Device Name'] || row['ECU Name'] || `Item ${index + 1}`;
        const key = `${index}_${name}`;
        if (selected !== null && !selected.has(key)) return;
        available.push({ key, name });
    });

    function askDelete(name, onConfirm) {
        let dialog = document.getElementById('battery-device-delete-dialog');
        if (!dialog) {
            dialog = document.createElement('dialog');
            dialog.id = 'battery-device-delete-dialog';
            dialog.className = 'industrial-confirm-dialog';
            dialog.innerHTML = `
                <form method="dialog">
                    <h2>Supprimer le Device</h2>
                    <p id="battery-device-delete-message"></p>
                    <div class="dialog-actions">
                        <button value="cancel" class="btn btn-back">Non</button>
                        <button value="confirm" class="device-delete-confirm">Oui</button>
                    </div>
                </form>`;
            document.body.append(dialog);
        }
        dialog.querySelector('#battery-device-delete-message').textContent =
            `Êtes-vous sûr de vouloir supprimer « ${name} » ?`;
        dialog.returnValue = '';
        dialog.addEventListener('close', () => {
            if (dialog.returnValue === 'confirm') onConfirm();
        }, { once: true });
        dialog.showModal();
    }

    function addDeleteButton(cell, name, onConfirm) {
        cell.classList.add('device-name-cell');
        const label = document.createElement('span');
        label.textContent = cell.textContent.trim();
        cell.replaceChildren(label);
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'device-row-delete';
        button.setAttribute('aria-label', `Supprimer ${name}`);
        button.title = `Supprimer ${name}`;
        button.textContent = '×';
        button.addEventListener('click', () => askDelete(name, onConfirm));
        cell.append(button);
    }

    [...tbody.rows].forEach((row, position) => {
        const info = available[position];
        if (!info) return;
        row.dataset.deviceKey = info.key;
        if (deletedKeys.has(info.key)) {
            row.remove();
            return;
        }
        const input = row.querySelector('td.sticky-col2 input');
        if (input) unitField(input, 'mA');
        addDeleteButton(row.cells[0], info.name, () => {
            deletedKeys.add(info.key);
            sessionStorage.setItem(deletedStorageKey, JSON.stringify([...deletedKeys]));
            delete currents[info.key];
            sessionStorage.setItem(currentKey, JSON.stringify(currents));
            row.remove();
        });
    });

    function renderCustom(device) {
        const key = `custom:${device.id}`;
        const row = document.createElement('tr');
        row.dataset.deviceKey = key;
        const nameCell = document.createElement('td');
        nameCell.className = 'sticky-col';
        nameCell.textContent = device.name;
        addDeleteButton(nameCell, device.name, () => {
            customDevices = customDevices.filter(item => item.id !== device.id);
            sessionStorage.setItem(customStorageKey, JSON.stringify(customDevices));
            delete currents[key];
            Object.keys(matrix).filter(k => k.startsWith(`${key}_`)).forEach(k => delete matrix[k]);
            sessionStorage.setItem(currentKey, JSON.stringify(currents));
            sessionStorage.setItem(matrixKey, JSON.stringify(matrix));
            row.remove();
        });
        row.append(nameCell);

        const currentCell = document.createElement('td');
        currentCell.className = 'sticky-col2';
        const input = document.createElement('input');
        input.type = 'number';
        input.min = '0';
        input.step = '0.01';
        input.className = 'homologation-input';
        input.value = currents[key] ?? device.current ?? 0;
        input.addEventListener('change', () => {
            currents[key] = input.value;
            sessionStorage.setItem(currentKey, JSON.stringify(currents));
        });
        currentCell.append(input);
        unitField(input, 'mA');
        row.append(currentCell);

        daysColumns.forEach((day, index) => {
            const cell = document.createElement('td');
            const select = document.createElement('select');
            select.className = 'profile-select';
            select.innerHTML = '<option value="0">0</option><option value="1">1</option>';
            const keyForDay = `${key}_${day}`;
            const fallback = index % 2 === 0 ? '1' : '0';
            select.value = matrix[keyForDay] ?? fallback;
            select.addEventListener('change', () => {
                matrix[keyForDay] = select.value;
                sessionStorage.setItem(matrixKey, JSON.stringify(matrix));
            });
            cell.append(select);
            row.append(cell);
        });
        tbody.append(row);
    }
    customDevices.forEach(renderCustom);

    const panel = document.createElement('section');
    panel.className = 'add-device-panel battery-add-device';
    panel.innerHTML = `
        <h2>Ajouter un Device</h2>
        <div class="add-device-fields">
            <label>Nom du Device
                <input id="new-battery-device-name" type="text" autocomplete="off">
            </label>
            <label>Current
                <span class="battery-unit-field">
                    <input id="new-battery-device-current" type="number" min="0" step="0.01" value="0">
                    <span class="battery-unit-suffix">mA</span>
                </span>
            </label>
            <button id="add-battery-device" type="button">Ajouter le Device</button>
        </div>`;
    document.querySelector('.container')?.insertBefore(panel, document.getElementById('table-wrapper'));
    panel.querySelector('#add-battery-device').addEventListener('click', () => {
        const nameInput = panel.querySelector('#new-battery-device-name');
        const currentInput = panel.querySelector('#new-battery-device-current');
        const name = nameInput.value.trim();
        if (!name) {
            nameInput.focus();
            return;
        }
        const device = {
            id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
            name,
            current: Number(currentInput.value) || 0
        };
        customDevices.push(device);
        sessionStorage.setItem(customStorageKey, JSON.stringify(customDevices));
        renderCustom(device);
        nameInput.value = '';
        currentInput.value = '0';
    });
})();
