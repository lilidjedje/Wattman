/* Calibration INA226 ↔ Fluke 287 : saisie, analyse et dashboards. */
(function () {
    'use strict';
    const config = window.calibrationConfig;
    const api = config.api;
    const $ = id => document.getElementById(id);
    const UNITS = {A: 1, mA: 1e3, 'µA': 1e6};
    const DIGITS = {A: 6, mA: 3, 'µA': 1};
    const STATUS = {
        pass: ['Conforme', 'Écart ≤ incertitude du Fluke'],
        warning: ['À surveiller', 'Écart ≤ Fluke + limite INA226 non calibré'],
        fail: ['Hors tolérance', 'Écart au-delà des limites'],
        missing: ['Incomplet', 'Relevé ou données manquants'],
    };
    const state = {
        unit: storeGet('cal.unit') || 'mA',
        tab: 'input',
        sources: [],
        campaigns: [],
        campaign: null,
        analysis: null,
        overview: null,
        hiddenRuns: new Set(),
        charts: {},
        saveTimers: {},
        analysisTimer: null,
    };

    function storeGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
    function storeSet(key, value) { try { localStorage.setItem(key, value); } catch { /* indisponible */ } }
    function escapeHtml(value) {
        const node = document.createElement('span');
        node.textContent = value ?? '';
        return node.innerHTML;
    }
    const css = name => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const series = index => css(`--rg-series-${(index % 7) + 1}`) || ['#1f5fbf', '#d55e00', '#009e73', '#cc79a7', '#8a6d00', '#56b4e9', '#5c5f66'][index % 7];
    const alpha = (color, a) => {
        const hex = color.replace('#', '');
        if (hex.length !== 6) return color;
        const n = parseInt(hex, 16);
        return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
    };
    const nf = (digits = 0) => new Intl.NumberFormat('fr-FR', {minimumFractionDigits: digits, maximumFractionDigits: digits});
    const conv = amps => amps == null ? null : amps * UNITS[state.unit];
    function amps(value, digits = DIGITS[state.unit]) {
        if (value == null || !Number.isFinite(value)) return '—';
        return `${nf(digits).format(value * UNITS[state.unit])} ${state.unit}`;
    }
    function signed(value, digits = DIGITS[state.unit]) {
        if (value == null || !Number.isFinite(value)) return '—';
        return `${value > 0 ? '+' : ''}${amps(value, digits)}`;
    }
    const pct = (value, digits = 2) => value == null || !Number.isFinite(value) ? '—' : `${nf(digits).format(value)} %`;
    const count = value => value == null ? '—' : nf(0).format(value);
    const parseInput = text => {
        const cleaned = String(text ?? '').replace(/\s/g, '').replace(',', '.');
        if (!cleaned) return null;
        const number = Number(cleaned);
        return Number.isFinite(number) ? number : NaN;
    };
    const toAmps = text => {
        const number = parseInput(text);
        return number == null || Number.isNaN(number) ? number : number / UNITS[state.unit];
    };
    const fromAmps = value => value == null ? '' : String(+(value * UNITS[state.unit]).toPrecision(10)).replace('.', ',');
    function duration(seconds) {
        const total = Math.max(0, Math.round(seconds));
        const minutes = Math.floor(total / 60);
        return minutes ? `${minutes} min ${String(total % 60).padStart(2, '0')} s` : `${total} s`;
    }
    async function request(url, options = {}) {
        const response = await fetch(url, {cache: 'no-store', ...options,
            headers: options.body ? {'Content-Type': 'application/json'} : undefined});
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || data.message || `Erreur ${response.status}`);
        return data;
    }
    function flash(element, text, type = 'ok') {
        element.hidden = !text;
        element.textContent = text;
        element.className = `message ${type}`;
    }

    // ------------------------------------------------------------------ Graphiques
    const errorBarsPlugin = {
        id: 'calErrorBars',
        afterDatasetsDraw(chart) {
            const {ctx} = chart;
            chart.data.datasets.forEach((dataset, index) => {
                if (!dataset.errorBars || !chart.isDatasetVisible(index)) return;
                const meta = chart.getDatasetMeta(index);
                ctx.save();
                ctx.strokeStyle = dataset.borderColor;
                ctx.lineWidth = 1.5;
                meta.data.forEach((point, i) => {
                    const bar = dataset.errorBars[i];
                    if (!bar || bar.low == null || bar.high == null) return;
                    const y1 = chart.scales.y.getPixelForValue(bar.low);
                    const y2 = chart.scales.y.getPixelForValue(bar.high);
                    ctx.beginPath();
                    ctx.moveTo(point.x, y1); ctx.lineTo(point.x, y2);
                    ctx.moveTo(point.x - 5, y1); ctx.lineTo(point.x + 5, y1);
                    ctx.moveTo(point.x - 5, y2); ctx.lineTo(point.x + 5, y2);
                    ctx.stroke();
                });
                ctx.restore();
            });
        }
    };

    function chart(id, build) {
        const canvas = $(id);
        if (!canvas || canvas.offsetParent === null) return;
        const spec = build();
        const existing = state.charts[id];
        if (existing) {
            existing.data = spec.data;
            existing.options = spec.options;
            existing.update('none');
            return;
        }
        state.charts[id] = new Chart(canvas, {type: 'line', ...spec, plugins: [errorBarsPlugin, ...(spec.plugins || [])]});
    }
    function baseOptions(xTitle, yTitle, extra = {}) {
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: {duration: 350},
            interaction: {mode: 'nearest', intersect: false},
            plugins: {
                legend: {position: 'bottom', labels: {usePointStyle: true, boxWidth: 8}},
                title: {display: false},
                tooltip: {callbacks: {}},
            },
            scales: {
                x: {type: 'linear', title: {display: true, text: xTitle}},
                y: {title: {display: true, text: yTitle}},
            },
            ...extra,
        };
    }
    function hline(label, value, xMin, xMax, color, dash = [6, 4]) {
        return {type: 'line', label, data: [{x: xMin, y: value}, {x: xMax, y: value}], borderColor: color,
            borderDash: dash, borderWidth: 1.5, pointRadius: 0, fill: false};
    }

    // ------------------------------------------------------------------ Protocole
    const form = $('protocolForm');
    // INA226 : LSB tension shunt 2,5 µV, pleine échelle ±81,92 mV.
    const INA_LSB_V = 2.5e-6;
    const INA_FULL_SCALE_V = 0.08192;
    /** « R100 » = 0,100 Ω, « R010 » = 0,010 Ω, « 2R5 » = 2,5 Ω, « 10m » / « 10 mΩ » = 0,010 Ω, « 0,01 » = 0,01 Ω. */
    function parseShunt(text) {
        const raw = String(text ?? '').trim().replace(/\s/g, '').replace(',', '.').replace(/Ω|ohms?$/i, '');
        if (!raw) return NaN;
        let match = raw.match(/^(\d*)R(\d*)$/i);
        if (match && (match[1] || match[2])) return Number(`${match[1] || '0'}.${match[2] || '0'}`);
        match = raw.match(/^(\d+(?:\.\d+)?)m$/i);
        if (match) return Number(match[1]) / 1000;
        const value = Number(raw);
        return Number.isFinite(value) ? value : NaN;
    }
    function shuntCode(ohms) {
        if (!(ohms > 0)) return '';
        if (ohms < 1) {
            const fixed = ohms.toFixed(3);
            if (Math.abs(Number(fixed) - ohms) < 1e-12) return `R${fixed.slice(2)}`;
            return `${String(+(ohms * 1000).toPrecision(6)).replace('.', ',')}m`;
        }
        return String(ohms).replace('.', 'R');
    }
    function physical(valueA, unitLabel = 'A') {
        const magnitude = Math.abs(valueA);
        const [factor, unit] = magnitude >= 1 ? [1, unitLabel] : magnitude >= 1e-3 ? [1e3, `m${unitLabel}`] : [1e6, `µ${unitLabel}`];
        const scaled = valueA * factor;
        const digits = Math.abs(scaled) >= 100 ? 1 : Math.abs(scaled) >= 10 ? 2 : 3;
        return `${new Intl.NumberFormat('fr-FR', {maximumFractionDigits: digits}).format(scaled)} ${unit}`;
    }
    function protocolFromForm() {
        const data = Object.fromEntries(new FormData(form));
        const shunt = parseShunt(data.shunt);
        if (!(shunt > 0)) throw new Error('Shunt invalide : saisissez un code (R100, R010, R002) ou une valeur en Ω.');
        return {
            name: data.name,
            notes: data.notes,
            protocol: {
                channel: data.channel,
                frequency_hz: data.frequency_hz,
                duration_s: data.duration_s,
                repetitions: data.repetitions,
                pause_s: data.pause_s,
                checkpoints_s: data.checkpoints_s,
                shunt_ohm: shunt,
                shunt_tolerance_pct: data.shunt_tolerance_pct,
            },
        };
    }
    function fillForm(campaign) {
        const protocol = campaign ? campaign.protocol : config.defaults;
        form.name.value = campaign ? campaign.name : '';
        form.notes.value = campaign ? campaign.notes || '' : '';
        ['channel', 'frequency_hz', 'duration_s', 'repetitions', 'pause_s', 'shunt_tolerance_pct']
            .forEach(key => { form[key].value = protocol[key]; });
        form.shunt.value = shuntCode(protocol.shunt_ohm);
        form.checkpoints_s.value = protocol.checkpoints_s.join(', ');
        $('deleteCampaign').hidden = !campaign;
        $('saveProtocol').textContent = campaign ? 'Enregistrer le protocole' : 'Créer la campagne';
        updateComputed();
    }
    function updateComputed() {
        const f = Number(form.frequency_hz.value) || 0;
        const d = Number(form.duration_s.value) || 0;
        const r = Number(form.repetitions.value) || 0;
        const p = Number(form.pause_s.value) || 0;
        const perRun = Math.round(f * d);
        const total = perRun * r;
        const totalTime = r * d + Math.max(0, r - 1) * p;
        const shunt = parseShunt(form.shunt.value);
        const validShunt = shunt > 0;
        const lsb = validShunt ? INA_LSB_V / shunt : null;
        const maxCurrent = validShunt ? INA_FULL_SCALE_V / shunt : null;
        const power = validShunt ? maxCurrent * maxCurrent * shunt : null;
        form.shunt.setCustomValidity(validShunt || !form.shunt.value ? '' : 'Code de shunt invalide');
        $('shuntHint').textContent = validShunt
            ? `${shuntCode(shunt)} = ${physical(shunt, 'Ω')}`
            : form.shunt.value ? 'Code invalide : R100, R010, R002, 2R5, 10m ou une valeur en Ω.' : '';
        $('shuntHint').classList.toggle('invalid', !validShunt && !!form.shunt.value);
        $('protocolComputed').innerHTML = `
            <div><span>Échantillons / répétition</span><strong>${count(perRun)}</strong><small>${count(d)} s × ${count(f)} Hz</small></div>
            <div><span>Échantillons au total</span><strong>${count(total)}</strong><small>${r} répétition${r > 1 ? 's' : ''}</small></div>
            <div class="cal-computed-accent"><span>Résolution INA226</span><strong>${validShunt ? `${physical(lsb)}/bit` : '—'}</strong><small>2,5 µV ÷ ${validShunt ? physical(shunt, 'Ω') : 'R shunt'}</small></div>
            <div class="cal-computed-accent"><span>Courant max mesurable</span><strong>${validShunt ? `±${physical(maxCurrent)}` : '—'}</strong><small>81,92 mV ÷ R${validShunt ? ` · ${physical(power, 'W')} dissipés` : ''}</small></div>
            <div><span>Durée du protocole</span><strong>${duration(totalTime)}</strong><small>pauses incluses</small></div>`;
        document.querySelectorAll('[data-circuit]').forEach(circuit => {
            circuit.classList.toggle('active', form.channel.value.includes(circuit.dataset.circuit));
            if (validShunt) {
                circuit.querySelector('[data-shunt-code]').textContent = `Rshunt ${shuntCode(shunt)}`;
                circuit.querySelector("[data-shunt-lsb]").textContent = `${physical(lsb)}/bit`;
            }
        });
    }
    form.addEventListener('input', updateComputed);
    form.addEventListener('submit', async event => {
        event.preventDefault();
        const button = $('saveProtocol');
        try {
            button.disabled = true;
            const payload = protocolFromForm();
            const both = payload.protocol.channel === 'AB';
            const named = channel => ({...payload, name: both ? `${(payload.name || 'Calibration').replace(/\s*·\s*canal [AB]$/i, '')} · canal ${channel}` : payload.name,
                protocol: {...payload.protocol, channel}});
            let data;
            if (state.campaign) {
                const own = both ? state.campaign.protocol.channel : payload.protocol.channel;
                data = await request(`${api.campaigns}/${state.campaign.id}`, {method: 'PUT', body: JSON.stringify(named(own))});
                if (both) await request(api.campaigns, {method: 'POST', body: JSON.stringify(named(own === 'A' ? 'B' : 'A'))});
            } else if (both) {
                data = await request(api.campaigns, {method: 'POST', body: JSON.stringify(named('A'))});
                await request(api.campaigns, {method: 'POST', body: JSON.stringify(named('B'))});
            } else {
                data = await request(api.campaigns, {method: 'POST', body: JSON.stringify(payload)});
            }
            flash($('protocolMessage'), both
                ? 'Deux campagnes créées, une par voie (A et B) : chaque circuit a ses propres relevés Fluke. Basculez de l’une à l’autre dans la liste.'
                : state.campaign ? 'Protocole enregistré.' : 'Campagne créée : reliez maintenant chaque répétition à son enregistrement.');
            await loadCampaigns();
            await openCampaign(data.campaign.id);
        } catch (error) {
            flash($('protocolMessage'), error.message, 'error');
        } finally {
            button.disabled = false;
        }
    });
    $('newCampaign').addEventListener('click', () => {
        state.campaign = null;
        state.analysis = null;
        bulk.selected.clear();
        fillForm(null);
        renderBulkSources();
        renderCampaignList();
        renderRuns();
        renderAll();
        form.name.focus();
        $('calState').textContent = 'Nouvelle campagne';
    });
    $('deleteCampaign').addEventListener('click', async () => {
        if (!state.campaign || !confirm(`Supprimer la campagne « ${state.campaign.name} » et ses relevés ? Les mesures de la base ne sont pas supprimées.`)) return;
        await request(`${api.campaigns}/${state.campaign.id}`, {method: 'DELETE'});
        state.campaign = null;
        await loadCampaigns();
        if (state.campaigns[0]) await openCampaign(state.campaigns[0].id); else $('newCampaign').click();
    });

    // ------------------------------------------------------------------ Campagnes
    async function loadCampaigns() {
        state.campaigns = (await request(api.campaigns)).campaigns;
        renderCampaignList();
    }
    function renderCampaignList() {
        $('campaignList').innerHTML = state.campaigns.length ? state.campaigns.map(campaign => `
            <button type="button" class="cal-campaign${state.campaign?.id === campaign.id ? ' active' : ''}" data-id="${campaign.id}">
                <strong>${escapeHtml(campaign.name)}</strong>
                <span>Canal ${campaign.protocol.channel} · ${campaign.protocol.repetitions} × ${count(campaign.protocol.duration_s)} s @ ${count(campaign.protocol.frequency_hz)} Hz</span>
                <small>${campaign.linked_runs}/${campaign.protocol.repetitions} répétitions reliées · ${new Date(campaign.updated_at * 1000).toLocaleString('fr-FR', {dateStyle: 'short', timeStyle: 'short'})}</small>
            </button>`).join('') : '<div class="empty-notice">Aucune campagne. Créez-en une avec le protocole ci-dessous.</div>';
    }
    $('campaignList').addEventListener('click', event => {
        const button = event.target.closest('.cal-campaign');
        if (button) openCampaign(button.dataset.id);
    });
    async function openCampaign(id) {
        state.campaign = (await request(`${api.campaigns}/${id}`)).campaign;
        storeSet('cal.campaign', id);
        fillForm(state.campaign);
        renderCampaignList();
        renderRuns();
        syncBulkFromCampaign();
        $('exportCsv').href = `${api.campaigns}/${id}/export.csv`;
        await refreshAnalysis();
    }

    // ------------------------------------------------------------------ Sources
    async function loadSources() {
        state.sources = (await request(api.sources)).sources;
        renderBulkSources();
    }
    function sourceOptions(selected) {
        const channel = state.campaign?.protocol.channel || form.channel.value;
        const items = state.sources.filter(source => source.channels[channel]);
        return `<option value="">— Choisir un enregistrement (canal ${channel}) —</option>` + items.map(source => {
            const info = source.channels[channel];
            return `<option value="${escapeHtml(source.source_file)}" ${source.source_file === selected ? 'selected' : ''}>
                ${escapeHtml(source.kind === 'digital' ? 'Numérique' : source.kind === 'asc' ? 'ASC' : 'Source')} · ${escapeHtml(source.started_label)} · ${escapeHtml(source.name)} · ${count(info.samples)} éch.</option>`;
        }).join('');
    }
    const bulk = {kind: 'all', selected: new Set()};
    function channelSources() {
        const channel = state.campaign?.protocol.channel || (form.channel.value === 'B' ? 'B' : 'A');
        return {channel, items: state.sources.filter(source => source.channels[channel]).sort((a, b) => (a.start || 0) - (b.start || 0))};
    }
    function renderBulkSources() {
        const {channel, items} = channelSources();
        const visible = items.filter(source => bulk.kind === 'all' || source.kind === bulk.kind);
        const order = [...bulk.selected].map(key => items.find(item => item.source_file === key)).filter(Boolean)
            .sort((a, b) => (a.start || 0) - (b.start || 0)).map(item => item.source_file);
        $('bulkSources').innerHTML = !state.campaign
            ? '<div class="empty-notice">Créez ou ouvrez une campagne pour choisir ses mesures.</div>'
            : visible.length ? visible.map((source, index) => {
                const info = source.channels[channel];
                const rank = order.indexOf(source.source_file);
                return `
                <label class="cal-source ${source.kind}${rank >= 0 ? ' selected' : ''}" style="--i:${Math.min(index, 12)}${rank >= 0 ? `;--run-color:${series(rank)}` : ''}">
                    <input type="checkbox" value="${escapeHtml(source.source_file)}" ${rank >= 0 ? 'checked' : ''}>
                    <span class="cal-source-rank" aria-hidden="true">${rank >= 0 ? `R${rank + 1}` : ''}</span>
                    <span class="cal-source-body">
                        <span class="cal-source-kind">${source.kind === 'digital' ? 'Numérique ESP32' : source.kind === 'asc' ? 'Log ASC' : 'Source'}</span>
                        <strong>${escapeHtml(source.kind === 'digital' ? source.started_label : source.name)}</strong>
                        <small>${source.kind === 'digital' ? '' : `${escapeHtml(source.started_label)} · `}${count(info.samples)} éch. · ${duration((info.end || 0) - (info.start || 0))}${info.frequency_hz ? ` · ${count(info.frequency_hz)} Hz` : ''}</small>
                    </span>
                </label>`;
            }).join('') : `<div class="empty-notice">Aucune mesure ${bulk.kind === 'digital' ? 'numérique ' : bulk.kind === 'asc' ? 'ASC ' : ''}sur le canal ${channel} dans la base.</div>`;
        const n = order.length;
        $('bulkSummary').textContent = n ? `${n} mesure${n > 1 ? 's' : ''} → ${n} répétition${n > 1 ? 's' : ''} (canal ${channel})` : 'Aucune mesure sélectionnée';
        $('bulkLink').disabled = !n || !state.campaign;
        $('bulkLink').textContent = n ? `Créer ${n} répétition${n > 1 ? 's' : ''}` : 'Créer les répétitions';
    }
    function syncBulkFromCampaign() {
        bulk.selected = new Set((state.campaign?.runs || []).map(run => run.source_file).filter(Boolean));
        renderBulkSources();
    }
    $('bulkSources').addEventListener('change', event => {
        if (event.target.type !== 'checkbox') return;
        if (event.target.checked) bulk.selected.add(event.target.value); else bulk.selected.delete(event.target.value);
        renderBulkSources();
    });
    document.querySelectorAll('[data-src-kind]').forEach(button => button.addEventListener('click', () => {
        bulk.kind = button.dataset.srcKind;
        document.querySelectorAll('[data-src-kind]').forEach(item => item.classList.toggle('active', item === button));
        renderBulkSources();
    }));
    $('bulkLink').addEventListener('click', async () => {
        if (!state.campaign) return;
        const {items} = channelSources();
        const chosen = items.filter(item => bulk.selected.has(item.source_file));
        if (!chosen.length) return;
        const button = $('bulkLink');
        try {
            button.disabled = true;
            button.textContent = 'Création…';
            const previous = new Map((state.campaign.runs || []).filter(run => run.source_file).map(run => [run.source_file, run]));
            await request(`${api.campaigns}/${state.campaign.id}`, {method: 'PUT', body: JSON.stringify({protocol: {repetitions: chosen.length}})});
            for (let index = 0; index < chosen.length; index++) {
                const kept = previous.get(chosen[index].source_file) || {};
                await request(`${api.campaigns}/${state.campaign.id}/runs/${index + 1}`, {method: 'PUT', body: JSON.stringify({
                    source_file: chosen[index].source_file, start_offset_s: kept.start_offset_s || 0,
                    samples_reported: kept.samples_reported ?? null, fluke_range_A: kept.fluke_range_A ?? null,
                    fluke_min_A: kept.fluke_min_A ?? null, fluke_max_A: kept.fluke_max_A ?? null,
                    ambient_c: kept.ambient_c ?? null, notes: kept.notes || '', reference: kept.reference || {},
                })});
            }
            await loadCampaigns();
            await openCampaign(state.campaign.id);
            flash($('protocolMessage'), `${chosen.length} répétition${chosen.length > 1 ? 's' : ''} créée${chosen.length > 1 ? 's' : ''} : saisissez maintenant les relevés du Fluke.`);
        } catch (error) {
            alert(error.message);
        } finally {
            renderBulkSources();
        }
    });

    // ------------------------------------------------------------------ Répétitions
    function runData(index) {
        return state.campaign?.runs.find(run => run.run_index === index) || {reference: {}};
    }
    function renderRuns() {
        const container = $('runCards');
        if (!state.campaign) {
            container.innerHTML = '<div class="empty-notice">Créez une campagne pour saisir les relevés du Fluke.</div>';
            return;
        }
        const protocol = state.campaign.protocol;
        const expected = Math.round(protocol.duration_s * protocol.frequency_hz);
        const html = [];
        for (let index = 1; index <= protocol.repetitions; index++) {
            const run = runData(index);
            html.push(`
            <article class="cal-run panel" data-run="${index}" style="--run-color:${series(index - 1)}">
                <header>
                    <span class="cal-run-badge">R${index}</span>
                    <div><h3>Répétition ${index}</h3><small>${escapeHtml(runSourceLabel(run.source_file))}</small></div>
                    <span class="cal-save-state" data-save-state></span>
                </header>
                <label class="field">Mesure en base
                    <select name="source_file">${sourceOptions(run.source_file)}</select>
                </label>
                <div class="cal-grid-2">
                    <label class="field">Début (s) <input name="start_offset_s" inputmode="decimal" value="${fromAmpsRaw(run.start_offset_s)}" placeholder="0" title="Décalage depuis le premier échantillon de la mesure"></label>
                    <label class="field">Éch. relevés <input name="samples_reported" inputmode="numeric" value="${run.samples_reported ?? ''}" placeholder="${count(expected)}"></label>
                </div>
                <div class="cal-grid-1">
                    <label class="field">Borne Fluke (entrée branchée)
                        <select name="fluke_range_A" title="Borne d’entrée du Fluke 287 sur laquelle le courant est branché. Le multimètre choisit ensuite seul le calibre (plage) de cette borne ; la précision utilisée dans les calculs en dépend.">
                            <option value="0.4" ${flukeInput(run) === 0.4 ? 'selected' : ''}>mA · 400 mA max</option>
                            <option value="10" ${flukeInput(run) === 10 ? 'selected' : ''}>A · 10 A max</option>
                        </select>
                    </label>
                </div>
                <fieldset class="cal-readings">
                    <legend>Relevés Fluke (${state.unit})</legend>
                    ${protocol.checkpoints_s.map(cp => `
                        <div class="cal-reading"><label for="ref_${index}_${cp}">I à ${count(cp)} s</label>
                            <input id="ref_${index}_${cp}" name="ref_${cp}" data-checkpoint="${cp}" inputmode="decimal" autocomplete="off" value="${fromAmps(run.reference?.[String(cp)])}">
                            <em data-cp-status="${cp}"></em>
                        </div>`).join('')}
                    <div class="cal-reading"><label for="min_${index}">MIN</label><input id="min_${index}" name="fluke_min_A" inputmode="decimal" autocomplete="off" value="${fromAmps(run.fluke_min_A)}"><em data-ext-status="min"></em></div>
                    <div class="cal-reading"><label for="max_${index}">MAX</label><input id="max_${index}" name="fluke_max_A" inputmode="decimal" autocomplete="off" value="${fromAmps(run.fluke_max_A)}"><em data-ext-status="max"></em></div>
                </fieldset>
                <div class="cal-grid-2">
                    <label class="field">Ambiante (°C) <input name="ambient_c" inputmode="decimal" value="${fromAmpsRaw(run.ambient_c)}"></label>
                    <label class="field">Notes <input name="notes" value="${escapeHtml(run.notes || '')}"></label>
                </div>
                <div class="cal-run-live" data-live></div>
            </article>`);
        }
        container.innerHTML = html.join('');
        renderRunLive();
    }
    function flukeInput(run) {
        if (run.fluke_range_A != null) return run.fluke_range_A > 0.4 + 1e-12 ? 10 : 0.4;
        const readings = [...Object.values(run.reference || {}), run.fluke_min_A, run.fluke_max_A].filter(v => v != null).map(Math.abs);
        return readings.length && Math.max(...readings) > 0.4 ? 10 : 0.4;
    }
    function runSourceLabel(key) {
        if (!key) return 'Aucune mesure reliée';
        const source = state.sources.find(item => item.source_file === key);
        if (!source) return key;
        return source.kind === 'digital' ? `Numérique ESP32 · ${source.started_label}` : `Log ASC · ${source.name} · ${source.started_label}`;
    }
    function fromAmpsRaw(value) { return value == null ? '' : String(+Number(value).toFixed(3)).replace('.', ','); }
    function collectRun(card) {
        const field = name => card.querySelector(`[name="${name}"]`);
        const reference = {};
        card.querySelectorAll('[data-checkpoint]').forEach(input => {
            const value = toAmps(input.value);
            if (Number.isNaN(value)) throw new Error(`Valeur invalide à ${input.dataset.checkpoint} s.`);
            if (value != null) reference[input.dataset.checkpoint] = value;
        });
        const number = (name, convert) => {
            const raw = field(name).value;
            const value = convert ? toAmps(raw) : parseInput(raw);
            if (Number.isNaN(value)) throw new Error(`Valeur invalide : ${name}.`);
            return value;
        };
        return {
            source_file: field('source_file').value || null,
            start_offset_s: number('start_offset_s'),
            samples_reported: field('samples_reported').value.replace(/\s/g, '') || null,
            fluke_range_A: field('fluke_range_A').value || null,
            fluke_min_A: number('fluke_min_A', true),
            fluke_max_A: number('fluke_max_A', true),
            ambient_c: number('ambient_c'),
            notes: field('notes').value,
            reference,
        };
    }
    async function saveRun(index, silent = false) {
        const card = document.querySelector(`.cal-run[data-run="${index}"]`);
        const status = card.querySelector('[data-save-state]');
        try {
            status.textContent = 'Enregistrement…';
            status.className = 'cal-save-state saving';
            const data = await request(`${api.campaigns}/${state.campaign.id}/runs/${index}`, {
                method: 'PUT', body: JSON.stringify(collectRun(card))
            });
            state.campaign = data.campaign;
            status.textContent = 'Enregistré';
            status.className = 'cal-save-state saved';
            if (!silent) scheduleAnalysis();
            loadCampaigns();
        } catch (error) {
            status.textContent = error.message;
            status.className = 'cal-save-state failed';
        }
    }
    $('runCards').addEventListener('input', event => {
        const card = event.target.closest('.cal-run');
        if (!card) return;
        const index = Number(card.dataset.run);
        card.querySelector('[data-save-state]').textContent = 'Modifié…';
        clearTimeout(state.saveTimers[index]);
        state.saveTimers[index] = setTimeout(() => saveRun(index), event.target.tagName === 'SELECT' ? 0 : 700);
    });
    $('runCards').addEventListener('change', event => {
        if (event.target.tagName !== 'SELECT') return;
        const card = event.target.closest('.cal-run');
        const index = Number(card.dataset.run);
        clearTimeout(state.saveTimers[index]);
        saveRun(index);
    });

    function renderRunLive() {
        if (!state.analysis) return;
        state.analysis.runs.forEach(run => {
            const card = document.querySelector(`.cal-run[data-run="${run.run_index}"]`);
            if (!card) return;
            const live = card.querySelector('[data-live]');
            if (!run.has_data) {
                live.innerHTML = '<span class="cal-muted">Aucune donnée liée pour cette fenêtre.</span>';
            } else {
                const completeness = Math.min(100, run.completeness_pct || 0);
                const tone = completeness >= 99 ? 'ok' : completeness >= 95 ? 'warn' : 'bad';
                live.innerHTML = `
                    <div class="cal-meter ${tone}" title="Complétude"><span style="width:${completeness}%"></span></div>
                    <div class="cal-live-grid">
                        <span><b>${count(run.samples)}</b> / ${count(run.samples_expected)} en base (${pct(run.completeness_pct, 1)})</span>
                        <span>Relevé : <b>${count(run.samples_reported)}</b>${run.reported_vs_db ? ` <em class="cal-delta">${run.reported_vs_db > 0 ? '+' : ''}${count(run.reported_vs_db)}</em>` : ''}</span>
                        <span>Moyenne <b>${amps(run.mean_A)}</b></span>
                        <span>σ <b>${amps(run.std_A)}</b></span>
                        <span>Min <b>${amps(run.min_A)}</b> · Max <b>${amps(run.max_A)}</b></span>
                        <span>Dérive <b>${signed(run.drift_A_per_min)}</b>/min</span>
                    </div>`;
            }
            run.checkpoints.forEach(cp => {
                const slot = card.querySelector(`[data-cp-status="${cp.t_s}"]`);
                if (!slot) return;
                slot.className = `cal-pill ${cp.status}`;
                slot.textContent = cp.error_A != null ? `${signed(cp.error_A)} · INA ${amps(cp.ina_mean_A)}` : (cp.ina_mean_A != null ? `INA ${amps(cp.ina_mean_A)}` : '');
                slot.title = cp.error_A != null ? `${STATUS[cp.status][0]} — limite Fluke ±${amps(cp.reference_limit_A)} (${cp.reference_formula})` : '';
            });
            (run.extremes || []).forEach(extreme => {
                const slot = card.querySelector(`[data-ext-status="${extreme.kind}"]`);
                if (!slot) return;
                slot.className = 'cal-pill neutral';
                slot.textContent = extreme.error_raw_A != null
                    ? `brut ${signed(extreme.error_raw_A)} · lissé ${signed(extreme.error_smoothed_A)}`
                    : `INA ${amps(extreme.ina_raw_A)}`;
            });
        });
        const first = state.analysis.runs.find(run => run.checkpoints.some(cp => cp.reference_A != null));
        const reading = first?.checkpoints.find(cp => cp.reference_A != null)?.reference_A;
        ['A', 'B'].forEach(channel => {
            $(`schematicReading${channel}`).textContent = channel === state.analysis.protocol.channel && reading != null
                ? amps(reading, state.unit === 'A' ? 4 : 2) : `— ${state.unit}`;
        });
    }

    // ------------------------------------------------------------------ Analyse
    function scheduleAnalysis(delay = 500) {
        clearTimeout(state.analysisTimer);
        state.analysisTimer = setTimeout(refreshAnalysis, delay);
    }
    async function refreshAnalysis() {
        if (!state.campaign) return;
        $('calState').textContent = 'Analyse…';
        try {
            state.analysis = (await request(`${api.campaigns}/${state.campaign.id}/analysis`)).analysis;
            const summary = state.analysis.summary;
            $('calState').textContent = `${count(summary.samples_total)} échantillons analysés`;
            renderAll();
            loadOverview();
        } catch (error) {
            $('calState').textContent = error.message;
        }
    }
    async function loadOverview() {
        if (!state.campaign) return;
        state.overview = await request(`${api.overview}?channel=${state.campaign.protocol.channel}`);
        if (state.tab === 'levels') renderLevels();
    }
    function renderAll() {
        renderRunLive();
        renderSummary();
        renderTab();
    }
    function renderTab() {
        if (!state.analysis) return;
        ({time: renderTime, errors: renderErrors, noise: renderNoise, sampling: renderSampling, levels: renderLevels}[state.tab] || (() => {}))();
    }

    function kpi(label, value, detail = '', tone = '') {
        return `<div class="cal-kpi ${tone}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></div>`;
    }
    function renderSummary() {
        const analysis = state.analysis;
        if (!analysis) {
            $('verdict').innerHTML = '';
            $('kpis').innerHTML = '<div class="empty-notice">Ouvrez ou créez une campagne.</div>';
            $('tips').innerHTML = '';
            return;
        }
        const s = analysis.summary;
        const [title, detail] = STATUS[s.verdict] || STATUS.missing;
        $('verdict').className = `cal-verdict ${s.verdict}`;
        $('verdict').innerHTML = `
            <div class="cal-verdict-ring"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15.9" pathLength="100"/><circle class="arc" cx="18" cy="18" r="15.9" pathLength="100" style="stroke-dasharray:${s.checkpoints_with_reference ? Math.round(100 * (s.pass_count || 0) / s.checkpoints_with_reference) : 0} 100"/></svg>
            <b>${s.checkpoints_with_reference ? `${s.pass_count || 0}/${s.checkpoints_with_reference}` : '—'}</b></div>
            <div><p class="eyebrow">Verdict de la campagne · canal ${analysis.protocol.channel}</p><h2>${title}</h2><p>${detail}${s.checkpoints_with_reference ? ` · ${s.warning_count} à surveiller · ${s.fail_count} hors tolérance` : ''}</p></div>`;
        const lsb = 2.5e-6 / analysis.protocol.shunt_ohm;
        $('kpis').innerHTML = [
            kpi('Biais (offset)', signed(s.offset_A), s.offset_u95_A != null ? `U95 ±${amps(s.offset_u95_A)}` : 'saisissez les relevés', s.offset_A == null ? '' : Math.abs(s.offset_A) <= (s.reference_limit_A || 0) ? 'ok' : 'bad'),
            kpi('Erreur max |E|', amps(s.error_max_abs_A), `RMS ${amps(s.error_rms_A)}`),
            kpi('Incertitude Fluke', s.reference_limit_A != null ? `±${amps(s.reference_limit_A)}` : '—', s.reference_mean_A != null ? `au niveau ${amps(s.reference_mean_A)}` : ''),
            kpi('Limite INA226 brute', s.ina_limit_A != null ? `±${amps(s.ina_limit_A)}` : '—', 'offset + gain + shunt (datasheet)'),
            kpi('Bruit σ', amps(s.noise_pooled_A), `${nf(2).format((s.noise_pooled_A || 0) / lsb)} LSB (LSB = ${amps(lsb)})`),
            kpi('Dérive', s.drift_mean_A_per_min != null ? `${signed(s.drift_mean_A_per_min)}/min` : '—', 'pente moyenne des répétitions'),
            kpi('Complétude', pct(s.completeness_pct, 1), `${count(s.samples_total)} / ${count(s.samples_expected_total)} éch.`, s.completeness_pct == null ? '' : s.completeness_pct >= 99 ? 'ok' : s.completeness_pct >= 95 ? 'warn' : 'bad'),
            kpi('Moyennage optimal', s.allan_best_tau_s != null ? `${nf(2).format(s.allan_best_tau_s)} s` : '—', s.allan_best_adev_A != null ? `σ Allan ${amps(s.allan_best_adev_A)}` : 'écart-type d’Allan'),
            kpi('Reproductibilité', amps(s.run_mean_spread_A), 'écart-type des moyennes'),
        ].join('');
        $('tips').innerHTML = s.recommendations.length ? s.recommendations.map(tip => `
            <li class="cal-tip ${tip.level}"><strong>${escapeHtml(tip.title)}</strong><p>${escapeHtml(tip.text)}</p></li>`).join('')
            : '<li class="cal-tip info"><strong>Rien à signaler</strong><p>Ajoutez des relevés pour obtenir des recommandations.</p></li>';

        table('runTable', ['Répétition', 'Source', 'Éch. base', 'Éch. relevés', 'Complétude', 'Moyenne', 'Médiane', 'σ', 'Min', 'Max', 'Crête-crête', 'P0,5–P99,5', 'Dérive /min', 'R² dérive', 'Biais moyen'],
            analysis.runs.map(run => run.has_data ? [
                `R${run.run_index}`, sourceName(run.source_file), count(run.samples), count(run.samples_reported), pct(run.completeness_pct, 1),
                amps(run.mean_A), amps(run.median_A), amps(run.std_A), amps(run.min_A), amps(run.max_A), amps(run.p2p_A),
                `${amps(run.p01_A)} → ${amps(run.p99_A)}`, signed(run.drift_A_per_min), nf(3).format(run.drift_r2 ?? 0), signed(run.error_mean_A),
            ] : [`R${run.run_index}`, 'non reliée', '0', count(run.samples_reported), '—', '—', '—', '—', '—', '—', '—', '—', '—', '—', '—']));
        table('checkpointTable', ['Répétition', 'Instant', 'Fluke', 'INA (moyenne)', 'σ fenêtre', 'Éch.', 'Erreur', 'Erreur %', 'Limite Fluke', 'Eₙ', 'Statut'],
            analysis.runs.flatMap(run => run.checkpoints.map(cp => [
                `R${run.run_index}`, `${count(cp.t_s)} s`, amps(cp.reference_A), amps(cp.ina_mean_A), amps(cp.ina_std_A), count(cp.samples),
                signed(cp.error_A), pct(cp.error_pct, 3), cp.reference_limit_A != null ? `±${amps(cp.reference_limit_A)}` : '—',
                cp.normalized_error != null ? nf(2).format(cp.normalized_error) : '—',
                `<span class="cal-pill ${cp.status}">${STATUS[cp.status][0]}</span>`,
            ])), true);
    }
    function sourceName(key) {
        const source = state.sources.find(item => item.source_file === key);
        return source ? `${source.kind === 'digital' ? 'Numérique' : 'ASC'} · ${source.started_label}` : (key || '—');
    }
    function table(id, headers, rows, html = false) {
        const element = $(id);
        if (!element.tHead || element.tHead.rows[0].cells.length !== headers.length) {
            element.innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody></tbody>`;
        }
        element.tBodies[0].innerHTML = rows.map(row => `<tr>${row.map(cell => `<td>${html ? cell : escapeHtml(cell)}</td>`).join('')}</tr>`).join('');
    }

    function visibleRuns() {
        return state.analysis.runs.filter(run => run.has_data && !state.hiddenRuns.has(run.run_index));
    }
    function renderRunToggles() {
        $('runToggles').innerHTML = state.analysis.runs.filter(run => run.has_data).map(run => `
            <label class="cal-run-chip" style="--run-color:${series(run.run_index - 1)}"><input type="checkbox" data-run-toggle="${run.run_index}" ${state.hiddenRuns.has(run.run_index) ? '' : 'checked'}> R${run.run_index}</label>`).join('');
    }
    $('runToggles').addEventListener('change', event => {
        const index = Number(event.target.dataset.runToggle);
        if (event.target.checked) state.hiddenRuns.delete(index); else state.hiddenRuns.add(index);
        renderTime();
    });
    ['optRaw', 'optSmooth', 'optRef', 'optSequence'].forEach(id => $(id).addEventListener('change', renderTime));

    function renderTime() {
        renderRunToggles();
        const protocol = state.analysis.protocol;
        const sequence = $('optSequence').checked;
        const offset = run => sequence ? (run.run_index - 1) * (protocol.duration_s + protocol.pause_s) : 0;
        const datasets = [];
        visibleRuns().forEach(run => {
            const color = series(run.run_index - 1);
            const shift = offset(run);
            if ($('optRaw').checked) datasets.push({type: 'line', label: `R${run.run_index} brut`, data: run.series.map(([t, v]) => ({x: t + shift, y: conv(v)})),
                borderColor: alpha(color, $('optSmooth').checked ? .18 : .85), borderWidth: 1, pointRadius: 0, tension: 0, parsing: false});
            if ($('optSmooth').checked) datasets.push({type: 'line', label: `R${run.run_index} moyenne glissante`, data: run.series_smoothed.map(([t, v]) => ({x: t + shift, y: conv(v)})),
                borderColor: color, borderWidth: 2, pointRadius: 0, tension: 0, parsing: false});
            if ($('optRef').checked) {
                const refs = run.checkpoints.filter(cp => cp.reference_A != null);
                datasets.push({type: 'scatter', label: `R${run.run_index} Fluke`, data: refs.map(cp => ({x: cp.t_s + shift, y: conv(cp.reference_A)})),
                    borderColor: color, backgroundColor: css('--rg-surface') || '#fff', pointStyle: 'rectRot', pointRadius: 7, borderWidth: 2,
                    errorBars: refs.map(cp => ({low: conv(cp.reference_A - cp.reference_limit_A), high: conv(cp.reference_A + cp.reference_limit_A)}))});
            }
        });
        chart('chartTime', () => ({data: {datasets}, options: baseOptions('Temps (s)', `Courant (${state.unit})`, {animation: false})}));

        const labels = [], fluke = [], raw = [], smooth = [];
        visibleRuns().forEach(run => (run.extremes || []).forEach(extreme => {
            labels.push(`R${run.run_index} ${extreme.kind.toUpperCase()}`);
            fluke.push(extreme.reference_limit_A != null ? conv(extreme.reference_limit_A) : null);
            raw.push(conv(extreme.error_raw_A));
            smooth.push(conv(extreme.error_smoothed_A));
        }));
        chart('chartExtremes', () => ({
            type: 'bar',
            data: {labels, datasets: [
                {label: 'INA brut − Fluke', data: raw, backgroundColor: alpha(series(1), .75)},
                {label: `INA lissé (${nf(2).format(state.analysis.protocol.smoothing_s)} s) − Fluke`, data: smooth, backgroundColor: alpha(series(0), .75)},
                {type: 'line', label: '± limite Fluke', data: fluke, borderColor: css('--rg-ok') || '#16794f', borderDash: [5, 4], pointRadius: 3, fill: false},
                {type: 'line', label: '', data: fluke.map(v => v == null ? null : -v), borderColor: css('--rg-ok') || '#16794f', borderDash: [5, 4], pointRadius: 3, fill: false},
            ]},
            options: {...baseOptions('', `Écart MIN/MAX (${state.unit})`), scales: {x: {type: 'category'}, y: {title: {display: true, text: `Écart (${state.unit})`}}},
                plugins: {legend: {position: 'bottom', labels: {filter: item => item.text}}}},
        }));
    }

    function renderErrors() {
        const runs = state.analysis.runs.filter(run => run.checkpoints.some(cp => cp.error_A != null));
        const checkpoints = state.analysis.protocol.checkpoints_s;
        const limitAt = cp => {
            const values = runs.flatMap(run => run.checkpoints.filter(c => c.t_s === cp && c.reference_limit_A != null).map(c => [c.reference_limit_A, c.ina_limit_A]));
            if (!values.length) return null;
            return [values.reduce((a, v) => a + v[0], 0) / values.length, values.reduce((a, v) => a + v[1], 0) / values.length];
        };
        const limits = checkpoints.map(cp => ({cp, limit: limitAt(cp)})).filter(item => item.limit);
        const ok = css('--rg-ok') || '#16794f';
        const warn = css('--rg-warn') || '#9a6400';
        const datasets = [
            {type: 'line', label: '+ limite Fluke', data: limits.map(l => ({x: l.cp, y: conv(l.limit[0])})), borderColor: ok, backgroundColor: alpha(ok.startsWith('#') ? ok : '#16794f', .12), borderWidth: 1, pointRadius: 0, fill: '+1'},
            {type: 'line', label: '− limite Fluke', data: limits.map(l => ({x: l.cp, y: -conv(l.limit[0])})), borderColor: ok, borderWidth: 1, pointRadius: 0, fill: false},
            {type: 'line', label: '± (Fluke + INA226 brut)', data: limits.map(l => ({x: l.cp, y: conv(l.limit[0] + l.limit[1])})), borderColor: warn, borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false},
            {type: 'line', label: '', data: limits.map(l => ({x: l.cp, y: -conv(l.limit[0] + l.limit[1])})), borderColor: warn, borderDash: [6, 4], borderWidth: 1, pointRadius: 0, fill: false},
            ...runs.map(run => {
                const points = run.checkpoints.filter(cp => cp.error_A != null);
                return {type: 'line', label: `R${run.run_index}`, data: points.map(cp => ({x: cp.t_s, y: conv(cp.error_A)})),
                    borderColor: series(run.run_index - 1), backgroundColor: series(run.run_index - 1), pointRadius: 5, borderWidth: 2,
                    errorBars: points.map(cp => ({low: conv(cp.error_A - cp.ina_u95_A), high: conv(cp.error_A + cp.ina_u95_A)}))};
            }),
        ];
        const options = baseOptions('Instant de relevé (s)', `Erreur INA − Fluke (${state.unit})`);
        options.plugins.legend.labels.filter = item => item.text;
        chart('chartErrors', () => ({data: {datasets}, options}));

        const bland = state.analysis.summary.bland_altman;
        if (bland) {
            const xs = bland.points.map(p => conv(p.mean_A));
            const xMin = Math.min(...xs), xMax = Math.max(...xs);
            const pad = (xMax - xMin) * .1 || Math.abs(xMin) * .001 || 1;
            const blandSets = [
                ...[...new Set(bland.points.map(p => p.run))].map(run => ({type: 'scatter', label: `R${run}`,
                    data: bland.points.filter(p => p.run === run).map(p => ({x: conv(p.mean_A), y: conv(p.diff_A), t: p.t_s})),
                    backgroundColor: series(run - 1), pointRadius: 5})),
                hline('Biais', conv(bland.bias_A), xMin - pad, xMax + pad, css('--rg-ink') || '#0b0c0e', []),
                hline('Biais + 1,96σ', conv(bland.loa_high_A), xMin - pad, xMax + pad, css('--rg-danger') || '#b42318'),
                hline('Biais − 1,96σ', conv(bland.loa_low_A), xMin - pad, xMax + pad, css('--rg-danger') || '#b42318'),
            ];
            chart('chartBland', () => ({data: {datasets: blandSets}, options: baseOptions(`Moyenne (INA + Fluke) / 2 (${state.unit})`, `INA − Fluke (${state.unit})`)}));
        }
        const runSet = state.analysis.runs.filter(run => run.error_mean_A != null);
        chart('chartRunBias', () => ({
            type: 'bar',
            data: {labels: runSet.map(run => `R${run.run_index}`), datasets: [{
                label: 'Biais moyen par répétition (min–max des relevés)', data: runSet.map(run => conv(run.error_mean_A)),
                backgroundColor: runSet.map(run => alpha(series(run.run_index - 1), .8)), borderColor: css('--rg-ink') || '#0b0c0e',
                errorBars: runSet.map(run => {
                    const errors = run.checkpoints.filter(cp => cp.error_A != null).map(cp => cp.error_A);
                    return {low: conv(Math.min(...errors)), high: conv(Math.max(...errors))};
                }),
            }]},
            options: {...baseOptions('', ''), scales: {x: {type: 'category'}, y: {title: {display: true, text: `Biais (${state.unit})`}}}},
        }));
    }

    function renderNoise() {
        const runs = state.analysis.runs.filter(run => run.has_data);
        chart('chartHistogram', () => ({
            data: {datasets: runs.map(run => ({type: 'line', label: `R${run.run_index}`, stepped: 'middle',
                data: run.histogram.map(bin => ({x: conv((bin.from + bin.to) / 2), y: bin.count})),
                borderColor: series(run.run_index - 1), backgroundColor: alpha(series(run.run_index - 1), .15), fill: true, pointRadius: 0, borderWidth: 1.5}))},
            options: baseOptions(`Courant (${state.unit})`, 'Échantillons'),
        }));
        const lsb = 2.5e-6 / state.analysis.protocol.shunt_ohm;
        const taus = runs.flatMap(run => run.allan.map(p => p.tau_s));
        const datasets = runs.map(run => ({type: 'line', label: `R${run.run_index}`, data: run.allan.map(p => ({x: p.tau_s, y: conv(p.adev_A)})),
            borderColor: series(run.run_index - 1), pointRadius: 2, borderWidth: 2}));
        if (taus.length) datasets.push(hline('LSB INA226', conv(lsb), Math.min(...taus), Math.max(...taus), css('--rg-ink-3') || '#62656b'));
        const options = baseOptions('τ (s)', `σ Allan (${state.unit})`);
        options.scales.x.type = 'logarithmic';
        options.scales.y.type = 'logarithmic';
        chart('chartAllan', () => ({data: {datasets}, options}));
    }

    function renderSampling() {
        const runs = state.analysis.runs;
        chart('chartCompleteness', () => ({
            type: 'bar',
            data: {labels: runs.map(run => `R${run.run_index}`), datasets: [
                {label: 'Attendus', data: runs.map(run => run.samples_expected), backgroundColor: alpha(series(6), .35)},
                {label: 'En base', data: runs.map(run => run.samples), backgroundColor: alpha(series(0), .85)},
                {label: 'Relevés', data: runs.map(run => run.samples_reported ?? null), backgroundColor: alpha(series(1), .85)},
            ]},
            options: {...baseOptions('', ''), scales: {x: {type: 'category'}, y: {beginAtZero: true, title: {display: true, text: 'Échantillons'}}}},
        }));
        chart('chartDt', () => ({
            data: {datasets: runs.filter(run => run.has_data && run.dt_histogram.length).map(run => ({type: 'line', label: `R${run.run_index}`, stepped: 'middle',
                data: run.dt_histogram.map(bin => ({x: (bin.from + bin.to) / 2, y: bin.count})),
                borderColor: series(run.run_index - 1), backgroundColor: alpha(series(run.run_index - 1), .15), fill: true, pointRadius: 0}))},
            options: baseOptions('Intervalle entre échantillons (ms)', 'Occurrences'),
        }));
        table('samplingTable', ['Répétition', 'Attendus', 'En base', 'Relevés', 'Écart relevé/base', 'Perdus', 'Fréquence effective', 'Δt moyen', 'σ Δt', 'Δt max', 'Trous', 'Éch. manquants (trous)'],
            runs.map(run => [
                `R${run.run_index}`, count(run.samples_expected), count(run.samples), count(run.samples_reported),
                run.reported_vs_db != null ? `${run.reported_vs_db > 0 ? '+' : ''}${count(run.reported_vs_db)}` : '—', count(run.lost_samples),
                run.effective_rate_hz != null ? `${nf(2).format(run.effective_rate_hz)} Hz` : '—',
                run.dt_mean_ms != null ? `${nf(3).format(run.dt_mean_ms)} ms` : '—', run.dt_std_ms != null ? `${nf(3).format(run.dt_std_ms)} ms` : '—',
                run.dt_max_ms != null ? `${nf(2).format(run.dt_max_ms)} ms` : '—', count(run.gap_count), count(run.gap_missing_samples),
            ]));
    }

    function renderLevels() {
        const overview = state.overview;
        if (!overview) return;
        const regression = overview.regression;
        const message = {
            insufficient: 'Au moins 3 relevés sont nécessaires pour la régression.',
            single_level: 'Un seul niveau de courant : l’offset et le gain ne sont pas séparables. Créez des campagnes à plusieurs niveaux (ex. 0 A, 100 mA, 300 mA, 1 A).',
        }[regression.status];
        flash($('levelsMessage'), message || `Offset ${signed(regression.offset_A)} · erreur de gain ${nf(4).format(regression.gain_error_pct)} % · R² ${nf(4).format(regression.r2)} — correction indicative : I = (I_INA − ${amps(regression.offset_A)}) × ${nf(6).format(regression.correction.gain_factor)}`, message ? '' : 'ok');
        const byCampaign = new Map();
        regression.points.forEach(point => {
            if (!byCampaign.has(point.campaign_id)) byCampaign.set(point.campaign_id, {name: point.campaign, points: []});
            byCampaign.get(point.campaign_id).points.push(point);
        });
        const datasets = [...byCampaign.values()].map((group, index) => ({type: 'scatter', label: group.name,
            data: group.points.map(p => ({x: conv(p.reference_A), y: conv(p.error_A)})), backgroundColor: series(index), pointRadius: 5}));
        if (regression.status === 'ok') {
            const xs = regression.points.map(p => p.reference_A);
            const x0 = Math.min(...xs), x1 = Math.max(...xs);
            datasets.push({type: 'line', label: 'Régression E = a + b·I', data: [x0, x1].map(x => ({x: conv(x), y: conv(regression.offset_A + regression.gain_error_pct / 100 * x)})),
                borderColor: css('--rg-ink') || '#0b0c0e', borderWidth: 2, pointRadius: 0});
        }
        chart('chartLevels', () => ({data: {datasets}, options: baseOptions(`Courant de référence Fluke (${state.unit})`, `Erreur INA − Fluke (${state.unit})`)}));
        table('levelsTable', ['Campagne', 'Niveau moyen', 'Biais', 'Erreur max', 'Bruit σ', 'Complétude', 'Verdict'],
            overview.campaigns.map(item => [
                item.name, amps(item.summary.reference_mean_A), signed(item.summary.offset_A), amps(item.summary.error_max_abs_A),
                amps(item.summary.noise_pooled_A), pct(item.summary.completeness_pct, 1), `<span class="cal-pill ${item.summary.verdict}">${STATUS[item.summary.verdict][0]}</span>`,
            ].map((cell, i) => i === 6 ? cell : escapeHtml(cell))), true);
    }

    // ------------------------------------------------------------------ Onglets, unités, exports
    const tabs = [...document.querySelectorAll('.cal-tabs [role=tab]')];
    function moveInk(tab) {
        const ink = document.querySelector('.cal-tab-ink');
        ink.style.width = `${tab.offsetWidth}px`;
        ink.style.transform = `translateX(${tab.offsetLeft}px)`;
    }
    function selectTab(name) {
        state.tab = name;
        storeSet('cal.tab', name);
        tabs.forEach(tab => {
            const active = tab.dataset.tab === name;
            tab.setAttribute('aria-selected', String(active));
            if (active) moveInk(tab);
        });
        document.querySelectorAll('.cal-panel').forEach(panel => { panel.hidden = panel.dataset.panel !== name; });
        renderTab();
    }
    tabs.forEach(tab => tab.addEventListener('click', () => selectTab(tab.dataset.tab)));
    document.querySelector('.cal-tabs').addEventListener('keydown', event => {
        const index = tabs.findIndex(tab => tab.dataset.tab === state.tab);
        const step = {ArrowRight: 1, ArrowLeft: -1}[event.key];
        if (!step) return;
        const next = tabs[(index + step + tabs.length) % tabs.length];
        next.focus();
        selectTab(next.dataset.tab);
    });
    window.addEventListener('resize', () => moveInk(tabs.find(tab => tab.dataset.tab === state.tab)));

    function applyUnit(unit) {
        state.unit = unit;
        storeSet('cal.unit', unit);
        document.querySelectorAll('#unitSwitch button').forEach(button => button.classList.toggle('active', button.dataset.unit === unit));
        document.querySelectorAll('[data-amps]').forEach(cell => { cell.textContent = amps(Number(cell.dataset.amps), unit === 'A' ? 5 : unit === 'mA' ? 2 : 2); });
    }
    $('unitSwitch').addEventListener('click', event => {
        const button = event.target.closest('[data-unit]');
        if (!button || button.dataset.unit === state.unit) return;
        applyUnit(button.dataset.unit);
        renderRuns();
        renderAll();
    });
    $('exportJson').addEventListener('click', () => {
        if (!state.analysis) return;
        const blob = new Blob([JSON.stringify(state.analysis, null, 2)], {type: 'application/json'});
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `calibration_${state.analysis.name.replace(/[^\w-]+/g, '_')}.json`;
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    });
    $('printReport').addEventListener('click', () => {
        selectTab('summary');
        setTimeout(() => window.print(), 300);
    });
    $('exportCsv').addEventListener('click', event => { if (!state.campaign) event.preventDefault(); });
    window.addEventListener('rg-themechange', () => renderTab());

    // ------------------------------------------------------------------ Démarrage
    (async function start() {
        applyUnit(state.unit);
        fillForm(null);
        try {
            await Promise.all([loadSources(), loadCampaigns()]);
            const remembered = storeGet('cal.campaign');
            const target = state.campaigns.find(item => item.id === remembered) || state.campaigns[0];
            if (target) await openCampaign(target.id);
            else { renderRuns(); renderSummary(); $('calState').textContent = 'Aucune campagne'; }
        } catch (error) {
            $('calState').textContent = error.message;
        }
        selectTab(storeGet('cal.tab') || 'input');
    })();
})();
