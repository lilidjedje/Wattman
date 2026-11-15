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
    window.addEventListener('resize', () => document.querySelector('.rg-appbar .rg-nav')?.$fit?.());
    revealCards();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();

  window.RGUI = Object.freeze({
    theme: resolvedTheme,
    reducedMotion: prefersReducedMotion,
    setTheme(value) { store.set('rg-theme', value); applyTheme(); }
  });
})();
