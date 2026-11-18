/* Calibration INA226 ↔ Fluke 287 : saisie, analyse et dashboards. */
(function () {
    'use strict';
    const config = window.calibrationConfig;
    const api = config.api;
    const $ = id => document.getElementById(id);
    const UNITS = {A: 1, mA: 1e3, 'µA': 1e6};
    const DIGITS = {A: 6, mA: 3, 'µA': 1};
    const STATUS = {
        pass: ['Conforme', 'Écart ≤ tolérance (±0,1 % < 500 mA ; ±0,3 % de 500 à 900 mA ; ±1 % de 900 mA à 1 A ; ±0,3 % > 1 A ; plancher : limite Fluke)'],
        warning: ['À la limite', 'Écart entre 1 et 1,5 × la tolérance'],
        fail: ['Hors tolérance', 'Écart > 1,5 × la tolérance'],
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
        full: null,
        viewChannel: 'A',
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
            const data = state.campaign
                ? await request(`${api.campaigns}/${state.campaign.id}`, {method: 'PUT', body: JSON.stringify(payload)})
                : await request(api.campaigns, {method: 'POST', body: JSON.stringify(payload)});
            flash($('protocolMessage'), state.campaign ? 'Protocole enregistré.'
                : 'Campagne créée : choisissez maintenant les mesures à comparer.');
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
        state.full = null;
        bulk.selected.clear();
        fillForm(null);
        renderBulkSources();
        renderCampaignList();
        renderRuns();
        renderAll();
        form.name.focus();
        $('calState').textContent = 'Nouvelle campagne';
    });
    // « Supprimer… » ouvre l'historique avec la campagne courante pré-cochée : on choisit ce qu'on supprime.
    $('deleteCampaign').addEventListener('click', () => {
        if (state.campaign) calHistory.selected = new Set([state.campaign.id]);
        selectTab('history');
    });

    // ------------------------------------------------------------------ Historique
    const calHistory = {selected: new Set()};
    function renderHistory() {
        const ids = new Set(state.campaigns.map(c => c.id));
        calHistory.selected = new Set([...calHistory.selected].filter(id => ids.has(id)));
        const n = calHistory.selected.size;
        $('historyCount').textContent = `${state.campaigns.length} campagne${state.campaigns.length > 1 ? 's' : ''}${n ? ` · ${n} sélectionnée${n > 1 ? 's' : ''}` : ''}`;
        $('historyDelete').disabled = !n;
        $('historyDelete').textContent = n ? `Supprimer la sélection (${n})` : 'Supprimer la sélection';
        const all = state.campaigns.length && n === state.campaigns.length;
        const date = ts => ts ? new Date(ts * 1000).toLocaleString('fr-FR', {dateStyle: 'short', timeStyle: 'short'}) : '—';
        const headers = [`<input type="checkbox" id="historyAll" aria-label="Tout sélectionner" ${all ? 'checked' : ''}>`,
            'Nom', 'Voie', 'Fréquence', 'Durée', 'Répét.', 'Pause', 'Instants de relevé', 'Shunt', 'Tol. shunt', 'Reliées', 'Créée', 'Modifiée', 'Notes', ''];
        $('historyTable').innerHTML = `<thead><tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr></thead><tbody>${
            state.campaigns.length ? state.campaigns.map(c => {
                const p = c.protocol;
                const active = state.campaign?.id === c.id;
                return `<tr class="${active ? 'is-active' : ''}${calHistory.selected.has(c.id) ? ' is-selected' : ''}">
                    <td><input type="checkbox" data-history-id="${c.id}" aria-label="Sélectionner ${escapeHtml(c.name)}" ${calHistory.selected.has(c.id) ? 'checked' : ''}></td>
                    <td><strong>${escapeHtml(c.name)}</strong>${active ? ' <span class="cal-pill neutral">ouverte</span>' : ''}</td>
                    <td>${p.channel === 'AB' ? 'A + B' : p.channel}</td>
                    <td>${count(p.frequency_hz)} Hz</td>
                    <td>${count(p.duration_s)} s</td>
                    <td>${p.repetitions}</td>
                    <td>${count(p.pause_s)} s</td>
                    <td>${(p.checkpoints_s || []).join(', ')} s</td>
                    <td>${p.shunt_ohm != null ? `${nf(3).format(p.shunt_ohm)} Ω` : '—'}</td>
                    <td>${p.shunt_tolerance_pct != null ? `${nf(1).format(p.shunt_tolerance_pct)} %` : '—'}</td>
                    <td>${c.linked_runs}/${p.repetitions}</td>
                    <td>${date(c.created_at)}</td>
                    <td>${date(c.updated_at)}</td>
                    <td class="cal-history-notes">${escapeHtml(c.notes || '')}</td>
                    <td><button type="button" class="cal-history-open" data-history-open="${c.id}" ${active ? 'disabled' : ''}>Ouvrir</button></td>
                </tr>`;
            }).join('') : `<tr><td colspan="${headers.length}"><div class="empty-notice">Aucune campagne enregistrée pour ce projet.</div></td></tr>`
        }</tbody>`;
    }
    $('historyTable').addEventListener('change', event => {
        const box = event.target;
        if (box.id === 'historyAll') calHistory.selected = box.checked ? new Set(state.campaigns.map(c => c.id)) : new Set();
        else if (box.dataset.historyId) {
            if (box.checked) calHistory.selected.add(box.dataset.historyId); else calHistory.selected.delete(box.dataset.historyId);
        }
        renderHistory();
    });
    $('historyTable').addEventListener('click', async event => {
        const button = event.target.closest('[data-history-open]');
        if (!button) return;
        await openCampaign(button.dataset.historyOpen);
        selectTab('input');
    });
    $('historyDelete').addEventListener('click', async () => {
        const chosen = state.campaigns.filter(c => calHistory.selected.has(c.id));
        if (!chosen.length) return;
        const names = chosen.map(c => `• ${c.name}`).join('\n');
        if (!confirm(`Supprimer définitivement ${chosen.length} campagne${chosen.length > 1 ? 's' : ''} et leurs relevés Fluke ?\n\n${names}\n\nLes mesures de la base ne sont pas supprimées.`)) return;
        $('historyDelete').disabled = true;
        const failed = [];
        for (const c of chosen) {
            try { await request(`${api.campaigns}/${c.id}`, {method: 'DELETE'}); }
            catch (error) { failed.push(`${c.name} : ${error.message}`); }
        }
        const deletedCurrent = state.campaign && chosen.some(c => c.id === state.campaign.id) && !failed.some(f => f.startsWith(`${state.campaign.name} :`));
        calHistory.selected = new Set();
        await loadCampaigns();
        if (deletedCurrent) {
            state.campaign = null;
            if (state.campaigns[0]) await openCampaign(state.campaigns[0].id); else $('newCampaign').click();
        }
        renderHistory();
        const ok = chosen.length - failed.length;
        flash($('historyMessage'), failed.length
            ? `${ok} supprimée${ok > 1 ? 's' : ''}, ${failed.length} en échec : ${failed.join(' ; ')}`
            : `${ok} campagne${ok > 1 ? 's' : ''} supprimée${ok > 1 ? 's' : ''}.`, failed.length ? 'error' : 'ok');
    });

    // ------------------------------------------------------------------ Campagnes
    async function loadCampaigns() {
        state.campaigns = (await request(api.campaigns)).campaigns;
        state.global = null; // L'analyse globale sera recalculée à la prochaine ouverture de l'onglet.
        renderCampaignList();
        if (state.tab === 'history') renderHistory();
    }
    // Sélecteur : recherche, filtre de voie, tri, groupes par date, clavier.
    const picker = {query: '', channel: storeGet('cal.pickerChannel') || 'all', sort: storeGet('cal.pickerSort') || 'recent', cursor: null};
    const fold = text => String(text || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    function highlight(text, query) {
        if (!query) return escapeHtml(text);
        const index = fold(text).indexOf(query);
        if (index < 0) return escapeHtml(text);
        return `${escapeHtml(text.slice(0, index))}<mark>${escapeHtml(text.slice(index, index + query.length))}</mark>${escapeHtml(text.slice(index + query.length))}`;
    }
    function dayLabel(ts) {
        const date = new Date(ts * 1000);
        const start = d => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
        const days = Math.round((start(new Date()) - start(date)) / 86400000);
        if (days === 0) return 'Aujourd’hui';
        if (days === 1) return 'Hier';
        if (days < 7) return date.toLocaleDateString('fr-FR', {weekday: 'long'}).replace(/^./, c => c.toUpperCase());
        return date.toLocaleDateString('fr-FR', {day: 'numeric', month: 'long', year: 'numeric'});
    }
    function pickerItems() {
        const query = fold(picker.query.trim());
        const items = state.campaigns.filter(c => (picker.channel === 'all' || c.protocol.channel === picker.channel)
            && (!query || fold(`${c.name} ${c.notes || ''}`).includes(query)));
        const by = {
            recent: (a, b) => b.updated_at - a.updated_at,
            oldest: (a, b) => a.updated_at - b.updated_at,
            name: (a, b) => a.name.localeCompare(b.name, 'fr', {numeric: true, sensitivity: 'base'}),
        }[picker.sort] || ((a, b) => b.updated_at - a.updated_at);
        return {query, items: items.sort(by)};
    }
    function renderCampaignList() {
        const list = $('campaignList');
        const {query, items} = pickerItems();
        const total = state.campaigns.length;
        $('campaignCount').textContent = total ? (items.length === total ? `${total}` : `${items.length} / ${total}`) : '';
        document.querySelectorAll('[data-camp-channel]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.campChannel === picker.channel)));
        $('campaignSort').value = picker.sort;
        if (!total) {
            list.innerHTML = '<div class="empty-notice">Aucune campagne. Créez-en une avec le protocole ci-dessous.</div>';
            return;
        }
        if (!items.length) {
            list.innerHTML = `<div class="cal-picker-empty">Aucune campagne ne correspond${picker.query ? ` à « ${escapeHtml(picker.query)} »` : ''}.<button type="button" data-camp-reset>Effacer les filtres</button></div>`;
            return;
        }
        if (!items.some(c => c.id === picker.cursor)) picker.cursor = (items.find(c => c.id === state.campaign?.id) || items[0]).id;
        let group = null, html = '';
        items.forEach(c => {
            const label = picker.sort === 'name' ? null : dayLabel(c.updated_at);
            if (label && label !== group) { group = label; html += `<div class="cal-picker-group" role="presentation">${label}</div>`; }
            const p = c.protocol;
            const active = state.campaign?.id === c.id;
            const complete = c.linked_runs >= p.repetitions;
            const time = new Date(c.updated_at * 1000).toLocaleTimeString('fr-FR', {hour: '2-digit', minute: '2-digit'});
            html += `<button type="button" role="option" aria-selected="${active}" tabindex="-1"
                class="cal-campaign${active ? ' active' : ''}${picker.cursor === c.id ? ' cursor' : ''}" data-id="${c.id}">
                <span class="cal-campaign-chan" data-chan="${p.channel}">${p.channel === 'AB' ? 'A+B' : p.channel}</span>
                <span class="cal-campaign-body">
                    <strong>${highlight(c.name, query)}</strong>
                    <span>${p.repetitions} × ${count(p.duration_s)} s · ${count(p.frequency_hz)} Hz</span>
                </span>
                <span class="cal-campaign-side">
                    <small>${picker.sort === 'name' ? new Date(c.updated_at * 1000).toLocaleDateString('fr-FR', {day: '2-digit', month: '2-digit', year: '2-digit'}) : time}</small>
                    <span class="cal-campaign-runs${complete ? ' ok' : ''}" title="${c.linked_runs}/${p.repetitions} répétitions reliées">${c.linked_runs}/${p.repetitions}</span>
                </span>
            </button>`;
        });
        list.innerHTML = html;
        const target = list.querySelector('.cal-campaign.cursor');
        if (target && picker.scroll !== false) {
            const top = target.offsetTop, bottom = top + target.offsetHeight; // liste en position: relative
            if (top < list.scrollTop + 28) list.scrollTop = Math.max(0, top - 28);
            else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
        }
        picker.scroll = true;
    }
    $('campaignList').addEventListener('click', event => {
        if (event.target.closest('[data-camp-reset]')) {
            picker.query = ''; picker.channel = 'all'; $('campaignSearch').value = '';
            storeSet('cal.pickerChannel', 'all');
            renderCampaignList(); $('campaignSearch').focus();
            return;
        }
        const button = event.target.closest('.cal-campaign');
        if (!button) return;
        picker.cursor = button.dataset.id;
        picker.scroll = false; // Le clic est déjà visible : ne pas faire sauter la liste.
        openCampaign(button.dataset.id);
    });
    $('campaignSearch').addEventListener('input', event => {
        picker.query = event.target.value;
        picker.cursor = null;
        $('campaignList').scrollTop = 0;
        renderCampaignList();
    });
    $('campaignSearch').addEventListener('keydown', event => {
        const {items} = pickerItems();
        if (!items.length) return;
        const index = Math.max(0, items.findIndex(c => c.id === picker.cursor));
        const move = {ArrowDown: 1, ArrowUp: -1, PageDown: 8, PageUp: -8}[event.key];
        if (move) {
            event.preventDefault();
            picker.cursor = items[Math.min(items.length - 1, Math.max(0, index + move))].id;
            renderCampaignList();
        } else if (event.key === 'Home' && event.ctrlKey || event.key === 'End' && event.ctrlKey) {
            event.preventDefault();
            picker.cursor = items[event.key === 'Home' ? 0 : items.length - 1].id;
            renderCampaignList();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            if (picker.cursor && picker.cursor !== state.campaign?.id) openCampaign(picker.cursor);
        } else if (event.key === 'Escape' && picker.query) {
            event.preventDefault();
            event.target.value = ''; picker.query = ''; renderCampaignList();
        }
    });
    document.querySelector('.cal-picker-filters').addEventListener('click', event => {
        const button = event.target.closest('[data-camp-channel]');
        if (!button) return;
        picker.channel = button.dataset.campChannel;
        storeSet('cal.pickerChannel', picker.channel);
        $('campaignList').scrollTop = 0;
        renderCampaignList();
    });
    $('campaignSort').addEventListener('change', event => {
        picker.sort = event.target.value;
        storeSet('cal.pickerSort', picker.sort);
        $('campaignList').scrollTop = 0;
        renderCampaignList();
    });
    document.addEventListener('keydown', event => {
        if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey) return;
        if (event.target.closest('input, textarea, select, [contenteditable="true"]')) return;
        event.preventDefault();
        $('campaignSearch').focus();
        $('campaignSearch').select();
    });
    async function openCampaign(id) {
        state.campaign = (await request(`${api.campaigns}/${id}`)).campaign;
        storeSet('cal.campaign', id);
        fillForm(state.campaign);
        renderCampaignList();
        if (state.tab === 'history') renderHistory();
        renderRuns();
        syncBulkFromCampaign();
        $('exportCsv').href = `${api.campaigns}/${id}/export.csv`;
        await refreshAnalysis();
    }

    const CHANNEL_ID = {A: '0x40', B: '0x44'};
    function campaignChannels() {
        const channel = state.campaign?.protocol.channel || form.channel.value;
        return channel === 'AB' ? ['A', 'B'] : [channel === 'B' ? 'B' : 'A'];
    }
    function channelRun(run, channel) {
        if (state.campaign?.protocol.channel !== 'AB') return run;
        const data = run.reference?.channels?.[channel] || {};
        return {...run, reference: data.points || {}, fluke_min_A: data.min ?? null, fluke_max_A: data.max ?? null, fluke_range_A: data.range ?? null};
    }

    // ------------------------------------------------------------------ Sources
    async function loadSources() {
        state.sources = (await request(api.sources)).sources;
        renderBulkSources();
    }
    function sourceOptions(selected) {
        const channels = campaignChannels();
        const items = state.sources.filter(source => channels.some(channel => source.channels[channel]));
        return `<option value="">— Choisir une mesure (canal ${channels.join(' + ')}) —</option>` + items.map(source => {
            const info = source.channels[channels.find(channel => source.channels[channel])];
            return `<option value="${escapeHtml(source.source_file)}" ${source.source_file === selected ? 'selected' : ''}>
                ${escapeHtml(source.kind === 'digital' ? 'Numérique' : source.kind === 'asc' ? 'ASC' : 'Source')} · ${escapeHtml(source.started_label)} · ${escapeHtml(source.name)} · ${count(info.samples)} éch.</option>`;
        }).join('');
    }
    const bulk = {kind: 'all', selected: new Set()};
    function channelSources() {
        const channels = campaignChannels();
        return {channel: channels.join(' + '), channels,
            items: state.sources.filter(source => channels.some(channel => source.channels[channel])).sort((a, b) => (a.start || 0) - (b.start || 0))};
    }
    function renderBulkSources() {
        const {channel, channels, items} = channelSources();
        const visible = items.filter(source => bulk.kind === 'all' || source.kind === bulk.kind);
        const order = [...bulk.selected].map(key => items.find(item => item.source_file === key)).filter(Boolean)
            .sort((a, b) => (a.start || 0) - (b.start || 0)).map(item => item.source_file);
        $('bulkSources').innerHTML = !state.campaign
            ? '<div class="empty-notice">Créez ou ouvrez une campagne pour choisir ses mesures.</div>'
            : visible.length ? visible.map((source, index) => {
                const present = channels.filter(item => source.channels[item]);
                const info = source.channels[present[0]];
                const rank = order.indexOf(source.source_file);
                return `
                <label class="cal-source ${source.kind}${rank >= 0 ? ' selected' : ''}" style="--i:${Math.min(index, 12)}${rank >= 0 ? `;--run-color:${series(rank)}` : ''}">
                    <input type="checkbox" value="${escapeHtml(source.source_file)}" ${rank >= 0 ? 'checked' : ''}>
                    <span class="cal-source-rank" aria-hidden="true">${rank >= 0 ? `R${rank + 1}` : ''}</span>
                    <span class="cal-source-body">
                        <span class="cal-source-kind">${source.kind === 'digital' ? 'Numérique ESP32' : source.kind === 'asc' ? 'Log ASC' : 'Source'} · canal ${present.join('+')}</span>
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
                const kept = previous.get(chosen[index].source_file) || {reference: {}};
                const perChannel = channel => {
                    const view = channelRun(kept, channel);
                    return {reference: view.reference || {}, fluke_min_A: view.fluke_min_A ?? null,
                        fluke_max_A: view.fluke_max_A ?? null, fluke_range_A: view.fluke_range_A ?? null};
                };
                const channels = campaignChannels();
                await request(`${api.campaigns}/${state.campaign.id}/runs/${index + 1}`, {method: 'PUT', body: JSON.stringify({
                    source_file: chosen[index].source_file, start_offset_s: kept.start_offset_s || 0,
                    samples_reported: kept.samples_reported ?? null, ambient_c: kept.ambient_c ?? null, notes: kept.notes || '',
                    ...(state.campaign.protocol.channel === 'AB'
                        ? {channels: Object.fromEntries(channels.map(channel => [channel, perChannel(channel)]))}
                        : perChannel(channels[0])),
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
            <article class="cal-run panel${campaignChannels().length > 1 ? ' multi' : ''}" data-run="${index}" style="--run-color:${series(index - 1)}">
                <header>
                    <span class="cal-run-badge">R${index}</span>
                    <div><h3>Répétition ${index}</h3><small>${escapeHtml(runSourceLabel(run.source_file))}</small></div>
                    <span class="cal-save-state" data-save-state></span>
                </header>
                <label class="field">Mesure en base
                    <select name="source_file">${sourceOptions(run.source_file)}</select>
                </label>
                <div class="cal-grid-2">
                    <div class="field cal-readonly"><span>Début</span><output data-start title="Date et heure du premier échantillon analysé, lues dans la mesure">—</output></div>
                    <label class="field">Éch. relevés <input name="samples_reported" inputmode="numeric" value="${run.samples_reported ?? ''}" placeholder="${count(expected)}"></label>
                </div>
                <div class="cal-channel-blocks">${campaignChannels().map(channel => channelBlock(index, channel, channelRun(run, channel), protocol)).join('')}</div>
                <div class="cal-grid-2">
                    <label class="field">Ambiante (°C) <input name="ambient_c" inputmode="decimal" value="${fromAmpsRaw(run.ambient_c)}"></label>
                    <label class="field">Notes <input name="notes" value="${escapeHtml(run.notes || '')}"></label>
                </div>
            </article>`);
        }
        container.innerHTML = html.join('');
        renderRunLive();
    }
    function channelBlock(index, channel, run, protocol) {
        const id = `${index}_${channel}`;
        return `
                <section class="cal-channel-block channel-${channel}" data-channel-block="${channel}">
                    <header class="cal-channel-head">
                        <span class="cal-channel-chip">Canal ${channel}</span>
                        <small>INA226 · ID ${CHANNEL_ID[channel]}</small>
                    </header>
                    <label class="field">Borne Fluke (entrée branchée)
                        <select name="fluke_range_A" title="Borne d’entrée du Fluke 287 sur laquelle le courant est branché. Le multimètre choisit ensuite seul le calibre (plage) de cette borne ; la précision utilisée dans les calculs en dépend.">
                            <option value="0.4" ${flukeInput(run) === 0.4 ? 'selected' : ''}>mA · 400 mA max</option>
                            <option value="10" ${flukeInput(run) === 10 ? 'selected' : ''}>A · 10 A max</option>
                        </select>
                    </label>
                    <div class="cal-compare" role="table" aria-label="Lecture Fluke et valeur mesurée par l’INA226, canal ${channel}">
                        <div class="cal-compare-head" role="row">
                            <span role="columnheader"></span>
                            <span role="columnheader" class="cal-col-fluke"><i aria-hidden="true">✎</i> Fluke 287 · votre lecture (${state.unit})</span>
                            <span role="columnheader" class="cal-col-ina"><i aria-hidden="true">◉</i> INA226 · mesuré</span>
                        </div>
                        ${protocol.checkpoints_s.map(cp => `
                        <div class="cal-compare-row" role="row">
                            <label role="rowheader" for="ref_${id}_${cp}">I à ${count(cp)} s</label>
                            <input class="cal-fluke-input" id="ref_${id}_${cp}" data-checkpoint="${cp}" inputmode="decimal" autocomplete="off" placeholder="lecture Fluke" value="${fromAmps(run.reference?.[String(cp)])}">
                            <output class="cal-ina-value" data-cp-value="${cp}">—</output>
                        </div>`).join('')}
                        <div class="cal-compare-row" role="row">
                            <label role="rowheader" for="min_${id}">MIN</label>
                            <input class="cal-fluke-input" id="min_${id}" name="fluke_min_A" inputmode="decimal" autocomplete="off" placeholder="lecture Fluke" value="${fromAmps(run.fluke_min_A)}">
                            <output class="cal-ina-value" data-ext-value="min">—</output>
                        </div>
                        <div class="cal-compare-row" role="row">
                            <label role="rowheader" for="max_${id}">MAX</label>
                            <input class="cal-fluke-input" id="max_${id}" name="fluke_max_A" inputmode="decimal" autocomplete="off" placeholder="lecture Fluke" value="${fromAmps(run.fluke_max_A)}">
                            <output class="cal-ina-value" data-ext-value="max">—</output>
                        </div>
                    </div>
                    <div class="cal-run-live" data-live></div>
                </section>`;
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
        const number = (input, convert, label) => {
            const value = convert ? toAmps(input.value) : parseInput(input.value);
            if (Number.isNaN(value)) throw new Error(`Valeur invalide : ${label}.`);
            return value;
        };
        const stored = runData(Number(card.dataset.run));
        const channels = {};
        card.querySelectorAll('[data-channel-block]').forEach(section => {
            const channel = section.dataset.channelBlock;
            const reference = {};
            section.querySelectorAll('[data-checkpoint]').forEach(input => {
                const value = number(input, true, `Fluke canal ${channel} à ${input.dataset.checkpoint} s`);
                if (value != null) reference[input.dataset.checkpoint] = value;
            });
            channels[channel] = {
                reference,
                fluke_range_A: section.querySelector('[name="fluke_range_A"]').value || null,
                fluke_min_A: number(section.querySelector('[name="fluke_min_A"]'), true, `MIN Fluke canal ${channel}`),
                fluke_max_A: number(section.querySelector('[name="fluke_max_A"]'), true, `MAX Fluke canal ${channel}`),
            };
        });
        const common = {
            source_file: field('source_file').value || null,
            start_offset_s: field('source_file').value === stored.source_file ? (stored.start_offset_s || 0) : 0,
            samples_reported: field('samples_reported').value.replace(/\s/g, '') || null,
            ambient_c: number(field('ambient_c'), false, 'température ambiante'),
            notes: field('notes').value,
        };
        return state.campaign.protocol.channel === 'AB' ? {...common, channels} : {...common, ...Object.values(channels)[0]};
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

    function incomplete(slot, text) {
        slot.innerHTML = `<span class="cal-pill missing">Incomplet · ${escapeHtml(text)}</span>`;
        slot.title = 'Aucun échantillon de la mesure ne couvre cet instant.';
    }
    function dateTime(timestamp) {
        return new Date(timestamp * 1000).toLocaleString('fr-FR', {day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit', second: '2-digit'});
    }
    function renderRunLive() {
        if (!state.full) return;
        const starts = {};
        state.full.channels.forEach(channel => state.full.by_channel[channel].runs.forEach(run => {
            if (run.start_timestamp != null && (starts[run.run_index] == null || run.start_timestamp < starts[run.run_index])) starts[run.run_index] = run.start_timestamp;
            const section = document.querySelector(`.cal-run[data-run="${run.run_index}"] [data-channel-block="${channel}"]`);
            if (!section) return;
            const absent = run.source_file ? `canal ${channel} absent de cette mesure` : 'aucune mesure reliée';
            section.querySelector('[data-live]').innerHTML = run.has_data
                ? `<div class="cal-live-grid"><span>Échantillons <b>${count(run.samples)}</b></span><span>Durée couverte <b>${nf(1).format(Math.max(0, (run.last_t_s || 0) - (run.first_t_s || 0)))} s</b></span></div>`
                : `<span class="cal-pill missing">Incomplet · ${absent}</span>`;
            run.checkpoints.forEach(cp => {
                const slot = section.querySelector(`[data-cp-value="${cp.t_s}"]`);
                if (!slot) return;
                if (!run.has_data) return incomplete(slot, absent);
                if (cp.ina_mean_A == null) return incomplete(slot, `pas de mesure à ${count(cp.t_s)} s`);
                slot.title = `Moyenne de ${count(cp.samples)} échantillons autour de ${count(cp.t_s)} s`;
                slot.innerHTML = `<b>${amps(cp.ina_mean_A)}</b>${cp.error_A != null
                    ? ` <span class="cal-pill ${cp.status}" title="Fluke ${amps(cp.reference_A)} · limite ±${amps(cp.reference_limit_A)}">écart ${signed(cp.error_A)}</span>` : ''}`;
            });
            ['min', 'max'].forEach(kind => {
                const slot = section.querySelector(`[data-ext-value="${kind}"]`);
                const extreme = (run.extremes || []).find(item => item.kind === kind);
                if (!slot) return;
                if (!run.has_data || !extreme) return incomplete(slot, absent);
                slot.title = `Lissé (${nf(2).format(state.full.protocol.smoothing_s)} s) : ${amps(extreme.ina_smoothed_A)}`;
                slot.innerHTML = `<b>${amps(extreme.ina_raw_A)}</b>${extreme.error_raw_A != null
                    ? ` <span class="cal-pill neutral" title="Fluke ${amps(extreme.reference_A)}">écart ${signed(extreme.error_raw_A)}</span>` : ''}`;
            });
        }));
        document.querySelectorAll('.cal-run').forEach(card => {
            const slot = card.querySelector('[data-start]');
            const timestamp = starts[Number(card.dataset.run)];
            if (slot) slot.textContent = timestamp != null ? dateTime(timestamp) : 'Incomplet · aucune donnée';
        });
        ['A', 'B'].forEach(channel => {
            const runs = state.full.by_channel[channel]?.runs || [];
            const reading = runs.flatMap(run => run.checkpoints).find(cp => cp.reference_A != null)?.reference_A;
            $(`schematicReading${channel}`).textContent = reading != null ? amps(reading, state.unit === 'A' ? 4 : 2) : `— ${state.unit}`;
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
            state.full = (await request(`${api.campaigns}/${state.campaign.id}/analysis`)).analysis;
            if (!state.full.channels.includes(state.viewChannel)) state.viewChannel = state.full.channels[0];
            setViewChannel(state.viewChannel, false);
            const total = state.full.channels.reduce((sum, channel) => sum + (state.full.by_channel[channel].summary.samples_total || 0), 0);
            $('calState').textContent = `${count(total)} échantillons analysés`;
            renderAll();
            loadOverview();
        } catch (error) {
            $('calState').textContent = error.message;
        }
    }
    function setViewChannel(channel, render = true) {
        state.viewChannel = channel;
        const view = state.full.by_channel[channel];
        state.analysis = {id: state.full.id, name: state.full.name, channels: state.full.channels,
            protocol: {...state.full.protocol, channel}, runs: view.runs, summary: view.summary};
        const switcher = $('channelSwitch');
        switcher.hidden = state.full.channels.length < 2;
        switcher.querySelectorAll('[data-view-channel]').forEach(button => button.classList.toggle('active', button.dataset.viewChannel === channel));
        if (render) { renderAll(); loadOverview(); }
    }
    $('channelSwitch').addEventListener('click', event => {
        const button = event.target.closest('[data-view-channel]');
        if (button && state.full) setViewChannel(button.dataset.viewChannel);
    });
    async function loadOverview() {
        if (!state.campaign) return;
        state.overview = await request(`${api.overview}?channel=${state.viewChannel}`);
        if (state.tab === 'levels') renderLevels();
    }
    function renderAll() {
        renderRunLive();
        renderSummary();
        renderTab();
    }
    function renderTab() {
        if (state.tab === 'history') return renderHistory();
        if (state.tab === 'global') return state.global ? renderGlobal() : loadGlobal();
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
        table('checkpointTable', ['Répétition', 'Instant', 'Fluke', 'INA (moyenne)', 'σ fenêtre', 'Éch.', 'Erreur', 'Erreur %', 'Tolérance', 'Limite Fluke', 'Eₙ', 'Statut'],
            analysis.runs.flatMap(run => run.checkpoints.map(cp => [
                `R${run.run_index}`, `${count(cp.t_s)} s`, amps(cp.reference_A), `<span class="cal-val ${cp.status}">${amps(cp.ina_mean_A)}</span>`, amps(cp.ina_std_A), count(cp.samples),
                `<span class="cal-val ${cp.status}">${signed(cp.error_A)}</span>`, `<span class="cal-val ${cp.status}">${pct(cp.error_pct, 3)}</span>`,
                cp.tolerance_A != null ? `±${amps(cp.tolerance_A)} <small>(${cp.tolerance_floor === 'fluke' ? 'plancher Fluke' : `${nf(1).format(cp.tolerance_pct)} %`})</small>` : '—',
                cp.reference_limit_A != null ? `±${amps(cp.reference_limit_A)}` : '—',
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
                // Courbe Fluke : même style que la moyenne glissante INA, couleur distincte.
                const refs = run.checkpoints.filter(cp => cp.reference_A != null).sort((a, b) => a.t_s - b.t_s);
                const flukeColor = series(run.run_index);
                datasets.push({type: 'line', label: `R${run.run_index} Fluke`, data: refs.map(cp => ({x: cp.t_s + shift, y: conv(cp.reference_A)})),
                    borderColor: flukeColor, backgroundColor: css('--rg-surface') || '#fff', borderWidth: 2, tension: 0, fill: false,
                    pointStyle: 'rectRot', pointRadius: 7, pointBorderWidth: 2, pointBorderColor: flukeColor,
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

    // ------------------------------------------------------------------ Analyse globale
    // Toutes les campagnes : scores, graphiques comparatifs, matrice « où ça cloche »,
    // diagnostic expert local et analyse Claude facultative (indicateurs agrégés seulement).
    const AXES = [
        ['accuracy', 'Justesse'], ['conformity', 'Conformité'], ['noise', 'Bruit'],
        ['stability', 'Stabilité'], ['completeness', 'Complétude'], ['repeatability', 'Reproductibilité'],
    ];
    state.global = null;
    state.globalChannel = '';
    state.globalLoading = false;
    const tone = name => getComputedStyle(document.body).getPropertyValue(name).trim();
    const scoreColor = score => score == null ? (css('--rg-ink-3') || '#67625c')
        : score >= 85 ? (tone('--cal-ok') || '#16794f') : score >= 60 ? (tone('--cal-warn') || '#9a6400') : (tone('--cal-bad') || '#b42318');
    const channelColor = channel => series(channel === 'B' ? 1 : 0);
    const rowLabel = row => `${row.name} · ${row.channel}`;

    async function loadGlobal(refresh = false) {
        if (state.globalLoading) return;
        state.globalLoading = true;
        flash($('globalMessage'), 'Analyse de toutes les campagnes en cours…', 'ok');
        try {
            const query = new URLSearchParams({channel: state.globalChannel, ...(refresh ? {refresh: '1'} : {})});
            state.global = await request(`${api.global}?${query}`);
            flash($('globalMessage'), '');
            renderGlobal();
        } catch (error) {
            flash($('globalMessage'), `Analyse globale impossible : ${error.message}`, 'error');
        } finally {
            state.globalLoading = false;
        }
    }

    function renderGlobal() {
        const data = state.global;
        if (!data || state.tab !== 'global') return;
        const rows = data.rows;
        const measured = rows.filter(row => row.score != null);
        const points = data.points;
        $('globalSub').textContent = rows.length
            ? `${measured.length} campagne${measured.length > 1 ? 's' : ''} exploitable${measured.length > 1 ? 's' : ''} sur ${rows.length} · ${points.length} relevé${points.length > 1 ? 's' : ''} Fluke comparé${points.length > 1 ? 's' : ''}`
            : 'Aucune campagne dans ce projet.';

        // KPI ---------------------------------------------------------------
        const median = values => {
            const list = values.filter(Number.isFinite).sort((a, b) => a - b);
            if (!list.length) return null;
            const mid = Math.floor(list.length / 2);
            return list.length % 2 ? list[mid] : (list[mid - 1] + list[mid]) / 2;
        };
        const meanScore = measured.length ? Math.round(measured.reduce((sum, row) => sum + row.score, 0) / measured.length) : null;
        const passed = points.filter(point => point.status === 'pass').length;
        const best = measured.reduce((a, b) => (!a || b.score > a.score ? b : a), null);
        const worst = measured.reduce((a, b) => (!a || b.score < a.score ? b : a), null);
        const toneOf = score => score == null ? '' : score >= 85 ? 'ok' : score >= 60 ? 'warn' : 'bad';
        $('globalKpis').innerHTML = [
            `<div class="cal-kpi ${toneOf(meanScore)}"><i class="cal-ring" style="--v:${meanScore ?? 0}"></i><span>Score moyen</span><strong>${meanScore ?? '—'}<small> / 100</small></strong><small>${measured.length} campagne(s)</small></div>`,
            kpi('Relevés conformes', points.length ? pct(100 * passed / points.length, 0) : '—', `${passed} / ${points.length} dans l’incertitude Fluke`, points.length ? toneOf(100 * passed / points.length) : ''),
            kpi('Biais médian', signed(median(measured.map(row => row.metrics.offset_A))), 'INA − Fluke, toutes campagnes'),
            kpi('Bruit médian', amps(median(measured.map(row => row.metrics.noise_pooled_A))), `${nf(0).format(median(measured.map(row => row.derived.noise_lsb)) ?? 0)} LSB`),
            kpi('Meilleure campagne', best ? `${best.score}/100` : '—', best ? escapeHtml(rowLabel(best)) : '', 'ok'),
            kpi('À corriger en priorité', worst ? `${worst.score}/100` : '—', worst ? escapeHtml(rowLabel(worst)) : '', worst && worst.score < 60 ? 'bad' : 'warn'),
        ].join('');

        // 1. Score par campagne (barres horizontales, du pire au meilleur) ----
        const ranked = [...measured].sort((a, b) => a.score - b.score);
        $('chartGlobalScore').parentElement.style.setProperty('--chart-h', `${Math.max(260, 30 * ranked.length + 70)}px`);
        chart('chartGlobalScore', () => ({
            type: 'bar',
            data: {labels: ranked.map(rowLabel), datasets: [{label: 'Score', data: ranked.map(row => row.score),
                backgroundColor: ranked.map(row => alpha(scoreColor(row.score), .8)), borderRadius: 4, barThickness: 18}]},
            options: {
                responsive: true, maintainAspectRatio: false, indexAxis: 'y', animation: {duration: 500},
                onClick: (event, elements) => { if (elements[0]) openFromGlobal(ranked[elements[0].index]); },
                plugins: {legend: {display: false}, tooltip: {callbacks: {afterLabel: item => {
                    const row = ranked[item.dataIndex];
                    return `Point faible : ${(AXES.find(([key]) => key === row.worst_axis) || [, '—'])[1]}`;
                }}}},
                scales: {x: {min: 0, max: 100, title: {display: true, text: 'Score de santé'}}, y: {ticks: {autoSkip: false}}},
            },
        }));

        // 2. Biais vs incertitude Fluke --------------------------------------
        const biasRows = measured.filter(row => row.metrics.offset_A != null);
        chart('chartGlobalBias', () => ({
            type: 'bar',
            data: {labels: biasRows.map(rowLabel), datasets: [
                {type: 'bar', label: 'Biais INA − Fluke', data: biasRows.map(row => conv(row.metrics.offset_A)),
                    backgroundColor: biasRows.map(row => alpha(((row.derived.offset_over_limit || 0) > 1 ? tone('--cal-bad') : channelColor(row.channel)) || '#1f5fbf', .75)), borderRadius: 3},
                {type: 'line', label: '± incertitude Fluke', data: biasRows.map(row => conv(row.metrics.reference_limit_A)),
                    borderColor: tone('--cal-ok') || '#16794f', borderDash: [5, 4], pointRadius: 0, stepped: 'middle', fill: false},
                {type: 'line', label: '', data: biasRows.map(row => -conv(row.metrics.reference_limit_A)),
                    borderColor: tone('--cal-ok') || '#16794f', borderDash: [5, 4], pointRadius: 0, stepped: 'middle', fill: false},
            ]},
            options: {...baseOptions('', `Biais (${state.unit})`), scales: {x: {type: 'category', ticks: {maxRotation: 50, autoSkip: false}}, y: {title: {display: true, text: `Biais (${state.unit})`}}},
                plugins: {legend: {position: 'bottom', labels: {filter: item => item.text, usePointStyle: true, boxWidth: 8}}},
                onClick: (event, elements) => { if (elements[0]) openFromGlobal(biasRows[elements[0].index]); }},
        }));

        // 3. Erreur selon le courant (tous les relevés) + régressions ---------
        const levelSets = ['A', 'B'].map(channel => ({channel, items: points.filter(point => point.channel === channel)}))
            .filter(group => group.items.length).map(group => ({type: 'scatter', label: `Relevés voie ${group.channel}`,
                data: group.items.map(point => ({x: conv(point.reference_A), y: conv(point.error_A)})),
                backgroundColor: alpha(channelColor(group.channel), .7), pointRadius: 4}));
        Object.entries(data.regressions).forEach(([channel, reg]) => {
            if (reg.status !== 'ok') return;
            const xs = points.filter(point => point.channel === channel).map(point => point.reference_A);
            const x0 = Math.min(...xs), x1 = Math.max(...xs);
            levelSets.push({type: 'line', label: `Tendance ${channel} : ${nf(3).format(reg.gain_error_pct)} %·I ${signed(reg.offset_A)}`,
                data: [x0, x1].map(x => ({x: conv(x), y: conv(reg.offset_A + reg.gain_error_pct / 100 * x)})),
                borderColor: channelColor(channel), borderWidth: 2, pointRadius: 0});
        });
        chart('chartGlobalLevels', () => ({data: {datasets: levelSets},
            options: baseOptions(`Courant de référence Fluke (${state.unit})`, `Erreur INA − Fluke (${state.unit})`)}));

        // 4. Bruit selon la fréquence ----------------------------------------
        const noiseSets = ['A', 'B'].map(channel => ({channel, items: measured.filter(row => row.channel === channel && row.metrics.noise_pooled_A != null)}))
            .filter(group => group.items.length).map(group => ({type: 'scatter', label: `Voie ${group.channel}`,
                data: group.items.map(row => ({x: row.protocol.frequency_hz, y: conv(row.metrics.noise_pooled_A), name: rowLabel(row)})),
                backgroundColor: alpha(channelColor(group.channel), .75), pointRadius: 6, pointHoverRadius: 8}));
        const freqs = measured.map(row => row.protocol.frequency_hz).filter(Boolean);
        if (freqs.length && measured[0]) noiseSets.push(hline('1 LSB', conv(measured[0].derived.lsb_A), Math.min(...freqs) * .8, Math.max(...freqs) * 1.25, css('--rg-ink-3') || '#67625c'));
        chart('chartGlobalNoise', () => ({data: {datasets: noiseSets}, options: {
            ...baseOptions('Fréquence d’acquisition (Hz)', `Bruit σ (${state.unit})`),
            scales: {x: {type: 'logarithmic', title: {display: true, text: 'Fréquence d’acquisition (Hz)'}}, y: {type: 'logarithmic', title: {display: true, text: `Bruit σ (${state.unit})`}}},
            plugins: {legend: {position: 'bottom', labels: {usePointStyle: true, boxWidth: 8}},
                tooltip: {callbacks: {label: item => `${item.raw.name || item.dataset.label} : ${nf(DIGITS[state.unit]).format(item.raw.y)} ${state.unit}`}}},
        }}));

        // 5. Évolution dans le temps ------------------------------------------
        const dated = [...measured].sort((a, b) => a.created_at - b.created_at);
        const day = ts => new Date(ts * 1000).toLocaleDateString('fr-FR', {day: '2-digit', month: '2-digit'});
        chart('chartGlobalTrend', () => ({data: {labels: dated.map(row => `${day(row.created_at)} ${row.name}`), datasets: [
            {type: 'line', label: 'Score', data: dated.map(row => row.score), yAxisID: 'y', borderColor: css('--rg-ink') || '#0b0c0e',
                backgroundColor: dated.map(row => scoreColor(row.score)), pointRadius: 5, tension: .25},
            {type: 'bar', label: `|Biais| (${state.unit})`, data: dated.map(row => row.metrics.offset_A == null ? null : Math.abs(conv(row.metrics.offset_A))),
                yAxisID: 'y1', backgroundColor: alpha(series(1), .35), borderRadius: 3},
        ]}, options: {...baseOptions('', 'Score'), scales: {
            x: {type: 'category', ticks: {maxRotation: 50, callback(value) { return this.getLabelForValue(value).slice(0, 18); }}},
            y: {min: 0, max: 100, title: {display: true, text: 'Score'}},
            y1: {position: 'right', grid: {drawOnChartArea: false}, title: {display: true, text: `|Biais| (${state.unit})`}},
        }}}));

        // Matrice « où ça cloche » ----------------------------------------------
        const cellText = {
            accuracy: row => signed(row.metrics.offset_A),
            conformity: row => `${row.metrics.pass_count ?? 0}/${(row.metrics.pass_count ?? 0) + (row.metrics.warning_count ?? 0) + (row.metrics.fail_count ?? 0)}`,
            noise: row => amps(row.metrics.noise_pooled_A),
            stability: row => amps(row.derived.drift_per_run_A),
            completeness: row => pct(row.metrics.completeness_pct, 1),
            repeatability: row => amps(row.metrics.run_mean_spread_A),
        };
        $('globalHeatmap').innerHTML = `<thead><tr><th>Campagne</th><th>Score</th>${AXES.map(([, label]) => `<th>${label}</th>`).join('')}</tr></thead><tbody>${
            [...rows].sort((a, b) => (a.score ?? 101) - (b.score ?? 101)).map(row => `<tr>
                <td><button type="button" class="cal-hm-name" data-open-campaign="${row.id}" data-open-channel="${row.channel}">${escapeHtml(row.name)} <small>${row.channel}</small></button></td>
                <td>${row.score == null ? '<span class="cal-hm-cell empty">—</span>' : `<span class="cal-hm-cell cal-hm-score" style="--g:${row.score / 100}">${row.score}</span>`}</td>
                ${AXES.map(([key, label]) => row.axes[key] == null
                    ? '<td><span class="cal-hm-cell empty" title="Non mesuré">—</span></td>'
                    : `<td><span class="cal-hm-cell" style="--g:${row.axes[key].toFixed(3)}" title="${label} : ${Math.round(row.axes[key] * 100)} %">${escapeHtml(cellText[key](row))}</span></td>`).join('')}
            </tr>`).join('') || `<tr><td colspan="${AXES.length + 2}"><div class="empty-notice">Aucune campagne.</div></td></tr>`
        }</tbody>`;

        // Diagnostic expert local -------------------------------------------------
        $('globalInsights').innerHTML = data.insights.map((item, index) => `
            <div class="cal-insight ${item.level}" style="--i:${Math.min(index, 8)}">
                <strong>${escapeHtml(item.title)}</strong>
                <p>${escapeHtml(item.text)}</p>
                ${item.action ? `<p class="cal-action">${escapeHtml(item.action)}</p>` : ''}
            </div>`).join('');

        // IA -------------------------------------------------------------------------
        const ai = data.ai || {};
        $('globalAiNote').textContent = ai.available
            ? `Claude (${ai.model}) compare toutes vos campagnes et propose un plan d’amélioration. Seuls les indicateurs agrégés (noms, paramètres, résultats) sont envoyés à l’API Anthropic, jamais les mesures brutes.`
            : `Analyse IA indisponible : ${ai.reason || 'configuration manquante.'} Le diagnostic expert ci-contre reste disponible hors ligne.`;
        $('globalAiRun').disabled = !ai.available || !measured.length;

        // Tableau complet -----------------------------------------------------------
        table('globalTable', ['Campagne', 'Voie', 'Créée', 'Fréquence', 'Durée', 'Répét.', 'Niveau Fluke', 'Biais', 'Biais / incert.', 'Erreur max', 'Bruit σ', 'Dérive / répét.', 'Complétude', 'Verdict', 'Score'],
            [...rows].sort((a, b) => b.created_at - a.created_at).map(row => [
                escapeHtml(row.name), row.channel, new Date(row.created_at * 1000).toLocaleDateString('fr-FR'),
                `${count(row.protocol.frequency_hz)} Hz`, `${count(row.protocol.duration_s)} s`, count(row.protocol.repetitions),
                amps(row.metrics.reference_mean_A), signed(row.metrics.offset_A),
                row.derived.offset_over_limit == null ? '—' : `${nf(1).format(row.derived.offset_over_limit)} ×`,
                amps(row.metrics.error_max_abs_A), amps(row.metrics.noise_pooled_A), amps(row.derived.drift_per_run_A),
                pct(row.metrics.completeness_pct, 1),
                `<span class="cal-pill ${row.metrics.verdict}">${STATUS[row.metrics.verdict]?.[0] || '—'}</span>`,
                row.score == null ? '—' : `<b style="color:${scoreColor(row.score)}">${row.score}</b>`,
            ]), true);
    }

    async function openFromGlobal(row) {
        if (!row) return;
        await openCampaign(row.id);
        if (state.full?.channels?.includes(row.channel)) setViewChannel(row.channel);
        selectTab('summary');
    }
    $('globalHeatmap').addEventListener('click', event => {
        const button = event.target.closest('[data-open-campaign]');
        if (button) openFromGlobal({id: button.dataset.openCampaign, channel: button.dataset.openChannel});
    });
    document.querySelector('.cal-global-head .cal-segment').addEventListener('click', event => {
        const button = event.target.closest('[data-global-channel]');
        if (!button) return;
        state.globalChannel = button.dataset.globalChannel;
        button.parentElement.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
        $('globalAiResult').innerHTML = '';
        loadGlobal();
    });
    $('globalRefresh').addEventListener('click', () => loadGlobal(true));

    function renderAiResult(result) {
        const list = (items, render) => items?.length ? `<ul class="cal-ai-list">${items.map(render).join('')}</ul>` : '<p class="cal-ai-meta">—</p>';
        const severity = {critique: 'fail', majeure: 'warning', mineure: 'neutral'};
        $('globalAiResult').innerHTML = `
            <p class="cal-ai-summary">${escapeHtml(result.synthese)}</p>
            <h3>Problèmes identifiés</h3>
            ${list(result.problemes, item => `<li><b>${escapeHtml(item.titre)}</b><span class="cal-pill ${severity[item.gravite] || 'neutral'}">${escapeHtml(item.gravite)}</span><br>${escapeHtml(item.constat)}<br><i>Cause probable :</i> ${escapeHtml(item.cause_probable)}${item.campagnes?.length ? `<br><span class="cal-ai-meta">${escapeHtml(item.campagnes.join(' · '))}</span>` : ''}</li>`)}
            <h3>Plan d’amélioration</h3>
            ${list([...(result.plan_amelioration || [])].sort((a, b) => a.priorite - b.priorite), item => `<li><b>${item.priorite}. ${escapeHtml(item.action)}</b><br>${escapeHtml(item.detail)}<br><span class="cal-ai-meta">Gain attendu : ${escapeHtml(item.gain_attendu)}</span></li>`)}
            <h3>Points forts</h3>
            ${list(result.points_forts, item => `<li>${escapeHtml(item)}</li>`)}
            <h3>Prochaines campagnes conseillées</h3>
            ${list(result.prochaines_campagnes, item => `<li>${escapeHtml(item)}</li>`)}
            <p class="cal-ai-meta">Généré par ${escapeHtml(result.model || 'Claude')} le ${new Date().toLocaleString('fr-FR')}. À vérifier par un ingénieur avant toute décision.</p>`;
    }
    $('globalAiRun').addEventListener('click', async () => {
        if (!confirm('Envoyer les indicateurs agrégés de vos campagnes (noms, paramètres, résultats — aucune mesure brute) à l’API Claude d’Anthropic pour analyse ?')) return;
        const button = $('globalAiRun');
        button.disabled = true;
        button.classList.add('loading');
        $('globalAiResult').innerHTML = '';
        try {
            const response = await request(api.globalAi, {method: 'POST', body: JSON.stringify({channel: state.globalChannel})});
            renderAiResult(response.analysis);
        } catch (error) {
            $('globalAiResult').innerHTML = `<div class="message error">${escapeHtml(error.message)}</div>`;
        } finally {
            button.classList.remove('loading');
            button.disabled = false;
        }
    });

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
