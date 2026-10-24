(function (global) {
    'use strict';

    const PROJECTS_KEY = 'engineeringProjects';
    const ACTIVE_KEY = 'activeProject';
    const DB_NAME = 'engineeringCalculatorProjects';
    const STORE_NAME = 'projectSnapshots';

    function parseJson(value, fallback) {
        try { return JSON.parse(value); } catch { return fallback; }
    }

    function projectId() {
        return global.crypto?.randomUUID?.() || `project-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }

    function getProjects() {
        const projects = parseJson(localStorage.getItem(PROJECTS_KEY) || '[]', []);
        return Array.isArray(projects) ? projects : [];
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
        await writeSnapshot(updatedProject.id, captureSnapshot());

        // 2. Nettoyage de la liste locale des projets (retire l'ancienne version du tableau)
        const updatedProjects = projects.filter(item => item.id !== updatedProject.id && item.name !== updatedProject.name);
        
        // 3. Insertion du projet à jour en tête de liste
        updatedProjects.unshift(updatedProject);
        
        localStorage.setItem(PROJECTS_KEY, JSON.stringify(updatedProjects));
        localStorage.setItem(ACTIVE_KEY, JSON.stringify(updatedProject));
        return updatedProject;
    }

    async function saveActiveProject() {
        const active = getActiveProject();
        if (!active?.name) return null;
        return saveProject(active);
    }

    function clearWorkingData() {
        sessionStorage.clear();
        const keys = [];
        for (let index = 0; index < localStorage.length; index += 1) keys.push(localStorage.key(index));
        keys.filter(key => key && ![PROJECTS_KEY, ACTIVE_KEY].includes(key)).forEach(key => localStorage.removeItem(key));
        localStorage.removeItem(ACTIVE_KEY);
    }

    async function restoreProject(project) {
        const snapshot = await readSnapshot(project.id).catch(() => null) || project.data || project.snapshot || null;
        clearWorkingData();
        if (snapshot?.sessionStorage) Object.entries(snapshot.sessionStorage).forEach(([key, value]) => sessionStorage.setItem(key, value));
        if (snapshot?.localStorage) Object.entries(snapshot.localStorage).forEach(([key, value]) => localStorage.setItem(key, value));
        const metadata = cleanMetadata(project);
        if (!metadata.serverFileUrl && metadata.filename) metadata.serverFileUrl = `/uploads/${encodeURIComponent(metadata.filename)}`;
        localStorage.setItem(ACTIVE_KEY, JSON.stringify(metadata));
        return metadata;
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
    // Récupère l'ID et le nom du projet à supprimer
    const targetId = typeof target === 'object' ? target.id : target;
    const targetName = typeof target === 'object' ? target.name : null;

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
        const matchName = targetName && p.name === targetName;
        return !matchId && !matchName;
    });

    localStorage.setItem(PROJECTS_KEY, JSON.stringify(projects));

    // 3. Réinitialisation du projet actif si c'est celui qu'on supprime
    const active = getActiveProject();
    if (active && (active.id === targetId || active.name === targetName)) {
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

    global.ProjectStorage = { getProjects, getActiveProject, saveProject, saveActiveProject, saveOrCreateProject, restoreProject, deleteProject, clearWorkingData, bindSaveButton };
})(window);
