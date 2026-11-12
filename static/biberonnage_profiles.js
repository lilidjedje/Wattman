/*
 * Profils biberonnage complets, gérés comme les profils DM1 / DM2 / Customer Mode.
 * Chaque profil contient ses propres saisies et analyses sur 30 et 90 jours, ainsi que
 * les durées qu'il couvre : 30 jours, 90 jours ou les deux.
 *
 * Sur les pages biberonnage, les clés de stockage du profil actif sont recopiées dans
 * sessionStorage (les pages et exports existants les lisent directement) et chaque
 * écriture est reportée dans le profil. Dans un rapport de synthèse (summary=1), le
 * profil demandé par ?configuration= est lu sans rien modifier.
 */
(() => {
    const LIST_KEY = 'biberonnageProfiles';
    const ACTIVE_KEY = 'activeBiberonnageProfile';
    const DAYS_KEY = 'biberonnageProfileDays';
    const DAY_OPTIONS = { '30': '30 jours', '90': '90 jours', both: '30 et 90 jours' };
    const BASE_KEYS = ['biberonnageParams', 'biberonnageBuiltinAnalyses', 'biberonnageCustomAnalyses', 'biberonnageCalculatedAnalyses'];
    const KEYS = new Set(['biberonnage30Days', 'biberonnage90Days', DAYS_KEY, ...BASE_KEYS.flatMap(key => [key, `${key}90Days`])]);

    const nativeRead = Storage.prototype.getItem;
    const nativeWrite = Storage.prototype.setItem;
    const nativeRemove = Storage.prototype.removeItem;
    const raw = key => nativeRead.call(sessionStorage, key);
    const parse = (text, fallback = null) => { try { return JSON.parse(text) ?? fallback; } catch { return fallback; } };
    const query = new URLSearchParams(location.search);
    const route = location.pathname.replace(/\/$/, '') || '/';
    const scoped = route === '/biberonnage' || route === '/biberonnage/resultats';
    const report = query.get('summary') === '1' || query.get('export') === '1';
    const newId = () => globalThis.crypto?.randomUUID?.() || `bib-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    function list() {
        const saved = parse(raw(LIST_KEY));
        if (Array.isArray(saved) && saved.length) return saved;
        const values = Object.fromEntries([...KEYS].map(key => [key, raw(key)]).filter(([, value]) => value !== null));
        const profiles = [{ id: 'main', name: 'Profil principal', values }];
        nativeWrite.call(sessionStorage, LIST_KEY, JSON.stringify(profiles));
        return profiles;
    }

    function save(profiles) {
        // Passe par sessionStorage.setItem pour déclencher la sauvegarde automatique du projet.
        sessionStorage.setItem(LIST_KEY, JSON.stringify(profiles));
    }

    function daysOf(profile) {
        const value = profile?.values?.[DAYS_KEY];
        return value === '30' || value === '90' ? [Number(value)] : [30, 90];
    }

    let selected = list().find(profile => profile.id === (query.get('configuration') || raw(ACTIVE_KEY))) || list()[0];

    function loadIntoSession(profile) {
        KEYS.forEach(key => {
            if (profile.values[key] === undefined) nativeRemove.call(sessionStorage, key);
            else nativeWrite.call(sessionStorage, key, profile.values[key]);
        });
    }

    function persistSelected() {
        if (report) return;
        const profiles = list();
        const index = profiles.findIndex(profile => profile.id === selected.id);
        if (index < 0) return;
        profiles[index] = { ...profiles[index], values: selected.values };
        save(profiles);
    }

    if (scoped) {
        if (report) {
            // Rapport : lecture seule du profil demandé.
            const memory = { ...selected.values };
            Storage.prototype.getItem = function (key) {
                if (this === sessionStorage && KEYS.has(String(key))) return memory[key] ?? null;
                return nativeRead.call(this, key);
            };
            Storage.prototype.setItem = function (key, value) {
                if (this === sessionStorage && KEYS.has(String(key))) { memory[key] = String(value); return; }
                return nativeWrite.call(this, key, value);
            };
            Storage.prototype.removeItem = function (key) {
                if (this === sessionStorage && KEYS.has(String(key))) { delete memory[key]; return; }
                return nativeRemove.call(this, key);
            };
        } else {
            nativeWrite.call(sessionStorage, ACTIVE_KEY, selected.id);
            loadIntoSession(selected);
            const previousWrite = Storage.prototype.setItem;
            const previousRemove = Storage.prototype.removeItem;
            Storage.prototype.setItem = function (key, value) {
                previousWrite.call(this, key, value);
                if (this === sessionStorage && KEYS.has(String(key)) && selected.values[key] !== String(value)) {
                    selected.values[key] = String(value);
                    persistSelected();
                }
            };
            Storage.prototype.removeItem = function (key) {
                previousRemove.call(this, key);
                if (this === sessionStorage && KEYS.has(String(key)) && key in selected.values) {
                    delete selected.values[key];
                    persistSelected();
                }
            };
        }
    }

    function activate(id) {
        const profile = list().find(item => item.id === id);
        if (!profile) return false;
        selected = profile;
        sessionStorage.setItem(ACTIVE_KEY, id);
        loadIntoSession(profile);
        return true;
    }

    function create(name) {
        const profiles = list();
        const profile = { id: newId(), name: name || `Profil ${profiles.length + 1}`, values: { [DAYS_KEY]: 'both' } };
        profiles.push(profile);
        save(profiles);
        activate(profile.id);
        return profile;
    }

    function rename(name) {
        const profiles = list();
        const profile = profiles.find(item => item.id === selected.id);
        if (!profile) return;
        profile.name = name.trim() || 'Profil sans nom';
        selected.name = profile.name;
        save(profiles);
    }

    function setDays(value) {
        if (!DAY_OPTIONS[value]) return;
        sessionStorage.setItem(DAYS_KEY, value);
        window.dispatchEvent(new CustomEvent('biberonnage-profile-days', { detail: { days: daysOf(selected) } }));
    }

    function remove(id) {
        const profiles = list();
        if (profiles.length <= 1 || !profiles.some(profile => profile.id === id)) return false;
        const remaining = profiles.filter(profile => profile.id !== id);
        save(remaining);
        if (selected.id === id) activate(remaining[0].id);
        return true;
    }

    function reload() {
        const url = new URL(location.href);
        url.searchParams.delete('configuration');
        location.href = url.pathname + url.search + url.hash;
    }

    window.BiberonnageProfiles = {
        DAY_OPTIONS, list, daysOf, activate, create, rename, remove, setDays,
        get selected() { return selected; },
        get days() { return daysOf(selected); }
    };

    if (!scoped || report) return;

    document.addEventListener('DOMContentLoaded', () => {
        const bar = document.createElement('section');
        bar.className = 'autonomy-profile-bar biberonnage-profile-bar';
        bar.setAttribute('aria-label', 'Profils biberonnage');

        const profileLabel = document.createElement('label');
        profileLabel.textContent = 'Profil Biberonnage';
        const select = document.createElement('select');
        select.id = 'biberonnage-profile-select';
        list().forEach(profile => select.add(new Option(profile.name, profile.id)));
        select.value = selected.id;
        select.onchange = () => { activate(select.value); reload(); };
        profileLabel.append(select);

        const nameLabel = document.createElement('label');
        nameLabel.textContent = 'Nom du profil';
        const name = document.createElement('input');
        name.id = 'biberonnage-profile-name';
        name.maxLength = 80;
        name.value = selected.name;
        name.oninput = () => { rename(name.value); select.selectedOptions[0].textContent = selected.name; };
        nameLabel.append(name);

        const daysLabel = document.createElement('label');
        daysLabel.textContent = 'Biberonnage étudié';
        const days = document.createElement('select');
        days.id = 'biberonnage-profile-days';
        Object.entries(DAY_OPTIONS).forEach(([value, label]) => days.add(new Option(label, value)));
        days.value = selected.values[DAYS_KEY] === '30' || selected.values[DAYS_KEY] === '90' ? selected.values[DAYS_KEY] : 'both';
        days.onchange = () => setDays(days.value);
        daysLabel.append(days);

        const add = document.createElement('button');
        add.type = 'button';
        add.id = 'add-biberonnage-profile';
        add.textContent = 'Ajouter un profil';
        add.onclick = () => { create(); reload(); };

        const deletion = document.createElement('button');
        deletion.type = 'button';
        deletion.id = 'remove-biberonnage-profile';
        deletion.className = 'danger';
        deletion.textContent = 'Supprimer ce profil';
        deletion.disabled = list().length === 1;
        deletion.onclick = () => {
            if (confirm(`Supprimer le profil « ${selected.name} » et toutes ses données de biberonnage ?`) && remove(selected.id)) reload();
        };

        const help = document.createElement('small');
        help.textContent = 'Consommations, seuils et analyses sur 30 et 90 jours sont enregistrés automatiquement dans ce profil et disponibles dans les synthèses.';

        bar.append(profileLabel, nameLabel, daysLabel, add, deletion, help);
        const anchor = document.querySelector('[data-profile-bar-anchor], header.header, header.page-header');
        if (anchor) anchor.after(bar); else document.body.prepend(bar);
    });
})();
