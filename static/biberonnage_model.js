(() => {
    const n = (value, fallback = 0) => {
        if (value === null || value === undefined || String(value).trim() === '') return fallback;
        const parsed = Number(String(value).replace(',', '.'));
        return Number.isFinite(parsed) ? parsed : fallback;
    };
    const labels = {
        1: 'Endormissement ECUs', 2: 'Secure Reboot PCU', 3: 'Secure Reboot CDC',
        4: 'PCU Garage mode (Google)', 5: 'CDC Garage mode (Google)', 6: '8ères heures', 7: 'FOTA',
        8: 'CDC Suspend to RAM', 9: 'Suspend to RAM PCU', 10: 'CONNECTIVITÉ', 11: 'Suspend to RAM Smart Antenna',
        13: 'TEST', 14: 'HFM / KAM', 15: 'Cell balancing', 16: 'Réveils techniques périodiques Customer',
        17: 'Veille CUSTOMER', 18: 'BLM', 19: 'AID', 20: 'Tachy', 21: 'Alarme', 22: 'TWT',
        24: 'Réveils techniques périodiques Delivery', 25: 'Veille DELIVERY', 26: 'Transport 10 jours',
        27: 'Auto décharge L2 (Pb) — ligne 1', 28: 'Auto décharge L2 (Pb)',
        29: 'TWT additionnel Delivery (Ah par période)'
    };
    const rows = Array.from({ length: 30 }, (_, rowIndex) => labels[rowIndex]
        ? { rowIndex, label: labels[rowIndex], unit: rowIndex === 29 ? 'Ah' : 'mA', group: rowIndex >= 24 ? 'delivery' : 'technical', required: rowIndex === 28 }
        : { rowIndex, section: ({ 0: 'Réveils et transitions techniques', 12: 'Fonctions véhicule et Customer', 23: 'Livraison et décharge batterie' })[rowIndex] });
    function columns(days) {
        return [{ key: '0', label: '0', daysElapsed: 0, referenceIndex: -1 },
            ...window.BiberonnageReference.columns.map((column, referenceIndex) => ({ ...column, referenceIndex }))
                .filter(column => column.daysElapsed <= days)];
    }
    function defaultValue(row, column, storage, days) {
        const index = row.rowIndex;
        if (column.referenceIndex < 0) return 0;
        if (index === 29) return days === 90 ? window.BiberonnageReference.deliveryTwtAh[column.referenceIndex] || 0 : 0;
        const read = key => JSON.parse(storage?.getItem(key) || '{}');
        const global = read('batteryConfiguration');
        const wake = read(index === 24 ? 'wakeParams_DM1' : 'wakeParams_Customer Mode');
        if ([16, 24].includes(index) && (Object.keys(wake).length || Object.keys(global).some(key => key.startsWith('wake')))) {
            const field = (key, fallback) => n(wake[key] ?? global[key], fallback);
            const period = field('wakePeriodHours', 8);
            return period > 0 ? (field('wakeCurrentMa', 536) * field('wakeDurationSeconds', 2)
                + field('wakeCellBalancingCurrentMa', 4359) * field('wakeCellBalancingDurationSeconds', 60)) / 3600 / period : 0;
        }
        if ([17, 25].includes(index) && storage?.getItem('excelData') && typeof window.SleepCurrent !== 'undefined') {
            const day = column.dayNum || column.day || (column.key === '8h' ? 0.3 : 0);
            return window.SleepCurrent.calculate(index === 17 ? 'Customer Mode' : 'DM1', storage, day).instantaneousUa / 1000;
        }
        const fixed = read('fixedConsumption');
        const entries = fixed.baseLab?.entries || fixed.configurations?.baseLab?.entries || {};
        const sleep = read('sleepConsumption').baseLab || {};
        const entryId = { 2: 'pcuSecure', 3: 'cdcSecure', 4: 'pcuGarage', 5: 'cdcGarage', 6: 'first8', 7: 'fota',
            8: 'cdcRam', 9: 'pcuRam', 10: 'smartAntenna', 11: 'smartAntennaRam', 18: 'blm' }[index];
        const entry = entries[entryId];
        const deletedFixed = JSON.parse(storage?.getItem('deletedFixedFunctionIds_Customer Mode') || '[]');
        const deletedSleep = JSON.parse(storage?.getItem('deletedSleepFunctionIds_Customer Mode') || '[]');
        if ((entryId && deletedFixed.includes(entryId)) || (index === 15 && deletedFixed.includes('cellBalancing'))) return 0;
        if ([19, 20, 21].includes(index) && deletedSleep.includes({ 19: 'aid', 20: 'tachy', 21: 'alarm' }[index])) return 0;
        if (entry) {
            const hours = n(entry.duration) * ({ h: 1, min: 1 / 60, s: 1 / 3600, jours: 24 }[entry.unit] || 0);
            return column.daysElapsed * 24 <= hours + 1e-9 ? n(entry.current) : 0;
        }
        if (index === 14 && (entries.handFree3 || entries.handFree48)) {
            const first = entries.handFree3, next = entries.handFree48;
            const firstDays = n(first?.duration, 3), nextDays = n(next?.duration, 5);
            if (column.daysElapsed <= firstDays) return deletedFixed.includes('handFree3') ? 0 : n(first?.current, 9);
            return column.daysElapsed <= firstDays + nextDays && !deletedFixed.includes('handFree48') ? n(next?.current, 4.2) : 0;
        }
        if ([19, 20, 21].includes(index)) {
            const field = { 19: 'aid', 20: 'tachy', 21: 'alarm' }[index];
            if (sleep[field] !== undefined) return n(sleep[field]);
        }
        return window.BiberonnageReference.currents[index]?.[column.referenceIndex] ?? 0;
    }
    function calculate({ config, selectedRows, timeColumns, currentFor, days }) {
        const capacityAh = Math.max(n(config.capacityAh, 60), 0.01);
        const startSoc = n(config.startingSoc, days === 30 ? 92 : 90);
        const demandSoc = n(config.efDemandSoc, 80), targetSoc = n(config.targetSoc, 90);
        const consoL1 = Math.max(0, n(config.consoL1, 7.971)), durationL1 = Math.max(0, n(config.durationL1, 120));
        const consoL2 = Math.max(0, n(config.consoL2, 7.971)), durationL2 = Math.max(0, n(config.durationL2, 90));
        const frequency = Math.max(0, n(config.frequencyDays, 7));
        const ahL1 = consoL1 * durationL1 / 60, ahL2 = consoL2 * durationL2 / 60;
        const recoveryL1 = Math.max(0, n(config.acceptanceL1, 3)) * durationL1 / 60;
        const recoveryL2 = Math.max(0, n(config.acceptanceL2, 3)) * durationL2 / 60;
        const ahSpent = [], cumulativeAh = [], intervalAh = [], socLost = [], socCurrent = [], events = [], socPoints = [];
        const losses = [], recharges = [];
        let cumulative = 0, previousSoc = startSoc, totalLossL1 = 0, totalLossL2 = 0, sumVeilleAh = 0;
        const selected = [...new Set([...selectedRows, 28])].filter(id => labels[id]);
        timeColumns.forEach((column, index) => {
            const previousTime = timeColumns[index - 1]?.daysElapsed || 0;
            const dt = Math.max(0, column.daysElapsed - previousTime) * 24;
            const sumMa = selected.filter(id => id !== 29).reduce((sum, id) => sum + Math.max(0, n(currentFor(id, column))), 0);
            const directAh = selected.includes(29) ? Math.max(0, n(currentFor(29, column))) : 0;
            // Excel's phase separator after day 3 has an explicitly zero total.
            const spent = (column.key === 'day-3-after' ? 0 : sumMa / 1000 * dt) + directAh;
            cumulative += spent;
            intervalAh.push(spent); cumulativeAh.push(cumulative);
            const daily = column.dayNum === 1 ? cumulative : column.dayNum ? spent : column.phaseChange ? directAh : 0;
            ahSpent.push(column.day ? daily : 0);
            if (column.day) sumVeilleAh += daily;
            const lost = column.day ? daily / capacityAh * 100 : 0;
            socLost.push(lost);
            let loss = 0, charge = 0;
            if (!column.day && column.key !== '8h') socCurrent.push(null);
            else if (column.key === '8h') {
                socCurrent.push(startSoc); socPoints.push({ x: column.daysElapsed, y: startSoc });
            } else {
                const before = Math.max(0, previousSoc - lost);
                const periodic = frequency > 0 && column.dayNum && Math.abs(column.dayNum / frequency - Math.round(column.dayNum / frequency)) < 1e-9;
                const threshold = before < demandSoc && before < targetSoc;
                const kind = periodic && recoveryL1 > 0 ? 1 : threshold && recoveryL2 > 0 ? 2 : 0;
                socPoints.push({ x: column.daysElapsed, y: before });
                if (kind) {
                    loss = kind === 1 ? ahL1 : ahL2;
                    charge = kind === 1 ? recoveryL1 : recoveryL2;
                    previousSoc = targetSoc;
                    if (kind === 1) totalLossL1 += loss; else totalLossL2 += loss;
                    events.push({ index, day: column.daysElapsed, kind, reason: periodic ? 'périodique' : 'seuil SOC', beforeSoc: before, afterSoc: targetSoc, lossAh: loss, rechargeAh: charge });
                    socPoints.push({ x: column.daysElapsed, y: targetSoc });
                } else previousSoc = before;
                socCurrent.push(previousSoc);
            }
            losses.push(loss); recharges.push(charge);
        });
        const sumVeilleWh = sumVeilleAh * 14.5, sumLossL1Wh = totalLossL1 * 14.5, sumLossL2Wh = totalLossL2 * 14.5;
        const totalRechargeAh = recharges.reduce((sum, value) => sum + value, 0);
        return { capacityAh, startSoc, demandSoc, targetSoc, consoL1, durationL1, consoL2, durationL2, ahL1, ahL2,
            recoveryL1, recoveryL2, intervalAh, cumulativeAh, ahSpent, socLost, socCurrent, socPoints, losses, recharges, events,
            totalLossL1, totalLossL2, totalRechargeAh, totalRechargeWh: totalRechargeAh * 14.5,
            sumVeilleAh, sumVeilleWh, sumLossL1Wh, sumLossL2Wh,
            totalCost: sumVeilleWh + sumLossL1Wh + sumLossL2Wh, bibCount: events.length };
    }
    window.BiberonnageModel = { rows, columns, defaultValue, calculate };
})();
