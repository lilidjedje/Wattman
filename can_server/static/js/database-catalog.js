/* Catalogue de la base locale : identification visuelle (type, date, canaux),
   filtres, sélection fine (fichier entier ou canal) et suppression ciblée. */
(function () {
    'use strict';
    const endpoints = window.databaseCatalogEndpoints;
    const list = document.getElementById('catalogList');
    const timeline = document.getElementById('catalogTimeline');
    const search = document.getElementById('catalogSearch');
    const selectAll = document.getElementById('catalogSelectAll');
    const actionbar = document.getElementById('catalogActionbar');
    const selectionLabel = document.getElementById('catalogSelection');
    const feedback = document.getElementById('catalogMessage');
    const state = {sources: [], kind: 'all', channel: 'all', query: '', selected: new Map()};
    const number = value => new Intl.NumberFormat('fr-FR').format(Number(value || 0));
    const KIND = {asc: 'Log ASC', digital: 'Numérique ESP32', other: 'Autre source'};

    function escapeHtml(value) {
        const node = document.createElement('span');
        node.textContent = value ?? '';
        return node.innerHTML;
    }
    function duration(seconds) {
        const total = Math.max(0, Number(seconds || 0));
        const two = value => new Intl.NumberFormat('fr-FR', {minimumFractionDigits: 2, maximumFractionDigits: 2}).format(value);
        if (total >= 86400) return `${two(total / 86400)} j`;
        if (total >= 3600) return `${two(total / 3600)} h`;
        if (total >= 60) return `${two(total / 60)} min`;
        return `${two(total)} s`;
    }
    function notify(text, type = '') {
        feedback.hidden = !text;
        feedback.textContent = text;
        feedback.className = `message ${type}`.trim();
    }
    function visibleSources() {
        const terms = state.query.toLowerCase().split(/\s+/).filter(Boolean);
        return state.sources.filter(source => {
            if (state.kind !== 'all' && source.kind !== state.kind) return false;
            if (state.channel !== 'all' && !source.channels[state.channel]) return false;
            const haystack = `${source.label} ${source.name} ${source.started_label} ${source.ended_label}`.toLowerCase();
            return terms.every(term => haystack.includes(term));
        });
    }
    function channelsOf(source) {
        return Object.keys(source.channels).sort();
    }
    function selectionCount() {
        let files = 0, channels = 0, samples = 0;
        state.selected.forEach((chosen, key) => {
            const source = state.sources.find(item => item.source_file === key);
            if (!source || !chosen.size) return;
            const all = channelsOf(source);
            if (chosen.size === all.length) files += 1; else channels += chosen.size;
            chosen.forEach(channel => { samples += source.channels[channel]?.samples || 0; });
        });
        return {files, channels, samples};
    }
    function updateActionbar() {
        const {files, channels, samples} = selectionCount();
        const parts = [];
        if (files) parts.push(`${files} enregistrement${files > 1 ? 's' : ''} complet${files > 1 ? 's' : ''}`);
        if (channels) parts.push(`${channels} canal${channels > 1 ? 'aux' : ''} isolé${channels > 1 ? 's' : ''}`);
        actionbar.hidden = !parts.length;
        selectionLabel.textContent = parts.length ? `${parts.join(' + ')} · ${number(samples)} mesures` : '';
        const visible = visibleSources();
        selectAll.checked = visible.length > 0 && visible.every(source => (state.selected.get(source.source_file)?.size || 0) === channelsOf(source).length);
        selectAll.indeterminate = !selectAll.checked && visible.some(source => state.selected.get(source.source_file)?.size);
    }
    function renderTimeline(sources) {
        const dated = sources.filter(source => source.start != null && source.end != null);
        if (!dated.length) { timeline.innerHTML = ''; timeline.hidden = true; return; }
        timeline.hidden = false;
        const min = Math.min(...dated.map(source => source.start));
        const max = Math.max(...dated.map(source => source.end));
        const span = Math.max(1, max - min);
        const fmt = ts => new Date(ts * 1000).toLocaleString('fr-FR', {day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit'});
        timeline.innerHTML = `<div class="db-timeline-track">${dated.map(source => {
            const left = ((source.start - min) / span) * 100;
            const width = Math.max(.6, ((source.end - source.start) / span) * 100);
            return `<span class="db-timeline-bar db-kind-${source.kind}" style="left:${left}%;width:${Math.min(width, 100 - left)}%" title="${escapeHtml(source.label)}"></span>`;
        }).join('')}</div><div class="db-timeline-scale"><span>${fmt(min)}</span><span>${fmt(max)}</span></div>`;
    }
    function render() {
        const sources = visibleSources();
        renderTimeline(state.sources);
        if (!state.sources.length) {
            list.innerHTML = '<div class="empty-notice">La base est vide. Ajoutez des logs ASC ci-dessus ou lancez une mesure numérique depuis la Workstation.</div>';
        } else if (!sources.length) {
            list.innerHTML = '<div class="empty-notice">Aucun enregistrement ne correspond aux filtres.</div>';
        } else {
            const nameCounts = new Map();
            state.sources.filter(item => item.kind === 'asc').forEach(item => nameCounts.set(item.name, (nameCounts.get(item.name) || 0) + 1));
            list.innerHTML = sources.map((source, index) => {
                const duplicate = source.kind === 'asc' && nameCounts.get(source.name) > 1;
                const chosen = state.selected.get(source.source_file) || new Set();
                const channels = channelsOf(source);
                const full = channels.length > 0 && chosen.size === channels.length;
                const frequencies = channels.map(channel => source.channels[channel].frequency_hz).filter(Boolean);
                return `
                <article class="db-row db-kind-${source.kind}${chosen.size ? ' is-selected' : ''}" data-source="${escapeHtml(source.source_file)}" style="--i:${Math.min(index, 12)}">
                    <label class="db-row-check" title="Sélectionner tout l’enregistrement">
                        <input type="checkbox" data-role="source" ${full ? 'checked' : ''} aria-label="Sélectionner ${escapeHtml(source.name)}">
                    </label>
                    <div class="db-row-main">
                        <div class="db-row-head">
                            <span class="db-kind db-kind-${source.kind}">${KIND[source.kind] || KIND.other}</span>
                            <strong class="db-row-name" title="${escapeHtml(source.source_file)}">${escapeHtml(source.name)}</strong>
                            ${duplicate ? '<span class="db-duplicate" title="Ce fichier ASC a été importé plusieurs fois : les mesures sont en double.">Doublon possible</span>' : ''}
                        </div>
                        <div class="db-row-meta">
                            <span><b>Début</b> ${escapeHtml(source.started_label)}</span>
                            <span><b>Fin</b> ${escapeHtml(source.ended_label)}</span>
                            <span><b>Durée</b> ${duration(source.duration_s)}</span>
                            <span><b>Mesures</b> ${number(source.samples)}</span>
                            ${frequencies.length ? `<span><b>Fréquence</b> ${[...new Set(frequencies)].map(number).join(' / ')} Hz</span>` : ''}
                        </div>
                    </div>
                    <div class="db-row-channels" role="group" aria-label="Canaux">
                        ${channels.length ? channels.map(channel => `
                            <label class="db-channel channel-${channel}${chosen.has(channel) ? ' checked' : ''}" title="Sélectionner uniquement le canal ${channel}">
                                <input type="checkbox" data-role="channel" data-channel="${channel}" ${chosen.has(channel) ? 'checked' : ''}>
                                <span>Canal ${channel}</span><small>${number(source.channels[channel].samples)}</small>
                            </label>`).join('') : '<span class="db-channel empty">Aucune mesure</span>'}
                    </div>
                </article>`;
            }).join('');
        }
        updateActionbar();
    }
    function toggle(sourceKey, channels, on) {
        const source = state.sources.find(item => item.source_file === sourceKey);
        if (!source) return;
        const chosen = state.selected.get(sourceKey) || new Set();
        (channels || channelsOf(source)).forEach(channel => on ? chosen.add(channel) : chosen.delete(channel));
        if (!channelsOf(source).length && on) chosen.add('*');
        if (!on) chosen.delete('*');
        if (chosen.size) state.selected.set(sourceKey, chosen); else state.selected.delete(sourceKey);
    }
    async function load() {
        try {
            const response = await fetch(endpoints.list, {cache: 'no-store'});
            if (!response.ok) throw new Error('Lecture du contenu de la base impossible.');
            state.sources = (await response.json()).sources || [];
            const keys = new Set(state.sources.map(source => source.source_file));
            [...state.selected.keys()].forEach(key => { if (!keys.has(key)) state.selected.delete(key); });
            render();
        } catch (error) {
            list.innerHTML = `<div class="empty-notice">${escapeHtml(error.message)}</div>`;
        }
    }

    list.addEventListener('change', event => {
        const row = event.target.closest('.db-row');
        if (!row) return;
        if (event.target.dataset.role === 'source') toggle(row.dataset.source, null, event.target.checked);
        if (event.target.dataset.role === 'channel') toggle(row.dataset.source, [event.target.dataset.channel], event.target.checked);
        render();
    });
    selectAll.addEventListener('change', () => {
        visibleSources().forEach(source => toggle(source.source_file, null, selectAll.checked));
        render();
    });
    search.addEventListener('input', () => { state.query = search.value; render(); });
    document.querySelectorAll('[data-kind-filter], [data-channel-filter]').forEach(button => {
        button.addEventListener('click', () => {
            const key = button.dataset.kindFilter ? 'kind' : 'channel';
            state[key] = button.dataset.kindFilter || button.dataset.channelFilter;
            button.parentElement.querySelectorAll('button').forEach(item => item.classList.toggle('active', item === button));
            render();
        });
    });
    document.getElementById('catalogClear').addEventListener('click', () => { state.selected.clear(); render(); });
    document.getElementById('catalogDelete').addEventListener('click', async () => {
        const items = [];
        state.selected.forEach((chosen, key) => {
            const source = state.sources.find(item => item.source_file === key);
            if (!source || !chosen.size) return;
            const all = channelsOf(source);
            items.push({source_file: key, channels: chosen.has('*') || chosen.size === all.length ? null : [...chosen]});
        });
        if (!items.length) return;
        const {samples} = selectionCount();
        const names = items.slice(0, 6).map(item => {
            const source = state.sources.find(entry => entry.source_file === item.source_file);
            return `• ${source.label}${item.channels ? ` (canal ${item.channels.join('+')} uniquement)` : ''}`;
        }).join('\n');
        const more = items.length > 6 ? `\n… et ${items.length - 6} autre(s)` : '';
        if (!confirm(`Supprimer définitivement ${number(samples)} mesures ?\n\n${names}${more}`)) return;
        const button = document.getElementById('catalogDelete');
        try {
            button.disabled = true;
            const response = await fetch(endpoints.remove, {
                method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({items})
            });
            const data = await response.json();
            if (!response.ok) throw new Error(data.message || 'Suppression refusée.');
            state.selected.clear();
            notify(data.message, 'ok');
            if (typeof window.refreshDatabase === 'function') await window.refreshDatabase();
            await load();
            window.dispatchEvent(new Event('can-database-changed'));
        } catch (error) {
            notify(error.message, 'error');
        } finally {
            button.disabled = false;
        }
    });
    window.addEventListener('can-database-changed', load);
    load();
})();
