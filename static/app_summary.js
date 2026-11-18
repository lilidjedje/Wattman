/*
 * Sommaire rétractable commun, ajouté sur les pages qui n'en possèdent pas.
 * Usage : <script src="/static/app_summary.js" data-items="mode,home"></script>
 * Les projets étant enregistrés automatiquement, le sommaire n'a pas de bouton « Enregistrer » :
 * il affiche seulement l'état de la sauvegarde automatique.
 */
(() => {
    const script = document.currentScript;
    const ITEMS = {
        autonomy: { label: 'Menu Autonomie', href: '/battery_menu', kind: 'autonomy' },
        battery: { label: 'Config Batterie', href: '/battery_configuration', kind: 'autonomy' },
        biberonnage: { label: 'Biberonnage', href: '/biberonnage', kind: 'autonomy' },
        homologation: { label: 'DCDC Sizing / WLTC', href: '/homologation_configuration', kind: 'mode' },
        synthesis: { label: 'Synthèse DCDC / WLTC', href: '/synthesis', kind: 'mode' },
        components: { label: 'Sélection des composants', href: '/select_components', kind: 'autonomy' },
        pdf: { label: 'Export synthèses PDF', href: '/export_synthesis_pdf?auto=1', kind: 'mode' },
        mode: { label: 'Sélection du mode', href: '/mode_selection', kind: 'mode' },
        home: { label: 'Accueil', href: '/', kind: 'home' }
    };

    function injectStyles() {
        if (document.getElementById('app-summary-styles')) return;
        const style = document.createElement('style');
        style.id = 'app-summary-styles';
        style.textContent = `
            .app-summary-bar { display: flex; justify-content: flex-end; padding: 16px 16px 0; position: relative; z-index: 1000; }
            .app-summary-floating .menu-content { z-index: 1000; }
            .app-summary-floating details { background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; box-shadow: 0 4px 12px rgba(0,0,0,.1); }
            .app-summary-floating summary { padding: 10px 18px; font-weight: 700; cursor: pointer; color: #1f4e78; list-style: none; background: #fff; border-radius: 8px; user-select: none; font-family: "Segoe UI", Tahoma, sans-serif; }
            .app-summary-floating summary::-webkit-details-marker { display: none; }
            .app-summary-floating .menu-content { position: absolute; right: 0; top: 110%; background: #fff; border: 1px solid #cbd5e1; border-radius: 8px; padding: 12px; display: flex; flex-direction: column; gap: 8px; box-shadow: 0 10px 25px rgba(0,0,0,.15); min-width: 230px; }
            .app-summary-floating .btn-menu { border: 0; border-radius: 5px; padding: 9px 14px; color: #fff; font: inherit; font-weight: 700; cursor: pointer; text-align: left; width: 100%; }
            .app-summary-floating .btn-autonomy { background: #64748b; }
            .app-summary-floating .btn-mode { background: #667eea; }
            .app-summary-floating .btn-home { background: #1e293b; }
            .app-summary-floating .saved-status { min-height: 1.25em; color: #087f5b; font-size: .85rem; font-weight: 700; text-align: right; }
        `;
        document.head.appendChild(style);
    }

    function mount() {
        if (document.querySelector('.app-summary')) return;
        const keys = (script?.dataset.items || 'mode,home').split(',').map(key => key.trim()).filter(key => ITEMS[key]);
        const current = location.pathname;
        injectStyles();
        const wrapper = document.createElement('div');
        wrapper.className = 'retractable-menu app-summary app-summary-floating';
        const details = document.createElement('details');
        const summary = document.createElement('summary');
        summary.textContent = 'Sommaire';
        const content = document.createElement('div');
        content.className = 'menu-content';
        if (!document.getElementById('saved-status')) {
            const status = document.createElement('span');
            status.className = 'saved-status';
            status.id = 'saved-status';
            status.setAttribute('aria-live', 'polite');
            content.appendChild(status);
        }
        keys.filter(key => ITEMS[key].href.split('?')[0] !== current).forEach(key => {
            const item = ITEMS[key];
            const button = document.createElement('button');
            button.type = 'button';
            button.className = `btn-menu btn-${item.kind}`;
            button.dataset.href = item.href;
            button.textContent = item.label;
            button.addEventListener('click', () => { window.location.href = item.href; });
            content.appendChild(button);
        });
        details.append(summary, content);
        wrapper.appendChild(details);
        // Sommaire placé en haut à droite de la page, dans le flux (les thèmes imposent position: relative).
        const target = document.querySelector('[data-summary-slot]');
        if (target) target.appendChild(wrapper);
        else {
            const bar = document.createElement('div');
            bar.className = 'app-summary-bar';
            bar.appendChild(wrapper);
            document.body.prepend(bar);
        }
        // Barre Wattman présente : le sommaire est intégré à la barre du haut.
        if (window.RGUI?.dockSummary?.(wrapper)) return;
        document.addEventListener('click', event => { if (details.open && !wrapper.contains(event.target)) details.open = false; });
        document.addEventListener('keydown', event => { if (event.key === 'Escape' && details.open) { details.open = false; summary.focus(); } });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
