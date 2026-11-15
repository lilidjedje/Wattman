/* Wattman Tool — logique des pages publiques (accueil, connexion, inscription).
   Réutilise les endpoints existants /api/auth/login et /api/auth/register ;
   les règles serveur (validation, hash des mots de passe, rôles) restent la référence. */
(function () {
  'use strict';
  const root = document.documentElement;
  root.dataset.theme = 'dark'; // univers graphite imposé sur ces pages

  const EYE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.4 10.4 0 0 1 12 5c6.4 0 10 7 10 7a17 17 0 0 1-3.2 4.1M6.6 6.6A17.4 17.4 0 0 0 2 12s3.6 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';

  // ---------------------------------------------------------- statistiques
  async function loadStats() {
    const accounts = document.querySelector('[data-stat="accounts"]');
    const projects = document.querySelector('[data-stat="projects"]');
    if (!accounts && !projects) return;
    const show = (node, value) => {
      if (!node) return;
      node.textContent = Number.isFinite(value) ? value.toLocaleString('fr-FR') : '—';
      node.closest('.auth-stat')?.classList.remove('is-loading');
    };
    try {
      const response = await fetch('/api/auth/stats', { cache: 'no-store' });
      const data = response.ok ? await response.json() : {};
      show(accounts, Number.isInteger(data.accounts) ? data.accounts : NaN);
    } catch { show(accounts, NaN); }
    try {
      const count = window.desktopEnvironment?.projectCount ? await window.desktopEnvironment.projectCount() : NaN;
      show(projects, Number.isInteger(count) ? count : NaN);
    } catch { show(projects, NaN); }
  }

  // ------------------------------------------------------- formulaires
  function setError(input, message) {
    const slot = input.closest('.auth-field')?.querySelector('.field-error');
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (slot) slot.textContent = message || '';
  }

  function validate(form) {
    let ok = true;
    const field = name => form.elements.namedItem(name);
    const check = (input, message) => { if (!input) return; setError(input, message); if (message) ok = false; };
    const email = field('email');
    check(email, !email.value.trim() ? 'Saisissez votre adresse e-mail.'
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.value.trim()) ? 'Adresse e-mail invalide.' : '');
    const password = field('password');
    if (form.dataset.form === 'login') {
      check(password, password.value ? '' : 'Saisissez votre mot de passe.');
    } else {
      check(field('lastName'), field('lastName').value.trim() ? '' : 'Le nom est obligatoire.');
      check(field('firstName'), field('firstName').value.trim() ? '' : 'Le prénom est obligatoire.');
      check(password, password.value.length < 8 ? 'Au moins 8 caractères.' : password.value.length > 128 ? '128 caractères maximum.' : '');
      const confirm = field('passwordConfirm');
      check(confirm, !confirm.value ? 'Confirmez le mot de passe.' : confirm.value !== password.value ? 'Les mots de passe ne correspondent pas.' : '');
    }
    return ok;
  }

  function bindForm(form) {
    const alert = form.querySelector('.auth-alert');
    const endpoint = form.dataset.form === 'login' ? '/api/auth/login' : '/api/auth/register';
    form.querySelectorAll('input').forEach(input => input.addEventListener('input', () => {
      if (input.getAttribute('aria-invalid') === 'true') setError(input, '');
      alert.textContent = '';
    }));
    form.addEventListener('submit', async event => {
      event.preventDefault();
      alert.textContent = '';
      if (!validate(form)) { form.querySelector('[aria-invalid="true"]')?.focus(); return; }
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        const values = Object.fromEntries(new FormData(form).entries());
        const payload = form.dataset.form === 'login'
          ? { email: values.email.trim(), password: values.password, rememberMe: form.elements.namedItem('rememberMe')?.checked === true }
          : { firstName: values.firstName.trim(), lastName: values.lastName.trim(), email: values.email.trim(), password: values.password };
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || 'Une erreur est survenue.');
        // Même suite qu'auparavant : nouvelle session, aucun projet précédent ouvert.
        sessionStorage.clear();
        localStorage.removeItem('activeProject');
        localStorage.setItem('engineeringAuthUser', JSON.stringify(data.user));
        window.location.href = '/';
      } catch (error) {
        alert.textContent = error.message;
      } finally {
        button.disabled = false;
      }
    });
  }

  function bindPasswordToggles() {
    document.querySelectorAll('.auth-password').forEach(wrap => {
      const input = wrap.querySelector('input');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'auth-toggle';
      const render = () => {
        const visible = input.type === 'text';
        button.innerHTML = visible ? EYE_OFF : EYE;
        button.setAttribute('aria-label', visible ? 'Masquer le mot de passe' : 'Afficher le mot de passe');
        button.setAttribute('aria-pressed', String(visible));
      };
      button.addEventListener('click', () => { input.type = input.type === 'password' ? 'text' : 'password'; render(); input.focus(); });
      render();
      wrap.append(button);
    });
  }

  function init() {
    loadStats();
    bindPasswordToggles();
    document.querySelectorAll('form[data-form]').forEach(bindForm);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
