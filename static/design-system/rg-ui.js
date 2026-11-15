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

  function pageLabel() {
    const h1 = document.querySelector('h1');
    const text = (h1 && h1.textContent.trim()) || document.title || '';
    return text.replace(/\s+/g, ' ').slice(0, 90);
  }
  function activeProjectName() {
    try { return (JSON.parse(store.get('activeProject') || '{}').name || '').trim(); } catch { return ''; }
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

  function buildAppbar() {
    if (document.querySelector('.rg-appbar') || root.hasAttribute('data-rg-no-appbar') || !document.body) return;
    const bar = document.createElement('div'); // pas <header> : les anciennes feuilles stylent body > header
    bar.className = 'rg-appbar';
    bar.setAttribute('role', 'banner');

    const brand = document.createElement('a');
    brand.className = 'rg-brand';
    brand.href = '/';
    brand.title = 'Accueil';
    brand.innerHTML = `${MARK}<span>Wattman</span><small>Engineering</small>`;
    bar.append(brand);

    const crumb = document.createElement('div');
    crumb.className = 'rg-crumb';
    const strong = document.createElement('strong');
    strong.textContent = pageLabel();
    crumb.append(strong);
    if (strong.textContent && !/^\/(auth)?$/.test(location.pathname)) bar.append(crumb);

    const spacer = document.createElement('div');
    spacer.className = 'rg-appbar-spacer';
    bar.append(spacer);

    const project = activeProjectName();
    if (project && !/\/(auth)?$/.test(location.pathname)) {
      const chip = document.createElement('span');
      chip.className = 'rg-project-chip';
      chip.title = `Projet actif : ${project}`;
      chip.textContent = project;
      bar.append(chip);
    }

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
    bar.append(motionBtn, themeBtn);

    document.body.prepend(bar);
    root.classList.add('rg-has-appbar');
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
