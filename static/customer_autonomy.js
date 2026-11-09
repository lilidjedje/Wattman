(() => {
    const number = value => Number(String(value).replace(',', '.'));
    const fixedRows = {
        cellBalancing: [20, 21, 24], pcuRam: [26, 27, 28], pcuSecure: [30, 31, 32],
        cdcRam: [34, 35, 36], cdcGarage: [38, 39, 40], cdcSecure: [42, 43, 44],
        smartAntenna: [46, 48, 55], fota: [57, 58, 59],
        handFree3: [66, 68, 69], handFree48: [71, 73, 74], first8: [76, 78, 79], blm: [81, 83, 84]
    };
    // Evaluate only the arithmetic used by the source workbook; never execute formula text as JS.
    function arithmetic(expression, cell) {
        const tokens = expression.match(/[A-Z]+\d+|\d+(?:\.\d*)?(?:[Ee][+-]?\d+)?|[()+*/-]/g) || [];
        if (tokens.join('') !== expression.replace(/\s/g, '')) throw new Error(`Unsupported formula: ${expression}`);
        let index = 0;
        function atom() {
            const token = tokens[index++];
            if (token === '+') return atom();
            if (token === '-') return -atom();
            if (token === '(') {
                const value = sum();
                if (tokens[index++] !== ')') throw new Error('Unbalanced formula');
                return value;
            }
            if (/^[A-Z]+\d+$/.test(token)) return cell(token);
            const value = Number(token);
            if (!Number.isFinite(value)) throw new Error('Invalid formula value');
            return value;
        }
        function product() {
            let value = atom();
            while (tokens[index] === '*' || tokens[index] === '/') {
                const operator = tokens[index++], right = atom();
                value = operator === '*' ? value * right : value / right;
            }
            return value;
        }
        function sum() {
            let value = product();
            while (tokens[index] === '+' || tokens[index] === '-') {
                const operator = tokens[index++], right = product();
                value = operator === '+' ? value + right : value - right;
            }
            return value;
        }
        const value = sum();
        if (index !== tokens.length) throw new Error('Unexpected formula tokens');
        return value;
    }

    function calculate(report, options = {}) {
        const reference = window.CustomerReference[report];
        if (!reference) throw new Error(`Unknown Customer report: ${report}`);
        const cells = Object.assign({}, ...reference.columns.map(column => column.cells));
        const scenarios = ['baseLab', 'withAlarm', 'withoutAlarmTachy', 'alarmTachy', 'baseLib'];
        const extraFixed = {}, extraDaily = {};
        const set = (col, row, value) => {
            if (value !== null && value !== undefined && value !== '' && Number.isFinite(number(value))) cells[col + row] = number(value);
        };
        reference.columns.forEach((column, index) => {
            const col = column.letter, key = scenarios[index];
            const fixed = options.fixed?.configurations?.[key] || options.fixed?.[key] || {};
            const entries = fixed.entries || {};
            const sleep = options.sleep?.[key] || {};
            const battery = options.battery || {};
            // Preserve the differences between PIE cases when the main battery is edited.
            for (const [field, row, factor] of [['capacityAh', 8, 1], ['startingSoc', 10, 0.01], ['minimumSoc', 11, 0.01]]) {
                if (battery[field] !== undefined) set(col, row, number(battery[field]) * factor
                    + column.cells[col + row] - reference.columns[0].cells['E' + row]);
            }
            set(col, 15, options.vehicle?.count ?? battery.vehicleSleepCount);
            set(col, 16, options.vehicle?.energyAh ?? battery.vehicleSleepEnergyAh);
            for (const [field, row] of Object.entries({ wakePeriodHours: 91, wakeDurationSeconds: 92,
                wakeCurrentMa: 93, wakeCellBalancingDurationSeconds: 94, wakeCellBalancingCurrentMa: 95 })) {
                set(col, row, options.wake?.[field] ?? battery[field]);
            }
            if (cells[col + 91] <= 0) set(col, 96, 0);
            Object.entries(fixedRows).forEach(([id, [currentRow, durationRow, energyRow]]) => {
                const entry = entries[id];
                if (entry) {
                    set(col, currentRow, entry.current);
                    const sourceUnit = ({ pcuSecure: 's', cdcGarage: 'min', cdcSecure: 'min', fota: 'min',
                        cellBalancing: 's', handFree3: 'jours', handFree48: 'jours', blm: 'jours', smartAntenna: 'jours' })[id] || 'h';
                    const hours = { h: 1, s: 1 / 3600, min: 1 / 60, jours: 24 };
                    set(col, durationRow, number(entry.duration) * (hours[entry.unit || sourceUnit] / hours[sourceUnit]));
                    if (id === 'cellBalancing') {
                        set(col, 19, entry.extra?.periodMin);
                        set(col, 23, entry.extra?.balancingDays);
                    }
                    if (id === 'smartAntenna') {
                        set(col, 50, entry.extra?.drxCurrent); set(col, 52, entry.extra?.drxDays); set(col, 54, entry.extra?.remoteEnergy);
                    }
                }
                if (options.deletedFixed?.includes(id)) set(col, energyRow, 0);
            });
            if (report !== 'Customer') {
                // Without unplug: these functions draw continuously (row 106), not as fixed energy.
                set(col, 27, 0); set(col, 35, 0); set(col, 48, 0);
            }
            if (options.dailyAh !== undefined) {
                set(col, 88, options.dailyAh / 24 * 1000);
                set(col, 89, options.dailyAh);
            }
            if (report === 'Customer') set(col, 106, sleep.sansEbdu);
            // PIE's rows 109/112/115 are case surconsumptions, not alarm/AID/tachy settings.
            if (report !== 'CustomerPIE') {
                set(col, 109, sleep.alarm); set(col, 112, sleep.aid); set(col, 115, sleep.tachy);
            }
            if (sleep.agingSoc !== undefined) set(col, 118, number(sleep.agingSoc) / 100);
            for (const [id, row] of [['sansEbdu', 107], ['aging', 119],
                ...(report === 'CustomerPIE' ? [] : [['alarm', 110], ['aid', 113], ['tachy', 116]])]) {
                if (options.deletedSleep?.includes(id)) set(col, row, 0);
            }
            extraFixed[col] = (fixed.custom || []).reduce((total, entry) => total + number(entry.current || 0) / 1000
                * number(entry.duration || 0) * ({ h: 1, min: 1 / 60, s: 1 / 3600, jours: 24 }[entry.unit] || 0), 0);
            extraDaily[col] = (options.customSleep || []).reduce((total, entry) => total
                + number(entry.values?.[key] ?? entry.current ?? 0) / 1000 * 24, 0);
        });
        const cache = {}, visiting = new Set();
        function value(address) {
            if (address in cache) return cache[address];
            if (visiting.has(address)) throw new Error(`Circular reference: ${address}`);
            visiting.add(address);
            const raw = cells[address] ?? 0;
            let result = typeof raw === 'string' ? arithmetic(raw, value) : raw;
            if (address.endsWith('86')) result -= extraFixed[address[0]] || 0;
            if (address.endsWith('121')) result += extraDaily[address[0]] || 0;
            visiting.delete(address);
            return cache[address] = result;
        }
        return reference.columns.map((column, index) => ({
            key: scenarios[index], label: column.label,
            value: row => value(column.letter + row),
            available: value(column.letter + 86), dailyAh: value(column.letter + 121),
            autonomy: value(column.letter + 121) > 0 ? Math.max(0, value(column.letter + 86)) / value(column.letter + 121) : null
        }));
    }
    window.CustomerAutonomy = { calculate };
})();
