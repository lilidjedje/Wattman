/* Wattman — runtime du design system (thème, mouvement, barre d'application).
   Purement présentationnel : ne lit ni n'écrit aucune donnée de calcul.
   Préférences locales : rg-theme (light|dark|system), rg-motion (full|reduced). */
(function () {
  'use strict';
  const root = document.documentElement;
  const store = {
    get(key) { try { return localStorage.getItem(key); } catch { return null; } },
    set(key, value) { try { localStorage.setItem(key, value); } catch { /* stockage indisponible */ } }
  };
  const media = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolvedTheme() {
    const pref = store.get('rg-theme') || 'light';
    if (pref === 'system') return media && media.matches ? 'dark' : 'light';
    return pref === 'dark' ? 'dark' : 'light';
  }
  function applyTheme() {
    const theme = resolvedTheme();
    if (theme === 'dark') root.dataset.theme = 'dark';
    else root.dataset.theme = 'light';
    window.dispatchEvent(new CustomEvent('rg-themechange', { detail: { theme } }));
  }
  function applyMotion() {
    if (store.get('rg-motion') === 'reduced') root.dataset.motion = 'reduced';
    else delete root.dataset.motion;
  }
  // Appliqué immédiatement (script synchrone dans <head>) : pas de flash de thème.
  applyTheme();
  applyMotion();
  if (media && media.addEventListener) media.addEventListener('change', () => { if (store.get('rg-theme') === 'system') applyTheme(); });

  const prefersReducedMotion = () =>
    root.dataset.motion === 'reduced' || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

  const ICONS = {
    sun: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
    moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z"/></svg>',
    motion: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12h4l3-7 4 14 3-7h4"/></svg>',
    home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M3 11 12 4l9 7v9h-6v-6H9v6H3z"/></svg>'
  };
  // Marque graphique originale (deux lames inclinées = puissance / mesure).
  // Ce n'est PAS le losange Renault : le logotype officiel n'est pas embarqué.
  const MARK = '<svg class="rg-brand-mark" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 20 9.5 4H13L6.5 20z" fill="#f4f4f2"/><path d="M11 20l6.5-16H21l-6.5 16z" fill="var(--rg-yellow)"/></svg>';

  function activeProjectName() {
    try { return (JSON.parse(store.get('activeProject') || '{}').name || '').trim(); } catch { return ''; }
  }
  function storedUser() {
    try { return JSON.parse(store.get('engineeringAuthUser') || 'null'); } catch { return null; }
  }

  // Sommaire contextuel : uniquement des routes réellement présentes dans l'application.
  const PROJECT_TABS = [
    { label: 'Composants', href: '/select_components', match: ['/select_components', '/display'] },
    { label: "Modes d'analyse", href: '/mode_selection', match: ['/mode_selection'] },
    { label: 'DCDC / WLTC', href: '/homologation_configuration' },
    { label: 'Autonomie batterie', href: '/battery_configuration' },
    { label: 'Analyse de logs', href: '/analyse_logs/' }
  ];
  const MODULES = [
    {
      name: 'DCDC / WLTC',
      paths: ['/homologation_configuration', '/edit_current', '/edit_alternator', '/edit_pao', '/edit_gmv', '/synthesis'],
      tabs: [
        { label: 'Configuration', href: '/homologation_configuration' },
        { label: 'DCDC Sizing', href: '/edit_current' },
        { label: 'WLTC (-7 °C)', href: '/edit_alternator' },
        { label: 'PAO', href: '/edit_pao' },
        { label: 'GMV', href: '/edit_gmv' },
        { label: 'Synthèse', href: '/synthesis' }
      ]
    },
    {
      name: 'Autonomie batterie',
      paths: ['/battery_configuration', '/battery_menu', '/configure_customer_currents', '/configure_dm_currents', '/edit_customer_mode',
        '/edit_dm_mode', '/fixed_consumption', '/sleep_consumption', '/vehicle_sleep', '/battery_results_menu', '/dm_results', '/biberonnage', '/biberonnage/resultats'],
      tabs: [
        { label: 'Batterie', href: '/battery_configuration' },
        { label: 'Menu', href: '/battery_menu' },
        { label: 'Customer Mode', href: '/configure_customer_currents', match: ['/configure_customer_currents', '/edit_customer_mode'] },
        { label: 'Mode DM', href: '/configure_dm_currents', match: ['/configure_dm_currents', '/edit_dm_mode'] },
        { label: 'Biberonnage', href: '/biberonnage', match: ['/biberonnage', '/biberonnage/resultats'] },
        { label: 'Synthèse Customer', href: '/battery_results_menu' },
        { label: 'Résultats DM', href: '/dm_results' }
      ]
    },
    {
      name: 'Analyse de logs',
      paths: ['/analyse_logs'],
      tabs: [
        { label: 'Workstation', href: '/analyse_logs/', match: ['/analyse_logs/', '/analyse_logs'] },
        { label: 'Acquisition', href: '/analyse_logs/measurement', onlyWhenActive: true },
        { label: 'Import des logs', href: '/analyse_logs/dashboard/import' },
        { label: 'Préparer le dashboard', href: '/analyse_logs/dashboard/setup' },
        { label: 'Dashboard', href: '/analyse_logs/dashboard', onlyWhenActive: true }
      ]
    }
  ];
  const path = location.pathname.replace(/\/+$/, '') || '/';
  const isActive = tab => (tab.match || [tab.href]).some(p => (p.replace(/\/+$/, '') || '/') === path);

  function navigationModel() {
    if (path === '/' || path === '/admin' || path === '/import_project') return null; // Hub : pas de sommaire
    const module = MODULES.find(m => m.paths.some(p => path === p || path.startsWith(`${p}/`)));
    if (module) return { name: module.name, tabs: module.tabs.filter(t => !t.onlyWhenActive || isActive(t)) };
    if (!activeProjectName()) return null;
    return { name: 'Projet', tabs: PROJECT_TABS };
  }

  function button(icon, label, onClick, pressed) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rg-icon-btn';
    b.title = label;
    b.setAttribute('aria-label', label);
    if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed));
    b.innerHTML = icon;
    b.addEventListener('click', onClick);
    return b;
  }

  function buildNav(model) {
    const nav = document.createElement('nav');
    nav.className = 'rg-nav';
    nav.setAttribute('aria-label', 'Navigation du projet');
    const project = activeProjectName();
    if (project) {
      const ctx = document.createElement(model ? 'a' : 'span');
      ctx.className = 'rg-nav-context';
      ctx.textContent = project;
      ctx.title = `Projet actif : ${project}${model ? " — revenir aux modes d'analyse" : ''}`;
      if (model) ctx.href = '/mode_selection';
      nav.append(ctx);
    }
    if (!model) return nav;
    const label = document.createElement('span');
    label.className = 'rg-nav-module';
    label.textContent = model.name;
    const tabs = document.createElement('div');
    tabs.className = 'rg-tabs';
    model.tabs.forEach(tab => {
      const a = document.createElement('a');
      a.className = 'rg-tab';
      a.href = tab.href;
      a.textContent = tab.label;
      if (isActive(tab)) a.setAttribute('aria-current', 'page');
      a.addEventListener('click', () => {
        // Mémorise la position de l'onglet quitté pour animer l'indicateur à l'arrivée.
        const current = tabs.querySelector('[aria-current="page"]');
        if (current) {
          try { sessionStorage.setItem('rg-nav-prev', JSON.stringify({ module: model.name, left: current.offsetLeft, width: current.offsetWidth })); } catch { /* indisponible */ }
        }
      });
      tabs.append(a);
    });
    const indicator = document.createElement('span');
    indicator.className = 'rg-tab-indicator';
    tabs.append(indicator);
    nav.append(label, tabs);
    nav.$place = () => placeIndicator(tabs, indicator, model.name);
    return nav;
  }

  function placeIndicator(tabs, indicator, moduleName) {
    const active = tabs.querySelector('[aria-current="page"]');
    if (!active) { indicator.style.width = '0'; return; }
    let previous = null;
    try { previous = JSON.parse(sessionStorage.getItem('rg-nav-prev') || 'null'); sessionStorage.removeItem('rg-nav-prev'); } catch { /* indisponible */ }
    const target = { left: active.offsetLeft, width: active.offsetWidth };
    if (previous && previous.module === moduleName && !prefersReducedMotion()) {
      indicator.style.transition = 'none';
      indicator.style.transform = `translateX(${previous.left}px)`;
      indicator.style.width = `${previous.width}px`;
      indicator.getBoundingClientRect();
      indicator.style.transition = '';
    }
    requestAnimationFrame(() => {
      indicator.style.transform = `translateX(${target.left}px)`;
      indicator.style.width = `${target.width}px`;
    });
    // Onglet actif toujours visible quand le sommaire défile.
    tabs.scrollLeft = Math.max(0, target.left - tabs.clientWidth / 2 + target.width / 2);
    const more = () => tabs.classList.toggle('has-more', tabs.scrollLeft + tabs.clientWidth < tabs.scrollWidth - 2);
    more();
    if (!tabs.$moreBound) { tabs.$moreBound = true; tabs.addEventListener('scroll', more, { passive: true }); }
  }

  async function logout() {
    try { await window.ProjectStorage?.saveActiveProject?.(); } catch (error) { console.warn('Sauvegarde avant déconnexion :', error); }
    await fetch('/api/auth/logout', { method: 'POST' });
    try { localStorage.removeItem('engineeringAuthUser'); localStorage.removeItem('activeProject'); sessionStorage.clear(); } catch { /* indisponible */ }
    window.location.href = '/auth';
  }

  function renderUser(bar, user) {
    const name = bar.querySelector('.rg-user-name');
    const admin = bar.querySelector('.rg-admin-link');
    const full = user ? `${user.firstName || ''} ${user.lastName || ''}`.trim() : '';
    name.textContent = full;
    name.title = full;
    name.dataset.initials = full.split(/\s+/).filter(Boolean).map(w => w[0]).join('').slice(0, 2).toUpperCase();
    admin.hidden = !user || user.role !== 'admin';
    if (path === '/admin') admin.setAttribute('aria-current', 'page');
  }

  function buildAppbar() {
    if (document.querySelector('.rg-appbar') || root.hasAttribute('data-rg-no-appbar') || !document.body) return;
    const bar = document.createElement('div'); // pas <header> : les anciennes feuilles stylent body > header
    bar.className = 'rg-appbar';
    bar.setAttribute('role', 'banner');

    const brand = document.createElement('a');
    brand.className = 'rg-brand';
    brand.href = '/';
    brand.title = 'Engineering Calculator Hub';
    brand.innerHTML = `${MARK}<span class="rg-brand-text"><strong>Wattman <span>Tool</span></strong><small>Engineering Calculator Hub</small></span>`;

    const model = navigationModel();
    const nav = buildNav(model);

    const user = document.createElement('div');
    user.className = 'rg-user';
    const name = document.createElement('span');
    name.className = 'rg-user-name';
    const admin = document.createElement('a');
    admin.className = 'rg-action rg-admin-link';
    admin.href = '/admin';
    admin.hidden = true;
    admin.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="m9 12 2 2 4-4"/></svg><span class="rg-act-label">Administration</span>';
    admin.title = 'Administration';
    const out = document.createElement('button');
    out.type = 'button';
    out.className = 'rg-action rg-logout';
    out.title = 'Déconnexion';
    out.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/></svg><span class="rg-act-label">Déconnexion</span>';
    out.addEventListener('click', async () => {
      out.disabled = true;
      try { await logout(); } catch (error) { out.disabled = false; console.error(error); }
    });
    const sep = document.createElement('span');
    sep.className = 'rg-sep';

    const themeBtn = button(resolvedTheme() === 'dark' ? ICONS.sun : ICONS.moon,
      resolvedTheme() === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre', () => {
        const next = resolvedTheme() === 'dark' ? 'light' : 'dark';
        store.set('rg-theme', next);
        applyTheme();
        themeBtn.innerHTML = next === 'dark' ? ICONS.sun : ICONS.moon;
        const label = next === 'dark' ? 'Passer en thème clair' : 'Passer en thème sombre';
        themeBtn.title = label; themeBtn.setAttribute('aria-label', label);
      });
    const motionBtn = button(ICONS.motion, 'Animations réduites', () => {
      const reduced = store.get('rg-motion') !== 'reduced';
      store.set('rg-motion', reduced ? 'reduced' : 'full');
      applyMotion();
      motionBtn.setAttribute('aria-pressed', String(reduced));
    }, store.get('rg-motion') === 'reduced');
    user.append(name, admin, out, sep, motionBtn, themeBtn);

    bar.append(brand, nav, user);
    document.body.prepend(bar);
    root.classList.add('rg-has-appbar');
    // Compactage adaptatif : si les onglets débordent, on réduit l'identité et le nom.
    const fit = () => {
      const tabs = nav.querySelector('.rg-tabs');
      bar.classList.remove('is-compact');
      if (tabs && tabs.scrollWidth > tabs.clientWidth + 1) bar.classList.add('is-compact');
      if (nav.$place) nav.$place();
    };
    nav.$fit = fit;
    fit();
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(fit);

    // Utilisateur : session locale immédiate, puis confirmation par le serveur.
    renderUser(bar, storedUser());
    fetch('/api/auth/me', { cache: 'no-store' }).then(r => (r.ok ? r.json() : null)).then(data => {
      if (!data) return;
      if (data.user) { store.set('engineeringAuthUser', JSON.stringify(data.user)); renderUser(bar, data.user); }
    }).catch(() => { /* hors ligne : on garde la session locale */ });
  }

  // ---------------------------------------------------------------------------
  // Sommaire unique de la bannière.
  // Un seul bouton « Sommaire » ouvre une fenêtre dont le contenu dépend du
  // chemin : actions de la page, onglets du module courant, étapes du projet,
  // navigation générale. Les anciens blocs « Sommaire » des pages (menus
  // details.retractable-menu, .dashboard-summary-menu, app_summary.js) sont
  // absorbés : leurs boutons sont DÉPLACÉS (pas copiés) afin de conserver
  // identifiants, onclick et écouteurs (sauvegarde avant navigation,
  // réinitialisation…). Le message d'enregistrement n'est plus affiché : la
  // sauvegarde est automatique (l'élément reste dans le DOM, masqué).
  const SUM_ICONS = {
    home: ICONS.home,
    grid: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/></svg>',
    chip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/><path d="M9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4"/></svg>',
    battery: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><rect x="3" y="7" width="16" height="10" rx="2"/><path d="M21 10.5v3M7 10v4M10.5 10v4"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11L10 22l8.5-11.5H12z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 20V4M4 20h16M8 16l4-5 3 3 5-7"/></svg>',
    doc: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v4h4M9 13h6M9 17h6"/></svg>',
    wave: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12h3l2-6 4 12 3-9 2 3h4"/></svg>',
    gauge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 17a8 8 0 1 1 16 0"/><path d="m12 17 4-6"/></svg>',
    db: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v12c0 1.7 3.1 3 7 3s7-1.3 7-3V6M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V4M7 9l5-5 5 5M4 20h16"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6z"/><path d="m9 12 2 2 4-4"/></svg>',
    reset: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5"/><path d="M4 4v4.5h4.5"/></svg>',
    save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M5 3h11l3 3v15H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></svg>',
    anchor: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M10 6h10M10 12h10M10 18h10M4 6h.01M4 12h.01M4 18h.01"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5M12 7v5l3 2"/></svg>',
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M15 6l-6 6 6 6"/></svg>',
    item: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M9 6l6 6-6 6"/></svg>',
    menu: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M4 6h16M4 12h10M4 18h16"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>'
  };
  const plainText = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
  const escapeHtml = text => String(text).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const normPath = href => {
    try { const u = new URL(href, location.origin); return (u.pathname.replace(/\/+$/, '') || '/') + (u.hash || ''); } catch { return ''; }
  };
  function iconFor(href, label) {
    const h = `${href} ${label}`.toLowerCase();
    if (/initial|réinitialis|reset/.test(h)) return 'reset';
    if (/enregistr|save/.test(h)) return 'save';
    if (/historique|history/.test(h)) return 'history';
    if (/calibration/.test(h)) return 'gauge';
    if (/database|base locale|logs asc/.test(h)) return 'db';
    if (/import/.test(h)) return 'upload';
    if (/admin/.test(h)) return 'shield';
    if (/pdf|export/.test(h)) return 'doc';
    if (/synth|résultat|resultat|dashboard/.test(h)) return 'chart';
    if (/analyse_logs|workstation|acquisition|mesure/.test(h)) return 'wave';
    if (/biberon|batter|autonom|customer|dm|veille|sleep|fixed/.test(h)) return 'battery';
    if (/dcdc|wltc|homolog|edit_current|alternator|pao|gmv/.test(h)) return 'bolt';
    if (/mode/.test(h)) return 'grid';
    if (/component|composant/.test(h)) return 'chip';
    if (/retour/.test(h)) return 'back';
    if (/^#|#/.test(href)) return 'anchor';
    if (href === '/' || /accueil/.test(h)) return 'home';
    return 'item';
  }
  // Destination d'un bouton de menu historique (onclick, href, rôle connu).
  function guessDestination(el) {
    if (el.dataset.href) return normPath(el.dataset.href);
    if (el.tagName === 'A' && el.getAttribute('href')) return normPath(el.getAttribute('href'));
    const code = el.getAttribute('onclick') || '';
    const literal = code.match(/['"](\/[^'"]*)['"]/);
    if (literal) return normPath(literal[1]);
    const label = plainText(el).toLowerCase();
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/navigateHome/.test(code) || /btn-home/.test(cls) || el.id === 'homologation-home' || label === 'accueil') return '/';
    if (/sélection du mode|selection du mode/.test(label)) return '/mode_selection';
    if (/menu autonomie/.test(label)) return '/battery_menu';
    if (/config.*batterie/.test(label)) return '/battery_configuration';
    return '';
  }

  const ANALYSE_TABS = [
    { label: 'Workstation', href: '/analyse_logs/', match: ['/analyse_logs/', '/analyse_logs'] },
    { label: 'Acquisition', href: '/analyse_logs/measurement', onlyWhenActive: true },
    { label: 'Import des logs', href: '/analyse_logs/dashboard/import' },
    { label: 'Préparer le dashboard', href: '/analyse_logs/dashboard/setup' },
    { label: 'Dashboard', href: '/analyse_logs/dashboard', onlyWhenActive: true },
    { label: 'Logs ASC et base locale', href: '/analyse_logs/database' },
    { label: 'Calibration INA226', href: '/analyse_logs/calibration' }
  ];
  const PROJECT_STEPS = [
    { label: 'Composants', href: '/select_components', hint: 'ECU retenus H / S' },
    { label: "Modes d'analyse", href: '/mode_selection', hint: 'Choisir un module' },
    { label: 'DCDC Sizing / WLTC', href: '/homologation_configuration', hint: 'Homologation' },
    { label: 'Autonomie batterie', href: '/battery_menu', hint: 'DM, Customer, biberonnage' },
    { label: 'Analyse de logs', href: '/analyse_logs/', hint: 'Mesures et dashboards' },
    { label: 'Export des synthèses', href: '/export_synthesis_pdf', hint: 'PDF et Excel' }
  ];

  function summaryModel() {
    const sections = [];
    const project = activeProjectName();
    const module = MODULES.find(m => m.paths.some(p => path === p || path.startsWith(`${p}/`)));
    if (module) {
      const tabs = module.name === 'Analyse de logs' ? ANALYSE_TABS : module.tabs;
      sections.push({ id: 'module', title: module.name, items: tabs.filter(t => !t.onlyWhenActive || isActive(t)).map(t => ({ ...t, current: isActive(t) })) });
    }
    if (project && path !== '/admin') {
      sections.push({ id: 'project', title: `Projet · ${project}`, items: PROJECT_STEPS
        .filter(step => !module || !module.paths.some(p => normPath(step.href) === normPath(p)))
        .map(step => ({ ...step, current: normPath(step.href) === path })) });
    }
    const general = [{ label: 'Accueil', href: '/', hint: 'Projets et outils', current: path === '/' },
      { label: 'Importer un projet', href: '/import_project', hint: 'Fichier Excel', current: path === '/import_project' }];
    const user = storedUser();
    if (user && user.role === 'admin') general.push({ label: 'Administration', href: '/admin', hint: 'Comptes et accès', current: path === '/admin' });
    sections.push({ id: 'general', title: 'Général', items: general });
    return sections;
  }

  let summaryUI = null;
  const absorbed = [];          // boutons historiques déplacés dans le sommaire
  const statusHolder = document.createElement('div');
  statusHolder.hidden = true;
  statusHolder.className = 'rg-sum-status-holder';

  function buildSummary(bar) {
    const wrap = document.createElement('div');
    wrap.className = 'rg-sum';
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'rg-action rg-sum-toggle';
    toggle.setAttribute('aria-haspopup', 'dialog');
    toggle.setAttribute('aria-expanded', 'false');
    toggle.title = 'Sommaire';
    toggle.innerHTML = `${SUM_ICONS.menu}<span class="rg-act-label">Sommaire</span>`;
    const panel = document.createElement('div');
    panel.className = 'rg-sum-panel';
    panel.id = 'rg-summary';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'Sommaire');
    panel.hidden = true;
    toggle.setAttribute('aria-controls', panel.id);
    wrap.append(toggle, panel);
    bar.querySelector('.rg-user').prepend(wrap);
    document.body.append(statusHolder);

    const open = () => {
      render();
      panel.hidden = false;
      toggle.setAttribute('aria-expanded', 'true');
      requestAnimationFrame(() => { panel.classList.add('is-open'); panel.querySelector('.rg-sum-filter input')?.focus({ preventScroll: true }); });
    };
    const close = (restoreFocus) => {
      if (panel.hidden) return;
      panel.classList.remove('is-open');
      toggle.setAttribute('aria-expanded', 'false');
      const done = () => { if (!panel.classList.contains('is-open')) panel.hidden = true; };
      if (prefersReducedMotion()) done(); else setTimeout(done, 160);
      if (restoreFocus) toggle.focus();
    };
    toggle.addEventListener('click', () => (panel.hidden || !panel.classList.contains('is-open') ? open() : close(false)));
    document.addEventListener('click', event => { if (!wrap.contains(event.target)) close(false); });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); close(true); return; }
      if (!panel.hidden && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
        const items = [...panel.querySelectorAll('.rg-sum-item:not([hidden])')];
        if (!items.length) return;
        event.preventDefault();
        const index = items.indexOf(document.activeElement);
        items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
      }
    });

    function itemShell(el, { label, hint, href, current, tone }) {
      el.classList.add('rg-sum-item');
      if (tone) el.classList.add(`is-${tone}`);
      if (current) el.setAttribute('aria-current', 'page');
      el.dataset.search = `${label} ${hint || ''}`.toLowerCase();
      el.innerHTML = `<span class="rg-sum-ico">${SUM_ICONS[iconFor(href || '', label)]}</span><span class="rg-sum-txt"><b>${escapeHtml(label)}</b>${hint ? `<small>${escapeHtml(hint)}</small>` : ''}</span>${current ? '<span class="rg-sum-here">Ici</span>' : ''}`;
      return el;
    }
    function render() {
      panel.replaceChildren();
      const head = document.createElement('div');
      head.className = 'rg-sum-head';
      const model = navigationModel();
      const title = (document.querySelector('h1')?.textContent || document.title || '').replace(/\s+/g, ' ').trim();
      head.innerHTML = `<span class="rg-sum-kicker">${escapeHtml(model ? model.name : 'Wattman Tool')}</span><strong>${escapeHtml(title || 'Sommaire')}</strong>`;
      const filter = document.createElement('label');
      filter.className = 'rg-sum-filter';
      filter.innerHTML = `${SUM_ICONS.search}<input type="search" placeholder="Aller à…" aria-label="Filtrer le sommaire" autocomplete="off"><kbd>Échap</kbd>`;
      head.append(filter);
      panel.append(head);
      const body = document.createElement('div');
      body.className = 'rg-sum-body';
      panel.append(body);

      // Boutons historiques : ceux qui mènent à une destination connue remplacent le lien générique
      // (leur gestionnaire de page — sauvegarde avant navigation — est conservé).
      const byDestination = new Map();
      const pageActions = [];
      absorbed.forEach(entry => {
        if (entry.destination && !entry.destination.startsWith('#') && !byDestination.has(entry.destination)) byDestination.set(entry.destination, entry);
        else pageActions.push(entry);
      });
      const used = new Set();
      const sections = summaryModel();
      const makeLink = item => {
        const destination = normPath(item.href);
        const legacy = byDestination.get(destination);
        if (legacy && !item.current) {
          used.add(legacy);
          return itemShell(legacy.el, { label: item.label, hint: item.hint, href: item.href });
        }
        const a = document.createElement('a');
        a.href = item.href;
        return itemShell(a, item);
      };
      const addSection = (id, titleText, nodes) => {
        if (!nodes.length) return;
        const section = document.createElement('section');
        section.className = `rg-sum-section rg-sum-${id}`;
        section.innerHTML = `<h3>${escapeHtml(titleText)}</h3>`;
        const list = document.createElement('div');
        list.className = 'rg-sum-list';
        nodes.forEach(node => list.append(node));
        section.append(list);
        body.append(section);
      };
      const sectionNodes = sections.map(section => ({ section, nodes: section.items.map(makeLink) }));
      // Actions propres à la page (réinitialiser, enregistrer un dashboard, ancres…) et liens non reconnus.
      const actions = [...pageActions, ...[...byDestination.values()].filter(entry => !used.has(entry))].map(entry =>
        itemShell(entry.el, { label: entry.label, href: entry.destination || '', tone: /initial|réinitialis/i.test(entry.label) ? 'warn' : '' }));
      addSection('page', 'Sur cette page', actions);
      sectionNodes.forEach(({ section, nodes }) => addSection(section.id, section.title, nodes));

      const input = filter.querySelector('input');
      input.addEventListener('input', () => {
        const query = input.value.trim().toLowerCase();
        body.querySelectorAll('.rg-sum-item').forEach(item => { item.hidden = !!query && !item.dataset.search.includes(query); });
        body.querySelectorAll('.rg-sum-section').forEach(section => { section.hidden = !section.querySelector('.rg-sum-item:not([hidden])'); });
      });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { const first = body.querySelector('.rg-sum-item:not([hidden])'); if (first) { event.preventDefault(); first.click(); } }
      });
      body.querySelectorAll('.rg-sum-item').forEach((item, index) => item.style.setProperty('--i', String(Math.min(index, 14))));
      body.addEventListener('click', event => { if (event.target.closest('.rg-sum-item')) close(false); });
    }
    return { open, close, toggle, panel };
  }

  // Absorbe un ancien bloc « Sommaire » de page dans la bannière.
  function dockSummary(menu) {
    const bar = document.querySelector('.rg-appbar');
    const content = menu && menu.querySelector('.menu-content, .dashboard-summary-content');
    if (!bar || !content || menu.dataset.rgDocked) return false;
    if (!summaryUI) summaryUI = buildSummary(bar);
    menu.dataset.rgDocked = '1';
    content.querySelectorAll('#saved-status, .saved-status, .saved').forEach(status => statusHolder.append(status));
    content.querySelectorAll('button, a').forEach(el => {
      if (el.hidden || el.style.display === 'none') return;
      const label = plainText(el);
      if (!label) return;
      el.title = label;
      el.removeAttribute('style');
      absorbed.push({ el, label, destination: guessDestination(el) });
    });
    const details = menu.matches('details') ? menu : menu.querySelector('details');
    if (details) details.open = false;
    menu.classList.add('rg-docked');
    return true;
  }
  function mountSummary() {
    const bar = document.querySelector('.rg-appbar');
    if (!bar) return;
    if (!summaryUI) summaryUI = buildSummary(bar);
    document.querySelectorAll('.retractable-menu, details.dashboard-summary-menu').forEach(dockSummary);
    // Message d'enregistrement retiré : la sauvegarde est automatique.
    document.querySelectorAll('#saved-status').forEach(status => { if (!statusHolder.contains(status)) status.classList.add('rg-hidden-status'); });
    bar.querySelector('.rg-nav')?.$fit?.();
  }

  // Apparition progressive des cartes, une seule fois au chargement.
  function revealCards() {
    if (prefersReducedMotion()) return;
    const selector = [
      '.option-card', '.mode-card', '.action-card', '.module-card', '.history-card',
      '.summary-card', '.dash-card', '.section-card', '.analysis', '.panel',
      '.autonomy-profile-bar', '.homologation-profile-bar', '.rg-reveal-item'
    ].join(',');
    const items = Array.from(document.querySelectorAll(selector))
      .filter(el => !el.closest('dialog, table, .menu-content') && el.getBoundingClientRect().top < window.innerHeight * 1.2)
      .slice(0, 24);
    items.forEach((el, index) => {
      el.style.setProperty('--rg-i', String(Math.min(index, 10)));
      el.classList.add('rg-reveal');
      el.addEventListener('animationend', () => { el.classList.remove('rg-reveal'); el.style.removeProperty('--rg-i'); }, { once: true });
    });
  }

  function init() {
    buildAppbar();
    mountSummary();
    window.addEventListener('resize', () => document.querySelector('.rg-appbar .rg-nav')?.$fit?.());
    revealCards();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  window.RGUI = Object.freeze({
    theme: resolvedTheme,
    reducedMotion: prefersReducedMotion,
    dockSummary,
    setTheme(value) { store.set('rg-theme', value); applyTheme(); }
  });
})();
