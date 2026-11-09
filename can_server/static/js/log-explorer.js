(() => {
    const form = document.getElementById('logFilterForm');
    const status = document.getElementById('logSearchStatus');
    const charts = [];
    const states = Object.fromEntries(['A', 'B'].map(channel => [channel, {page: 0, totalPages: 0}]));
    let applied = null, busy = false, appliedForm = null;
    const archive = window.dashboardArchive;
    function archiveUrl(url) {
        const result = new URL(url, location.href);
        if (archive) result.searchParams.set('saved_dashboard_id', archive.id);
        return result;
    }
    window.getDashboardExplorerState = () => {
        if (busy) throw new Error('Attendez la fin de la recherche avant d\u2019enregistrer.');
        return {filters: applied ? [...applied] : null, form: appliedForm,
                pages: Object.fromEntries(['A', 'B'].map(c => [c, states[c].page]))};
    };
    const esc = value => { const node = document.createElement('span'); node.textContent = value ?? ''; return node.innerHTML; };
    const number = value => new Intl.NumberFormat('fr-FR', {maximumSignificantDigits: 10}).format(value);
    const unitName = unit => unit === 'uA' ? 'µA' : unit;
    const scale = unit => ({A: 1, mA: 1000, uA: 1000000})[unit];
    // Round once in integer microseconds before splitting seconds and fraction.
    function timestampParts(timestamp) {
        const micros = Math.round(timestamp * 1e6);
        const seconds = Math.floor(micros / 1e6);
        const date = new Date(seconds * 1000);
        return [date.toLocaleDateString('fr-FR'), `${date.toLocaleTimeString('fr-FR', {hour12: false})}.${String(micros - seconds * 1e6).padStart(6, '0')}`];
    }
    const sourceName = source => String(source || '').replace(/^can_[a-f0-9]+_\d+_/, '');
    async function readJson(url) {
        const response = await fetch(url, {cache: 'no-store'});
        const data = await response.json();
        if (!response.ok) throw new Error(data.message || 'Lecture des mesures impossible.');
        return data;
    }
    async function refreshCatalog() {
        const data = await readJson(archiveUrl(window.logExplorerEndpoints.catalog));
        const source = document.getElementById('logSource'), day = document.getElementById('logDay');
        const sources = [...new Set(data.sources.map(item => item.source_file).filter(Boolean))];
        source.innerHTML = '<option value="">Tous les fichiers</option>' + sources.map(value => `<option value="${esc(value)}">${esc(sourceName(value))}</option>`).join('');
        day.innerHTML = '<option value="">Tous les jours</option>' + data.days.map(value => `<option value="${value}">${esc(value.split('-').reverse().join('/'))}</option>`).join('');
        status.textContent = data.sources.length ? `${number(data.sources.reduce((sum, item) => sum + item.samples, 0))} mesures disponibles sur ${number(data.days.length)} jour(s). Lancez une recherche.` : 'Importez des fichiers ASC pour explorer leurs mesures.';
    }
    function filters() {
        const params = new URLSearchParams(new FormData(form));
        for (const key of ['start', 'end']) {
            const value = params.get(key);
            if (value) {
                // Date uses milliseconds; preserve any extra microsecond digits.
                const fraction = (value.split('.')[1] || '').padEnd(6, '0').slice(0, 6);
                params.set(key, new Date(value.split('.')[0]).getTime() / 1000 + Number(fraction) / 1e6);
            } else params.delete(key);
        }
        return params;
    }
    function renderCharts(data, params) {
        charts.splice(0).forEach(chart => chart.destroy());
        const area = document.getElementById('logGraphArea');
        const container = document.getElementById('logCharts');
        area.hidden = params.get('graph') !== '1';
        container.replaceChildren();
        if (area.hidden) return;
        for (const channel of ['A', 'B']) {
            const points = (data.series || []).filter(item => item.channel === channel);
            if (!points.length) continue;
            const panel = document.createElement('article'); panel.className = 'explorer-chart';
            panel.innerHTML = `<h3>Canal ${channel} · branche ${channel}</h3><div class="explorer-canvas"><canvas aria-label="Courant canal ${channel}"></canvas></div>`;
            container.append(panel);
            const color = channel === 'A' ? '#2563eb' : '#c15b17';
            const factor = scale(params.get('unit'));
            const chartPoints = key => points.flatMap((item, index) => {
                const point = {x: (item.start + item.end) * 500, y: item[key] * factor, interval: item};
                // Missing buckets are gaps in acquisition, not interpolated current.
                return index && item.bucket > points[index - 1].bucket + 1
                    ? [{x: (points[index - 1].end + item.start) * 500, y: null}, point]
                    : [point];
            });
            charts.push(new Chart(panel.querySelector('canvas'), {
                type: 'line',
                data: {datasets: [['minimum', 'Minimum', false], ['maximum', 'Maximum', '-1'], ['average', 'Moyenne', false]].map(([key, label, fill]) => ({
                    label, data: chartPoints(key),
                    borderColor: color, backgroundColor: channel === 'A' ? '#2563eb22' : '#c15b1722',
                    borderWidth: key === 'average' ? 2 : 1, pointRadius: points.length < 20 ? 3 : 0, fill, tension: 0, spanGaps: false
                }))},
                options: {responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
                    interaction: {intersect: false, mode: 'index'},
                    scales: {x: {type: 'linear', ticks: {maxTicksLimit: 6, callback: value => new Date(value).toLocaleString('fr-FR')}, title: {display: true, text: 'Date et heure locales'}}, y: {title: {display: true, text: `Courant (${unitName(params.get('unit'))})`}}},
                    plugins: {tooltip: {callbacks: {title: items => {const item = items[0].raw.interval; return item ? `${new Date(item.start * 1000).toLocaleString('fr-FR')} → ${new Date(item.end * 1000).toLocaleString('fr-FR')} · ${number(item.samples)} mesures` : '';}}}}
                }
            }));
        }
    }
    function navigation() {
        for (const channel of ['A', 'B']) {
            const state = states[channel];
            const noPages = state.totalPages === 0;
            for (const id of ['logFirst', 'logPrevious']) document.getElementById(`${id}${channel}`).disabled = busy || noPages || state.page === 0;
            for (const id of ['logNext', 'logLast']) document.getElementById(`${id}${channel}`).disabled = busy || noPages || state.page >= state.totalPages - 1;
            const input = document.getElementById(`logPageInput${channel}`);
            input.disabled = busy || noPages;
            input.max = Math.max(1, state.totalPages);
            input.value = noPages ? 1 : state.page + 1;
            document.getElementById(`logGo${channel}`).disabled = busy || noPages;
        }
    }
    async function loadChannel(channel, targetPage, graph) {
        const state = states[channel];
        const params = new URLSearchParams(applied);
        params.set('channel', channel);
        if (!graph) params.delete('graph');
        params.set('page', targetPage + 1);
        const data = await readJson(archiveUrl(`${window.logExplorerEndpoints.search}?${params}`));
        state.page = Math.max(0, data.page - 1); state.totalPages = data.total_pages;
        document.getElementById(`logCurrentHeading${channel}`).textContent = `Courant (${unitName(applied.get('unit'))})`;
        document.getElementById(`logRows${channel}`).innerHTML = data.rows.length ? data.rows.map(item => {
            const [date, time] = timestampParts(item.timestamp);
            return `<tr><td>${date}</td><td class="timestamp-cell">${time}</td><td class="current-cell">${number(item.current_A * scale(applied.get('unit')))}</td></tr>`;
        }).join('') : '<tr><td colspan="3" class="empty-results">Aucune mesure sur cette période pour ce canal.</td></tr>';
        document.getElementById(`logPage${channel}`).textContent = `Page ${number(data.page)} sur ${number(data.total_pages)} · ${number(data.total_samples)} mesures`;
        const period = data.period;
        document.getElementById(`logPeriod${channel}`).textContent = period?.samples
            ? `${number(period.samples)} mesures · première : ${timestampParts(period.start).join(' ')} · dernière : ${timestampParts(period.end).join(' ')}.`
            : 'Aucune mesure pour ce canal dans les filtres choisis.';
        return data;
    }
    async function search(channel = null, targetPage = 0, restore = null) {
        if (busy) return;
        busy = true;
        document.getElementById('logSearch').disabled = true;
        navigation(); form.setAttribute('aria-busy', 'true');
        status.textContent = 'Recherche en cours…';
        try {
            if (!channel) {
                applied = restore?.filters ? new URLSearchParams(restore.filters) : filters();
                appliedForm = restore?.form || [...new FormData(form)];
                const selected = applied.get('channel');
                const channels = ['A', 'B'].filter(value => selected === 'AB' || selected === value);
                for (const value of ['A', 'B']) {
                    states[value] = {page: 0, totalPages: 0};
                    document.getElementById(`logChannel${value}`).hidden = !channels.includes(value);
                }
                const results = await Promise.all(channels.map(value => loadChannel(value, restore?.pages?.[value] || 0, true)));
                renderCharts({series: results.flatMap(data => data.series || [])}, applied);
            } else await loadChannel(channel, targetPage, false);
            status.textContent = 'Mesures réelles en ordre chronologique, séparées par canal. Chaque tableau se termine à la dernière mesure de son canal.';
        } catch (error) { status.textContent = error.message; }
        finally {
            busy = false; navigation();
            document.getElementById('logSearch').disabled = false;
            form.removeAttribute('aria-busy');
        }
    }
    form.addEventListener('submit', event => {event.preventDefault(); search();});
    form.addEventListener('change', () => { if (!busy) status.textContent = 'Filtres modifiés. Relancez la recherche.'; });
    for (const channel of ['A', 'B']) {
        document.getElementById(`logNext${channel}`).addEventListener('click', () => search(channel, states[channel].page + 1));
        document.getElementById(`logPrevious${channel}`).addEventListener('click', () => search(channel, states[channel].page - 1));
        document.getElementById(`logFirst${channel}`).addEventListener('click', () => search(channel, 0));
        document.getElementById(`logLast${channel}`).addEventListener('click', () => search(channel, states[channel].totalPages - 1));
        document.getElementById(`logPageForm${channel}`).addEventListener('submit', event => {
            event.preventDefault();
            const input = document.getElementById(`logPageInput${channel}`);
            const page = Number(input.value);
            if (!input.reportValidity() || !Number.isInteger(page) || page < 1 || page > states[channel].totalPages) return;
            search(channel, page - 1);
        });
    }
    document.getElementById('logReset').addEventListener('click', () => {if (!busy) {form.reset(); search();}});
    window.addEventListener('can-database-changed', () => {
        if (busy) return;
        for (const channel of ['A', 'B']) {
            states[channel] = {page: 0, totalPages: 0};
            document.getElementById(`logRows${channel}`).innerHTML = '<tr><td colspan="3" class="empty-results">Base actualisée. Relancez la recherche.</td></tr>';
            document.getElementById(`logPeriod${channel}`).textContent = '';
            document.getElementById(`logPage${channel}`).textContent = 'Page 0 sur 0';
        }
        navigation();
        charts.splice(0).forEach(chart => chart.destroy());
        document.getElementById('logGraphArea').hidden = true;
        refreshCatalog().catch(error => {status.textContent = error.message;});
    });
    refreshCatalog().then(async () => {
        const saved = archive?.state;
        if (saved?.form) {
            for (const field of form.elements) {
                if (!field.name) continue;
                const value = saved.form.find(pair => pair[0] === field.name)?.[1];
                if (field.type === 'checkbox') field.checked = value !== undefined;
                else if (value !== undefined) field.value = value;
            }
        }
        if (saved?.filters) await search(null, 0, saved);
    }).catch(error => {status.textContent = error.message;});
})();
