(function (global) {
    'use strict';

    const PROJECTS_KEY = 'engineeringProjects';
    const ACTIVE_KEY = 'activeProject';
    const DB_NAME = 'engineeringCalculatorProjects';
    const STORE_NAME = 'projectSnapshots';
    const AUTOSAVE_DELAY_MS = 250;
    const WORKING_KEY = '__workingProjectId';
    let restoring = false;
    const diskStore = global.desktopEnvironment?.projectStore;
    let autosaveTimer = null;
    let autosaveInFlight = null;
    let autosaveDirty = false;
    let autosaveFailed = false;

    function parseJson(value, fallback) {
        try { return JSON.parse(value); } catch { return fallback; }
    }

    function projectId() {
        return global.crypto?.randomUUID?.() || `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function getProjects() {
        const projects = parseJson(localStorage.getItem(PROJECTS_KEY) || '[]', []);
        const merged = new Map((Array.isArray(projects) ? projects : []).map(project => [project.id || project.name, project]));
        if (diskStore) diskStore('list').forEach(project => {
            const previous = merged.get(project.id);
            if (!previous || project.updatedAt > previous.updatedAt) merged.set(project.id, project);
        });
        return [...merged.values()];
    }

    function getActiveProject() {
        return parseJson(localStorage.getItem(ACTIVE_KEY) || 'null', null);
    }

    function storageSnapshot(storage, excludedKeys = []) {
        const excluded = new Set(excludedKeys);
        const snapshot = {};
        for (let index = 0; index < storage.length; index += 1) {
            const key = storage.key(index);
            if (key && !excluded.has(key)) snapshot[key] = storage.getItem(key);
        }
        return snapshot;
    }

    function captureSnapshot() {
        return {
            version: 1,
            savedAt: new Date().toISOString(),
            sessionStorage: storageSnapshot(sessionStorage),
            localStorage: storageSnapshot(localStorage, [PROJECTS_KEY, ACTIVE_KEY])
        };
    }

    function workingProjectLoaded() {
        const active = getActiveProject();
        return active?.id && sessionStorage.getItem(WORKING_KEY) === active.id;
    }

    function checkpoint() {
        if (!diskStore || restoring || !workingProjectLoaded()) return;
        const metadata = { ...cleanMetadata(getActiveProject()), updatedAt: new Date().toISOString() };
        diskStore('write', { metadata, snapshot: captureSnapshot() });
    }

    function applySnapshot(snapshot) {
        if (snapshot?.sessionStorage) Object.entries(snapshot.sessionStorage).forEach(([key, value]) => sessionStorage.setItem(key, value));
        if (snapshot?.localStorage) Object.entries(snapshot.localStorage).forEach(([key, value]) => {
            if (![PROJECTS_KEY, ACTIVE_KEY].includes(key)) localStorage.setItem(key, value);
        });
    }

    function openDatabase() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(DB_NAME, 1);
            request.onupgradeneeded = () => {
                const database = request.result;
                if (!database.objectStoreNames.contains(STORE_NAME)) database.createObjectStore(STORE_NAME, { keyPath: 'id' });
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function writeSnapshot(id, snapshot) {
        const database = await openDatabase();
        await new Promise((resolve, reject) => {
            const transaction = database.transaction(STORE_NAME, 'readwrite');
            transaction.objectStore(STORE_NAME).put({ id, snapshot });
            transaction.oncomplete = resolve;
            transaction.onerror = () => reject(transaction.error);
        });
        database.close();
    }

    async function readSnapshot(id) {
        const database = await openDatabase();
        const result = await new Promise((resolve, reject) => {
            const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(id);
            request.onsuccess = () => resolve(request.result?.snapshot || null);
            request.onerror = () => reject(request.error);
        });
        database.close();
        return result;
    }

    function cleanMetadata(project) {
        const { data, snapshot, ...metadata } = project || {};
        return metadata;
    }

    async function saveProject(metadata) {
        const projects = getProjects();
        // Recherche si le projet existe déjà par son ID ou par son Nom
        const existingProject = projects.find(item => (metadata.id && item.id === metadata.id) || (!metadata.id && item.name === metadata.name));
        const now = new Date().toISOString();
        
        // Construction du nouvel objet projet mis à jour avec les métadonnées actuelles
        const updatedProject = {
            ...cleanMetadata(existingProject || {}),
            ...cleanMetadata(metadata),
            id: metadata.id || existingProject?.id || projectId(),
            createdAt: metadata.createdAt || existingProject?.createdAt || now,
            updatedAt: now
        };

        // 1. Remplacement total de l'instantané (efface et écrase l'ancien snapshot en base IndexedDB)
        const snapshot = captureSnapshot();
        snapshot.sessionStorage[WORKING_KEY] = updatedProject.id;
        if (diskStore) diskStore('write', { metadata: updatedProject, snapshot });
        try { await writeSnapshot(updatedProject.id, snapshot); }
        catch (error) { if (!diskStore) throw error; }

        // 2. Nettoyage de la liste locale des projets (retire l'ancienne version du tableau)
        const updatedProjects = projects.filter(item => item.id !== updatedProject.id && (item.id || item.name !== updatedProject.name));
        
        // 3. Insertion du projet à jour en tête de liste
        updatedProjects.unshift(updatedProject);
        
        localStorage.setItem(PROJECTS_KEY, JSON.stringify(updatedProjects));
        localStorage.setItem(ACTIVE_KEY, JSON.stringify(updatedProject));
        restoring = true;
        try { sessionStorage.setItem(WORKING_KEY, updatedProject.id); }
        finally { restoring = false; }
        return updatedProject;
    }

    async function saveActiveProject() {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
        while (autosaveInFlight) await autosaveInFlight;

        const active = getActiveProject();
        if (!active?.name || !workingProjectLoaded()) return null;

        autosaveDirty = false;
        autosaveFailed = false;
        const save = saveProject(active);
        autosaveInFlight = save;
        let project;
        try {
            project = await save;
        } catch (error) {
            autosaveDirty = true;
            throw error;
        } finally {
            autosaveInFlight = null;
        }

        return autosaveDirty ? saveActiveProject() : project;
    }

    function showAutosaveStatus(message) {
        const status = document.getElementById('saved-status');
        if (status) status.textContent = message;
    }

    function flushAutosave() {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
        if (!autosaveDirty || autosaveFailed || autosaveInFlight) return autosaveInFlight;

        const active = getActiveProject();
        if (!active?.name) {
            autosaveDirty = false;
            return null;
        }

        autosaveDirty = false;
        showAutosaveStatus('Enregistrement automatique…');
        autosaveInFlight = saveProject(active)
            .then(project => {
                showAutosaveStatus(`Modifications enregistrées (${project.name}).`);
            })
            .catch(error => {
                autosaveDirty = true;
                autosaveFailed = true;
                showAutosaveStatus(`Erreur de sauvegarde automatique : ${error.message}`);
                console.error('Erreur de sauvegarde automatique du projet :', error);
            })
            .finally(() => {
                autosaveInFlight = null;
                if (autosaveDirty && !autosaveFailed) scheduleAutosave();
            });
        return autosaveInFlight;
    }

    function scheduleAutosave() {
        if (restoring || !getActiveProject()?.name || !workingProjectLoaded()) return;
        try { checkpoint(); }
        catch (error) {
            showAutosaveStatus(`Erreur de sauvegarde automatique : ${error.message}`);
            console.error('Sauvegarde sur disque impossible :', error);
        }
        autosaveDirty = true;
        autosaveFailed = false;
        clearTimeout(autosaveTimer);
        autosaveTimer = setTimeout(flushAutosave, AUTOSAVE_DELAY_MS);
    }

    function installAutosave() {
        const originalSetItem = Storage.prototype.setItem;
        const originalRemoveItem = Storage.prototype.removeItem;
        const originalClear = Storage.prototype.clear;

        Storage.prototype.setItem = function (key, value) {
            originalSetItem.call(this, key, value);
            if (this === sessionStorage || (this === localStorage && key !== PROJECTS_KEY && key !== ACTIVE_KEY)) {
                scheduleAutosave();
            }
        };
        Storage.prototype.removeItem = function (key) {
            originalRemoveItem.call(this, key);
            if (this === sessionStorage || (this === localStorage && key !== PROJECTS_KEY && key !== ACTIVE_KEY)) {
                scheduleAutosave();
            }
        };
        Storage.prototype.clear = function () {
            originalClear.call(this);
            scheduleAutosave();
        };

        global.addEventListener('pagehide', () => { checkpoint(); flushAutosave(); });
        document.addEventListener('input', event => {
            const target = event.target;
            if (!target?.matches('input:not([type=file]):not([type=checkbox]):not([type=radio]),textarea')) return;
            const fields = [...document.querySelectorAll('input,textarea')];
            const fieldIndex = fields.indexOf(target);
            const focused = document.activeElement === target;
            target.dispatchEvent(new Event('change', { bubbles: true }));
            if (focused && !target.isConnected) document.querySelectorAll('input,textarea')[fieldIndex]?.focus();
        });
    }

    function clearWorkingData() {
        clearTimeout(autosaveTimer);
        autosaveTimer = null;
        autosaveDirty = false;
        restoring = true;
        try {
        sessionStorage.clear();
        const keys = [];
        for (let index = 0; index < localStorage.length; index += 1) keys.push(localStorage.key(index));
        keys.filter(key => key && ![PROJECTS_KEY, ACTIVE_KEY].includes(key)).forEach(key => localStorage.removeItem(key));
        localStorage.removeItem(ACTIVE_KEY);
        } finally { restoring = false; }
    }

    async function restoreProject(project) {
        await saveActiveProject();
        const diskRecord = diskStore && project.id ? diskStore('read', project.id) : null;
        const indexedSnapshot = await readSnapshot(project.id).catch(() => null);
        const candidates = [diskRecord?.snapshot, indexedSnapshot, project.data, project.snapshot].filter(Boolean);
        candidates.sort((first, second) => String(second.savedAt || '').localeCompare(String(first.savedAt || '')));
        const hasSource = snapshot => Object.values(parseJson(snapshot?.sessionStorage?.excelData, {}) || {}).some(sheet => Array.isArray(sheet?.data) && sheet.data.length > 0);
        const snapshot = candidates.find(hasSource) || candidates[0] || { sessionStorage: {}, localStorage: {} };
        const metadata = { ...cleanMetadata(project), ...diskRecord?.metadata };
        let sourceRecovered = false;
        if (!snapshot.sessionStorage) snapshot.sessionStorage = {};
        if (!hasSource(snapshot) && (metadata.serverFilename || metadata.filename)) {
            const response = await fetch('/recover-project-source', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ projectId: metadata.id, filename: metadata.serverFilename || metadata.filename })
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || 'Fiche Excel du projet introuvable.');
            snapshot.sessionStorage.excelData = JSON.stringify(result.sheets);
            snapshot.sessionStorage.wattmanServerFileUrl = result.serverFileUrl;
            metadata.serverFileUrl = result.serverFileUrl;
            sourceRecovered = true;
            if (snapshot.sessionStorage.homologationDevices === '[]') delete snapshot.sessionStorage.homologationDevices;
        }
        clearWorkingData();
        restoring = true;
        try { applySnapshot(snapshot); }
        finally { restoring = false; }
        if (!metadata.serverFileUrl && metadata.filename) metadata.serverFileUrl = `/uploads/${encodeURIComponent(metadata.filename)}`;
        localStorage.setItem(ACTIVE_KEY, JSON.stringify(metadata));
        const saved = await saveProject(metadata);
        return { ...saved, sourceRecovered };
    }

    function ensureDialogStyles() {
        if (document.getElementById('project-storage-styles')) return;
        const style = document.createElement('style');
        style.id = 'project-storage-styles';
        style.textContent = `
            .project-save-dialog{width:min(520px,calc(100% - 32px));border:0;border-radius:10px;padding:24px;box-shadow:0 24px 80px rgba(15,23,42,.35)}
            .project-save-dialog::backdrop{background:rgba(15,23,42,.48)}
            .project-save-dialog h2{margin:0 0 15px;color:#1f4e78}
            .project-save-dialog form{display:grid;gap:13px}.project-save-dialog label{display:grid;gap:5px;font-size:.86rem;font-weight:700;color:#475569}
            .project-save-dialog input{width:100%;padding:9px;border:1px solid #94a3b8;border-radius:6px;font:inherit}
            .project-save-dialog .dialog-actions{display:flex;justify-content:flex-end;gap:9px;margin-top:5px}
            .project-save-dialog button{border:0;border-radius:6px;padding:9px 14px;color:white;font:inherit;font-weight:750;cursor:pointer}
            .project-save-dialog .cancel-project{background:#64748b}.project-save-dialog .confirm-project{background:#087f5b}`;
        document.head.appendChild(style);
    }

    function requestProjectMetadata() {
        ensureDialogStyles();
        return new Promise(resolve => {
            const dialog = document.createElement('dialog');
            dialog.className = 'project-save-dialog';
            const today = new Date().toISOString().slice(0, 10);
            dialog.innerHTML = `<h2>Créer le projet</h2><form method="dialog"><label>Nom du projet<input name="name" required></label><label>Date<input name="date" type="date" value="${today}" required></label><label>Pilot Wattman<input name="pilotWattman" required></label><div class="dialog-actions"><button class="cancel-project" type="button">Annuler</button><button class="confirm-project" type="submit">Créer et enregistrer</button></div></form>`;
            document.body.appendChild(dialog);
            const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
            dialog.querySelector('.cancel-project').addEventListener('click', () => finish(null));
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
            dialog.querySelector('form').addEventListener('submit', event => {
                event.preventDefault();
                const values = Object.fromEntries(new FormData(event.currentTarget).entries());
                finish(values);
            });
            dialog.showModal();
            dialog.querySelector('[name="name"]').focus();
        });
    }

    async function saveOrCreateProject() {
        const active = getActiveProject();
        if (active?.name) return saveProject(active);
        const metadata = await requestProjectMetadata();
        return metadata ? saveProject(metadata) : null;
    }

    // Remplacez le module global.ProjectStorage dans project_storage.js par cette version mise à jour :

    async function deleteProject(target) {
    await saveActiveProject();
    // Récupère l'ID et le nom du projet à supprimer
    const targetId = typeof target === 'object' ? target.id : target;
    const targetName = typeof target === 'object' ? target.name : null;
    if (diskStore && targetId) diskStore('delete', targetId);

    // 1. Suppression du snapshot dans IndexedDB
    if (targetId) {
        try {
            const database = await openDatabase();
            await new Promise((resolve, reject) => {
                const transaction = database.transaction(STORE_NAME, 'readwrite');
                transaction.objectStore(STORE_NAME).delete(targetId);
                transaction.oncomplete = resolve;
                transaction.onerror = () => reject(transaction.error);
            });
            database.close();
        } catch (e) {
            console.warn('Erreur lors de la suppression du snapshot IndexedDB:', e);
        }
    }

    // 2. Suppression robuste dans localStorage (par ID OU par Nom)
    const projects = getProjects().filter(p => {
        const matchId = targetId && String(p.id) === String(targetId);
        const matchName = !targetId && targetName && p.name === targetName;
        return !matchId && !matchName;
    });

    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));

    // 3. Réinitialisation du projet actif si c'est celui qu'on supprime
    const active = getActiveProject();
    if (active && (active.id === targetId || (!targetId && active.name === targetName))) {
        clearWorkingData();
    }
}

    function bindSaveButton(button, statusElement) {
        const target = typeof button === 'string' ? document.getElementById(button) : button;
        const status = typeof statusElement === 'string' ? document.getElementById(statusElement) : statusElement;
        if (!target) return;
        target.addEventListener('click', async () => {
            target.disabled = true;
            try {
                const project = await saveOrCreateProject();
                if (status && project) status.textContent = `Projet « ${project.name} » enregistré.`;
                if (status && !project) status.textContent = 'Enregistrement annulé.';
            } catch (error) {
                if (status) status.textContent = `Erreur d’enregistrement : ${error.message}`;
                else alert(`Erreur d’enregistrement : ${error.message}`);
            } finally {
                target.disabled = false;
                if (status) setTimeout(() => { status.textContent = ''; }, 3500);
            }
        });
    }

    const active = getActiveProject();
    if (active?.id && !sessionStorage.getItem(WORKING_KEY)) {
        const record = diskStore ? diskStore('read', active.id) : null;
        if (record) applySnapshot(record.snapshot);
        if (record || sessionStorage.getItem('excelData') || (!active.filename && !active.serverFilename && sessionStorage.length > 0)) sessionStorage.setItem(WORKING_KEY, active.id);
    }
    installAutosave();
    global.ProjectStorage = { getProjects, getActiveProject, saveProject, saveActiveProject, saveOrCreateProject, restoreProject, deleteProject, clearWorkingData, bindSaveButton };
})(window);
